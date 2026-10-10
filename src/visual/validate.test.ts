import { describe, expect, it } from 'vitest';
import { emptyProject, type ContractFunction, type GraphEdge, type GraphNode, type VisualProject } from './model';
import { indexDiagnostics, stableOrder, validateProject } from './validate';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const FNS: ContractFunction[] = [
  { signature: 'balanceOf(address)', name: 'balanceOf', inputs: ['address'], outputs: ['uint256'], mutability: 'view' },
  { signature: 'deposit(uint256)', name: 'deposit', inputs: ['uint256'], outputs: [], mutability: 'nonpayable' },
  { signature: 'flag(bool)', name: 'flag', inputs: ['bool'], outputs: [], mutability: 'nonpayable' },
  { signature: 'stake()', name: 'stake', inputs: [], outputs: [], mutability: 'payable' },
];

interface Options {
  nodes?: GraphNode[];
  edges?: GraphEdge[];
  contracts?: VisualProject['contracts'];
}

function project({ nodes = [], edges = [], contracts = [{ id: 'c1', name: 'Vault', address: ADDRESS, functions: FNS }] }: Options): VisualProject {
  return { contracts, nodes, edges, positions: {}, frameSizes: {} };
}

let edgeSeq = 0;
function edge(from: string, fromPort: string, to: string, toPort: string): GraphEdge {
  return { id: `e${++edgeSeq}`, from: { node: from, port: fromPort }, to: { node: to, port: toPort } };
}

const messages = (p: VisualProject) => validateProject(p).map(d => d.message);

