import {
  clampFrameSize, IF_DEFAULT_SIZE, IF_MIN_SIZE,
  type GraphNode, type IfBranch, type IfFrameSize, type ScopeTarget, type Vec2, type VisualProject,
} from './model';
import { nodeSize, spawnPositionInBounds, type Rect, type Size } from './spawnPosition';

/**
 * Presentation-only geometry for IF containers. The semantic `parent` +
 * `branch` fields are the single source of truth; these helpers merely
 * derive the frames the canvas draws and hit-tests drags against, and
 * persist their growth. The branch regions below are projections of that
 * state — nothing here may feed lowering or generation.
 */

export interface Frame {
  readonly id: string;
  /** Full container rect (anchored at the IF's stored position). */
  readonly rect: Rect;
  /** Frame minus its header strip — the combined work area of both branches. */
  readonly body: Rect;
  /** THEN drop region: the whole body without ELSE, the left half with it. */
  readonly thenBody: Rect;
  /** ELSE drop region (right half); only when the block has ELSE enabled. */
  readonly elseBody?: Rect;
  /** Nesting level; 0 for IFs at top level. Independent of node order. */
  readonly depth: number;
}

export const IF_HEADER = 44;
export const IF_PADDING = 16;

/** Comfortable minimum work width per branch once ELSE splits the body. */
export const ELSE_MIN_BRANCH_WIDTH = 320;

/** Nesting depth of any node: hops up its semantic parent chain. Cycle-safe
 *  and independent of node array order — no memo assumptions. */
export function scopeDepth(project: VisualProject, nodeId: string): number {
  const parentOf = new Map(project.nodes.map(n => [n.id, n.parent] as const));
  let depth = 0;
  const seen = new Set<string>([nodeId]);
  let parent = parentOf.get(nodeId);
  while (parent !== undefined && !seen.has(parent)) {
    seen.add(parent);
    depth += 1;
    parent = parentOf.get(parent);
  }
  return depth;
}

/**
 * Frames of all IF nodes. Each starts at its stored size (clamped, default
 * when absent) and grows to wrap its direct children — including the
 * effective rect of nested IFs — computed inside-out. Frames never shrink
 * below their stored size; only user resize lowers a stored size. With
 * ELSE enabled the body splits into equal halves and the width additionally
 * grows so each branch's own children fit inside their half.
 */
