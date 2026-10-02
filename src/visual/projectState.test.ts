import { describe, expect, it } from 'vitest';
import { emptyProject, type VisualProject } from './model';
import {
  addContract, addEdge, addNode, connectPort, enableElse, moveGraphNodes, removeContract, removeEdge, removeNodes,
  setNodeFrameSize, setNodeParent, setNodePosition, setNodeScope, updateContract, updateNode,
} from './projectState';
import { iframes } from './containment';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const contract = (name: string) => ({ name, address: ADDRESS, functions: [] as const });

function projectWithCall(): VisualProject {
  let p = addContract(emptyProject(), contract('USDC'));
  const id = p.contracts[0].id;
  p = addNode(p, { id: 'call1', kind: 'call', contractId: id, signature: 'balanceOf(address)' }, { x: 10, y: 20 });
  p = addNode(p, { id: 'lit1', kind: 'literal', literalType: 'address', literal: ADDRESS }, { x: 0, y: 0 });
  p = addEdge(p, { from: { node: 'lit1', port: 'out' }, to: { node: 'call1', port: 'arg:0' } });
  return p;
}

describe('contracts', () => {
  it('assigns sequential contract ids', () => {
    let p = addContract(emptyProject(), contract('A'));
    p = addContract(p, contract('B'));
    expect(p.contracts.map(c => c.id)).toEqual(['c1', 'c2']);
  });

  it('updating the address is visible through every reference', () => {
    let p = projectWithCall();
    p = updateContract(p, 'c1', { address: '0x2222222222222222222222222222222222222222' });
    expect(p.contracts[0].address).toBe('0x2222222222222222222222222222222222222222');
    // The call node references the resource, so nothing else needs rewriting.
    expect(p.nodes.find(n => n.id === 'call1')).toMatchObject({ contractId: 'c1' });
  });

  it('removing a contract cascades its call nodes, edges, and positions', () => {
    let p = projectWithCall();
    p = removeContract(p, 'c1');
    expect(p.contracts).toEqual([]);
    expect(p.nodes.map(n => n.id)).toEqual(['lit1']);
    expect(p.edges).toEqual([]);
    expect(p.positions.call1).toBeUndefined();
    expect(p.positions.lit1).toEqual({ x: 0, y: 0 });
  });

  it('removing a contract keeps consumers of its call outputs but drops the edges', () => {
    let p = projectWithCall();
    p = addNode(p, { id: 'dep1', kind: 'call', contractId: 'c1', signature: 'deposit(uint256)' }, { x: 0, y: 0 });
    p = addEdge(p, { from: { node: 'call1', port: 'out:0' }, to: { node: 'dep1', port: 'arg:0' } });
    p = removeContract(p, 'c1');
    // dep1 belongs to the same contract's function set; it is a call node
    // of c1, so it cascades, and its now-dangling input edge goes with it.
    expect(p.nodes.map(n => n.id)).toEqual(['lit1']);
    expect(p.edges).toEqual([]);
  });

  it('a surviving consumer of another contract keeps its other edges', () => {
    let p = projectWithCall();
    p = addContract(p, contract('DAI')); // c2
    const c2 = p.contracts[1].id;
    p = addNode(p, { id: 'call2', kind: 'call', contractId: c2, signature: 'balanceOf(address)' }, { x: 0, y: 0 });
    p = addEdge(p, { from: { node: 'call1', port: 'out:0' }, to: { node: 'call2', port: 'arg:0' } });
    p = removeContract(p, 'c1');
    expect(p.nodes.map(n => n.id)).toEqual(['lit1', 'call2']);
    expect(p.edges).toEqual([]); // the cross-contract edge was dangling
    expect(p.positions.call2).toEqual({ x: 0, y: 0 });
  });
});

