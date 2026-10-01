import { describe, expect, it } from 'vitest';
import { STARTER_SOURCE } from '../editor/examples';
import { compileSource } from '../compile/run';
import { emptyProject, type ContractFunction, type GraphEdge, type GraphNode, type VisualProject } from './model';
import { generateVisualSource } from './generate';

const USDC = '0x1111111111111111111111111111111111111111';
const VAULT = '0x2222222222222222222222222222222222222222';

const TOKEN_FNS: ContractFunction[] = [{
  signature: 'balanceOf(address)', name: 'balanceOf', inputs: ['address'], outputs: ['uint256'], mutability: 'view',
}];
const VAULT_FNS: ContractFunction[] = [
  { signature: 'deposit(uint256)', name: 'deposit', inputs: ['uint256'], outputs: [], mutability: 'nonpayable' },
  { signature: 'stake()', name: 'stake', inputs: [], outputs: [], mutability: 'payable' },
];

function starterLikeProject(): VisualProject {
  const nodes: GraphNode[] = [
    { id: 'call1', kind: 'call', contractId: 'c1', signature: 'balanceOf(address)' },
    { id: 'self1', kind: 'context', name: 'SELF' },
    { id: 'ret1', kind: 'return', decoder: 'uint256' },
    { id: 'lit1', kind: 'literal', literalType: 'uint', literal: '1000' },
    { id: 'cmp1', kind: 'binary', op: 'gt' },
    { id: 'if1', kind: 'if' },
    { id: 'gas1', kind: 'context', name: 'GAS' },
    { id: 'call2', kind: 'call', contractId: 'c2', signature: 'deposit(uint256)', parent: 'if1' },
  ];
  const edges: GraphEdge[] = [
    { id: 'e1', from: { node: 'self1', port: 'out' }, to: { node: 'call1', port: 'arg:0' } },
    { id: 'e2', from: { node: 'call1', port: 'result' }, to: { node: 'ret1', port: 'result' } },
    { id: 'e3', from: { node: 'ret1', port: 'out' }, to: { node: 'cmp1', port: 'lhs' } },
    { id: 'e4', from: { node: 'lit1', port: 'out' }, to: { node: 'cmp1', port: 'rhs' } },
    { id: 'e5', from: { node: 'cmp1', port: 'out' }, to: { node: 'if1', port: 'condition' } },
  ];
  edges.push({ id: 'e7', from: { node: 'ret1', port: 'out' }, to: { node: 'call2', port: 'arg:0' } });
  return {
    contracts: [
      { id: 'c1', name: 'TOKEN', address: USDC, functions: TOKEN_FNS },
      { id: 'c2', name: 'VAULT', address: VAULT, functions: VAULT_FNS },
    ],
    nodes, edges,
    positions: { call1: { x: 1, y: 2 } },
  };
}

