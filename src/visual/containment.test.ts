import { describe, expect, it } from 'vitest';
import { absolutePosition, containmentTarget, descendants, expandIfFrames, frameZones, iframes, normalizeDrag, resolveNodeDrop, spawnInsideIf, BRANCH_HEADER, ELSE_MIN_BRANCH_WIDTH, IF_HEADER, IF_PADDING } from './containment';
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
  const mk = (id: string, rect: { x: number; y: number; width: number; height: number }, hasElse: boolean, depth: number) =>
    ({ id, ...frameZones(rect, hasElse), depth });
  const frames = () => [
    mk('if1', { x: 0, y: 0, width: 800, height: 600 }, false, 0),
    mk('if2', { x: 100, y: 100, width: 300, height: 200 }, false, 1),
  ];
  const withElse = () => [mk('if1', { x: 0, y: 0, width: 800, height: 600 }, true, 0)];

  it('picks the deepest frame whose body contains the node center', () => {
    expect(containmentTarget({ movedRect: { x: 150, y: 180, width: 180, height: 64 }, frames: frames() }))
      .toEqual({ parent: 'if2', branch: 'then' });
    expect(containmentTarget({ movedRect: { x: 600, y: 300, width: 180, height: 64 }, frames: frames() }))
      .toEqual({ parent: 'if1', branch: 'then' });
  });

  it('returns nothing outside every body', () => {
    expect(containmentTarget({ movedRect: { x: 2000, y: 2000, width: 180, height: 64 }, frames: frames() })).toBeUndefined();
  });

  it('does not capture the header or a branch label strip', () => {
    // center at y=20 sits in if1's rect but inside the IF condition header
    expect(containmentTarget({ movedRect: { x: 300, y: -12, width: 180, height: 64 }, frames: frames() })).toBeUndefined();
    // center at y=80 sits below the header but inside the THEN label strip
    expect(containmentTarget({ movedRect: { x: 300, y: 64, width: 180, height: 32 }, frames: frames() })).toBeUndefined();
  });

  it('targets the ELSE half when the center lands right of the divider', () => {
    expect(containmentTarget({ movedRect: { x: 560, y: 300, width: 180, height: 64 }, frames: withElse() }))
      .toEqual({ parent: 'if1', branch: 'else' });
    expect(containmentTarget({ movedRect: { x: 100, y: 300, width: 180, height: 64 }, frames: withElse() }))
      .toEqual({ parent: 'if1', branch: 'then' });
  });

  it('prefers the deepest frame even when a shallower ELSE half also covers the center', () => {
    const overlap = [mk('if1', { x: 0, y: 0, width: 800, height: 600 }, true, 0), frames()[1]];
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
    expect(placed.position.x).toBeGreaterThanOrEqual(frame.thenBody.x);
    expect(placed.position.y).toBeGreaterThanOrEqual(frame.thenBody.y);
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
    expect(placed.position.x).toBeGreaterThanOrEqual(100 + IF_PADDING);
    expect(placed.position.y).toBeGreaterThanOrEqual(100 + IF_HEADER + BRANCH_HEADER);
  });

  it('returns nothing for an unknown or non-IF frame', () => {
    const p = project([{ id: 'ctx1', kind: 'context', name: 'SELF' }], { ctx1: { x: 0, y: 0 } });
    expect(spawnInsideIf({ project: p, frameId: 'ctx1', branch: 'then', size: { width: 10, height: 10 } })).toBeNull();
    expect(spawnInsideIf({ project: p, frameId: 'nope', branch: 'then', size: { width: 10, height: 10 } })).toBeNull();
  });
});