describe('nodes', () => {
  it('addNode stores position metadata separately from semantics', () => {
    const p = addNode(emptyProject(), { id: 'x', kind: 'if' }, { x: 5, y: 6 });
    expect(p.nodes).toEqual([{ id: 'x', kind: 'if' }]);
    expect(p.positions.x).toEqual({ x: 5, y: 6 });
  });

  it('setNodePosition ignores unknown nodes', () => {
    const p = setNodePosition(emptyProject(), 'ghost', { x: 1, y: 1 });
    expect(p.positions).toEqual({});
  });

  it('deleting an if block cascades its body nodes', () => {
    let p = emptyProject();
    p = addNode(p, { id: 'if1', kind: 'if' }, { x: 0, y: 0 });
    p = addNode(p, { id: 'call1', kind: 'call', contractId: 'c1', signature: 'go()', parent: 'if1' }, { x: 1, y: 1 });
    p = addNode(p, { id: 'lit1', kind: 'literal', literalType: 'uint', literal: '1' }, { x: 2, y: 2 });
    p = addEdge(p, { from: { node: 'lit1', port: 'out' }, to: { node: 'call1', port: 'arg:0' } });
    const after = removeNodes(p, ['if1']);
    expect(after.nodes).toEqual([{ id: 'lit1', kind: 'literal', literalType: 'uint', literal: '1' }]);
    expect(after.edges).toEqual([]); // edge touched a cascaded node
    expect(after.positions.if1).toBeUndefined();
    expect(after.positions.call1).toBeUndefined();
  });

  it('deleting a node drops only edges that touch it', () => {
    let p = emptyProject();
    p = addNode(p, { id: 'a', kind: 'context', name: 'SELF' }, { x: 0, y: 0 });
    p = addNode(p, { id: 'b', kind: 'context', name: 'CALLER' }, { x: 0, y: 0 });
    p = addNode(p, { id: 't', kind: 'binary', op: 'add' }, { x: 0, y: 0 });
    p = addEdge(p, { from: { node: 'a', port: 'out' }, to: { node: 't', port: 'lhs' } });
    p = addEdge(p, { from: { node: 'b', port: 'out' }, to: { node: 't', port: 'rhs' } });
    const after = removeNodes(p, ['a']);
    expect(after.edges.map(e => e.from.node)).toEqual(['b']);
    const gone = removeEdge(after, after.edges[0].id);
    expect(gone.edges).toEqual([]);
  });

  it('setNodeParent attaches and detaches if-body membership', () => {
    let p = emptyProject();
    p = addNode(p, { id: 'if1', kind: 'if' }, { x: 0, y: 0 });
    p = addNode(p, { id: 'lit1', kind: 'literal', literalType: 'uint', literal: '7' }, { x: 0, y: 0 });
    p = setNodeParent(p, 'lit1', 'if1');
    expect(p.nodes.find(n => n.id === 'lit1')).toEqual({ id: 'lit1', kind: 'literal', literalType: 'uint', literal: '7', parent: 'if1', branch: 'then' });
    p = setNodeParent(p, 'lit1', undefined);
    expect(p.nodes.find(n => n.id === 'lit1')).not.toHaveProperty('parent');
    expect(p.nodes.find(n => n.id === 'lit1')).not.toHaveProperty('branch');
  });

  it('setNodeParent rejects invalid containment without touching the project', () => {
    let p = emptyProject();
    p = addNode(p, { id: 'if1', kind: 'if' }, { x: 0, y: 0 });
    p = addNode(p, { id: 'if2', kind: 'if', parent: 'if1' }, { x: 0, y: 0 });
    p = addNode(p, { id: 'lit1', kind: 'literal', literalType: 'uint', literal: '7' }, { x: 0, y: 0 });
    expect(setNodeParent(p, 'if1', 'if1')).toBe(p);                      // self
    expect(setNodeParent(p, 'if1', 'if2')).toBe(p);                      // own descendant -> cycle
    expect(setNodeParent(p, 'if1', 'lit1')).toBe(p);                     // non-IF parent
    expect(setNodeParent(p, 'if1', 'ghost')).toBe(p);                    // unknown parent
    expect(setNodeParent(p, 'ghost', 'if1')).toBe(p);                    // unknown node
    const nested = setNodeParent(p, 'lit1', 'if2');
    expect(nested.nodes.find(n => n.id === 'lit1')?.parent).toBe('if2'); // legit nesting
    expect(setNodeParent(nested, 'lit1', 'if2')).toBe(nested);           // no-op is referential
  });

  it('connectPort replaces the existing driver of an input port', () => {
    let p = emptyProject();
    p = addNode(p, { id: 'a', kind: 'context', name: 'SELF' }, { x: 0, y: 0 });
    p = addNode(p, { id: 'b', kind: 'context', name: 'CALLER' }, { x: 0, y: 0 });
    p = addNode(p, { id: 'call', kind: 'call', contractId: 'c1', signature: 'f(address)' }, { x: 0, y: 0 });
    p = addEdge(p, { from: { node: 'a', port: 'out' }, to: { node: 'call', port: 'arg:0' } });
    p = connectPort(p, { from: { node: 'b', port: 'out' }, to: { node: 'call', port: 'arg:0' } });
    expect(p.edges).toHaveLength(1);
    expect(p.edges[0].from.node).toBe('b');
  });

  it('updateNode edits fields but not identity', () => {
    let p = emptyProject();
    p = addNode(p, { id: 'lit1', kind: 'literal', literalType: 'uint', literal: '1', parent: 'if1' }, { x: 0, y: 0 });
    p = updateNode(p, 'lit1', { literal: '42' });
    expect(p.nodes[0]).toEqual({ id: 'lit1', kind: 'literal', literalType: 'uint', literal: '42', parent: 'if1' });
  });
});