export function iframes(project: VisualProject): Map<string, Frame> {
  const frames = new Map<string, Frame>();
  const anchorOf = (id: string): Vec2 => project.positions[id] ?? { x: 0, y: 0 };
  const ifNodes = project.nodes.filter(n => n.kind === 'if');
  const depths = new Map<string, number>();
  for (const node of ifNodes) depths.set(node.id, scopeDepth(project, node.id));
  // Children before parents: a parent frame must see nested effective sizes.
  const ordered = [...ifNodes].sort((a, b) => (depths.get(b.id) ?? 0) - (depths.get(a.id) ?? 0));
  const effective = new Map<string, IfFrameSize>();
  for (const node of ordered) {
    const anchor = anchorOf(node.id);
    const stored = clampFrameSize(project.frameSizes?.[node.id] ?? IF_DEFAULT_SIZE);
    let right = anchor.x + stored.width;
    let bottom = anchor.y + stored.height;
    let thenRight = anchor.x;
    for (const child of project.nodes) {
      if (child.parent !== node.id) continue;
      const position = anchorOf(child.id);
      const size: Size = child.kind === 'if'
        ? effective.get(child.id) ?? storedSizeOf(project, child)
        : nodeSize(child, project);
      right = Math.max(right, position.x + size.width + IF_PADDING);
      bottom = Math.max(bottom, position.y + size.height + IF_PADDING);
      // Only THEN content sizes the divider; the ELSE half's own children
      // stretch the frame's right edge without moving the divider, so an
      // ELSE child can never end up rendered left of its own region.
      if (child.branch !== 'else') thenRight = Math.max(thenRight, position.x + size.width + IF_PADDING);
    }
    let divider = anchor.x;
    if (node.hasElse === true) {
      divider = Math.max(thenRight, anchor.x + ELSE_MIN_BRANCH_WIDTH);
      right = Math.max(right, divider + ELSE_MIN_BRANCH_WIDTH);
    }
    const size: IfFrameSize = {
      width: Math.max(right - anchor.x, IF_MIN_SIZE.width),
      height: Math.max(bottom - anchor.y, IF_MIN_SIZE.height),
    };
    effective.set(node.id, size);
    const rect: Rect = { x: anchor.x, y: anchor.y, width: size.width, height: size.height };
    const body: Rect = { x: rect.x, y: rect.y + IF_HEADER, width: rect.width, height: Math.max(rect.height - IF_HEADER, 1) };
    const hasElse = node.hasElse === true;
    frames.set(node.id, {
      id: node.id,
      rect,
      body,
      thenBody: hasElse ? { x: body.x, y: body.y, width: divider - body.x, height: body.height } : body,
      ...(hasElse ? { elseBody: { x: divider, y: body.y, width: body.x + body.width - divider, height: body.height } } : {}),
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
 * moves, reparenting, and adds; only explicit resize may shrink. THEN growth
 * pushes the divider right; ELSE children it would swallow are slid right by
 * the same amount (with their subtrees) so rendered position and semantic
 * branch never disagree. Purely positional — semantics untouched.
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
  let next = changed ? { ...project, frameSizes } : project;
  for (let pass = 0; pass < 6; pass++) {
    const frames = iframes(next);
    const positions = { ...next.positions };
    let moved = false;
    for (const node of next.nodes) {
      const parent = node.parent === undefined ? undefined : next.nodes.find(n => n.id === node.parent);
      if (node.branch !== 'else' || parent?.kind !== 'if' || parent.hasElse !== true) continue;
      const divider = frames.get(parent.id)?.elseBody?.x;
      if (divider === undefined) continue;
      const at = positions[node.id] ?? { x: 0, y: 0 };
      if (at.x >= divider) continue;
      const dx = divider + IF_PADDING / 2 - at.x;
      positions[node.id] = { x: at.x + dx, y: at.y };
      for (const childId of descendants(next, node.id)) {
        const childAt = positions[childId] ?? { x: 0, y: 0 };
        positions[childId] = { x: childAt.x + dx, y: childAt.y };
      }
      moved = true;
    }
    next = { ...next, positions };
    if (!moved) return next;
  }
  return next;
}

/**
 * Placement for a node added into a branch body (padding included), growing
 * the frame right/down in fixed steps when nothing fits. Occupancy excludes
 * the target frame and its ancestors — their rects merely contain the
 * search area. Growth with ELSE keeps both halves equal.
 */
export function spawnInsideIf(params: {
  project: VisualProject;
  frameId: string;
  branch: IfBranch;
  size: Size;
  /**
   * Preferred flow-space point (a drag/drop landing): tried first, inside
   * the branch body, before the frame-centered spiral and growth loop.
   */
  anchor?: Vec2;
  /** Maximum grow steps per axis before placement is declared impossible. */
  maxGrowSteps?: number;
}): { position: Vec2; frameSize: IfFrameSize } | null {
  const { project, frameId, branch, size } = params;
  const node = project.nodes.find(n => n.id === frameId);
  if (!node || node.kind !== 'if') return null;
  if (branch === 'else' && node.hasElse !== true) return null;
  const frame = iframes(project).get(frameId);
  if (!frame) return null;
  const anchor = project.positions[frameId] ?? { x: 0, y: 0 };
  const skip = containerSkipSet(project, frameId);
  const occupied = occupiedRects(project).filter(rect => !skip.has(rect.id));
  const hasElse = node.hasElse === true;
  let width = frame.rect.width;
  let height = frame.rect.height;
  // The divider only moves for THEN content: a THEN slot that does not fit
  // left of it widens the THEN half (ELSE children are slid right on commit
  // by expandIfFrames); an ELSE slot only ever needs the right half.
  let divider = frame.elseBody?.x ?? anchor.x + width;
  if (hasElse && branch === 'then') {
    divider = Math.max(divider, anchor.x + size.width + IF_PADDING * 2 + 8);
    width = Math.max(width, divider - anchor.x + ELSE_MIN_BRANCH_WIDTH + IF_PADDING);
  }
  const boundsFor = (): Rect => {
    const height2 = Math.max(height - IF_HEADER - IF_PADDING * 1.5, 1);
    if (!hasElse) {
      return {
        x: anchor.x + IF_PADDING, y: anchor.y + IF_HEADER + IF_PADDING / 2,
        width: Math.max(width - IF_PADDING * 2, 1), height: height2,
      };
    }
    return branch === 'else'
      ? { x: divider + IF_PADDING / 2, y: anchor.y + IF_HEADER + IF_PADDING / 2, width: Math.max(anchor.x + width - divider - IF_PADDING * 1.5, 1), height: height2 }
      : { x: anchor.x + IF_PADDING, y: anchor.y + IF_HEADER + IF_PADDING / 2, width: Math.max(divider - anchor.x - IF_PADDING * 2, 1), height: height2 };
  };
  // Guarantee one slot geometrically fits before searching for emptiness,
  // so a selected IF never silently loses the node to a viewport fallback.
  height = Math.max(height, size.height + IF_HEADER + IF_PADDING * 2 + 8);
  if (params.anchor) {
    const dropped = spawnPositionInBounds({ anchor: params.anchor, size, occupied, bounds: boundsFor() });
    if (dropped) return { position: dropped, frameSize: { width, height } };
  }
  const steps = params.maxGrowSteps ?? 6;
  for (let attempt = 0; attempt <= steps; attempt++) {
    const bounds = boundsFor();
    const anchorPoint = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    const position = spawnPositionInBounds({ anchor: anchorPoint, size, occupied, bounds });
    if (position) return { position, frameSize: { width, height } };
    width += hasElse && branch === 'else' ? size.width + 40 : (size.width + 40) * (hasElse ? 2 : 1);
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
 * Which IF branch a dragged node landed in, judged by its center. The
 * deepest containing branch region wins; ties break on frame id, then
 * branch. Returns undefined when the node belongs nowhere (outside every
 * region) — callers keep nothing from frames that would capture the node's
 * own subtree.
 */
export function containmentTarget(params: {
  movedRect: Rect;
  frames: Iterable<Frame>;
}): ScopeTarget | undefined {
  const center = { x: params.movedRect.x + params.movedRect.width / 2, y: params.movedRect.y + params.movedRect.height / 2 };
  const inRect = (r: Rect) => center.x >= r.x && center.x <= r.x + r.width
    && center.y >= r.y && center.y <= r.y + r.height;
  let best: { frame: Frame; branch: IfBranch } | undefined;
  for (const frame of params.frames) {
    const branch: IfBranch | undefined = inRect(frame.elseBody ?? frame.thenBody) ? (frame.elseBody ? 'else' : 'then')
      : inRect(frame.thenBody) ? 'then' : undefined;
    if (branch === undefined) continue;
    if (!best || frame.depth > best.frame.depth
        || (frame.depth === best.frame.depth
            && (frame.id < best.frame.id || (frame.id === best.frame.id && branch === 'then')))) {
      best = { frame, branch };
    }
  }
  return best && { parent: best.frame.id, branch: best.branch };
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
