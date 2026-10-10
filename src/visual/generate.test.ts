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
    { id: 'lit1', kind: 'literal', literalType: 'uint', literal: '1000' },
    { id: 'cmp1', kind: 'binary', op: 'gt' },
    { id: 'if1', kind: 'if' },
    { id: 'gas1', kind: 'context', name: 'GAS' },
    { id: 'call2', kind: 'call', contractId: 'c2', signature: 'deposit(uint256)', parent: 'if1' },
  ];
  const edges: GraphEdge[] = [
    { id: 'e1', from: { node: 'self1', port: 'out' }, to: { node: 'call1', port: 'arg:0' } },
    { id: 'e3', from: { node: 'call1', port: 'out:0' }, to: { node: 'cmp1', port: 'lhs' } },
    { id: 'e4', from: { node: 'lit1', port: 'out' }, to: { node: 'cmp1', port: 'rhs' } },
    { id: 'e5', from: { node: 'cmp1', port: 'out' }, to: { node: 'if1', port: 'condition' } },
    { id: 'e7', from: { node: 'call1', port: 'out:0' }, to: { node: 'call2', port: 'arg:0' } },
  ];
  return {
    contracts: [
      { id: 'c1', name: 'TOKEN', address: USDC, functions: TOKEN_FNS },
      { id: 'c2', name: 'VAULT', address: VAULT, functions: VAULT_FNS },
    ],
    nodes, edges,
    positions: { call1: { x: 1, y: 2 } },
    frameSizes: {},
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

  it('decodes only the outputs an edge consumes, at their head offsets', () => {
    const project: VisualProject = {
      ...emptyProject(),
      contracts: [{
        id: 'c1', name: 'TOKEN', address: USDC,
        functions: [
          {
            signature: 'snapshot(address)', name: 'snapshot', inputs: ['address'],
            outputs: ['uint256', 'bytes32'], mutability: 'view',
            outputNames: ['total', 'root'],
          },
          { signature: 'store(uint256)', name: 'store', inputs: ['bytes32'], outputs: [], mutability: 'nonpayable' },
        ],
      }],
      nodes: [
        { id: 'call1', kind: 'call', contractId: 'c1', signature: 'snapshot(address)' },
        { id: 'self1', kind: 'context', name: 'SELF' },
        { id: 'storeA', kind: 'call', contractId: 'c1', signature: 'store(uint256)' },
      ],
      edges: [
        { id: 'e1', from: { node: 'self1', port: 'out' }, to: { node: 'call1', port: 'arg:0' } },
        { id: 'e2', from: { node: 'call1', port: 'out:1' }, to: { node: 'storeA', port: 'arg:0' } },
      ],
    };
    // Only output 1 (root) is consumed, so only its word is decoded.
    const source = generateVisualSource(project);
    expect(source).toContain('const snapshot_call1 = p.staticCall(c_TOKEN, encodeCall("snapshot(address)", [SELF])).word(32);');
    expect(source).not.toContain('uint256()');
    expect(() => compileSource(source)).not.toThrow();
  });

  it('decodes each used output of a multi-output call exactly once', () => {
    const project: VisualProject = {
      ...emptyProject(),
      contracts: [{
        id: 'c1', name: 'TOKEN', address: USDC,
        functions: [
          { signature: 'snapshot(address)', name: 'snapshot', inputs: ['address'], outputs: ['uint256', 'bytes32'], mutability: 'view' },
          { signature: 'store(uint256)', name: 'store', inputs: ['bytes32'], outputs: [], mutability: 'nonpayable' },
        ],
      }],
      nodes: [
        { id: 'call1', kind: 'call', contractId: 'c1', signature: 'snapshot(address)' },
        { id: 'self1', kind: 'context', name: 'SELF' },
        { id: 'storeA', kind: 'call', contractId: 'c1', signature: 'store(uint256)' },
        { id: 'storeB', kind: 'call', contractId: 'c1', signature: 'store(uint256)' },
        { id: 'storeC', kind: 'call', contractId: 'c1', signature: 'store(uint256)' },
      ],
      edges: [
        { id: 'e1', from: { node: 'self1', port: 'out' }, to: { node: 'call1', port: 'arg:0' } },
        { id: 'e2', from: { node: 'call1', port: 'out:0' }, to: { node: 'storeA', port: 'arg:0' } },
        { id: 'e3', from: { node: 'call1', port: 'out:1' }, to: { node: 'storeB', port: 'arg:0' } },
        // fan-out: the same output feeding a third consumer reuses the name
        { id: 'e4', from: { node: 'call1', port: 'out:0' }, to: { node: 'storeC', port: 'arg:0' } },
      ],
    };
    const source = generateVisualSource(project);
    expect(source).toContain('const r_call1 = p.staticCall(c_TOKEN, encodeCall("snapshot(address)", [SELF]));');
    expect(source).toContain('const snapshot_call1_out0 = r_call1.uint256();');
    expect(source).toContain('const snapshot_call1_out1 = r_call1.word(32);');
    // one call, one decode per used output, regardless of consumer count
    expect(source.split('\n').filter(l => l.includes('staticCall'))).toHaveLength(1);
    expect(source.split('\n').filter(l => l.includes('snapshot_call1_out0 ='))).toHaveLength(1);
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
      { id: 'call2', kind: 'call', contractId: 'c2', signature: 'deposit(uint256)', parent: 'if1' },
    ];
    const edges: GraphEdge[] = [
      { id: 'e1', from: { node: 'gas1', port: 'out' }, to: { node: 'cmp1', port: 'lhs' } },
      { id: 'e2', from: { node: 'lit1', port: 'out' }, to: { node: 'cmp1', port: 'rhs' } },
      { id: 'e3', from: { node: 'cmp1', port: 'out' }, to: { node: 'if1', port: 'condition' } },
      { id: 'e4', from: { node: 'self1', port: 'out' }, to: { node: 'call1', port: 'arg:0' } },
      { id: 'e6', from: { node: 'call1', port: 'out:0' }, to: { node: 'call2', port: 'arg:0' } },
    ];
    const base: VisualProject = {
      contracts: [
        { id: 'c1', name: 'TOKEN', address: USDC, functions: TOKEN_FNS },
        { id: 'c2', name: 'VAULT', address: VAULT, functions: VAULT_FNS },
      ],
      nodes, edges, positions: {}, frameSizes: {},
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

describe('presentation cannot reach lowering', () => {
  it('frame sizes and positions never change the generated source', () => {
    const base = starterLikeProject();
    const twin = {
      ...base,
      positions: Object.fromEntries(base.nodes.map((n, i) => [n.id, { x: 7000 - i * 131, y: i * 91 }])),
      frameSizes: { if1: { width: 1600, height: 900 }, ifAbsent: { width: 10, height: 10 } },
    };
    expect(generateVisualSource(twin)).toBe(generateVisualSource(base));
  });
});

describe('ELSE generation', () => {
  function elseProject(withElse = true): VisualProject {
    const nodes: GraphNode[] = [
      { id: 'self1', kind: 'context', name: 'SELF' },
      { id: 'if1', kind: 'if', ...(withElse ? { hasElse: true } : {}) },
      { id: 't1', kind: 'call', contractId: 'c1', signature: 'balanceOf(address)', parent: 'if1', branch: 'then' },
      { id: 'cmp1', kind: 'binary', op: 'gt' },
      { id: 'lit1', kind: 'literal', literalType: 'uint', literal: '5' },
      ...(withElse
        ? [{ id: 'e1', kind: 'call', contractId: 'c1', signature: 'balanceOf(address)', parent: 'if1', branch: 'else' } as GraphNode]
        : []),
    ];
    const edges: GraphEdge[] = [
      { id: 'g1', from: { node: 'self1', port: 'out' }, to: { node: 'cmp1', port: 'lhs' } },
      { id: 'g2', from: { node: 'lit1', port: 'out' }, to: { node: 'cmp1', port: 'rhs' } },
      { id: 'g3', from: { node: 'cmp1', port: 'out' }, to: { node: 'if1', port: 'condition' } },
      { id: 'g4', from: { node: 'self1', port: 'out' }, to: { node: 't1', port: 'arg:0' } },
      ...(withElse
        ? [{ id: 'g5', from: { node: 'self1', port: 'out' }, to: { node: 'e1', port: 'arg:0' } } as GraphEdge]
        : []),
    ];
    return {
      contracts: [{ id: 'c1', name: 'Token', address: USDC, functions: TOKEN_FNS }],
      nodes, edges,
      positions: { self1: { x: 0, y: 0 }, if1: { x: 0, y: 100 }, t1: { x: 30, y: 160 }, e1: { x: 470, y: 160 }, cmp1: { x: 0, y: 40 }, lit1: { x: 220, y: 40 } },
      frameSizes: { if1: { width: 800, height: 300 } },
    };
  }

  it('emits the two-argument form when ELSE is absent', () => {
    const src = generateVisualSource(elseProject(false));
    expect(src).toContain('p.if((');
    expect(src.match(/=> \{\}, \(\) => \{\}\);/g)).toBeNull();
    const body = src.split('p.if(')[1];
    expect(body.indexOf(') => {')).toBeGreaterThan(-1);
    expect(src).not.toMatch(/\}, \(\) =>/);
  });

  it('emits the three-argument form with distinct branch bodies', () => {
    const src = generateVisualSource(elseProject());
    const elseArrow = src.search(/\}, \(\) => \{/);
    expect(elseArrow).toBeGreaterThan(-1);
    const open = src.indexOf('p.if(');
    const callT = src.indexOf('balanceOf(address)', open);
    const callE = src.indexOf('balanceOf(address)', elseArrow);
    expect(callT).toBeGreaterThan(open);
    expect(callT).toBeLessThan(elseArrow);
    expect(callE).toBeGreaterThan(elseArrow);
    expect(() => compileSource(src)).not.toThrow();
  });

  it('keeps decoded call outputs inside their branch body', () => {
    const p = elseProject();
    const used = (id: string): VisualProject => ({
      ...p,
      contracts: [...p.contracts, { id: 'c2', name: 'Vault', address: VAULT, functions: VAULT_FNS }],
      edges: [...p.edges, { id: 'x1', from: { node: id, port: 'out:0' }, to: { node: id === 't1' ? 't2' : 'e2', port: 'arg:0' } }],
      nodes: [...p.nodes, { id: id === 't1' ? 't2' : 'e2', kind: 'call', contractId: 'c2', signature: 'deposit(uint256)', parent: 'if1', branch: id === 't1' ? 'then' : 'else' }],
    });
    const thenSrc = generateVisualSource(used('t1'));
    const split = thenSrc.search(/\}, \(\) => \{/);
    expect(thenSrc.indexOf('const balanceOf_t1')).toBeLessThan(split);
    expect(thenSrc.indexOf('encodeCall("deposit(uint256)"')).toBeLessThan(split);
    const elseSrc = generateVisualSource(used('e1'));
    const split2 = elseSrc.search(/\}, \(\) => \{/);
    expect(elseSrc.indexOf('const balanceOf_e1')).toBeGreaterThan(split2);
    expect(elseSrc.indexOf('encodeCall("deposit(uint256)"')).toBeGreaterThan(split2);
    expect(() => compileSource(thenSrc)).not.toThrow();
    expect(() => compileSource(elseSrc)).not.toThrow();
  });

  it('emits an empty ELSE deterministically and compiles', () => {
    const base = elseProject();
    const p: VisualProject = {
      ...base,
      nodes: base.nodes.filter(n => !(n.parent === 'if1' && n.branch === 'else')),
      edges: base.edges.filter(e => e.from.node !== 'e1' && e.to.node !== 'e1'),
    };
    const src = generateVisualSource(p);
    expect(src).toMatch(/\}, \(\) => \{\}\);/);
    expect(generateVisualSource(p)).toBe(src);
    expect(() => compileSource(src)).not.toThrow();
  });

  it('recurses through nested IF/ELSE naturally and is presentation-independent', () => {
    const base = elseProject();
    const nested: VisualProject = {
      ...base,
      nodes: [
        ...base.nodes,
        { id: 'if2', kind: 'if', parent: 'if1', branch: 'else', hasElse: true },
        { id: 'e2', kind: 'call', contractId: 'c1', signature: 'balanceOf(address)', parent: 'if2', branch: 'else' },
        { id: 'lit2', kind: 'literal', literalType: 'address', literal: USDC },
      ],
      edges: [
        ...base.edges,
        { id: 'n1', from: { node: 'lit2', port: 'out' }, to: { node: 'e2', port: 'arg:0' } },
        { id: 'n2', from: { node: 'cmp1', port: 'out' }, to: { node: 'if2', port: 'condition' } },
      ],
      positions: { ...base.positions, if2: { x: 470, y: 240 }, e2: { x: 850, y: 300 }, lit2: { x: 0, y: -80 } },
    };
    const src = generateVisualSource(nested);
    expect(src.match(/p\.if\(/g)?.length).toBe(2);
    const inner = src.slice(src.indexOf('p.if(', src.indexOf('p.if(') + 1));
    expect(inner).toMatch(/\}, \(\) => \{/);
    expect(() => compileSource(src)).not.toThrow();
    const moved: VisualProject = {
      ...nested,
      positions: Object.fromEntries(Object.entries(nested.positions).map(([k, v]) => [k, { x: v.x + 1234, y: v.y - 777 }])),
      frameSizes: { if1: { width: 9999, height: 1234 }, if2: { width: 777, height: 321 } },
    };
    expect(generateVisualSource(moved)).toBe(src);
  });
});

