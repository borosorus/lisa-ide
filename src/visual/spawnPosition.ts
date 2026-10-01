import type { GraphNode, Vec2 } from './model';

/**
 * Canvas-aware placement for newly created nodes. Pure and deterministic:
 * a square spiral outward from the anchor (usually the viewport center)
 * until the candidate slot neither overlaps an existing node nor falls
 * outside the visible flow area while closer slots did not.
 */

export interface Size { readonly width: number; readonly height: number }
export interface Rect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

/** Conservative card footprints; only separation quality depends on them. */
export function nodeSize(kind: GraphNode['kind']): Size {
  switch (kind) {
    case 'call': return { width: 250, height: 104 };
    case 'if': return { width: 220, height: 64 };
    default: return { width: 180, height: 64 };
  }
}

const MAX_RING = 24;

export function spawnPosition(params: {
  /** Preferred top-left is centered on this flow-space point. */
  anchor: Vec2;
  size: Size;
  occupied: readonly Rect[];
  /** Visible flow rect; candidates inside it are tried first, never required. */
  bounds?: Rect | null;
  gap?: number;
}): Vec2 {
  const gap = params.gap ?? 24;
  const stepX = params.size.width + gap;
  const stepY = params.size.height + gap;
  const base = { x: params.anchor.x - params.size.width / 2, y: params.anchor.y - params.size.height / 2 };
  for (let pass = 0; pass < 2; pass++) {
    for (let ring = 0; ring <= MAX_RING; ring++) {
      for (const [dx, dy] of ringOffsets(ring)) {
        const candidate = { x: base.x + dx * stepX, y: base.y + dy * stepY, width: params.size.width, height: params.size.height };
        if (params.occupied.some(rect => overlaps(candidate, rect, gap))) continue;
        if (pass === 0 && params.bounds && !inside(candidate, params.bounds)) continue;
        return { x: candidate.x, y: candidate.y };
      }
    }
  }
  return { x: base.x, y: base.y };
}

/** Deterministic Chebyshev-ring order: top row L→R, right, bottom R→L, left. */
function ringOffsets(ring: number): readonly (readonly [number, number])[] {
  if (ring === 0) return [[0, 0]];
  const offsets: [number, number][] = [];
  for (let x = -ring; x <= ring; x++) offsets.push([x, -ring], [x, ring]);
  for (let y = -ring + 1; y <= ring - 1; y++) offsets.push([-ring, y], [ring, y]);
  return offsets;
}

function overlaps(a: Rect, b: Rect, gap: number): boolean {
  return a.x < b.x + b.width + gap && a.x + a.width + gap > b.x
    && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
}

function inside(a: Rect, b: Rect): boolean {
  return a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width && a.y + a.height <= b.y + b.height;
}

/** Rects of existing nodes from the canonical project, for occupancy checks. */
export function occupiedRects(nodes: readonly GraphNode[], positions: Readonly<Record<string, Vec2>>): Rect[] {
  return nodes.map(node => {
    const size = nodeSize(node.kind);
    const position = positions[node.id] ?? { x: 0, y: 0 };
    return { x: position.x, y: position.y, width: size.width, height: size.height };
  });
}