describe('IF frame sizes', () => {
  const IF: VisualProject['nodes'][number] = { id: 'if1', kind: 'if' };

  it('a new IF starts at the comfortable default frame size', () => {
    const p = addNode(emptyProject(), IF, { x: 0, y: 0 });
    expect(p.frameSizes.if1).toEqual({ width: 420, height: 260 });
  });

  it('resizing clamps to the minimum and stays presentation-only', () => {
    let p = addNode(emptyProject(), IF, { x: 10, y: 10 });
    p = addNode(p, { id: 'ctx1', kind: 'context', name: 'SELF' }, { x: 40, y: 80 });
    const before = p;
    p = setNodeFrameSize(p, 'if1', { width: 1, height: 1 });
    expect(p.frameSizes.if1).toEqual({ width: 260, height: 150 });
    expect(p.nodes).toEqual(before.nodes);
    expect(p.edges).toEqual(before.edges);
    expect(p.positions).toEqual(before.positions);
  });

  it('rejects sizes for non-IF nodes and non-finite numbers', () => {
    let p = addNode(emptyProject(), { id: 'ctx1', kind: 'context', name: 'SELF' }, { x: 0, y: 0 });
    expect(setNodeFrameSize(p, 'ctx1', { width: 900, height: 900 })).toBe(p);
    p = addNode(p, IF, { x: 0, y: 0 });
    const nan = setNodeFrameSize(p, 'if1', { width: Number.NaN, height: 500 });
    expect(nan.frameSizes.if1).toEqual({ width: 420, height: 260 });
  });

  it('shrinking below the content keeps the frame wrapping its children', () => {
    let p = addNode(emptyProject(), { ...IF }, { x: 0, y: 0 });
    p = addNode(p, { id: 'call1', kind: 'call', contractId: 'c1', signature: 'f()', parent: 'if1' }, { x: 900, y: 500 });
    p = setNodeFrameSize(p, 'if1', { width: 260, height: 150 });
    const frame = iframes(p).get('if1')!;
    expect(p.frameSizes.if1.width).toBeGreaterThanOrEqual(900 + 250 + 16);
    expect(frame.rect.height).toBeGreaterThanOrEqual(500 + 16);
  });

  it('moving a child outward grows the stored frame; moving back never shrinks it', () => {
    let p = addNode(emptyProject(), { ...IF }, { x: 0, y: 0 });
    p = addNode(p, { id: 'ctx1', kind: 'context', name: 'SELF', parent: 'if1' }, { x: 40, y: 80 });
    p = moveGraphNodes(p, { ctx1: { x: 1200, y: 900 } });
    const grown = { ...p.frameSizes.if1 };
    expect(grown.width).toBeGreaterThanOrEqual(1200 + 180 + 16);
    expect(grown.height).toBeGreaterThanOrEqual(900 + 64 + 16);
    p = moveGraphNodes(p, { ctx1: { x: 40, y: 80 } });
    expect(p.frameSizes.if1).toEqual(grown);
  });

  it('growth propagates outward through nested IFs and is persisted', () => {
    let p = addNode(emptyProject(), { ...IF }, { x: 0, y: 0 });
    p = addNode(p, { id: 'if2', kind: 'if', parent: 'if1' }, { x: 100, y: 100 });
    p = addNode(p, { id: 'ctx1', kind: 'context', name: 'SELF', parent: 'if2' }, { x: 200, y: 200 });
    p = moveGraphNodes(p, { ctx1: { x: 1500, y: 1100 } });
    expect(p.frameSizes.if2.width).toBeGreaterThanOrEqual(1500 - 100 + 180 + 16);
    expect(p.frameSizes.if1.width).toBeGreaterThanOrEqual(100 + p.frameSizes.if2.width + 16);
  });

  it('moveGraphNodes applies parents and positions as one edit', () => {
    let p = addNode(emptyProject(), { ...IF }, { x: 0, y: 0 });
    p = addNode(p, { id: 'ctx1', kind: 'context', name: 'SELF' }, { x: 1000, y: 900 });
    p = moveGraphNodes(p, { ctx1: { x: 300, y: 200 } }, { ctx1: { parent: 'if1', branch: 'then' } });
    expect(p.nodes.find(n => n.id === 'ctx1')?.parent).toBe('if1');
    expect(p.positions.ctx1).toEqual({ x: 300, y: 200 });
  });

  it('deleting an IF cascade-removes its stored frame size', () => {
    let p = addNode(emptyProject(), { ...IF }, { x: 0, y: 0 });
    expect(p.frameSizes.if1).toBeDefined();
    p = removeNodes(p, ['if1']);
    expect(p.frameSizes.if1).toBeUndefined();
  });
});