describe('balance, hash, and guard nodes', () => {
  function graph(nodes: GraphNode[], edges: GraphEdge[]): VisualProject {
    return {
      ...emptyProject(),
      contracts: [{ id: 'c1', name: 'VAULT', address: VAULT, functions: VAULT_FNS }],
      nodes, edges,
    };
  }

  function guardGraph(): VisualProject {
    return graph([
      { id: 'bal1', kind: 'balance' },
      { id: 'self1', kind: 'context', name: 'SELF' },
      { id: 'lit1', kind: 'literal', literalType: 'uint', literal: '1000' },
      { id: 'cmp1', kind: 'binary', op: 'gt' },
      { id: 'guard1', kind: 'guard' },
    ], [
      { id: 'e1', from: { node: 'self1', port: 'out' }, to: { node: 'bal1', port: 'address' } },
      { id: 'e2', from: { node: 'bal1', port: 'out' }, to: { node: 'cmp1', port: 'lhs' } },
      { id: 'e3', from: { node: 'lit1', port: 'out' }, to: { node: 'cmp1', port: 'rhs' } },
      { id: 'e4', from: { node: 'cmp1', port: 'out' }, to: { node: 'guard1', port: 'condition' } },
    ]);
  }

  it('inlines the balance and lowers the guard to revertUnless', () => {
    const source = generateVisualSource(guardGraph());
    expect(source).toContain('p.revertUnless((p.balance(SELF)).gt(1000n));');
    expect(compileSource(source).program).toBe(compileSource(`const p = createProgram();
p.revertUnless((p.balance(SELF)).gt(1000n));
return p;`).program);
  });

  it('re-reads a balance at every site that consumes it', () => {
    const project = graph([
      { id: 'bal1', kind: 'balance' },
      { id: 'self1', kind: 'context', name: 'SELF' },
      { id: 'call1', kind: 'call', contractId: 'c1', signature: 'deposit(uint256)' },
      { id: 'call2', kind: 'call', contractId: 'c1', signature: 'deposit(uint256)' },
    ], [
      { id: 'e1', from: { node: 'self1', port: 'out' }, to: { node: 'bal1', port: 'address' } },
      { id: 'e2', from: { node: 'bal1', port: 'out' }, to: { node: 'call1', port: 'arg:0' } },
      { id: 'e3', from: { node: 'bal1', port: 'out' }, to: { node: 'call2', port: 'arg:0' } },
    ]);
    const output = compileSource(generateVisualSource(project));
    expect(output.disassembly.filter(line => line.includes('BALANCE'))).toHaveLength(2);
  });

  it('keeps canvas position and node order out of a balance output', () => {
    const base = guardGraph();
    const moved: VisualProject = {
      ...base,
      positions: Object.fromEntries(base.nodes.map((n, i) => [n.id, { x: i * 999, y: -i * 4321 }])),
    };
    expect(generateVisualSource(moved)).toBe(generateVisualSource(base));
    const reversed: VisualProject = { ...base, nodes: [...base.nodes].reverse() };
    expect(generateVisualSource(reversed)).toBe(generateVisualSource(base));
  });

  it('refuses a balance nothing reads and a guard without a condition', () => {
    const unread = graph([
      { id: 'bal1', kind: 'balance' },
      { id: 'self1', kind: 'context', name: 'SELF' },
    ], [{ id: 'e1', from: { node: 'self1', port: 'out' }, to: { node: 'bal1', port: 'address' } }]);
    expect(() => generateVisualSource(unread)).toThrow(/Balance is never read/);
    const bare = graph([{ id: 'guard1', kind: 'guard' }], []);
    expect(() => generateVisualSource(bare)).toThrow(/unless is missing an input/);
  });

  it('hashes once and shares the digest, like a bound constant in source mode', () => {
    const project = graph([
      { id: 'hash1', kind: 'keccak', data: '0xdeadbeef' },
      { id: 'call1', kind: 'call', contractId: 'c1', signature: 'deposit(uint256)' },
      { id: 'call2', kind: 'call', contractId: 'c1', signature: 'deposit(uint256)' },
    ], [
      { id: 'e1', from: { node: 'hash1', port: 'out' }, to: { node: 'call1', port: 'arg:0' } },
      { id: 'e2', from: { node: 'hash1', port: 'out' }, to: { node: 'call2', port: 'arg:0' } },
    ]);
    const source = generateVisualSource(project);
    expect(source.match(/p\.keccak\(/g)).toHaveLength(1);
    expect(source).toMatch(/^const \w+ = p\.keccak\("0xdeadbeef"\);$/m);
    const output = compileSource(source);
    expect(output.disassembly.filter(line => line.includes('KECCAK256'))).toHaveLength(1);
    expect(output.program).toBe(compileSource(`const p = createProgram();
const h = p.keccak("0xdeadbeef");
const v = "${VAULT}";
p.call(v, encodeCall("deposit(uint256)", [h]));
p.call(v, encodeCall("deposit(uint256)", [h]));
return p;`).program);
  });

  it('emits a hash even when nothing consumes it, because it occupies a slot', () => {
    const source = generateVisualSource(graph([{ id: 'hash1', kind: 'keccak', data: '0x' }], []));
    expect(source).toContain('p.keccak("0x")');
    expect(compileSource(source).program).toBe(compileSource('const p = createProgram();\nconst h = p.keccak("0x");\nreturn p;').program);
  });

  it('refuses hash data that is not byte data', () => {
    const project = graph([{ id: 'hash1', kind: 'keccak', data: 'nope' }], []);
    expect(() => generateVisualSource(project)).toThrow(/Hash data "nope" is not 0x-prefixed/);
  });

  it('lowers statements inside the branch that owns them', () => {
    const project: VisualProject = {
      ...graph([
        { id: 'gas1', kind: 'context', name: 'GAS' },
        { id: 'lit1', kind: 'literal', literalType: 'uint', literal: '1' },
        { id: 'cmp1', kind: 'binary', op: 'gt' },
        { id: 'if1', kind: 'if', hasElse: true },
        { id: 'hash1', kind: 'keccak', data: '0x01', parent: 'if1', branch: 'then' },
        { id: 'call1', kind: 'call', contractId: 'c1', signature: 'deposit(uint256)', parent: 'if1', branch: 'then' },
        { id: 'guard1', kind: 'guard', parent: 'if1', branch: 'else' },
      ], [
        { id: 'e1', from: { node: 'gas1', port: 'out' }, to: { node: 'cmp1', port: 'lhs' } },
        { id: 'e2', from: { node: 'lit1', port: 'out' }, to: { node: 'cmp1', port: 'rhs' } },
        { id: 'e3', from: { node: 'cmp1', port: 'out' }, to: { node: 'if1', port: 'condition' } },
        { id: 'e4', from: { node: 'hash1', port: 'out' }, to: { node: 'call1', port: 'arg:0' } },
        { id: 'e5', from: { node: 'cmp1', port: 'out' }, to: { node: 'guard1', port: 'condition' } },
      ]),
      frameSizes: {},
    };
    const source = generateVisualSource(project);
    const thenBody = source.slice(source.indexOf('p.if('), source.indexOf('}, () => {'));
    const elseBody = source.slice(source.indexOf('}, () => {'));
    expect(thenBody).toContain('p.keccak("0x01")');
    expect(elseBody).toContain('p.revertUnless(');
    expect(() => compileSource(source)).not.toThrow();
  });

  it('never lets a branch-local digest or guard escape its block', () => {
    const project = graph([
      { id: 'gas1', kind: 'context', name: 'GAS' },
      { id: 'lit1', kind: 'literal', literalType: 'uint', literal: '1' },
      { id: 'cmp1', kind: 'binary', op: 'gt' },
      { id: 'if1', kind: 'if' },
      { id: 'hash1', kind: 'keccak', data: '0x01', parent: 'if1', branch: 'then' },
      { id: 'call1', kind: 'call', contractId: 'c1', signature: 'deposit(uint256)' },
    ], [
      { id: 'e1', from: { node: 'gas1', port: 'out' }, to: { node: 'cmp1', port: 'lhs' } },
      { id: 'e2', from: { node: 'lit1', port: 'out' }, to: { node: 'cmp1', port: 'rhs' } },
      { id: 'e3', from: { node: 'cmp1', port: 'out' }, to: { node: 'if1', port: 'condition' } },
      { id: 'e4', from: { node: 'hash1', port: 'out' }, to: { node: 'call1', port: 'arg:0' } },
    ]);
    expect(() => generateVisualSource(project)).toThrow(/cannot be used outside that block/);
  });
});

describe('send and raw call nodes', () => {
  const TARGET = '0x4444444444444444444444444444444444444444';

  function graph(nodes: GraphNode[], edges: GraphEdge[]): VisualProject {
    return { ...emptyProject(), contracts: [{ id: 'c1', name: 'VAULT', address: VAULT, functions: VAULT_FNS }], nodes, edges };
  }

  function addressLiteral(id: string, literal: string): GraphNode {
    return { id, kind: 'literal', literalType: 'address', literal };
  }

  it('lowers a send to a value-carrying call with empty calldata', () => {
    const project = graph([
      { id: 'send1', kind: 'send' },
      addressLiteral('addr1', TARGET),
      { id: 'lit1', kind: 'literal', literalType: 'uint', literal: '1000' },
    ], [
      { id: 'e1', from: { node: 'addr1', port: 'out' }, to: { node: 'send1', port: 'address' } },
      { id: 'e2', from: { node: 'lit1', port: 'out' }, to: { node: 'send1', port: 'value' } },
    ]);
    const source = generateVisualSource(project);
    expect(source).toContain(`p.call("${TARGET}", rawCalldata("0x"), 1000n);`);
    expect(compileSource(source).program).toBe(compileSource(`const p = createProgram();
p.call("${TARGET}", rawCalldata("0x"), 1000n);
return p;`).program);
  });

  it('sends to a fed address, not just a literal one', () => {
    const project = graph([
      { id: 'send1', kind: 'send' },
      { id: 'caller1', kind: 'context', name: 'CALLER' },
      { id: 'lit1', kind: 'literal', literalType: 'uint', literal: '1' },
    ], [
      { id: 'e1', from: { node: 'caller1', port: 'out' }, to: { node: 'send1', port: 'address' } },
      { id: 'e2', from: { node: 'lit1', port: 'out' }, to: { node: 'send1', port: 'value' } },
    ]);
    expect(generateVisualSource(project)).toContain('p.call(CALLER, rawCalldata("0x"), 1n);');
  });

  it('refuses a send with no value — an empty transfer is a mistake, not a call', () => {
    const project = graph([
      { id: 'send1', kind: 'send' },
      addressLiteral('addr1', TARGET),
    ], [
      { id: 'e1', from: { node: 'addr1', port: 'out' }, to: { node: 'send1', port: 'address' } },
    ]);
    expect(() => generateVisualSource(project)).toThrow(/value \(wei\) is missing an input/);
  });

  it('lowers a raw call and omits the third argument when nothing feeds value', () => {
    const project = graph([
      { id: 'raw1', kind: 'rawcall', calldata: '0x12345678' },
      addressLiteral('addr1', TARGET),
    ], [
      { id: 'e1', from: { node: 'addr1', port: 'out' }, to: { node: 'raw1', port: 'address' } },
    ]);
    const source = generateVisualSource(project);
    expect(source).toContain(`p.call("${TARGET}", rawCalldata("0x12345678"));`);
    expect(compileSource(source).program).toBe(compileSource(`const p = createProgram();
p.call("${TARGET}", rawCalldata("0x12345678"));
return p;`).program);
  });

  it('carries value with a raw call when the port is fed', () => {
    const project = graph([
      { id: 'raw1', kind: 'rawcall', calldata: '0xABCD' },
      addressLiteral('addr1', TARGET),
      { id: 'lit1', kind: 'literal', literalType: 'uint', literal: '7' },
    ], [
      { id: 'e1', from: { node: 'addr1', port: 'out' }, to: { node: 'raw1', port: 'address' } },
      { id: 'e2', from: { node: 'lit1', port: 'out' }, to: { node: 'raw1', port: 'value' } },
    ]);
    const source = generateVisualSource(project);
    // Calldata text is case-normalized at lowering, like every other literal.
    expect(source).toContain(`p.call("${TARGET}", rawCalldata("0xabcd"), 7n);`);
    expect(compileSource(source).program).toBe(compileSource(`const p = createProgram();
p.call("${TARGET}", rawCalldata("0xabcd"), 7n);
return p;`).program);
  });

  it('refuses raw calldata that is not byte data', () => {
    const project = graph([
      { id: 'raw1', kind: 'rawcall', calldata: 'nope' },
      addressLiteral('addr1', TARGET),
    ], [
      { id: 'e1', from: { node: 'addr1', port: 'out' }, to: { node: 'raw1', port: 'address' } },
    ]);
    expect(() => generateVisualSource(project)).toThrow(/Calldata "nope" is not 0x-prefixed/);
  });

  it('lowers sends and raw calls inside the branch that owns them', () => {
    const project = graph([
      { id: 'gas1', kind: 'context', name: 'GAS' },
      { id: 'lit1', kind: 'literal', literalType: 'uint', literal: '1' },
      { id: 'cmp1', kind: 'binary', op: 'gt' },
      { id: 'if1', kind: 'if', hasElse: true },
      { id: 'send1', kind: 'send', parent: 'if1', branch: 'then' },
      { id: 'addr1', kind: 'literal', literalType: 'address', literal: TARGET, parent: 'if1', branch: 'then' },
      { id: 'lit2', kind: 'literal', literalType: 'uint', literal: '5', parent: 'if1', branch: 'then' },
      { id: 'raw1', kind: 'rawcall', calldata: '0x', parent: 'if1', branch: 'else' },
      { id: 'self1', kind: 'context', name: 'SELF' },
    ], [
      { id: 'e1', from: { node: 'gas1', port: 'out' }, to: { node: 'cmp1', port: 'lhs' } },
      { id: 'e2', from: { node: 'lit1', port: 'out' }, to: { node: 'cmp1', port: 'rhs' } },
      { id: 'e3', from: { node: 'cmp1', port: 'out' }, to: { node: 'if1', port: 'condition' } },
      { id: 'e4', from: { node: 'addr1', port: 'out' }, to: { node: 'send1', port: 'address' } },
      { id: 'e5', from: { node: 'lit2', port: 'out' }, to: { node: 'send1', port: 'value' } },
      { id: 'e6', from: { node: 'self1', port: 'out' }, to: { node: 'raw1', port: 'address' } },
    ]);
    const source = generateVisualSource(project);
    const thenBody = source.slice(source.indexOf('p.if('), source.indexOf('}, () => {'));
    const elseBody = source.slice(source.indexOf('}, () => {'));
    expect(thenBody).toContain(`p.call("${TARGET}", rawCalldata("0x"), 5n);`);
    expect(elseBody).toContain('p.call(SELF, rawCalldata("0x"));');
    expect(() => compileSource(source)).not.toThrow();
  });
});