describe('ELSE geometry', () => {
  const ELSE_IF1: GraphNode = { id: 'if1', kind: 'if', hasElse: true };
  const SIZES: Record<string, IfFrameSize> = { if1: { width: 800, height: 400 } };

  it('splits the body into equal halves with explicit zones', () => {
    const frame = iframes(project([ELSE_IF1], { if1: { x: 0, y: 0 } }, SIZES)).get('if1')!;
    expect(frame.header.height).toBe(IF_HEADER);
    expect(frame.thenHeader.y).toBe(frame.rect.y + IF_HEADER);
    expect(frame.thenHeader.width).toBe(frame.rect.width / 2);
    expect(frame.elseHeader!.x).toBe(frame.rect.x + frame.rect.width / 2);
    expect(frame.thenBody.x).toBe(frame.rect.x + IF_PADDING);
    expect(frame.thenBody.y).toBe(frame.thenHeader.y + BRANCH_HEADER);
    // Safe bounds inset from the outer border and the divider on both sides.
    expect(frame.elseBody!.x - (frame.thenBody.x + frame.thenBody.width)).toBe(IF_PADDING * 2);
    expect(frame.elseBody!.x + frame.elseBody!.width + IF_PADDING).toBe(frame.rect.x + frame.rect.width);
    expect(frame.elseBody!.width).toBeGreaterThanOrEqual(ELSE_MIN_BRANCH_WIDTH);
  });

  it('derives the divider from the frame width alone', () => {
    // THEN content reaches far right: the frame GROWS so the midpoint still
    // clears it, but the divider is always width/2 — never a content value.
    const p = project(
      [ELSE_IF1, { ...CALL, parent: 'if1', branch: 'then' }, { ...CALL, id: 'call2', parent: 'if1', branch: 'else' }],
      { if1: { x: 0, y: 0 }, call1: { x: 380, y: 100 }, call2: { x: 700, y: 100 } },
    );
    const frame = iframes(p).get('if1')!;
    const size = nodeSize(CALL, p);
    expect(frame.elseHeader!.x).toBe(frame.rect.width / 2);
    // THEN half widened to hold its child inside the safe bounds...
    expect(frame.thenBody.x + frame.thenBody.width).toBeGreaterThanOrEqual(380 + size.width);
    // ...and every ELSE child renders right of the divider inside its body.
    expect(700).toBeGreaterThanOrEqual(frame.elseBody!.x);
    expect(700 + size.width + IF_PADDING).toBeLessThanOrEqual(frame.rect.width);
  });

  it('keeps existing THEN children left of the divider after ELSE appears', () => {
    const p = project([ELSE_IF1, { ...CALL, parent: 'if1' }], { if1: { x: 0, y: 0 }, call1: { x: 200, y: 120 } }, SIZES);
    const frame = iframes(p).get('if1')!;
    expect(200 + nodeSize(CALL, p).width).toBeLessThan(frame.elseHeader!.x);
  });

  it('leaves the divider and ELSE children untouched by ordinary THEN movement', () => {
    const p = project(
      [ELSE_IF1, { ...CALL, parent: 'if1', branch: 'then' }, { ...CALL, id: 'call2', parent: 'if1', branch: 'else' }],
      { if1: { x: 0, y: 0 }, call1: { x: 60, y: 120 }, call2: { x: 430, y: 120 } },
      SIZES,
    );
    const before = iframes(p).get('if1')!;
    // Ordinary move: 60 -> 100, still inside the THEN safe bounds.
    const moved = expandIfFrames({ ...p, positions: { ...p.positions, call1: { x: 100, y: 120 } } });
    const after = iframes(moved).get('if1')!;
    expect(moved.frameSizes.if1).toEqual(SIZES.if1);      // no growth
    expect(after.elseHeader!.x).toBe(before.elseHeader!.x); // divider fixed
    expect(moved.positions.call2).toEqual({ x: 430, y: 120 }); // ELSE undisturbed
    expect(moved.positions.call1).toEqual({ x: 100, y: 120 }); // THEN move kept
  });

  it('pulls an ELSE child left of the divider back into its body on growth', () => {
    // A THEN child forces real growth; the divider sweeps over the ELSE
    // child, and normalization (not just a slide) restores the invariant.
    const p = project(
      [ELSE_IF1, { ...CALL, parent: 'if1', branch: 'then' }, { ...CALL, id: 'call2', parent: 'if1', branch: 'else' }],
      { if1: { x: 0, y: 0 }, call1: { x: 380, y: 100 }, call2: { x: 380, y: 200 } },
    );
    const grown = expandIfFrames(p);
    const frame = iframes(grown).get('if1')!;
    const size = nodeSize(CALL, p);
    expect(grown.positions.call2.x).toBeGreaterThanOrEqual(frame.elseBody!.x);
    expect(grown.positions.call2.x + size.width + IF_PADDING).toBeLessThanOrEqual(frame.rect.width);
    expect(grown.positions.call1).toEqual({ x: 380, y: 100 }); // THEN child untouched
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

describe('resolveNodeDrop', () => {
  const ELSE_IF1: GraphNode = { id: 'if1', kind: 'if', hasElse: true };
  const SIZES: Record<string, IfFrameSize> = { if1: { width: 800, height: 400 } };
  const CTX: GraphNode = { id: 'ctx1', kind: 'context', name: 'SELF' };
  const base = () => project([ELSE_IF1, { ...CTX }], { if1: { x: 0, y: 0 }, ctx1: { x: -500, y: 0 } }, SIZES);
  const CTX_SIZE = { width: 180, height: 79 };
  const inside = (pos: { x: number; y: number }, rect: { x: number; y: number; width: number; height: number }) =>
    pos.x >= rect.x && pos.y >= rect.y
      && pos.x + CTX_SIZE.width <= rect.x + rect.width
      && pos.y + CTX_SIZE.height <= rect.y + rect.height;

  it('drops a node fully inside the THEN body', () => {
    const p = base();
    const res = resolveNodeDrop({ project: p, node: CTX, desiredPosition: { x: 100, y: 120 } });
    expect(res.scope).toEqual({ parent: 'if1', branch: 'then' });
    expect(inside(res.position, iframes(p).get('if1')!.thenBody)).toBe(true);
  });

  it('drops a node fully inside the ELSE body', () => {
    const p = base();
    const res = resolveNodeDrop({ project: p, node: CTX, desiredPosition: { x: 700, y: 200 } });
    expect(res.scope).toEqual({ parent: 'if1', branch: 'else' });
    expect(inside(res.position, iframes(p).get('if1')!.elseBody!)).toBe(true);
  });

  it('never leaves a node straddling the divider', () => {
    const p = base();
    const frame = iframes(p).get('if1')!;
    const divider = frame.elseHeader!.x;
    const left = resolveNodeDrop({ project: p, node: CTX, desiredPosition: { x: 210, y: 350 } });
    const right = resolveNodeDrop({ project: p, node: CTX, desiredPosition: { x: 390, y: 120 } });
    expect(left.scope).toEqual({ parent: 'if1', branch: 'then' });
    expect(right.scope).toEqual({ parent: 'if1', branch: 'else' });
    expect(left.position.x + CTX_SIZE.width).toBeLessThanOrEqual(divider);
    expect(right.position.x).toBeGreaterThanOrEqual(divider);
  });

  it('drops onto the header as top-level, moved fully outside', () => {
    const p = base();
    const res = resolveNodeDrop({ project: p, node: CTX, desiredPosition: { x: 300, y: 0 } });
    expect(res.scope).toBeNull();
    const frame = iframes(p).get('if1')!.rect;
    const rect = { ...res.position, ...CTX_SIZE };
    expect(rect.y + rect.height).toBeLessThanOrEqual(frame.y); // pushed up: nearest exit
  });

  it('treats the branch label strip as outside', () => {
    const p = base();
    const res = resolveNodeDrop({ project: p, node: CTX, desiredPosition: { x: 500, y: 45 } }); // center y ~84: strip band
    expect(res.scope).toBeNull();
  });

  it('clears a top-level node off any frame it overlaps', () => {
    const p = base();
    const res = resolveNodeDrop({ project: p, node: CTX, desiredPosition: { x: 100, y: 25 } }); // center in the IF header
    expect(res.scope).toBeNull();
    const f = iframes(p).get('if1')!.rect;
    const rect = { ...res.position, ...CTX_SIZE };
    const overlaps = rect.x < f.x + f.width && f.x < rect.x + rect.width
      && rect.y < f.y + f.height && f.y < rect.y + rect.height;
    expect(overlaps).toBe(false);
  });

  it('clears scope and stays put when dragged out of the branch', () => {
    const p = project(
      [ELSE_IF1, { ...CTX, parent: 'if1', branch: 'then' }],
      { if1: { x: 0, y: 0 }, ctx1: { x: 100, y: 120 } }, SIZES,
    );
    const res = resolveNodeDrop({ project: p, node: p.nodes[1], desiredPosition: { x: 2000, y: 900 } });
    expect(res.scope).toBeNull();
    expect(res.position).toEqual({ x: 2000, y: 900 });
  });

  it('grows the frame around a too-large scoped child before placement holds', () => {
    // The nested IF (effective 420x260 default) cannot fit the 320-wide ELSE
    // body: it lands at the body origin and expansion widens/raises the
    // frame until the whole nested frame sits inside the ELSE body.
    const p = project(
      [ELSE_IF1, { id: 'if2', kind: 'if', parent: 'if1', branch: 'else' }],
      { if1: { x: 0, y: 0 }, if2: { x: 420, y: 120 } }, SIZES,
    );
    const grown = expandIfFrames(p);
    const frame = iframes(grown).get('if1')!;
    const inner = iframes(grown).get('if2')!.rect;
    const body = frame.elseBody!;
    expect(inner.x).toBeGreaterThanOrEqual(body.x);
    expect(inner.y).toBeGreaterThanOrEqual(body.y);
    expect(inner.x + inner.width).toBeLessThanOrEqual(body.x + body.width);
    expect(inner.y + inner.height).toBeLessThanOrEqual(body.y + body.height);
  });

  it('clamps a nested IF drop by its effective frame size', () => {
    const p = project(
      [ELSE_IF1, { id: 'if2', kind: 'if' }],
      { if1: { x: 0, y: 0 }, if2: { x: 300, y: 300 } }, SIZES,
    );
    const res = resolveNodeDrop({ project: p, node: p.nodes[1], desiredPosition: { x: 100, y: 200 }, excludedFrames: new Set(['if2']) });
    expect(res.scope).toEqual({ parent: 'if1', branch: 'then' });
    const body = iframes(p).get('if1')!.thenBody;
    const rect = { ...res.position, width: 420, height: 260 };
    expect(rect.x).toBeGreaterThanOrEqual(body.x);
    expect(rect.y).toBeGreaterThanOrEqual(body.y);
    expect(rect.y + rect.height).toBeLessThanOrEqual(body.y + body.height + 1);
  });

  it('prefers the deepest branch for nested IFs', () => {
    // Drop point inside if2's ELSE body AND inside if1's ELSE region: the
    // deeper block must win, and the node must land in if2's body.
    const p = project(
      [{ id: 'if1', kind: 'if', hasElse: true }, { id: 'if2', kind: 'if', hasElse: true, parent: 'if1', branch: 'then' }],
      { if1: { x: 0, y: 0 }, if2: { x: 100, y: 100 } }, SIZES,
    );
    const f2 = iframes(p).get('if2')!;
    const center = { x: f2.elseBody!.x + f2.elseBody!.width / 2, y: f2.elseBody!.y + f2.elseBody!.height / 2 };
    const res = resolveNodeDrop({ project: p, node: CTX, desiredPosition: { x: center.x - 90, y: center.y - 39 } });
    expect(res.scope).toEqual({ parent: 'if2', branch: 'else' });
    expect(inside(res.position, f2.elseBody!)).toBe(true);
  });

  it('is deterministic', () => {
    const p = base();
    const a = resolveNodeDrop({ project: p, node: CTX, desiredPosition: { x: 390, y: 120 } });
    const b = resolveNodeDrop({ project: p, node: CTX, desiredPosition: { x: 390, y: 120 } });
    expect(a).toEqual(b);
  });
});

describe('invariant restoration', () => {
  const CTX: GraphNode = { id: 'ctx1', kind: 'context', name: 'SELF' };
  const overlaps = (pos: { x: number; y: number }, w: number, h: number, f: { x: number; y: number; width: number; height: number }) =>
    pos.x < f.x + f.width && f.x < pos.x + w && pos.y < f.y + f.height && f.y < pos.y + h;

  it('growth or resize cannot swallow a top-level node', () => {
    // A resize (or any commit) enlarges the frame over an unscoped card:
    // normalization pushes it fully outside instead of burying it.
    const p = project([IF1, { ...CTX }], { if1: { x: 0, y: 0 }, ctx1: { x: 500, y: 150 } }, { if1: { width: 700, height: 400 } });
    const settled = expandIfFrames(p);
    expect(overlaps(settled.positions.ctx1, 180, 79, iframes(settled).get('if1')!.rect)).toBe(false);
    expect(settled.nodes.find(n => n.id === 'ctx1')!.parent).toBeUndefined(); // still top-level
  });

  it('normalizeDrag resolves every independently dragged node', () => {
    const ELSE_IF1: GraphNode = { id: 'if1', kind: 'if', hasElse: true };
    const p = project(
      [ELSE_IF1, { ...CTX }, { id: 'ctx2', kind: 'context', name: 'GAS' }],
      { if1: { x: 0, y: 0 }, ctx1: { x: 100, y: 120 }, ctx2: { x: 900, y: 900 } },
      { if1: { width: 800, height: 400 } },
    );
    const res = normalizeDrag(p, { ctx1: { x: 100, y: 120 }, ctx2: { x: 300, y: 0 } });
    const frame = iframes(p).get('if1')!;
    expect(res.scopes.ctx1).toEqual({ parent: 'if1', branch: 'then' });
    // Secondary card dropped on the IF header: stays top-level and is
    // pushed clear — it does not ride into the frame unchecked.
    expect(res.scopes.ctx2).toBeUndefined();
    expect(overlaps(res.changes.ctx2, 180, 79, frame.rect)).toBe(false);
  });

  it('converges deep nesting in one normalization call', () => {
    const nodes: GraphNode[] = [];
    const positions: Record<string, { x: number; y: number }> = {};
    for (let i = 0; i < 12; i++) {
      nodes.push(i === 0 ? { id: `if${i}`, kind: 'if' } : { id: `if${i}`, kind: 'if', parent: `if${i - 1}`, branch: 'then' });
      positions[`if${i}`] = { x: 0, y: 0 };
    }
    const settled = expandIfFrames(project(nodes, positions));
    const again = expandIfFrames(settled);
    expect(again.positions).toEqual(settled.positions); // fixed point reached in one call
    const frames = iframes(settled);
    for (let i = 1; i < 12; i++) {
      const inner = frames.get(`if${i}`)!.rect;
      const body = frames.get(`if${i - 1}`)!.thenBody;
      expect(inner.x).toBeGreaterThanOrEqual(body.x);
      expect(inner.y).toBeGreaterThanOrEqual(body.y);
      expect(inner.x + inner.width).toBeLessThanOrEqual(body.x + body.width);
      expect(inner.y + inner.height).toBeLessThanOrEqual(body.y + body.height);
    }
  });
});
