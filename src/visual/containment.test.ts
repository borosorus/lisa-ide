import { describe, expect, it } from 'vitest';
import { absolutePosition, containmentTarget, descendants, iframes } from './containment';
import type { GraphNode, VisualProject } from './model';

function project(nodes: GraphNode[], positions: Record<string, { x: number; y: number }>): VisualProject {
  return { contracts: [], nodes, edges: [], positions };
}

const IF1: GraphNode = { id: 'if1', kind: 'if' };
const IF2: GraphNode = { id: 'if2', kind: 'if', parent: 'if1' };
const CALL: GraphNode = { id: 'call1', kind: 'call', contractId: 'c1', signature: 'f()' };

describe('iframes', () => {
  it('gives an empty IF the minimum frame at its position', () => {
    const frames = iframes(project([IF1], { if1: { x: 100, y: 50 } }));
    const frame = frames.get('if1')!;
    expect(frame.rect.x).toBe(100);
    expect(frame.rect.y).toBe(50);
    expect(frame.rect.width).toBeGreaterThanOrEqual(260);
    expect(frame.rect.height).toBeGreaterThanOrEqual(150);
    expect(frame.depth).toBe(0);
  });

  it('expands to wrap semantic children', () => {
    const frames = iframes(project(
      [IF1, { ...CALL, parent: 'if1' }],
      { if1: { x: 0, y: 0 }, call1: { x: 900, y: 500 } },
    ));
    const frame = frames.get('if1')!;
    expect(frame.rect.width).toBeGreaterThanOrEqual(900 + 250 + 16);
    expect(frame.rect.height).toBeGreaterThanOrEqual(500 + 104 + 16);
  });

  it('nests depths for nested IFs', () => {
    const frames = iframes(project([IF1, IF2], { if1: { x: 0, y: 0 }, if2: { x: 50, y: 80 } }));
    expect(frames.get('if1')!.depth).toBe(0);
    expect(frames.get('if2')!.depth).toBe(1);
  });
});

describe('containmentTarget', () => {
  const frames = () => [
    { id: 'if1', rect: { x: 0, y: 0, width: 800, height: 600 }, body: { x: 0, y: 44, width: 800, height: 556 }, depth: 0 },
    { id: 'if2', rect: { x: 100, y: 100, width: 300, height: 200 }, body: { x: 100, y: 144, width: 300, height: 156 }, depth: 1 },
  ];

  it('picks the deepest frame whose body contains the node center', () => {
    expect(containmentTarget({ movedRect: { x: 150, y: 180, width: 180, height: 64 }, frames: frames() })).toBe('if2');
    expect(containmentTarget({ movedRect: { x: 600, y: 300, width: 180, height: 64 }, frames: frames() })).toBe('if1');
  });

  it('returns nothing outside every body', () => {
    expect(containmentTarget({ movedRect: { x: 2000, y: 2000, width: 180, height: 64 }, frames: frames() })).toBeUndefined();
  });

  it('does not capture the header strip', () => {
    // center at y=20 sits in if1's rect but above its body
    expect(containmentTarget({ movedRect: { x: 300, y: -12, width: 180, height: 64 }, frames: frames() })).toBeUndefined();
  });
});

describe('absolutePosition', () => {
  it('returns the stored absolute position unchanged', () => {
    const p = project([IF1, IF2, { ...CALL, parent: 'if2' }], { if1: { x: 10, y: 10 }, if2: { x: 100, y: 50 }, call1: { x: 20, y: 30 } });
    expect(absolutePosition(p, 'call1')).toEqual({ x: 20, y: 30 });
  });

  it('survives a parent cycle without hanging', () => {
    const p = project(
      [{ id: 'a', kind: 'if', parent: 'b' }, { id: 'b', kind: 'if', parent: 'a' }],
      { a: { x: 10, y: 0 }, b: { x: 100, y: 0 } },
    );
    expect(absolutePosition(p, 'a').x).toBe(10);
  });
});

describe('descendants', () => {
  it('collects all depths and ignores cycles', () => {
    const p = project([IF1, IF2, { ...CALL, parent: 'if2' }], {});
    expect(descendants(p, 'if1').sort()).toEqual(['call1', 'if2']);
    const cycle = project([{ id: 'a', kind: 'if', parent: 'b' }, { id: 'b', kind: 'if', parent: 'a' }], {});
    expect(descendants(cycle, 'a')).toEqual(['b']);
  });
});
