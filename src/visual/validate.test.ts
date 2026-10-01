import { describe, expect, it } from 'vitest';
import { emptyProject, type ContractFunction, type GraphEdge, type GraphNode, type VisualProject } from './model';
import { stableOrder, validateProject } from './validate';

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
  return { contracts, nodes, edges, positions: {} };
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
        { id: 'amt', kind: 'return', decoder: 'uint256' },
        { id: 'lit', kind: 'literal', literalType: 'uint', literal: '1000' },
        { id: 'cmp', kind: 'binary', op: 'gt' },
        { id: 'if1', kind: 'if' },
        { id: 'dep', kind: 'call', contractId: 'c1', signature: 'deposit(uint256)', parent: 'if1' },
      ],
      edges: [
        edge('self', 'out', 'call1', 'arg:0'),
        edge('call1', 'result', 'amt', 'result'),
        edge('amt', 'out', 'cmp', 'lhs'),
        edge('lit', 'out', 'cmp', 'rhs'),
        edge('cmp', 'out', 'if1', 'condition'),
        edge('amt', 'out', 'dep', 'arg:0'),
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

  it('rejects a word offset that is not a word multiple', () => {
    const p = project({ nodes: [{ id: 'r', kind: 'return', decoder: 'word', offset: 16 }] });
    expect(messages(p).join()).toContain('multiple of 32');
  });

  it('rejects negative, fractional, and unsafe word offsets', () => {
    for (const offset of [-32, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      const p = project({ nodes: [{ id: 'r', kind: 'return', decoder: 'word', offset }] });
      expect(messages(p).join()).toContain('non-negative multiple of 32');
    }
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
    // result outputs only feed decoders; also lit has no such input port
    expect(messages(rawToValue).join()).toContain('Input port "out" no longer exists');
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

  it('allows a decoder at or below its call\'s block but not above it', () => {
    // The builder decodes return data in the call's scope or any nested block,
    // so a decoder inside a nested IF below the call is valid.
    const nestedDecoder = project({
      nodes: [
        { id: 'self', kind: 'context', name: 'SELF' },
        { id: 'if1', kind: 'if' },
        { id: 'cond1', kind: 'context', name: 'GAS' },
        { id: 'call', kind: 'call', contractId: 'c1', signature: 'balanceOf(address)', parent: 'if1' },
        { id: 'if2', kind: 'if', parent: 'if1' },
        { id: 'cond2', kind: 'context', name: 'GAS' },
        { id: 'ret', kind: 'return', decoder: 'uint256', parent: 'if2' },
      ],
      edges: [
        edge('self', 'out', 'call', 'arg:0'),
        edge('cond1', 'out', 'if1', 'condition'),
        edge('cond2', 'out', 'if2', 'condition'),
        edge('call', 'result', 'ret', 'result'),
      ],
    });
    expect(validateProject(nestedDecoder)).toEqual([]);

    // Decoding ABOVE the call would read return data that no longer exists.
    const shallowerDecoder = project({
      nodes: [
        { id: 'self', kind: 'context', name: 'SELF' },
        { id: 'if1', kind: 'if' },
        { id: 'cond1', kind: 'context', name: 'GAS' },
        { id: 'call', kind: 'call', contractId: 'c1', signature: 'balanceOf(address)', parent: 'if1' },
        { id: 'ret', kind: 'return', decoder: 'uint256' },
      ],
      edges: [
        edge('self', 'out', 'call', 'arg:0'),
        edge('cond1', 'out', 'if1', 'condition'),
        edge('call', 'result', 'ret', 'result'),
      ],
    });
    expect(messages(shallowerDecoder).join()).toContain('cannot be used outside');
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
        { id: 'ret', kind: 'return', decoder: 'uint256' },
      ],
      edges: [edge('callA', 'result', 'ret', 'result'), edge('src', 'out', 'callA', 'arg:0')],
    });
    expect(stableOrder(p).order).toEqual(['callB', 'src', 'callA', 'ret']);
    expect(stableOrder(p).cycle).toEqual([]);
  });

  it('orders IF blocks after producers their body consumes, whatever the array order', () => {
    const nodes: GraphNode[] = [
      { id: 'if1', kind: 'if' },
      { id: 'cond', kind: 'context', name: 'GAS' },
      { id: 'self1', kind: 'context', name: 'SELF' },
      { id: 'call1', kind: 'call', contractId: 'c1', signature: 'balanceOf(address)' },
      { id: 'ret1', kind: 'return', decoder: 'uint256' },
      { id: 'dep', kind: 'call', contractId: 'c1', signature: 'deposit(uint256)', parent: 'if1' },
    ];
    const edges = [
      edge('cond', 'out', 'if1', 'condition'),
      edge('self1', 'out', 'call1', 'arg:0'),
      edge('call1', 'result', 'ret1', 'result'),
      edge('ret1', 'out', 'dep', 'arg:0'),
    ];
    const ifFirst = project({ nodes, edges });
    expect(validateProject(ifFirst)).toEqual([]);
    const { order, cycle } = stableOrder(ifFirst);
    expect(cycle).toEqual([]);
    expect(order.indexOf('ret1')).toBeLessThan(order.indexOf('if1'));
    expect(order.indexOf('call1')).toBeLessThan(order.indexOf('if1'));

    // reversing the array must not change the semantic order of the relevant pair
    const reversed = project({ nodes: [...nodes].reverse(), edges });
    const rev = stableOrder(reversed);
    expect(rev.cycle).toEqual([]);
    expect(rev.order.indexOf('ret1')).toBeLessThan(rev.order.indexOf('if1'));
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