describe('generateVisualSource', () => {
  it('renders the starter example shape', () => {
    const source = generateVisualSource(starterLikeProject());
    expect(source).toBe(`const p = createProgram();

const c_TOKEN = "${USDC}";

const c_VAULT = "${VAULT}";

const balanceOf_call1 = p.staticCall(c_TOKEN, encodeCall("balanceOf(address)", [SELF])).uint256();

p.if((balanceOf_call1).gt(1000n), () => {
  p.call(c_VAULT, encodeCall("deposit(uint256)", [balanceOf_call1]));
});

return p;`);
  });

  it('compiles the graph to the same bytes as the hand-written starter source', () => {
    const fromGraph = compileSource(generateVisualSource(starterLikeProject()));
    const fromSource = compileSource(STARTER_SOURCE);
    expect(fromGraph.program).toBe(fromSource.program);
    expect(fromGraph.programHash).toBe(fromSource.programHash);
  });

  it('ignores node positions entirely', () => {
    const base = starterLikeProject();
    const moved = { ...base, positions: Object.fromEntries(base.nodes.map((n, i) => [n.id, { x: i * 999, y: -i }])) };
    expect(generateVisualSource(moved)).toBe(generateVisualSource(base));
  });

  it('honors creation order for independent calls', () => {
    const a: VisualProject = {
      ...emptyProject(),
      contracts: [
        { id: 'c1', name: 'TOKEN', address: USDC, functions: [{ signature: 'snapshot()', name: 'snapshot', inputs: [], outputs: ['uint256'], mutability: 'view' }] },
        { id: 'c2', name: 'VAULT', address: VAULT, functions: VAULT_FNS },
      ],
      nodes: [
        { id: 'callA', kind: 'call', contractId: 'c1', signature: 'snapshot()' },
        { id: 'callB', kind: 'call', contractId: 'c2', signature: 'stake()' },
      ],
      edges: [],
    };
    const b: VisualProject = { ...a, nodes: [a.nodes[1], a.nodes[0]] };
    const [firstA] = generateVisualSource(a).split('\n').filter(l => l.includes('encodeCall'));
    const [firstB] = generateVisualSource(b).split('\n').filter(l => l.includes('encodeCall'));
    expect(firstA).toContain('snapshot');
    expect(firstB).toContain('stake');
    expect(generateVisualSource(a)).not.toBe(generateVisualSource(b));
  });

  it('emits decoder handles for multi-word results', () => {
    const project: VisualProject = {
      ...emptyProject(),
      contracts: [{
        id: 'c1', name: 'TOKEN', address: USDC,
        functions: [{ signature: 'snapshot(address)', name: 'snapshot', inputs: ['address'], outputs: ['uint256', 'bytes32'], mutability: 'view' }],
      }],
      nodes: [
        { id: 'call1', kind: 'call', contractId: 'c1', signature: 'snapshot(address)' },
        { id: 'self1', kind: 'context', name: 'SELF' },
        { id: 'ret1', kind: 'return', decoder: 'uint256' },
        { id: 'ret2', kind: 'return', decoder: 'word', offset: 32 },
      ],
      edges: [
        { id: 'e1', from: { node: 'self1', port: 'out' }, to: { node: 'call1', port: 'arg:0' } },
        { id: 'e2', from: { node: 'call1', port: 'result' }, to: { node: 'ret1', port: 'result' } },
        { id: 'e3', from: { node: 'call1', port: 'result' }, to: { node: 'ret2', port: 'result' } },
      ],
    };
    const source = generateVisualSource(project);
    expect(source).toContain('const r_call1 = p.staticCall(c_TOKEN, encodeCall("snapshot(address)", [SELF]));');
    expect(source).toContain('const snapshot_uint256_ret1 = r_call1.uint256();');
    expect(source).toContain('const snapshot_w1_ret2 = r_call1.word(32);');
    expect(() => compileSource(source)).not.toThrow();
  });

  it('supports payable calls with and without a value port', () => {
    const base: VisualProject = {
      ...emptyProject(),
      contracts: [{ id: 'c1', name: 'STAKING', address: USDC, functions: VAULT_FNS }],
      nodes: [{ id: 'call1', kind: 'call', contractId: 'c1', signature: 'stake()' }],
      edges: [],
    };
    expect(generateVisualSource(base)).toContain('p.call(c_STAKING, encodeCall("stake()"));');
    const withValue: VisualProject = {
      ...base,
      nodes: [...base.nodes, { id: 'lit1', kind: 'literal', literalType: 'uint', literal: '7' }],
      edges: [{ id: 'e1', from: { node: 'lit1', port: 'out' }, to: { node: 'call1', port: 'value' } }],
    };
    expect(generateVisualSource(withValue)).toContain('p.call(c_STAKING, encodeCall("stake()"), 7n);');
    expect(() => compileSource(generateVisualSource(withValue))).not.toThrow();
  });

  it('generates valid source for literal types', () => {
    const project: VisualProject = {
      ...emptyProject(),
      contracts: [{
        id: 'c1', name: 'T', address: USDC,
        functions: [{ signature: 'set(address,bool,uint256)', name: 'set', inputs: ['address', 'bool', 'uint256'], outputs: [], mutability: 'nonpayable' }],
      }],
      nodes: [
        { id: 'a', kind: 'literal', literalType: 'address', literal: VAULT },
        { id: 'b', kind: 'literal', literalType: 'bool', literal: 'true' },
        { id: 'c', kind: 'literal', literalType: 'uint', literal: '0xff' },
        { id: 'call1', kind: 'call', contractId: 'c1', signature: 'set(address,bool,uint256)' },
      ],
      edges: [
        { id: 'e1', from: { node: 'a', port: 'out' }, to: { node: 'call1', port: 'arg:0' } },
        { id: 'e2', from: { node: 'b', port: 'out' }, to: { node: 'call1', port: 'arg:1' } },
        { id: 'e3', from: { node: 'c', port: 'out' }, to: { node: 'call1', port: 'arg:2' } },
      ],
    };
    const source = generateVisualSource(project);
    expect(source).toContain(`p.call(c_T, encodeCall("set(address,bool,uint256)", ["${VAULT}", true, 255n]));`);
    expect(() => compileSource(source)).not.toThrow();
  });

  it('nests IF blocks with the authoring shape', () => {
    const project: VisualProject = {
      ...emptyProject(),
      contracts: [{ id: 'c1', name: 'V', address: VAULT, functions: VAULT_FNS }],
      nodes: [
        { id: 'gas1', kind: 'context', name: 'GAS' },
        { id: 'lit1', kind: 'literal', literalType: 'uint', literal: '10' },
        { id: 'cmp1', kind: 'binary', op: 'lt' },
        { id: 'if1', kind: 'if' },
        { id: 'lit2', kind: 'literal', literalType: 'uint', literal: '1' },
        { id: 'cmp2', kind: 'binary', op: 'eq' },
        { id: 'if2', kind: 'if', parent: 'if1' },
        { id: 'lit3', kind: 'literal', literalType: 'uint', literal: '5' },
        { id: 'call1', kind: 'call', contractId: 'c1', signature: 'deposit(uint256)', parent: 'if2' },
      ],
      edges: [
        { id: 'e1', from: { node: 'gas1', port: 'out' }, to: { node: 'cmp1', port: 'lhs' } },
        { id: 'e2', from: { node: 'lit1', port: 'out' }, to: { node: 'cmp1', port: 'rhs' } },
        { id: 'e3', from: { node: 'cmp1', port: 'out' }, to: { node: 'if1', port: 'condition' } },
        { id: 'e4', from: { node: 'gas1', port: 'out' }, to: { node: 'cmp2', port: 'lhs' } },
        { id: 'e5', from: { node: 'lit2', port: 'out' }, to: { node: 'cmp2', port: 'rhs' } },
        { id: 'e6', from: { node: 'cmp2', port: 'out' }, to: { node: 'if2', port: 'condition' } },
        { id: 'e7', from: { node: 'lit3', port: 'out' }, to: { node: 'call1', port: 'arg:0' } },
      ],
    };
    const source = generateVisualSource(project);
    expect(source).toContain(`p.if((GAS).lt(10n), () => {
  p.if((GAS).eq(1n), () => {
    p.call(c_V, encodeCall("deposit(uint256)", [5n]));
  });
});`);
    expect(() => compileSource(source)).not.toThrow();
  });

  it('inlines shared pure expressions at every consumption site', () => {
    const project: VisualProject = {
      ...emptyProject(),
      contracts: [{ id: 'c1', name: 'V', address: VAULT, functions: VAULT_FNS }],
      nodes: [
        { id: 'gas1', kind: 'context', name: 'GAS' },
        { id: 'lit1', kind: 'literal', literalType: 'uint', literal: '3' },
        { id: 'sum1', kind: 'binary', op: 'add' },
        { id: 'call1', kind: 'call', contractId: 'c1', signature: 'deposit(uint256)' },
        { id: 'call2', kind: 'call', contractId: 'c1', signature: 'deposit(uint256)' },
      ],
      edges: [
        { id: 'e1', from: { node: 'gas1', port: 'out' }, to: { node: 'sum1', port: 'lhs' } },
        { id: 'e2', from: { node: 'lit1', port: 'out' }, to: { node: 'sum1', port: 'rhs' } },
        { id: 'e3', from: { node: 'sum1', port: 'out' }, to: { node: 'call1', port: 'arg:0' } },
        { id: 'e4', from: { node: 'sum1', port: 'out' }, to: { node: 'call2', port: 'arg:0' } },
      ],
    };
    const source = generateVisualSource(project);
    const inline = '(GAS).add(3n)';
    expect(source.split('\n').filter(line => line.includes(inline))).toHaveLength(2);
    // Matches direct builder semantics: pure expression values re-emit per use.
    expect(() => compileSource(source)).not.toThrow();
  });

  it('compiles arithmetic with literal receivers on either side', () => {
    const project: VisualProject = {
      ...emptyProject(),
      contracts: [{ id: 'c1', name: 'V', address: VAULT, functions: VAULT_FNS }],
      nodes: [
        { id: 'lit1', kind: 'literal', literalType: 'uint', literal: '5' },
        { id: 'gas1', kind: 'context', name: 'GAS' },
        { id: 'sub1', kind: 'binary', op: 'sub' },
        { id: 'call1', kind: 'call', contractId: 'c1', signature: 'deposit(uint256)' },
      ],
      edges: [
        { id: 'e1', from: { node: 'lit1', port: 'out' }, to: { node: 'sub1', port: 'lhs' } },
        { id: 'e2', from: { node: 'gas1', port: 'out' }, to: { node: 'sub1', port: 'rhs' } },
        { id: 'e3', from: { node: 'sub1', port: 'out' }, to: { node: 'call1', port: 'arg:0' } },
      ],
    };
    const source = generateVisualSource(project);
    expect(source).toContain('(5n).sub(GAS)');
    expect(() => compileSource(source)).not.toThrow();
  });

  it('emits producers before IF blocks whose body consumes their results, in any node order', () => {
    const nodes: GraphNode[] = [
      { id: 'if1', kind: 'if' },
      { id: 'gas1', kind: 'context', name: 'GAS' },
      { id: 'lit1', kind: 'literal', literalType: 'uint', literal: '1000' },
      { id: 'cmp1', kind: 'binary', op: 'gt' },
      { id: 'call1', kind: 'call', contractId: 'c1', signature: 'balanceOf(address)' },
      { id: 'self1', kind: 'context', name: 'SELF' },
      { id: 'ret1', kind: 'return', decoder: 'uint256' },
      { id: 'call2', kind: 'call', contractId: 'c2', signature: 'deposit(uint256)', parent: 'if1' },
    ];
    const edges: GraphEdge[] = [
      { id: 'e1', from: { node: 'gas1', port: 'out' }, to: { node: 'cmp1', port: 'lhs' } },
      { id: 'e2', from: { node: 'lit1', port: 'out' }, to: { node: 'cmp1', port: 'rhs' } },
      { id: 'e3', from: { node: 'cmp1', port: 'out' }, to: { node: 'if1', port: 'condition' } },
      { id: 'e4', from: { node: 'self1', port: 'out' }, to: { node: 'call1', port: 'arg:0' } },
      { id: 'e5', from: { node: 'call1', port: 'result' }, to: { node: 'ret1', port: 'result' } },
      { id: 'e6', from: { node: 'ret1', port: 'out' }, to: { node: 'call2', port: 'arg:0' } },
    ];
    const base: VisualProject = {
      contracts: [
        { id: 'c1', name: 'TOKEN', address: USDC, functions: TOKEN_FNS },
        { id: 'c2', name: 'VAULT', address: VAULT, functions: VAULT_FNS },
      ],
      nodes, edges, positions: {},
    };
    const reversed: VisualProject = { ...base, nodes: [...nodes].reverse() };
    const fromGraph = generateVisualSource(base);
    const ifStatement = fromGraph.split('\n').findIndex(line => line.includes('p.if('));
    const callStatement = fromGraph.split('\n').findIndex(line => line.includes('staticCall'));
    expect(callStatement).toBeGreaterThanOrEqual(0);
    expect(callStatement).toBeLessThan(ifStatement);
    expect(() => compileSource(fromGraph)).not.toThrow();
    // array order must never change semantics
    expect(generateVisualSource(reversed)).toBe(fromGraph);
  });

  it('refuses invalid graphs with graph diagnostics', () => {
    const project: VisualProject = {
      ...emptyProject(),
      contracts: [],
      nodes: [{ id: 'call1', kind: 'call', contractId: 'nope', signature: 'x()' }],
      edges: [],
    };
    expect(() => generateVisualSource(project)).toThrowError(/missing contract/i);
  });
});
