import { describe, expect, it } from 'vitest';
import { arrangeProject } from './arrange';
import { iframes } from './containment';
import type { GraphEdge, GraphNode, VisualProject } from './model';

function project(nodes: GraphNode[], edges: GraphEdge[] = [], frameSizes: VisualProject['frameSizes'] = {}): VisualProject {
  return { contracts: [], nodes, edges, positions: Object.fromEntries(nodes.map((node, index) => [node.id, { x: 1000 - index * 13, y: index * 31 }])), frameSizes };
}

const edge = (id: string, from: string, to: string): GraphEdge => ({
  id, from: { node: from, port: 'out' }, to: { node: to, port: 'in' },
});
const pair = (id: string, ifId: string, elseId: string): GraphEdge => ({
  id, kind: 'control', from: { node: ifId, port: 'else' }, to: { node: elseId, port: 'if' },
});
const context = (id: string, parent?: string): GraphNode => ({ id, kind: 'context', name: 'SELF', ...(parent ? { parent } : {}) });
const ifNode = (id: string, parent?: string): GraphNode => ({ id, kind: 'if', ...(parent ? { parent } : {}) });
const elseNode = (id: string, parent?: string): GraphNode => ({ id, kind: 'else', ...(parent ? { parent } : {}) });

describe('arrangeProject', () => {
  it('lays data dependencies left to right and keeps independent ordering stable', () => {
    const input = project([context('a'), context('b'), context('c'), context('d')], [edge('ac', 'a', 'c'), edge('bc', 'b', 'c'), edge('cd', 'c', 'd')]);
    const result = arrangeProject(input);
    expect(result.changed).toBe(true);
    expect(result.project.positions.a.x).toBe(result.project.positions.b.x);
    expect(result.project.positions.a.y).toBeLessThan(result.project.positions.b.y);
    expect(result.project.positions.c.x).toBeGreaterThan(result.project.positions.a.x);
    expect(result.project.positions.d.x).toBeGreaterThan(result.project.positions.c.x);
  });

  it('orders nodes within a nested layer by their upstream neighbors', () => {
    const input = project([
      ifNode('scope'), context('upperSource', 'scope'), context('lowerSource', 'scope'),
      context('lowerTarget', 'scope'), context('upperTarget', 'scope'),
    ], [edge('upper', 'upperSource', 'upperTarget'), edge('lower', 'lowerSource', 'lowerTarget')]);
    const result = arrangeProject(input);

    expect(result.project.positions.upperSource.y).toBeLessThan(result.project.positions.lowerSource.y);
    expect(result.project.positions.upperTarget.y).toBeLessThan(result.project.positions.lowerTarget.y);
  });

  it('keeps original node order when same-layer neighbor positions tie', () => {
    const input = project([context('source'), context('first'), context('second')], [
      edge('firstEdge', 'source', 'first'), edge('secondEdge', 'source', 'second'),
    ]);
    const result = arrangeProject(input);

    expect(result.project.positions.first.y).toBeLessThan(result.project.positions.second.y);
  });

  it('uses the average position when a node has multiple upstream neighbors', () => {
    const input = project([
      context('source0'), context('source1'), context('source2'), context('source3'),
      context('target2'), context('targetAverage'),
    ], [
      edge('to2', 'source2', 'target2'),
      edge('toAverage0', 'source0', 'targetAverage'),
      edge('toAverage3', 'source3', 'targetAverage'),
    ]);
    const result = arrangeProject(input);

    expect(result.project.positions.targetAverage.y).toBeLessThan(result.project.positions.target2.y);
  });

  it('moves a paired IF/ELSE composite as one dependency unit', () => {
    const input = project([
      context('upperSource'), context('lowerSource'), ifNode('if1'), elseNode('else1'),
      context('other'), context('ifChild', 'if1'),
    ], [
      edge('ifDependency', 'lowerSource', 'ifChild'),
      edge('otherDependency', 'upperSource', 'other'),
      pair('ifElsePair', 'if1', 'else1'),
    ]);
    const result = arrangeProject(input);
    const frames = iframes(result.project);

    expect(result.project.positions.other.y).toBeLessThan(result.project.positions.if1.y);
    expect(result.project.positions.else1.x).toBeGreaterThanOrEqual(
      frames.get('if1')!.rect.x + frames.get('if1')!.rect.width + 56,
    );
  });

  it('moves a strongly connected component as one dependency unit', () => {
    const input = project([
      context('upperSource'), context('lowerSource'), context('cycleA'),
      context('cycleB'), context('independentTarget'),
    ], [
      edge('cycleIn', 'lowerSource', 'cycleA'),
      edge('cycleForward', 'cycleA', 'cycleB'),
      edge('cycleBack', 'cycleB', 'cycleA'),
      edge('independentIn', 'upperSource', 'independentTarget'),
    ]);
    const result = arrangeProject(input);

    expect(result.warning).toMatch(/dependency cycles/);
    expect(result.project.positions.independentTarget.y).toBeLessThan(result.project.positions.cycleA.y);
    expect(result.project.positions.cycleA.x).toBe(result.project.positions.cycleB.x);
    expect(result.project.positions.cycleA.y).not.toBe(result.project.positions.cycleB.y);
  });

  it('uses explicit execution order and measured rendered sizes', () => {
    const before: GraphNode = { id: 'before', kind: 'guard' };
    const after: GraphNode = { id: 'after', kind: 'guard', executionAfter: 'before' };
    const result = arrangeProject(project([before, after]), { before: { width: 340, height: 120 } });
    expect(result.project.positions.after.x).toBeGreaterThan(result.project.positions.before.x);
    expect(result.project.positions.after.y).toBe(result.project.positions.before.y);
  });

  it('keeps paired IF and ELSE containers side by side and fits each body', () => {
    const input = project([
      ifNode('if1'), elseNode('else1'), context('thenChild', 'if1'), context('elseChild', 'else1'),
    ], [pair('pair', 'if1', 'else1')], { if1: { width: 900, height: 600 }, else1: { width: 900, height: 600 } });
    const result = arrangeProject(input);
    const frames = iframes(result.project);
    const then = frames.get('if1')!;
    const otherwise = frames.get('else1')!;
    expect(result.project.positions.else1.x).toBeGreaterThanOrEqual(then.rect.x + then.rect.width + 56);
    expect(then.rect.width).toBe(260);
    expect(otherwise.rect.width).toBe(260);
    expect(result.project.positions.thenChild.x).toBeGreaterThanOrEqual(then.thenBody.x);
    expect(result.project.positions.elseChild.x).toBeGreaterThanOrEqual(otherwise.thenBody.x);
  });

  it('recursively lays out nested pairs and grows parent containers to fit them', () => {
    const input = project([
      ifNode('outer'), elseNode('outerElse'),
      ifNode('inner', 'outer'), elseNode('innerElse', 'outer'),
      context('nestedLeaf', 'innerElse'),
    ], [pair('outerPair', 'outer', 'outerElse'), pair('innerPair', 'inner', 'innerElse')]);
    const result = arrangeProject(input);
    const frames = iframes(result.project);
    expect(result.project.positions.outerElse.x).toBeGreaterThan(result.project.positions.outer.x);
    expect(result.project.positions.innerElse.x).toBeGreaterThan(result.project.positions.inner.x);
    expect(frames.get('innerElse')!.rect.x).toBeGreaterThanOrEqual(frames.get('inner')!.rect.x + frames.get('inner')!.rect.width + 56);
    expect(frames.get('outer')!.rect.width).toBeGreaterThan(frames.get('innerElse')!.rect.x - frames.get('outer')!.rect.x + frames.get('innerElse')!.rect.width);
    expect(result.project.positions.nestedLeaf.y).toBeGreaterThan(frames.get('innerElse')!.rect.y);
  });

  it('reserves enough height for deep containers before stacking a sibling', () => {
    const input = project([
      ifNode('outer'), ifNode('inner1', 'outer'), ifNode('inner2', 'inner1'),
      ifNode('inner3', 'inner2'), ifNode('inner4', 'inner3'),
      context('leaf', 'inner4'), context('sibling', 'outer'),
    ]);
    const result = arrangeProject(input);
    const outer = iframes(result.project).get('outer')!.rect;
    const sibling = result.project.positions.sibling;
    const nested = iframes(result.project).get('inner1')!.rect;
    expect(sibling.y).toBeGreaterThanOrEqual(nested.y + nested.height + 48);
    expect(sibling.y + 79 + 16).toBeLessThanOrEqual(outer.y + outer.height);
  });

  it('arranges disconnected ELSE containers and their dormant descendants', () => {
    const input = project([elseNode('else1'), context('dormant', 'else1')]);
    const result = arrangeProject(input);
    expect(result.changed).toBe(true);
    expect(result.project.positions.dormant).toBeDefined();
    expect(result.project.positions.dormant.y).toBeGreaterThan(result.project.positions.else1.y);
  });

  it('places cycle members together deterministically and reports best-effort layout', () => {
    const input = project([context('a'), context('b'), context('c')], [edge('ab', 'a', 'b'), edge('ba', 'b', 'a'), edge('bc', 'b', 'c')]);
    const first = arrangeProject(input);
    const second = arrangeProject(first.project);
    expect(first.warning).toMatch(/dependency cycles/);
    expect(first.project.positions.a.x).toBe(first.project.positions.b.x);
    expect(first.project.positions.a.y).not.toBe(first.project.positions.b.y);
    expect(first.project.positions.c.x).toBeGreaterThan(first.project.positions.a.x);
    expect(second.project.positions).toEqual(first.project.positions);
    expect(second.project.frameSizes).toEqual(first.project.frameSizes);
  });

  it('does not use old scattered coordinates to decide layout and is idempotent', () => {
    const input = project([context('a'), context('b'), context('c')], [edge('ac', 'a', 'c')]);
    const first = arrangeProject(input);
    const second = arrangeProject(first.project);
    expect(second.project.positions).toEqual(first.project.positions);
    expect(second.project.frameSizes).toEqual(first.project.frameSizes);
  });

  it('retains node order, edges, and semantic node fields', () => {
    const nodes: GraphNode[] = [
      { id: 'a', kind: 'guard' },
      { id: 'b', kind: 'guard', executionAfter: 'a' },
    ];
    const edges = [edge('ab', 'a', 'b')];
    const input = project(nodes, edges);
    const result = arrangeProject(input);
    expect(result.project.nodes).toBe(input.nodes);
    expect(result.project.edges).toBe(input.edges);
    expect(result.project.nodes).toEqual(nodes);
    expect(result.project.edges).toEqual(edges);
  });

  it('leaves malformed containment unchanged with an explanation', () => {
    const input = project([ifNode('a', 'b'), ifNode('b', 'a')]);
    const result = arrangeProject(input);
    expect(result.changed).toBe(false);
    expect(result.project).toBe(input);
    expect(result.error).toMatch(/cycle/);
  });

  it('returns a no-op for an empty graph', () => {
    const input: VisualProject = { contracts: [], nodes: [], edges: [], positions: {}, frameSizes: {} };
    expect(arrangeProject(input)).toMatchObject({ project: input, changed: false });
  });
});