describe('validateProject', () => {
  it('accepts a connected program', () => {
    const p = project({
      nodes: [
        { id: 'self', kind: 'context', name: 'SELF' },
        { id: 'call1', kind: 'call', contractId: 'c1', signature: 'balanceOf(address)' },
        { id: 'lit', kind: 'literal', literalType: 'uint', literal: '1000' },
        { id: 'cmp', kind: 'binary', op: 'gt' },
        { id: 'if1', kind: 'if' },
        { id: 'dep', kind: 'call', contractId: 'c1', signature: 'deposit(uint256)', parent: 'if1' },
      ],
      edges: [
        edge('self', 'out', 'call1', 'arg:0'),
        edge('call1', 'out:0', 'cmp', 'lhs'),
        edge('lit', 'out', 'cmp', 'rhs'),
        edge('cmp', 'out', 'if1', 'condition'),
        edge('call1', 'out:0', 'dep', 'arg:0'),
      ],
    });
    expect(validateProject(p)).toEqual([]);
  });

  it('reports missing contracts and vanished functions', () => {
    const missing = project({ nodes: [{ id: 'x', kind: 'call', contractId: 'gone', signature: 'a()' }] });
    expect(messages(missing)).toContain('References a missing contract resource');
    const stale = project({ nodes: [{ id: 'x', kind: 'call', contractId: 'c1', signature: 'nope()' }] });
    expect(messages(stale).join()).toContain('no longer has nope()');
  });

  it('rejects an invalid literal', () => {
    const p = project({ nodes: [{ id: 'l', kind: 'literal', literalType: 'uint', literal: 'abc' }] });
    expect(messages(p).join()).toContain('not a valid uint');
  });

  it('rejects edges from output indices the ABI does not have', () => {
    const p = project({
      nodes: [
        { id: 'call', kind: 'call', contractId: 'c1', signature: 'balanceOf(address)' },
        { id: 'lit', kind: 'literal', literalType: 'uint', literal: '1' },
      ],
      edges: [edge('call', 'out:1', 'lit', 'out')],
    });
    // balanceOf has one output; and a literal has no input ports at all.
    expect(messages(p).join()).toContain('no longer exists');
  });

  it('routes booleans into bool slots only', () => {
    const boolToUint = project({
      nodes: [
        { id: 'lit', kind: 'literal', literalType: 'bool', literal: 'true' },
        { id: 'dep', kind: 'call', contractId: 'c1', signature: 'deposit(uint256)' },
      ],
      edges: [edge('lit', 'out', 'dep', 'arg:0')],
    });
    expect(messages(boolToUint).join()).toContain('Cannot feed uint256 #1 from a bool output');

    const boolToBool = project({
      nodes: [
        { id: 'lit', kind: 'literal', literalType: 'bool', literal: 'true' },
        { id: 'flg', kind: 'call', contractId: 'c1', signature: 'flag(bool)' },
      ],
      edges: [edge('lit', 'out', 'flg', 'arg:0')],
    });
    expect(validateProject(boolToBool)).toEqual([]);

    const boolToIf = project({
      nodes: [
        { id: 'lit', kind: 'literal', literalType: 'bool', literal: 'true' },
        { id: 'if1', kind: 'if' },
      ],
      edges: [edge('lit', 'out', 'if1', 'condition')],
    });
    expect(messages(boolToIf).join()).toContain('Cannot feed if from a bool output');
  });

  it('rejects incompatible port types', () => {
    const gasToAddress = project({
      nodes: [
        { id: 'gas', kind: 'context', name: 'GAS' },
        { id: 'call', kind: 'call', contractId: 'c1', signature: 'balanceOf(address)' },
      ],
      edges: [edge('gas', 'out', 'call', 'arg:0')],
    });
    expect(messages(gasToAddress).join()).toContain('Cannot feed address #1 from a value output');
    const rawToValue = project({
      nodes: [
        { id: 'call', kind: 'call', contractId: 'c1', signature: 'stake()' },
        { id: 'lit', kind: 'literal', literalType: 'uint', literal: '1' },
      ],
      edges: [edge('call', 'result', 'lit', 'out')],
    });
    // The raw result port is gone; old graphs migrate it on load.
    expect(messages(rawToValue).join()).toContain('Output port "result" no longer exists');
  });

  it('rejects multiple drivers and missing required inputs', () => {
    const p = project({
      nodes: [
        { id: 'a', kind: 'context', name: 'SELF' },
        { id: 'b', kind: 'context', name: 'SELF' },
        { id: 'call', kind: 'call', contractId: 'c1', signature: 'balanceOf(address)' },
        { id: 'dep', kind: 'call', contractId: 'c1', signature: 'deposit(uint256)' },
      ],
      edges: [edge('a', 'out', 'call', 'arg:0'), edge('b', 'out', 'call', 'arg:0')],
    });
    const diags = messages(p);
    expect(diags.join()).toContain('has 2 inputs');
    expect(diags.join()).toContain('uint256 #1 is missing an input');
    // payable value port is optional
    const stake = project({ nodes: [{ id: 's', kind: 'call', contractId: 'c1', signature: 'stake()' }] });
    expect(validateProject(stake)).toEqual([]);
  });

  it('rejects cycles and self feeds', () => {
    const cyclic = project({
      nodes: [
        { id: 'x', kind: 'binary', op: 'add' },
        { id: 'y', kind: 'binary', op: 'add' },
      ],
      edges: [edge('x', 'out', 'y', 'lhs'), edge('y', 'out', 'x', 'rhs')],
    });
    const diags = messages(cyclic);
    expect(diags.join()).toContain('Value cycle detected');
    const selfFeed = project({
      nodes: [{ id: 'x', kind: 'binary', op: 'add' }, { id: 'src', kind: 'context', name: 'GAS' }],
      edges: [
        edge('src', 'out', 'x', 'lhs'), edge('x', 'out', 'x', 'rhs'),
      ],
    });
    expect(messages(selfFeed).join()).toContain('Node feeds itself');
  });

  it('rejects values escaping an IF body but allows inward flow', () => {
    const escape = project({
      nodes: [
        { id: 'if1', kind: 'if' },
        { id: 'lit', kind: 'literal', literalType: 'uint', literal: '5', parent: 'if1' },
        { id: 'dep', kind: 'call', contractId: 'c1', signature: 'deposit(uint256)' },
        { id: 'cond', kind: 'context', name: 'GAS' },
      ],
      edges: [edge('cond', 'out', 'if1', 'condition'), edge('lit', 'out', 'dep', 'arg:0')],
    });
    expect(messages(escape).join()).toContain('cannot be used outside');

    const inward = project({
      nodes: [
        { id: 'if1', kind: 'if' },
        { id: 'cond', kind: 'context', name: 'GAS' },
        { id: 'lit', kind: 'literal', literalType: 'uint', literal: '5' },
        { id: 'dep', kind: 'call', contractId: 'c1', signature: 'deposit(uint256)', parent: 'if1' },
      ],
      edges: [edge('cond', 'out', 'if1', 'condition'), edge('lit', 'out', 'dep', 'arg:0')],
    });
    expect(validateProject(inward)).toEqual([]);
  });

  it('allows a call output consumed at or below its block, not above it', () => {
    // The decode sits at the call site, so a consumer in a nested block
    // below the call reads a constant that is in scope.
    const nestedConsumer = project({
      nodes: [
        { id: 'self', kind: 'context', name: 'SELF' },
        { id: 'if1', kind: 'if' },
        { id: 'cond1', kind: 'context', name: 'GAS' },
        { id: 'call', kind: 'call', contractId: 'c1', signature: 'balanceOf(address)', parent: 'if1' },
        { id: 'if2', kind: 'if', parent: 'if1' },
        { id: 'cond2', kind: 'context', name: 'GAS' },
        { id: 'dep', kind: 'call', contractId: 'c1', signature: 'deposit(uint256)', parent: 'if2' },
      ],
      edges: [
        edge('self', 'out', 'call', 'arg:0'),
        edge('cond1', 'out', 'if1', 'condition'),
        edge('cond2', 'out', 'if2', 'condition'),
        edge('call', 'out:0', 'dep', 'arg:0'),
      ],
    });
    expect(validateProject(nestedConsumer)).toEqual([]);

    // Consuming ABOVE the call would read a constant that never existed
    // at that scope (and return data is stale outside the call's block).
    const shallowerConsumer = project({
      nodes: [
        { id: 'self', kind: 'context', name: 'SELF' },
        { id: 'if1', kind: 'if' },
        { id: 'cond1', kind: 'context', name: 'GAS' },
        { id: 'call', kind: 'call', contractId: 'c1', signature: 'balanceOf(address)', parent: 'if1' },
        { id: 'dep', kind: 'call', contractId: 'c1', signature: 'deposit(uint256)' },
      ],
      edges: [
        edge('self', 'out', 'call', 'arg:0'),
        edge('cond1', 'out', 'if1', 'condition'),
        edge('call', 'out:0', 'dep', 'arg:0'),
      ],
    });
    expect(messages(shallowerConsumer).join()).toContain('cannot be used outside');
  });

  it('marks dynamic outputs non-connectable but keeps the function usable', () => {
    const contracts = [{ id: 'c1', name: 'Meta', address: ADDRESS, functions: [
      { signature: 'meta()', name: 'meta', inputs: [], outputs: ['string', 'uint256'], mutability: 'view' as const },
      { signature: 'deposit(uint256)', name: 'deposit', inputs: ['uint256'], outputs: [], mutability: 'nonpayable' as const },
    ] }];
    const throughDynamic = project({
      contracts,
      nodes: [
        { id: 'call', kind: 'call', contractId: 'c1', signature: 'meta()' },
        { id: 'dep', kind: 'call', contractId: 'c1', signature: 'deposit(uint256)' },
      ],
      edges: [edge('call', 'out:0', 'dep', 'arg:0')],
    });
    expect(messages(throughDynamic).join()).toContain('not decodable');

    const afterDynamic = project({
      contracts,
      nodes: [
        { id: 'call', kind: 'call', contractId: 'c1', signature: 'meta()' },
        { id: 'dep', kind: 'call', contractId: 'c1', signature: 'deposit(uint256)' },
      ],
      edges: [edge('call', 'out:1', 'dep', 'arg:0')],
    });
    // The uint after a dynamic predecessor sits at head word 1 and decodes fine.
    expect(validateProject(afterDynamic)).toEqual([]);
  });

  it('reports dangling parent and parent cycles', () => {
    const dangling = project({ nodes: [{ id: 'x', kind: 'context', name: 'SELF', parent: 'ghost' }] });
    expect(messages(dangling)).toContain('Belongs to a missing IF block');
    const loopingA = { id: 'a', kind: 'if' as const, parent: 'b' };
    const loopingB = { id: 'b', kind: 'if' as const, parent: 'a' };
    expect(messages(project({ nodes: [loopingA, loopingB] })).join()).toContain('cycle of IF blocks');
    const wrongParent = project({
      nodes: [{ id: 'lit', kind: 'literal', literalType: 'uint', literal: '1' }, { id: 'other', kind: 'context', name: 'SELF' }, { id: 'x', kind: 'context', name: 'SELF', parent: 'other' }],
    });
    expect(messages(wrongParent).join()).toContain('is not an IF block');
  });

  it('reports duplicate ids and stale edge endpoints', () => {
    const dup = project({ nodes: [{ id: 'a', kind: 'if' }, { id: 'a', kind: 'if' }] });
    expect(messages(dup)).toContain('Duplicate node id: a');
    const danglingEdge = project({
      nodes: [{ id: 'x', kind: 'binary', op: 'add' }],
      edges: [edge('ghost', 'out', 'x', 'lhs')],
    });
    expect(messages(danglingEdge).join()).toContain('is missing');
  });
});

