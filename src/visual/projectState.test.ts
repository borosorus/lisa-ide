import { describe, expect, it } from 'vitest';
import { emptyProject, type VisualProject } from './model';
import {
  addContract, addEdge, addNode, removeContract, removeEdge, removeNodes,
  setNodeParent, setNodePosition, updateContract,
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
});
