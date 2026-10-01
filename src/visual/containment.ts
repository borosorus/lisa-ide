import type { GraphNode, Vec2, VisualProject } from './model';
import { nodeSize, type Rect } from './spawnPosition';

/**
 * Presentation-only geometry for IF containers. The semantic `parent` field
 * is the single source of truth; these helpers merely derive the frames the
 * canvas draws and hit-test drags against. Nothing here may feed lowering.
 */

export interface Frame {
  readonly id: string;
  /** Full container rect (anchored at the IF's stored position). */
  readonly rect: Rect;
  /** Frame minus its header strip — the only region that captures drops. */
  readonly body: Rect;
  /** Nesting level; 0 for IFs at top level. */
  readonly depth: number;
}

const MIN_WIDTH = 260;
const MIN_HEIGHT = 150;
const HEADER = 44;
const PADDING = 16;

/** Frames of all IF nodes, expanded to wrap their semantic descendants. */
export function iframes(project: VisualProject): Map<string, Frame> {
  const frames = new Map<string, Frame>();
  const kindOf = new Map(project.nodes.map(n => [n.id, n.kind] as const));
  const depths = new Map<string, number>();
  for (const node of project.nodes) {
    if (node.kind !== 'if') continue;
    const anchor = project.positions[node.id] ?? { x: 0, y: 0 };
    let right = anchor.x + MIN_WIDTH;
    let bottom = anchor.y + MIN_HEIGHT;
    let depth = 0;
    let parent = node.parent;
    const seen = new Set<string>([node.id]);
    while (parent !== undefined && !seen.has(parent)) {
      seen.add(parent);
      depth = (depths.get(parent) ?? 0) + 1;
      parent = project.nodes.find(n => n.id === parent)?.parent;
    }
    depths.set(node.id, depth);
    for (const id of descendants(project, node.id)) {
      const size = nodeSize(kindOf.get(id) ?? 'literal');
      const position = project.positions[id] ?? { x: 0, y: 0 };
      right = Math.max(right, position.x + size.width + PADDING);
      bottom = Math.max(bottom, position.y + size.height + PADDING);
    }
    const rect: Rect = { x: anchor.x, y: anchor.y, width: right - anchor.x, height: bottom - anchor.y };
    frames.set(node.id, {
      id: node.id,
      rect,
      body: { x: rect.x, y: rect.y + HEADER, width: rect.width, height: Math.max(rect.height - HEADER, 1) },
      depth,
    });
  }
  return frames;
}

/**
 * Absolute flow position of a node. Stored positions are already absolute
 * (canvas coordinates); the parent chain plays no part.
 */
export function absolutePosition(project: VisualProject, id: string): Vec2 {
  return project.positions[id] ?? { x: 0, y: 0 };
}

/**
 * Which IF a dragged node landed in, judged by its center. The deepest
 * containing body wins; ties break on id. Returns undefined when the node
 * belongs nowhere (outside every body) — callers keep nothing from frames
 * that would capture the node's own subtree.
 */
export function containmentTarget(params: {
  movedRect: Rect;
  frames: Iterable<Frame>;
}): string | undefined {
  const center = { x: params.movedRect.x + params.movedRect.width / 2, y: params.movedRect.y + params.movedRect.height / 2 };
  let best: Frame | undefined;
  for (const frame of params.frames) {
    const { body } = frame;
    if (center.x < body.x || center.x > body.x + body.width) continue;
    if (center.y < body.y || center.y > body.y + body.height) continue;
    if (!best || frame.depth > best.depth || (frame.depth === best.depth && frame.id < best.id)) best = frame;
  }
  return best?.id;
}

/** Ids of semantic descendants of `id`, any depth, defensively cycle-safe. */
export function descendants(project: VisualProject, id: string): string[] {
  const out: string[] = [];
  const queue = [id];
  const seen = new Set<string>([id]);
  while (queue.length) {
    const current = queue.pop()!;
    for (const node of project.nodes) {
      if (node.parent === current && !seen.has(node.id)) {
        seen.add(node.id);
        out.push(node.id);
        queue.push(node.id);
      }
    }
  }
  return out;
}

export type { GraphNode };