describe('stableOrder', () => {
  it('orders dependencies before consumers and ties by creation order', () => {
    const p = project({
      nodes: [
        { id: 'callA', kind: 'call', contractId: 'c1', signature: 'balanceOf(address)' },
        { id: 'callB', kind: 'call', contractId: 'c1', signature: 'stake()' },
        { id: 'src', kind: 'context', name: 'SELF' },
        { id: 'dep', kind: 'call', contractId: 'c1', signature: 'deposit(uint256)' },
      ],
      edges: [edge('callA', 'out:0', 'dep', 'arg:0'), edge('src', 'out', 'callA', 'arg:0')],
    });
    expect(stableOrder(p).order).toEqual(['callB', 'src', 'callA', 'dep']);
    expect(stableOrder(p).cycle).toEqual([]);
  });

  it('orders IF blocks after producers their body consumes, whatever the array order', () => {
    const nodes: GraphNode[] = [
      { id: 'if1', kind: 'if' },
      { id: 'cond', kind: 'context', name: 'GAS' },
      { id: 'self1', kind: 'context', name: 'SELF' },
      { id: 'call1', kind: 'call', contractId: 'c1', signature: 'balanceOf(address)' },
      { id: 'dep', kind: 'call', contractId: 'c1', signature: 'deposit(uint256)', parent: 'if1' },
    ];
    const edges = [
      edge('cond', 'out', 'if1', 'condition'),
      edge('self1', 'out', 'call1', 'arg:0'),
      edge('call1', 'out:0', 'dep', 'arg:0'),
    ];
    const ifFirst = project({ nodes, edges });
    expect(validateProject(ifFirst)).toEqual([]);
    const { order, cycle } = stableOrder(ifFirst);
    expect(cycle).toEqual([]);
    expect(order.indexOf('call1')).toBeLessThan(order.indexOf('if1'));

    // reversing the array must not change the semantic order of the relevant pair
    const reversed = project({ nodes: [...nodes].reverse(), edges });
    const rev = stableOrder(reversed);
    expect(rev.cycle).toEqual([]);
    expect(rev.order.indexOf('call1')).toBeLessThan(rev.order.indexOf('if1'));
  });

  it('lists remaining nodes as the cycle', () => {
    const p = project({
      nodes: [
        { id: 'ok', kind: 'context', name: 'SELF' },
        { id: 'x', kind: 'binary', op: 'add' },
        { id: 'y', kind: 'binary', op: 'add' },
      ],
      edges: [edge('x', 'out', 'y', 'lhs'), edge('y', 'out', 'x', 'lhs')],
    });
    const { order, cycle } = stableOrder(p);
    expect(order).toEqual(['ok']);
    expect(cycle).toEqual(['x', 'y']);
  });
});

