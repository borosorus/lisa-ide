import {
  clampFrameSize, IF_DEFAULT_SIZE, IF_MIN_SIZE,
  type GraphNode, type IfFrameSize, type Vec2, type VisualProject,
} from './model';
import { nodeSize, spawnPositionInBounds, type Rect, type Size } from './spawnPosition';

/**
 * Presentation-only geometry for IF containers. The semantic `parent` field
 * is the single source of truth; these helpers merely derive the frames the
 * canvas draws and hit-tests drags against, and persist their growth.
 * Nothing here may feed lowering.
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

export const IF_HEADER = 44;
export const IF_PADDING = 16;

/**
 * Frames of all IF nodes. Each starts at its stored size (clamped, default
 * when absent) and grows to wrap its direct children — including the
 * effective rect of nested IFs — computed inside-out. Frames never shrink
 * below their stored size; only user resize lowers a stored size.
 */
export function iframes(project: VisualProject): Map<string, Frame> {
  const frames = new Map<string, Frame>();
  const anchorOf = (id: string): Vec2 => project.positions[id] ?? { x: 0, y: 0 };
  const depths = new Map<string, number>();
  const ifNodes = project.nodes.filter(n => n.kind === 'if');
  for (const node of ifNodes) {
    let depth = 0;
    const seen = new Set<string>([node.id]);
    let parent = node.parent;
    while (parent !== undefined && !seen.has(parent)) {
      seen.add(parent);
      depth = (depths.get(parent) ?? 0) + 1;
      parent = project.nodes.find(n => n.id === parent)?.parent;
    }
    depths.set(node.id, depth);
  }
  // Children before parents: a parent frame must see nested effective sizes.
  const ordered = [...ifNodes].sort((a, b) => (depths.get(b.id) ?? 0) - (depths.get(a.id) ?? 0));
  const effective = new Map<string, IfFrameSize>();
  for (const node of ordered) {
    const anchor = anchorOf(node.id);
    const stored = clampFrameSize(project.frameSizes?.[node.id] ?? IF_DEFAULT_SIZE);
    let right = anchor.x + stored.width;
    let bottom = anchor.y + stored.height;
    for (const child of project.nodes) {
      if (child.parent !== node.id) continue;
      const position = anchorOf(child.id);
      const size: Size = child.kind === 'if'
        ? effective.get(child.id) ?? storedSizeOf(project, child)
        : nodeSize(child, project);
      right = Math.max(right, position.x + size.width + IF_PADDING);
      bottom = Math.max(bottom, position.y + size.height + IF_PADDING);
    }
    const size: IfFrameSize = {
      width: Math.max(right - anchor.x, IF_MIN_SIZE.width),
      height: Math.max(bottom - anchor.y, IF_MIN_SIZE.height),
    };
    effective.set(node.id, size);
    const rect: Rect = { x: anchor.x, y: anchor.y, width: size.width, height: size.height };
    frames.set(node.id, {
      id: node.id,
      rect,
      body: { x: rect.x, y: rect.y + IF_HEADER, width: rect.width, height: Math.max(rect.height - IF_HEADER, 1) },
      depth: depths.get(node.id) ?? 0,
    });
  }
  return frames;
}

function storedSizeOf(project: VisualProject, ifNode: GraphNode): IfFrameSize {
  return ifNode.kind === 'if'
    ? clampFrameSize(project.frameSizes?.[ifNode.id] ?? IF_DEFAULT_SIZE)
    : IF_DEFAULT_SIZE;
}

/**
 * Persist current effective frame sizes into `frameSizes` wherever they grew,
 * so a frame never shrinks when a child moves away or is deleted. Run after
 * moves, reparenting, and adds; only explicit resize may shrink.
 */
export function expandIfFrames(project: VisualProject): VisualProject {
  let changed = false;
  const frameSizes = { ...project.frameSizes };
  for (const [id, frame] of iframes(project)) {
    const current = frameSizes[id] ?? IF_DEFAULT_SIZE;
    if (frame.rect.width > current.width || frame.rect.height > current.height) {
      frameSizes[id] = {
        width: Math.max(frame.rect.width, current.width),
        height: Math.max(frame.rect.height, current.height),
      };
      changed = true;
    }
  }
  return changed ? { ...project, frameSizes } : project;
}

/**
 * Placement for a node added while its IF is selected: a free slot inside
 * the frame body (padding included), growing the frame right/down in fixed
 * steps when nothing fits. Occupancy excludes the target frame and its
 * ancestors — their rects merely contain the search area.
 */
export function spawnInsideIf(params: {
  project: VisualProject;
  frameId: string;
  size: Size;
  /** Maximum grow steps per axis before placement is declared impossible. */
  maxGrowSteps?: number;
}): { position: Vec2; frameSize: IfFrameSize } | null {
  const { project, frameId, size } = params;
  const frame = iframes(project).get(frameId);
  if (!frame) return null;
  const anchor = project.positions[frameId] ?? { x: 0, y: 0 };
  const skip = containerSkipSet(project, frameId);
  const occupied = occupiedRects(project).filter(rect => !skip.has(rect.id));
  let width = frame.rect.width;
  let height = frame.rect.height;
  // Guarantee one slot geometrically fits before searching for emptiness,
  // so a selected IF never silently loses the node to a viewport fallback.
  width = Math.max(width, size.width + IF_PADDING * 2 + 8);
  height = Math.max(height, size.height + IF_HEADER + IF_PADDING * 2 + 8);
  const steps = params.maxGrowSteps ?? 6;
  for (let attempt = 0; attempt <= steps; attempt++) {
    const bounds: Rect = {
      x: anchor.x + IF_PADDING,
      y: anchor.y + IF_HEADER + IF_PADDING / 2,
      width: Math.max(width - IF_PADDING * 2, 1),
      height: Math.max(height - IF_HEADER - IF_PADDING * 1.5, 1),
    };
    const anchorPoint = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    const position = spawnPositionInBounds({ anchor: anchorPoint, size, occupied, bounds });
    if (position) return { position, frameSize: { width, height } };
    width += size.width + 40;
    height += size.height + 40;
  }
  return null;
}

/** The frame itself plus its ancestor chain — rects that contain, not block. */
function containerSkipSet(project: VisualProject, frameId: string): Set<string> {
  const skip = new Set<string>([frameId]);
  let parent = project.nodes.find(n => n.id === frameId)?.parent;
  const seen = new Set<string>([frameId]);
  while (parent !== undefined && !seen.has(parent)) {
    seen.add(parent);
    skip.add(parent);
    parent = project.nodes.find(n => n.id === parent)?.parent;
  }
  return skip;
}

/** Rects of every node — IFs at their effective frames — for occupancy. */
export function occupiedRects(project: VisualProject): (Rect & { id: string })[] {
  const frames = iframes(project);
  return project.nodes.map(node => {
    const frame = node.kind === 'if' ? frames.get(node.id) : undefined;
    const position = project.positions[node.id] ?? { x: 0, y: 0 };
    if (frame) return { id: node.id, ...frame.rect };
    const size = nodeSize(node, project);
    return { id: node.id, x: position.x, y: position.y, width: size.width, height: size.height };
  });
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
