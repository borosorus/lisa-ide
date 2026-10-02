import { describe, expect, it } from 'vitest';
import { absolutePosition, containmentTarget, descendants, expandIfFrames, iframes, spawnInsideIf, ELSE_MIN_BRANCH_WIDTH, IF_PADDING } from './containment';
import { nodeSize } from './spawnPosition';
import type { GraphNode, IfFrameSize, VisualProject } from './model';

function project(nodes: GraphNode[], positions: Record<string, { x: number; y: number }>, frameSizes: Record<string, IfFrameSize> = {}): VisualProject {
  return { contracts: [], nodes, edges: [], positions, frameSizes };
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
    const p = project(
      [IF1, { ...CALL, parent: 'if1' }],
      { if1: { x: 0, y: 0 }, call1: { x: 900, y: 500 } },
    );
    const frame = iframes(p).get('if1')!;
    const size = nodeSize(CALL, p);
    expect(frame.rect.width).toBeGreaterThanOrEqual(900 + size.width + 16);
    expect(frame.rect.height).toBeGreaterThanOrEqual(500 + size.height + 16);
  });

  it('starts a childless IF at the comfortable default size', () => {
    const frame = iframes(project([IF1], { if1: { x: 0, y: 0 } })).get('if1')!;
    expect(frame.rect.width).toBeGreaterThanOrEqual(420);
    expect(frame.rect.height).toBeGreaterThanOrEqual(260);
  });

  it('honors a stored frame size above the default', () => {
    const frame = iframes(project([IF1], { if1: { x: 0, y: 0 } }, { if1: { width: 800, height: 500 } })).get('if1')!;
    expect(frame.rect.width).toBeGreaterThanOrEqual(800);
    expect(frame.rect.height).toBeGreaterThanOrEqual(500);
  });

  it('grows a parent around a nested IF by the nested effective frame, inside-out', () => {
    // if2 sits at 300,300 and itself wraps a child far to its right.
    const p = project(
      [IF1, IF2, { ...CALL, parent: 'if2' }],
      { if1: { x: 0, y: 0 }, if2: { x: 300, y: 300 }, call1: { x: 1200, y: 400 } },
    );
    const frames = iframes(p);
    const inner = frames.get('if2')!;
    const outer = frames.get('if1')!;
    expect(outer.rect.width).toBeGreaterThanOrEqual(inner.rect.x + inner.rect.width + 16);
    expect(outer.rect.height).toBeGreaterThanOrEqual(inner.rect.y + inner.rect.height + 16);
  });

  it('nests depths for nested IFs', () => {
    const frames = iframes(project([IF1, IF2], { if1: { x: 0, y: 0 }, if2: { x: 50, y: 80 } }));
    expect(frames.get('if1')!.depth).toBe(0);
    expect(frames.get('if2')!.depth).toBe(1);
  });
});