describe('indexDiagnostics', () => {
  it('groups messages and ports per node and drops node-less entries', () => {
    const index = indexDiagnostics([
      { message: 'global problem' },
      { message: 'arg:0 is missing an input', node: 'call1', port: 'arg:0' },
      { message: 'References a missing contract resource', node: 'call1' },
      { message: 'cycle', node: 'op1' },
    ]);
    expect(index.get('call1')!.messages).toEqual(['arg:0 is missing an input', 'References a missing contract resource']);
    expect([...index.get('call1')!.ports]).toEqual(['arg:0']);
    expect(index.get('op1')!.ports.size).toBe(0);
    expect(index.size).toBe(2);
  });
});

describe('branch-aware scope validation', () => {
  const IF1: GraphNode = { id: 'if1', kind: 'if', hasElse: true };
  const IF2: GraphNode = { id: 'if2', kind: 'if', parent: 'if1', branch: 'then' };
  const lit = (id: string, extra: Partial<GraphNode> = {}): GraphNode =>
    ({ id, kind: 'literal', literalType: 'address', literal: ADDRESS, ...extra }) as GraphNode;
  const call = (id: string, extra: Partial<GraphNode> = {}): GraphNode =>
    ({ id, kind: 'call', contractId: 'c1', signature: 'deposit(uint256)', ...extra }) as GraphNode;
  const edge = (from: string, to: string): GraphEdge =>
    ({ id: `${from}->${to}`, from: { node: from, port: 'out' }, to: { node: to, port: 'arg:0' } });

  it('top-level values may feed either branch', () => {
    const p = project({ nodes: [IF1, lit('a'), call('t', { parent: 'if1', branch: 'then' }), call('e', { parent: 'if1', branch: 'else' })],
      edges: [edge('a', 't'), edge('a', 'e')] });
    expect(validateProject(p).filter(d => d.message.includes('scope') || d.message.includes('branch') || d.message.includes('outside'))).toEqual([]);
  });

  it('rejects THEN -> ELSE and ELSE -> THEN crossings', () => {
    const p = project({ nodes: [IF1, lit('t', { parent: 'if1', branch: 'then' }), call('e', { parent: 'if1', branch: 'else' })],
      edges: [edge('t', 'e')] });
    const hits = validateProject(p).filter(d => d.node === 'e');
    expect(hits.length).toBe(1);
    expect(hits[0].message).toMatch(/different IF branch/);
    const flipped = project({ nodes: [IF1, lit('e', { parent: 'if1', branch: 'else' }), call('t', { parent: 'if1', branch: 'then' })],
      edges: [edge('e', 't')] });
    expect(validateProject(flipped).some(d => d.node === 't' && d.message.includes('different IF branch'))).toBe(true);
  });

  it('checks scope through IF condition and payable value ports', () => {
    // if2 lives in if1:then; an if1:else value may not feed its condition.
    const cond = project({
      nodes: [IF1, { id: 'if2', kind: 'if', parent: 'if1', branch: 'then' },
        lit('bad', { literalType: 'bool', literal: 'true', parent: 'if1', branch: 'else' }),
        lit('ok', { literalType: 'bool', literal: 'false' })],
      edges: [
        { id: 'c1e', from: { node: 'bad', port: 'out' }, to: { node: 'if2', port: 'condition' } },
        { id: 'c2e', from: { node: 'ok', port: 'out' }, to: { node: 'if1', port: 'condition' } }],
    });
    expect(validateProject(cond).some(d => d.node === 'if2' && d.message.includes('different IF branch'))).toBe(true);

    // A payable call's value port is a normal edge target; branch rules hold.
    const payable = project({
      nodes: [IF1,
        { id: 'stake', kind: 'call', contractId: 'c1', signature: 'stake()', parent: 'if1', branch: 'then' } as GraphNode,
        lit('amt', { kind: 'literal', literalType: 'uint', literal: '7', parent: 'if1', branch: 'else' } as GraphNode)],
      edges: [{ id: 'v', from: { node: 'amt', port: 'out' }, to: { node: 'stake', port: 'value' } }],
    });
    expect(validateProject(payable).some(d => d.node === 'stake' && d.message.includes('different IF branch'))).toBe(true);
  });

  it('lets one top-level decoded output feed both branches', () => {
    const p = project({
      nodes: [IF1,
        { id: 'read', kind: 'call', contractId: 'c1', signature: 'balanceOf(address)' } as GraphNode,
        lit('a'),
        call('t', { parent: 'if1', branch: 'then' }),
        call('e', { parent: 'if1', branch: 'else' })],
      edges: [
        { id: 'r', from: { node: 'a', port: 'out' }, to: { node: 'read', port: 'arg:0' } },
        { id: 't', from: { node: 'read', port: 'out:0' }, to: { node: 't', port: 'arg:0' } },
        { id: 'e', from: { node: 'read', port: 'out:0' }, to: { node: 'e', port: 'arg:0' } }],
    });
    expect(validateProject(p).filter(d => d.message.includes('branch') || d.message.includes('outside'))).toEqual([]);
  });

  it('rejects branch values escaping to after the IF', () => {
    const p = project({ nodes: [IF1, lit('t', { parent: 'if1', branch: 'then' }), call('top')], edges: [edge('t', 'top')] });
    expect(validateProject(p).some(d => d.node === 'top' && d.message.includes('outside that block'))).toBe(true);
  });

  it('allows a THEN value deeper into a nested IF inside that same branch', () => {
    const p = project({
      nodes: [IF1, IF2, lit('t', { parent: 'if1', branch: 'then' }), call('deep', { parent: 'if2', branch: 'then' })],
      edges: [edge('t', 'deep')],
    });
    expect(validateProject(p).filter(d => d.node === 'deep' && d.message.match(/branch|outside/))).toEqual([]);
  });

  it('a nested branch-local value cannot escape to an ancestor branch', () => {
    const p = project({
      nodes: [IF1, IF2, lit('d', { parent: 'if2', branch: 'then' }), call('outer', { parent: 'if1', branch: 'then' })],
      edges: [edge('d', 'outer')],
    });
    expect(validateProject(p).some(d => d.node === 'outer' && d.message.includes('outside that block'))).toBe(true);
  });

  it('a THEN value cannot feed a sibling nested inside the ELSE', () => {
    const elseNested: GraphNode = { id: 'if3', kind: 'if', parent: 'if1', branch: 'else' };
    const p = project({
      nodes: [IF1, elseNested, lit('t', { parent: 'if1', branch: 'then' }), call('inElse', { parent: 'if3', branch: 'then' })],
      edges: [edge('t', 'inElse')],
    });
    expect(validateProject(p).some(d => d.node === 'inElse' && d.message.includes('different IF branch'))).toBe(true);
  });

  it('flags ELSE membership on a block without ELSE, and branch without a block', () => {
    const orphanBranch = project({ nodes: [{ id: 'ctx1', kind: 'context', name: 'SELF', branch: 'else' as const }] });
    expect(validateProject(orphanBranch).some(d => d.message.includes('without belonging'))).toBe(true);
    const badElse = project({
      nodes: [{ id: 'if1', kind: 'if' }, { id: 'ctx1', kind: 'context', name: 'SELF', parent: 'if1', branch: 'else' as const }, call('c1', { parent: 'if1', branch: 'else' })],
    });
    expect(validateProject(badElse).some(d => d.message.includes('has no ELSE'))).toBe(true);
  });

  it('scope decisions are independent of node array order', () => {
    const nodes = [IF1, lit('t', { parent: 'if1', branch: 'then' }), call('e', { parent: 'if1', branch: 'else' })];
    const forward = project({ nodes, edges: [edge('t', 'e')] });
    const reverse = project({ nodes: [...nodes].reverse(), edges: [edge('t', 'e')] });
    expect(validateProject(reverse).filter(d => d.node === 'e' && d.message.includes('branch')))
      .toEqual(validateProject(forward).filter(d => d.node === 'e' && d.message.includes('branch')));
  });
});

