import { describe, expect, it } from 'vitest';
import { absolutePosition, containmentTarget, descendants, expandIfFrames, frameZones, iframes, normalizeDrag, resolveNodeDrop, spawnInsideIf, IF_HEADER, IF_PADDING } from './containment';
import { nodeSize } from './spawnPosition';
import type { GraphEdge, GraphNode, IfFrameSize, VisualProject } from './model';

function project(nodes: GraphNode[], positions: Record<string, { x: number; y: number }>, frameSizes: Record<string, IfFrameSize> = {}, edges: GraphEdge[] = []): VisualProject {
  return { contracts: [], nodes, edges, positions, frameSizes };
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
  const mk = (id: string, rect: { x: number; y: number; width: number; height: number }, depth: number) =>
    ({ id, ...frameZones(rect), depth });
  const frames = () => [
    mk('if1', { x: 0, y: 0, width: 800, height: 600 }, 0),
    mk('if2', { x: 100, y: 100, width: 300, height: 200 }, 1),
  ];
  const withElse = () => [
    mk('if1', { x: 0, y: 0, width: 420, height: 600 }, 0),
    mk('else1', { x: 476, y: 0, width: 420, height: 600 }, 0),
  ];

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

  it('targets a separate ELSE container by its own frame', () => {
    expect(containmentTarget({ movedRect: { x: 560, y: 300, width: 180, height: 64 }, frames: withElse() }))
      .toEqual({ parent: 'else1', branch: 'then' });
    expect(containmentTarget({ movedRect: { x: 100, y: 300, width: 180, height: 64 }, frames: withElse() }))
      .toEqual({ parent: 'if1', branch: 'then' });
  });

  it('prefers the deepest frame even when a shallower ELSE half also covers the center', () => {
    const overlap = [mk('if1', { x: 0, y: 0, width: 800, height: 600 }, 0), frames()[1]];
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
    expect(placed.position.y).toBeGreaterThanOrEqual(100 + IF_HEADER);
  });

  it('returns nothing for an unknown or non-IF frame', () => {
    const p = project([{ id: 'ctx1', kind: 'context', name: 'SELF' }], { ctx1: { x: 0, y: 0 } });
    expect(spawnInsideIf({ project: p, frameId: 'ctx1', branch: 'then', size: { width: 10, height: 10 } })).toBeNull();
    expect(spawnInsideIf({ project: p, frameId: 'nope', branch: 'then', size: { width: 10, height: 10 } })).toBeNull();
  });
});