describe('containmentTarget', () => {
  const frames = () => [
    { id: 'if1', rect: { x: 0, y: 0, width: 800, height: 600 }, body: { x: 0, y: 44, width: 800, height: 556 }, thenBody: { x: 0, y: 44, width: 800, height: 556 }, depth: 0 },
    { id: 'if2', rect: { x: 100, y: 100, width: 300, height: 200 }, body: { x: 100, y: 144, width: 300, height: 156 }, thenBody: { x: 100, y: 144, width: 300, height: 156 }, depth: 1 },
  ];
  const withElse = () => [{
    id: 'if1', rect: { x: 0, y: 0, width: 800, height: 600 }, body: { x: 0, y: 44, width: 800, height: 556 },
    thenBody: { x: 0, y: 44, width: 400, height: 556 }, elseBody: { x: 400, y: 44, width: 400, height: 556 }, depth: 0,
  }];

  it('picks the deepest frame whose body contains the node center', () => {
    expect(containmentTarget({ movedRect: { x: 150, y: 180, width: 180, height: 64 }, frames: frames() }))
      .toEqual({ parent: 'if2', branch: 'then' });
    expect(containmentTarget({ movedRect: { x: 600, y: 300, width: 180, height: 64 }, frames: frames() }))
      .toEqual({ parent: 'if1', branch: 'then' });
  });

  it('returns nothing outside every body', () => {
    expect(containmentTarget({ movedRect: { x: 2000, y: 2000, width: 180, height: 64 }, frames: frames() })).toBeUndefined();
  });

  it('does not capture the header strip', () => {
    // center at y=20 sits in if1's rect but above its body
    expect(containmentTarget({ movedRect: { x: 300, y: -12, width: 180, height: 64 }, frames: frames() })).toBeUndefined();
  });

  it('targets the ELSE half when the center lands right of the divider', () => {
    expect(containmentTarget({ movedRect: { x: 560, y: 300, width: 180, height: 64 }, frames: withElse() }))
      .toEqual({ parent: 'if1', branch: 'else' });
    expect(containmentTarget({ movedRect: { x: 100, y: 300, width: 180, height: 64 }, frames: withElse() }))
      .toEqual({ parent: 'if1', branch: 'then' });
  });

  it('prefers the deepest frame even when a shallower ELSE half also covers the center', () => {
    const overlap = [...frames().slice(0, 1).map(f => ({ ...f, ...{ thenBody: { x: 0, y: 44, width: 400, height: 556 }, elseBody: { x: 400, y: 44, width: 400, height: 556 } } })), frames()[1]];
    expect(containmentTarget({ movedRect: { x: 150, y: 180, width: 180, height: 64 }, frames: overlap }))
      .toEqual({ parent: 'if2', branch: 'then' });
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

describe('spawnInsideIf', () => {
  const CTX: GraphNode = { id: 'ctx1', kind: 'context', name: 'SELF' };

  it('places the first node inside the frame body, deterministically', () => {
    const p = project([IF1], { if1: { x: 0, y: 0 } });
    const placed = spawnInsideIf({ project: p, frameId: 'if1', branch: 'then', size: { width: 180, height: 64 } })!;
    expect(placed).not.toBeNull();
    const frame = iframes(p).get('if1')!;
    expect(placed.position.x).toBeGreaterThanOrEqual(frame.rect.x);
    expect(placed.position.y).toBeGreaterThanOrEqual(frame.body.y);
    expect(placed.position.x + 180).toBeLessThanOrEqual(frame.rect.x + placed.frameSize.width);
    expect(placed.position.y + 64).toBeLessThanOrEqual(frame.rect.y + placed.frameSize.height);
    const again = spawnInsideIf({ project: p, frameId: 'if1', branch: 'then', size: { width: 180, height: 64 } });
    expect(again?.position).toEqual(placed.position);
  });

  it('picks a different slot when the first is occupied', () => {
    const p = project(
      [IF1, { ...CTX }, { id: 'ctx0', kind: 'context', name: 'GAS', parent: 'if1' }],
      { if1: { x: 0, y: 0 }, ctx0: spawnInsideIf({ project: project([IF1], { if1: { x: 0, y: 0 } }), frameId: 'if1', branch: 'then', size: { width: 180, height: 64 } })!.position },
    );
    const placed = spawnInsideIf({ project: p, frameId: 'if1', branch: 'then', size: { width: 180, height: 64 } })!;
    expect(placed.position).not.toEqual(p.positions.ctx0);
  });

  it('grows the frame when the node cannot fit its current body', () => {
    const p = project([IF1], { if1: { x: 0, y: 0 } });
    const placed = spawnInsideIf({ project: p, frameId: 'if1', branch: 'then', size: { width: 500, height: 300 } })!;
    expect(placed).not.toBeNull();
    expect(placed.frameSize.width).toBeGreaterThan(420);
    expect(placed.frameSize.height).toBeGreaterThan(260);
    expect(placed.position.y + 300).toBeLessThanOrEqual(placed.frameSize.height);
  });

  it('is unbothered by an enclosing ancestor frame overlapping the body', () => {
    const p = project([IF1, { ...IF2 }], { if1: { x: 0, y: 0 }, if2: { x: 100, y: 100 } });
    const placed = spawnInsideIf({ project: p, frameId: 'if2', branch: 'then', size: { width: 180, height: 64 } })!;
    expect(placed.position.x).toBeGreaterThanOrEqual(100);
    expect(placed.position.y).toBeGreaterThanOrEqual(100 + 44);
  });

  it('returns nothing for an unknown or non-IF frame', () => {
    const p = project([{ id: 'ctx1', kind: 'context', name: 'SELF' }], { ctx1: { x: 0, y: 0 } });
    expect(spawnInsideIf({ project: p, frameId: 'ctx1', branch: 'then', size: { width: 10, height: 10 } })).toBeNull();
    expect(spawnInsideIf({ project: p, frameId: 'nope', branch: 'then', size: { width: 10, height: 10 } })).toBeNull();
  });
});

describe('ELSE geometry', () => {
  const ELSE_IF1: GraphNode = { id: 'if1', kind: 'if', hasElse: true };

  it('splits the body into equal halves and grows to the two-branch minimum', () => {
    const frame = iframes(project([ELSE_IF1], { if1: { x: 0, y: 0 } })).get('if1')!;
    expect(frame.rect.width).toBeGreaterThanOrEqual(640);
    expect(frame.elseBody).toBeDefined();
    expect(frame.thenBody.width).toBe(Math.floor(frame.body.width / 2));
    expect(frame.elseBody!.x).toBe(frame.thenBody.x + frame.thenBody.width);
    expect(frame.elseBody!.width + frame.elseBody!.x).toBe(frame.body.x + frame.body.width);
  });

  it('moves the divider right when THEN content would cross it', () => {
    // THEN child at the far right of the old THEN half: the divider tracks
    // its right edge (the THEN half widens); the ELSE half keeps its minimum
    // and the ELSE child sits right of the divider inside the grown frame.
    const p = project(
      [ELSE_IF1, { ...CALL, parent: 'if1', branch: 'then' }, { ...CALL, id: 'call2', parent: 'if1', branch: 'else' }],
      { if1: { x: 0, y: 0 }, call1: { x: 380, y: 50 }, call2: { x: 700, y: 50 } },
    );
    const frame = iframes(p).get('if1')!;
    const size = nodeSize(CALL, p);
    expect(frame.elseBody!.x).toBe(380 + size.width + IF_PADDING);
    expect(frame.thenBody.width).toBeGreaterThanOrEqual(380 + size.width + IF_PADDING);
    expect(frame.elseBody!.width).toBeGreaterThanOrEqual(ELSE_MIN_BRANCH_WIDTH);
    expect(700 + size.width).toBeLessThanOrEqual(frame.rect.width);
    expect(frame.elseBody!.x + frame.elseBody!.width).toBe(frame.body.x + frame.body.width);
  });

  it('slides ELSE children right when THEN growth would swallow them', () => {
    // ELSE child still in pre-ELSE coordinates while THEN grows wide: the
    // divider sweeps over it, so frame expansion slides that child (and
    // only it) back right of the divider. Purely positional.
    const p = project(
      [ELSE_IF1, { ...CALL, parent: 'if1', branch: 'then' }, { ...CALL, id: 'call2', parent: 'if1', branch: 'else' }],
      { if1: { x: 0, y: 0 }, call1: { x: 380, y: 50 }, call2: { x: 380, y: 200 } },
    );
    const grown = expandIfFrames(p);
    const frame = iframes(grown).get('if1')!;
    expect(grown.positions.call2.x).toBeGreaterThanOrEqual(frame.elseBody!.x);
    expect(grown.positions.call1).toEqual({ x: 380, y: 50 });
    const size = nodeSize(CALL, p);
    expect(frame.elseBody!.x + size.width + IF_PADDING).toBeLessThanOrEqual(frame.rect.width);
    expect(frame.thenBody.width).toBeGreaterThanOrEqual(380 + size.width + IF_PADDING);
  });

  it('keeps existing THEN children left of the divider after ELSE appears', () => {
    const without = project([{ ...CALL, parent: 'if1' }], { if1: { x: 0, y: 0 }, call1: { x: 200, y: 60 } });
    const before = iframes(without).get('if1')!;
    const widened = project([{ ...CALL, parent: 'if1' }, { id: 'if0', kind: 'if', hasElse: true }].slice(1).concat([{ ...CALL, parent: 'if0' }]) as GraphNode[], {}) ;void widened;
    // Same frame anchor with ELSE enabled keeps the child well inside THEN.
    const withElse = project([ELSE_IF1, { ...CALL, parent: 'if1' }], { if1: { x: 0, y: 0 }, call1: { x: 200, y: 60 } });
    const after = iframes(withElse).get('if1')!;
    expect(after.thenBody.x + after.thenBody.width).toBeGreaterThan(200 + nodeSize(CALL, withElse).width);
    void before;
  });

  it('computes IF depth by the parent chain, independent of array order', () => {
    const A: GraphNode = { id: 'ifA', kind: 'if' };
    const B: GraphNode = { id: 'ifB', kind: 'if', parent: 'ifA' };
    const C: GraphNode = { id: 'ifC', kind: 'if', parent: 'ifB' };
    const positions = { ifA: { x: 0, y: 0 }, ifB: { x: 50, y: 50 }, ifC: { x: 100, y: 100 } };
    for (const nodes of [[A, B, C], [C, B, A], [B, C, A], [C, A, B]]) {
      const frames = iframes(project(nodes, positions));
      expect(frames.get('ifA')!.depth).toBe(0);
      expect(frames.get('ifB')!.depth).toBe(1);
      expect(frames.get('ifC')!.depth).toBe(2);
    }
  });

  it('survives a parent cycle in depth computation', () => {
    const frames = iframes(project(
      [{ id: 'a', kind: 'if', parent: 'b' }, { id: 'b', kind: 'if', parent: 'a' }],
      { a: { x: 0, y: 0 }, b: { x: 100, y: 0 } },
    ));
    expect(frames.get('a')!.depth).toBe(1);
  });

  it('spawns into the ELSE half only when the block has ELSE', () => {
    const placed = spawnInsideIf({ project: project([ELSE_IF1], { if1: { x: 0, y: 0 } }), frameId: 'if1', branch: 'else', size: { width: 180, height: 64 } })!;
    const frame = iframes(project([ELSE_IF1], { if1: { x: 0, y: 0 } })).get('if1')!;
    expect(placed.position.x).toBeGreaterThanOrEqual(frame.elseBody!.x);
    expect(placed.position.x + 180).toBeLessThanOrEqual(placed.frameSize.width);
    const noElse = spawnInsideIf({ project: project([IF1], { if1: { x: 0, y: 0 } }), frameId: 'if1', branch: 'else', size: { width: 10, height: 10 } });
    expect(noElse).toBeNull();
  });

  it('prefers an anchor slot inside the branch body when one fits', () => {
    const frame = iframes(project([ELSE_IF1], { if1: { x: 0, y: 0 } })).get('if1')!;
    const point = { x: frame.elseBody!.x + 40, y: frame.elseBody!.y + 40 };
    const placed = spawnInsideIf({ project: project([ELSE_IF1], { if1: { x: 0, y: 0 } }), frameId: 'if1', branch: 'else', size: { width: 180, height: 64 }, anchor: point })!;
    expect(placed.position.x).toBeGreaterThanOrEqual(frame.elseBody!.x);
    expect(Math.abs(placed.position.x - point.x)).toBeLessThanOrEqual(180 + 24);
  });
});