describe('balance, hash, and guard diagnostics', () => {
  it('requires an address on a balance and a condition on a guard', () => {
    const p = project({ nodes: [{ id: 'bal', kind: 'balance' }, { id: 'grd', kind: 'guard' }] });
    expect(messages(p)).toEqual(expect.arrayContaining([
      'address is missing an input',
      'unless is missing an input',
    ]));
  });

  it('flags hash data that is not byte data', () => {
    expect(messages(project({ nodes: [{ id: 'h', kind: 'keccak', data: 'nope' }] })))
      .toContain('Hash data "nope" is not 0x-prefixed byte data');
    expect(messages(project({ nodes: [{ id: 'h', kind: 'keccak', data: '0x' }] }))).toEqual([]);
  });

  it('marks a balance whose value nothing reads', () => {
    const p = project({
      nodes: [{ id: 'self', kind: 'context', name: 'SELF' }, { id: 'bal', kind: 'balance' }],
      edges: [edge('self', 'out', 'bal', 'address')],
    });
    expect(messages(p)).toEqual(['Balance is never read; connect it to a call input, a guard, or an IF condition']);
  });

  it('reads a balance through the value graph, not just its own edges', () => {
    // A balance feeding a comparison that nothing reads is still unread: the
    // comparison emits nothing on its own, so BALANCE would never be emitted.
    const dangling = project({
      nodes: [
        { id: 'self', kind: 'context', name: 'SELF' },
        { id: 'bal', kind: 'balance' },
        { id: 'lit', kind: 'literal', literalType: 'uint', literal: '1' },
        { id: 'cmp', kind: 'binary', op: 'gt' },
      ],
      edges: [edge('self', 'out', 'bal', 'address'), edge('bal', 'out', 'cmp', 'lhs'), edge('lit', 'out', 'cmp', 'rhs')],
    });
    expect(messages(dangling)).toEqual(['Balance is never read; connect it to a call input, a guard, or an IF condition']);
    const used = project({
      nodes: [...dangling.nodes, { id: 'if1', kind: 'if' }],
      edges: [...dangling.edges, edge('cmp', 'out', 'if1', 'condition')],
    });
    expect(messages(used)).toEqual([]);
  });

  it('takes a comparison into a guard and refuses a bool as an address', () => {
    const ok = project({
      nodes: [
        { id: 'self', kind: 'context', name: 'SELF' },
        { id: 'lit', kind: 'literal', literalType: 'uint', literal: '5' },
        { id: 'cmp', kind: 'binary', op: 'gt' },
        { id: 'grd', kind: 'guard' },
      ],
      edges: [edge('self', 'out', 'cmp', 'lhs'), edge('lit', 'out', 'cmp', 'rhs'), edge('cmp', 'out', 'grd', 'condition')],
    });
    expect(messages(ok)).toEqual([]);
    const bad = project({
      nodes: [{ id: 'lit', kind: 'literal', literalType: 'bool', literal: 'true' }, { id: 'bal', kind: 'balance' }],
      edges: [edge('lit', 'out', 'bal', 'address')],
    });
    expect(messages(bad)).toContain('Cannot feed address from a bool output');
  });

  it('emits a guard or a hash by dependency and creation order, never by position', () => {
    const p = project({
      nodes: [
        { id: 'grd', kind: 'guard' },
        { id: 'cmp', kind: 'binary', op: 'lt' },
        { id: 'a', kind: 'context', name: 'GAS' },
        { id: 'b', kind: 'literal', literalType: 'uint', literal: '9' },
        { id: 'h', kind: 'keccak', data: '0x01' },
      ],
      edges: [edge('a', 'out', 'cmp', 'lhs'), edge('b', 'out', 'cmp', 'rhs'), edge('cmp', 'out', 'grd', 'condition')],
    });
    const { order, cycle } = stableOrder(p);
    expect(cycle).toEqual([]);
    expect(order.indexOf('cmp')).toBeLessThan(order.indexOf('grd'));
  });
});