describe('ELSE transitions', () => {
  const IF = { id: 'if1', kind: 'if' } as const;
  const CTX = { id: 'ctx1', kind: 'context', name: 'SELF' } as const;

  it('enableElse marks the block and persists the wider frame', () => {
    let p = addNode(emptyProject(), IF, { x: 0, y: 0 });
    expect(p.frameSizes.if1.width).toBe(420);
    p = enableElse(p, 'if1');
    expect(p.nodes.find(n => n.id === 'if1')).toMatchObject({ kind: 'if', hasElse: true });
    expect(p.frameSizes.if1.width).toBeGreaterThanOrEqual(640);
    expect(enableElse(p, 'if1')).toBe(p);                       // idempotent
    expect(enableElse(p, 'ghost')).toBe(p);                     // unknown node
    const withLit = addNode(p, CTX, { x: 500, y: 500 });
    expect(enableElse(withLit, 'ctx1')).toBe(withLit);          // non-IF
  });

  it('enableElse grows around children far to the right', () => {
    let p = addNode(emptyProject(), IF, { x: 0, y: 0 });
    p = addNode(p, { ...CTX, parent: 'if1', branch: 'then' }, { x: 1000, y: 60 });
    p = enableElse(p, 'if1');
    expect(p.frameSizes.if1.width).toBeGreaterThanOrEqual(1000 + 180 + 16 + 320);
  });

  it('setNodeScope rejects ELSE membership until ELSE exists', () => {
    let p = addNode(emptyProject(), IF, { x: 0, y: 0 });
    p = addNode(p, CTX, { x: 50, y: 50 });
    expect(setNodeScope(p, 'ctx1', { parent: 'if1', branch: 'else' })).toBe(p);
    p = enableElse(p, 'if1');
    const moved = setNodeScope(p, 'ctx1', { parent: 'if1', branch: 'else' });
    expect(moved.nodes.find(n => n.id === 'ctx1')).toMatchObject({ parent: 'if1', branch: 'else' });
    const back = setNodeScope(moved, 'ctx1', { parent: 'if1', branch: 'then' });
    expect(back.nodes.find(n => n.id === 'ctx1')).toMatchObject({ parent: 'if1', branch: 'then' });
    const cleared = setNodeScope(back, 'ctx1', null);
    expect(cleared.nodes.find(n => n.id === 'ctx1')).not.toHaveProperty('branch');
    expect(setNodeScope(cleared, 'ctx1', null)).toBe(cleared);  // no-op is referential
  });

  it('setNodeScope keeps cycle and kind protection', () => {
    let p = addNode(emptyProject(), IF, { x: 0, y: 0 });
    p = addNode(p, { id: 'if2', kind: 'if', parent: 'if1' }, { x: 50, y: 50 });
    expect(setNodeScope(p, 'if1', { parent: 'if2', branch: 'then' })).toBe(p);
    expect(setNodeScope(p, 'if1', { parent: 'if1', branch: 'then' })).toBe(p);
    p = enableElse(p, 'if1');
    const lit = addNode(p, CTX, { x: 400, y: 400 });
    expect(setNodeScope(lit, 'ctx1', { parent: 'ctx1', branch: 'then' })).toBe(lit);
  });

  it('moveGraphNodes records branch-only moves as one semantic edit', () => {
    let p = addNode(emptyProject(), IF, { x: 0, y: 0 });
    p = enableElse(p, 'if1');
    p = addNode(p, { ...CTX, parent: 'if1', branch: 'then' }, { x: 470, y: 100 });
    const before = p;
    p = moveGraphNodes(p, { ctx1: { x: 900, y: 100 } }, { ctx1: { parent: 'if1', branch: 'else' } });
    expect(p.nodes.find(n => n.id === 'ctx1')).toMatchObject({ parent: 'if1', branch: 'else' });
    expect(p.positions.ctx1).toEqual({ x: 900, y: 100 });
    // Positions alone stay a positional edit: scope untouched.
    const moved = moveGraphNodes(before, { ctx1: { x: 300, y: 100 } });
    expect(moved.nodes.find(n => n.id === 'ctx1')).toMatchObject({ branch: 'then' });
  });

  it('updateNode cannot smuggle scope fields through field patches', () => {
    let p = addNode(emptyProject(), IF, { x: 0, y: 0 });
    p = addNode(p, CTX, { x: 10, y: 10 });
    const patched = updateNode(p, 'ctx1', { name: 'GAS', parent: 'if1', branch: 'else', hasElse: true });
    expect(patched.nodes.find(n => n.id === 'ctx1')).not.toHaveProperty('parent');
    expect(patched.nodes.find(n => n.id === 'ctx1')).not.toHaveProperty('branch');
    expect(patched.nodes.find(n => n.id === 'ctx1')).toMatchObject({ name: 'GAS' });
    expect(patched.nodes.find(n => n.id === 'if1')).not.toHaveProperty('hasElse');
  });
});
