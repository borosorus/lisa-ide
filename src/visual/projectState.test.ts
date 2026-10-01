import { describe, expect, it } from 'vitest';
import { emptyProject, type VisualProject } from './model';
import {
  addContract, addEdge, addNode, connectPort, removeContract, removeEdge, removeNodes,
  setNodeParent, setNodePosition, updateContract, updateNode,
} from './projectState';

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
    expect(p.nodes.find(n => n.id === 'lit1')).toEqual({ id: 'lit1', kind: 'literal', literalType: 'uint', literal: '7', parent: 'if1' });
    p = setNodeParent(p, 'lit1', undefined);
    expect(p.nodes.find(n => n.id === 'lit1')).not.toHaveProperty('parent');
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