describe('send and raw call validation', () => {
  it('requires both inputs on a send — an empty transfer is a mistake', () => {
    expect(messages(project({ nodes: [{ id: 'send1', kind: 'send' }] }))).toEqual([
      'address is missing an input',
      'value (wei) is missing an input',
    ]);
  });

  it('lets a raw call stand without a value: the third argument is simply omitted', () => {
    const p = project({
      nodes: [
        { id: 'raw1', kind: 'rawcall', calldata: '0x12345678' },
        { id: 'addr', kind: 'literal', literalType: 'address', literal: ADDRESS },
      ],
      edges: [edge('addr', 'out', 'raw1', 'address')],
    });
    expect(messages(p)).toEqual([]);
  });

  it('flags calldata that is not byte data and marks the field', () => {
    const p = project({ nodes: [{ id: 'raw1', kind: 'rawcall', calldata: 'nope' }, { id: 'addr', kind: 'literal', literalType: 'address', literal: ADDRESS }], edges: [edge('addr', 'out', 'raw1', 'address')] });
    expect(messages(p)).toContain('Calldata "nope" is not 0x-prefixed byte data');
    const byNode = indexDiagnostics(validateProject(p));
    expect([...byNode.get('raw1')!.ports]).toContain('calldata');
  });

  it('keeps port-kind rules: addresses feed addresses, values feed value slots', () => {
    const p = project({
      nodes: [
        { id: 'raw1', kind: 'rawcall' as const, calldata: '0x' },
        { id: 'lit', kind: 'literal', literalType: 'uint', literal: '7' },
        { id: 'send1', kind: 'send' },
        { id: 'bool', kind: 'literal', literalType: 'bool', literal: 'true' },
      ],
      edges: [
        edge('lit', 'out', 'raw1', 'address'),
        edge('bool', 'out', 'raw1', 'value'),
        edge('bool', 'out', 'send1', 'value'),
        edge('lit', 'out', 'send1', 'address'),
      ],
    });
    const msgs = messages(p);
    expect(msgs).toContain('Cannot feed address from a value output');
    expect(msgs).toContain('Cannot feed value (wei) from a bool output');
  });

  it('a balance feeding a raw call is read — raw statements are reach roots', () => {
    const p = project({
      nodes: [
        { id: 'raw1', kind: 'rawcall', calldata: '0x' },
        { id: 'bal', kind: 'balance' },
        { id: 'addr', kind: 'literal', literalType: 'address', literal: ADDRESS },
      ],
      edges: [
        edge('addr', 'out', 'raw1', 'address'),
        edge('addr', 'out', 'bal', 'address'),
        edge('bal', 'out', 'raw1', 'value'),
      ],
    });
    expect(messages(p)).toEqual([]);
  });
});