describe('separate ELSE geometry', () => {
  const IF: GraphNode = { id: 'if1', kind: 'if' };
  const ELSE: GraphNode = { id: 'else1', kind: 'else' };
  const PAIR: GraphEdge = { id: 'pair', kind: 'control', from: { node: 'if1', port: 'else' }, to: { node: 'else1', port: 'if' } };

  it('gives IF and ELSE independent full-width frames and bodies', () => {
    const p = project([IF, ELSE], { if1: { x: 0, y: 0 }, else1: { x: 476, y: 0 } }, {}, [PAIR]);
    const frames = iframes(p);
    expect(frames.get('if1')!.thenBody.width).toBeGreaterThan(300);
    expect(frames.get('else1')!.thenBody.width).toBeGreaterThan(300);
    expect(frames.get('if1')!.thenBody.x + frames.get('if1')!.thenBody.width).toBeLessThan(frames.get('else1')!.rect.x);
  });

  it('grows each container around only its own children', () => {
    const p = project(
      [IF, ELSE, { ...CALL, parent: 'if1' }, { ...CALL, id: 'call2', parent: 'else1' }],
      { if1: { x: 0, y: 0 }, else1: { x: 476, y: 0 }, call1: { x: 100, y: 200 }, call2: { x: 580, y: 300 } }, {}, [PAIR],
    );
    const frames = iframes(p);
    expect(frames.get('if1')!.rect.height).toBeGreaterThanOrEqual(200 + nodeSize(CALL, p).height + IF_PADDING);
    expect(frames.get('else1')!.rect.height).toBeGreaterThanOrEqual(300 + nodeSize(CALL, p).height + IF_PADDING);
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

  it('spawns into the separate ELSE body', () => {
    const p = project([IF, ELSE], { if1: { x: 0, y: 0 }, else1: { x: 476, y: 0 } }, {}, [PAIR]);
    const placed = spawnInsideIf({ project: p, frameId: 'else1', branch: 'then', size: { width: 180, height: 64 } })!;
    const frame = iframes(p).get('else1')!;
    expect(placed.position.x).toBeGreaterThanOrEqual(frame.thenBody.x);
    expect(placed.position.y).toBeGreaterThanOrEqual(frame.thenBody.y);
  });
});

describe('resolveNodeDrop', () => {
  const IF: GraphNode = { id: 'if1', kind: 'if' };
  const ELSE: GraphNode = { id: 'else1', kind: 'else' };
  const PAIR: GraphEdge = { id: 'pair', kind: 'control', from: { node: 'if1', port: 'else' }, to: { node: 'else1', port: 'if' } };
  const SIZES: Record<string, IfFrameSize> = { if1: { width: 420, height: 400 }, else1: { width: 420, height: 400 } };
  const CTX: GraphNode = { id: 'ctx1', kind: 'context', name: 'SELF' };
  const base = () => project([IF, ELSE, { ...CTX }], { if1: { x: 0, y: 0 }, else1: { x: 476, y: 0 }, ctx1: { x: -500, y: 0 } }, SIZES, [PAIR]);
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

  it('drops a node fully inside the separate ELSE body', () => {
    const p = base();
    const res = resolveNodeDrop({ project: p, node: CTX, desiredPosition: { x: 560, y: 200 } });
    expect(res.scope).toEqual({ parent: 'else1', branch: 'then' });
    expect(inside(res.position, iframes(p).get('else1')!.thenBody)).toBe(true);
  });

  it('does not infer a branch from the gap between separate containers', () => {
    const p = base();
    const res = resolveNodeDrop({ project: p, node: CTX, desiredPosition: { x: 320, y: 150 } });
    expect(res.scope).toBeNull();
    const rect = { ...res.position, ...CTX_SIZE };
    for (const frame of iframes(p).values()) {
      const intersects = rect.x < frame.rect.x + frame.rect.width && frame.rect.x < rect.x + rect.width
        && rect.y < frame.rect.y + frame.rect.height && frame.rect.y < rect.y + rect.height;
      expect(intersects).toBe(false);
    }
  });

  it('drops onto the header as top-level, moved fully outside', () => {
    const p = base();
    const res = resolveNodeDrop({ project: p, node: CTX, desiredPosition: { x: 300, y: 0 } });
    expect(res.scope).toBeNull();
    const frame = iframes(p).get('if1')!.rect;
    const rect = { ...res.position, ...CTX_SIZE };
    expect(rect.y + rect.height).toBeLessThanOrEqual(frame.y); // pushed up: nearest exit
  });

  it('treats the container header as outside', () => {
    const p = base();
    const res = resolveNodeDrop({ project: p, node: CTX, desiredPosition: { x: 500, y: 40 } });
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
      [IF, ELSE, { ...CTX, parent: 'if1' }],
      { if1: { x: 0, y: 0 }, ctx1: { x: 100, y: 120 } }, SIZES,
      [PAIR],
    );
    const res = resolveNodeDrop({ project: p, node: p.nodes.find(node => node.id === 'ctx1')!, desiredPosition: { x: 2000, y: 900 } });
    expect(res.scope).toBeNull();
    expect(res.position).toEqual({ x: 2000, y: 900 });
  });

  it('grows the frame around a too-large scoped child before placement holds', () => {
    // The nested IF has its own frame inside the separate ELSE container.
    const p = project(
      [IF, ELSE, { id: 'if2', kind: 'if', parent: 'else1' }],
      { if1: { x: 0, y: 0 }, else1: { x: 476, y: 0 }, if2: { x: 520, y: 120 } }, SIZES,
      [PAIR],
    );
    const grown = expandIfFrames(p);
    const frame = iframes(grown).get('else1')!;
    const inner = iframes(grown).get('if2')!.rect;
    const body = frame.thenBody;
    expect(inner.x).toBeGreaterThanOrEqual(body.x);
    expect(inner.y).toBeGreaterThanOrEqual(body.y);
    expect(inner.x + inner.width).toBeLessThanOrEqual(body.x + body.width);
    expect(inner.y + inner.height).toBeLessThanOrEqual(body.y + body.height);
  });

  it('clamps a nested IF drop by its effective frame size', () => {
    const p = project(
      [IF, { id: 'if2', kind: 'if' }],
      { if1: { x: 0, y: 0 }, if2: { x: 300, y: 300 } }, { if1: { width: 800, height: 400 } },
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
    // Drop point inside if2's frame nested in if1: the deeper frame wins.
    const p = project(
      [IF, { id: 'if2', kind: 'if', parent: 'if1' }],
      { if1: { x: 0, y: 0 }, if2: { x: 100, y: 100 } }, { if1: { width: 1000, height: 700 } },
    );
    const f2 = iframes(p).get('if2')!;
    const center = { x: f2.thenBody.x + f2.thenBody.width / 2, y: f2.thenBody.y + f2.thenBody.height / 2 };
    const res = resolveNodeDrop({ project: p, node: CTX, desiredPosition: { x: center.x - 90, y: center.y - 39 } });
    expect(res.scope).toEqual({ parent: 'if2', branch: 'then' });
    expect(inside(res.position, f2.thenBody)).toBe(true);
  });

  it('is deterministic', () => {
    const p = base();
    const a = resolveNodeDrop({ project: p, node: CTX, desiredPosition: { x: 390, y: 120 } });
    const b = resolveNodeDrop({ project: p, node: CTX, desiredPosition: { x: 390, y: 120 } });
    expect(a).toEqual(b);
  });

  it('uses the nearest clear corner around adjacent frames', () => {
    const frames = [
      { id: 'if1', kind: 'if' as const },
      { id: 'if2', kind: 'if' as const },
      { id: 'if3', kind: 'if' as const },
    ];
    const p = project(frames, {
      if1: { x: 0, y: 0 },
      if2: { x: 500, y: 0 },
      if3: { x: 0, y: 350 },
      ctx1: { x: 0, y: 0 },
    });
    const res = resolveNodeDrop({ project: p, node: CTX, desiredPosition: { x: 400, y: 240 } });
    expect(res.scope).toBeNull();
    expect(res.position).toEqual({ x: 444, y: 284 });
  });

  it('breaks equal-distance placements by preferring right, then left, down, and up', () => {
    const p = project(
      [{ id: 'a', kind: 'if' }, { id: 'b', kind: 'if' }],
      { a: { x: 0, y: 0 }, b: { x: 500, y: 0 }, ctx1: { x: 0, y: 0 } },
      { a: { width: 420, height: 2000 }, b: { width: 420, height: 2000 } },
    );
    const res = resolveNodeDrop({ project: p, node: CTX, desiredPosition: { x: 370, y: 950 } });
    expect(res.position).toEqual({ x: 944, y: 950 });
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
    const ELSE_IF1: GraphNode = { id: 'if1', kind: 'if' };
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
