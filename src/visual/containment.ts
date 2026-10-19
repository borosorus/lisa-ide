import {
  clampFrameSize, IF_DEFAULT_SIZE, IF_MIN_SIZE,
  type GraphNode, type IfBranch, type IfFrameSize, type ScopeTarget, type Vec2, type VisualProject,
} from './model';
import { nodeSize, spawnPositionInBounds, type Rect, type Size } from './spawnPosition';
import { isContainer, pairedElse, pairedIf } from './controlFlow';

/**
 * Presentation-only geometry for IF containers. The semantic `parent` +
 * `branch` fields are the single source of truth; this module derives the
 * frame zones the canvas draws, normalizes positions into them, and grows
 * frames. Nothing here may feed lowering, generation, or validateProject().
 *
 * A frame is split into explicit zones:
 *
 *   ┌ header (IF condition UI — never content) ┐
 *   ├ THEN strip ──────┬ ELSE strip ───────────┤  (labels only)
 *   │  thenBody        │  elseBody             │  (the only content space)
 *   └──────────────────┴───────────────────────┘
 *
 * The bodies are already inset to their safe bounds (padding from the outer
 * border, the strips, the divider, and the bottom edge). The spatial
 * invariant: every scoped node's full rect sits inside exactly one body;
 * every unscoped node is fully outside every frame.
 */

export interface Frame {
  readonly id: string;
  /** Full container rect (anchored at the IF's stored position). */
  readonly rect: Rect;
  /** IF condition row; never a valid containment target. */
  readonly header: Rect;
  /** THEN label strip; labels only, never content space. */
  readonly thenHeader: Rect;
  /** THEN safe content bounds. */
  readonly thenBody: Rect;
  /** ELSE label strip; only when the block has ELSE. */
  readonly elseHeader?: Rect;
  /** ELSE safe content bounds. */
  readonly elseBody?: Rect;
  /** Nesting level; 0 for IFs at top level. Independent of node order. */
  readonly depth: number;
}

/** Container header space for the title, control handle, and connection state. */
export const IF_HEADER = 96;
/** @deprecated Legacy branch marker sizing; kept for older test fixtures. */
export const BRANCH_HEADER = 28;
/** Safe-content inset from every zone border. */
export const IF_PADDING = 16;
/** @deprecated The canvas no longer splits an IF frame into side-by-side branches. */
export const ELSE_MIN_BRANCH_WIDTH = 320;
/** Gap left between a pushed-out unscoped node and the frame it clears. */
export const OUTSIDE_GAP = 24;

/** Nesting depth of any node: hops up its semantic parent chain. Cycle-safe
 *  and independent of node array order. */
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

/** Zones of a frame rect: header, branch strips, padded safe bodies. The
 *  divider is always the frame's horizontal midpoint (§9: derived from
 *  frame width, never from where children happen to sit). */
export function frameZones(rect: Rect, _hasElse = false): Omit<Frame, 'id' | 'depth'> {
  const top = rect.y + IF_HEADER;
  const height = Math.max(rect.height - IF_HEADER - IF_PADDING, 1);
  return {
    rect,
    header: { x: rect.x, y: rect.y, width: rect.width, height: IF_HEADER },
    thenHeader: { x: rect.x, y: top, width: rect.width, height: 0 },
    thenBody: {
      x: rect.x + IF_PADDING, y: top,
      width: Math.max(rect.width - IF_PADDING * 2, 1), height,
    },
  };
}

/**
 * Frames of all IF nodes. Each starts at its stored size (clamped, default
 * when absent) and grows to wrap its children — including the effective
 * rect of nested IFs — computed inside-out. Growth never shrinks a stored
 * size and, with ELSE, keeps the equal split predictable: the THEN half is
 * at least its widest reach, every half can hold its largest child, and
 * both halves keep the branch minimum. Ordinary child movement inside the
 * current frame therefore cannot move the divider.
 */
export function iframes(project: VisualProject): Map<string, Frame> {
  const frames = new Map<string, Frame>();
  const anchorOf = (id: string): Vec2 => project.positions[id] ?? { x: 0, y: 0 };
  const ifNodes = project.nodes.filter(isContainer);
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
    let maxChildWidth = 0;
    let maxChildHeight = 0;
    for (const child of project.nodes) {
      if (child.parent !== node.id) continue;
      const position = anchorOf(child.id);
      const size: Size = isContainer(child)
        ? effective.get(child.id) ?? storedSizeOf(project, child)
        : nodeSize(child, project);
      maxChildWidth = Math.max(maxChildWidth, size.width);
      maxChildHeight = Math.max(maxChildHeight, size.height);
      right = Math.max(right, position.x + size.width + IF_PADDING);
      bottom = Math.max(bottom, position.y + size.height + IF_PADDING);
    }
    const width = Math.max(right - anchor.x, IF_MIN_SIZE.width, maxChildWidth + IF_PADDING * 2);
    const height = Math.max(
      bottom - anchor.y,
      IF_MIN_SIZE.height,
      IF_HEADER + IF_PADDING * 2 + maxChildHeight,
    );
    const size: IfFrameSize = { width, height };
    effective.set(node.id, size);
    frames.set(node.id, {
      id: node.id,
      ...frameZones({ x: anchor.x, y: anchor.y, width: size.width, height: size.height }),
      depth: depths.get(node.id) ?? 0,
    });
  }
  return frames;
}

function storedSizeOf(project: VisualProject, ifNode: GraphNode): IfFrameSize {
  return isContainer(ifNode) ? clampFrameSize(project.frameSizes?.[ifNode.id] ?? IF_DEFAULT_SIZE) : IF_DEFAULT_SIZE;
}

/** Rendered size of any node: IFs at their effective frame, rest per card. */
export function effectiveSize(project: VisualProject, node: GraphNode, frames = iframes(project)): Size {
  if (!isContainer(node)) return nodeSize(node, project);
  const frame = frames.get(node.id);
  return frame ? { width: frame.rect.width, height: frame.rect.height } : nodeSize(node, project);
}

/**
 * The one normalizer every project transition ends with: persist frame
 * growth, then clamp every scoped node fully inside its branch body's safe
 * bounds (sliding semantic descendants with it). Deterministic and
 * idempotent; purely positional — semantics untouched. Growth can only
 * move the equal-split divider outward, and this pass then pulls (never
 * merely slides) any ELSE child that ended up left of it back into its
 * body, so a child can never render in the wrong branch.
 */
export function expandIfFrames(project: VisualProject): VisualProject {
  let next = project;
  // Converge to a fixed point: growth, scoped clamping, and unscoped
  // push-out can each wake another pass (deep nesting especially). The cap
  // only guards against pathological cycles, not normal nesting depth.
  for (let pass = 0; pass < 64; pass++) {
    const frames = iframes(next);
    const frameSizes = { ...next.frameSizes };
    let grew = false;
    for (const [id, frame] of frames) {
      const current = frameSizes[id] ?? IF_DEFAULT_SIZE;
      if (frame.rect.width > current.width || frame.rect.height > current.height) {
        frameSizes[id] = {
          width: Math.max(frame.rect.width, current.width),
          height: Math.max(frame.rect.height, current.height),
        };
        grew = true;
      }
    }
    if (grew) next = { ...next, frameSizes };
    const positions = { ...next.positions };
    let moved = false;
    const shift = (id: string, delta: Vec2) => {
      for (const childId of [id, ...descendants(next, id)]) {
        const at = positions[childId] ?? { x: 0, y: 0 };
        positions[childId] = { x: at.x + delta.x, y: at.y + delta.y };
      }
    };
    for (const node of next.nodes) {
      const at = positions[node.id] ?? { x: 0, y: 0 };
      const size = effectiveSize(next, node, frames);
      if (node.parent === undefined) {
        // The invariant also covers unscoped nodes: never overlapping a
        // frame. Frame growth must not be able to swallow one.
        const obstacles = [...frames.values()]
          .filter(f => f.id !== node.id && !descendants(next, node.id).includes(f.id))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const pushed = pushOutOfFrames(at, size, obstacles);
        if (pushed.x === at.x && pushed.y === at.y) continue;
        shift(node.id, { x: pushed.x - at.x, y: pushed.y - at.y });
        moved = true;
        continue;
      }
      const frame = frames.get(node.parent);
      const parent = next.nodes.find(n => n.id === node.parent);
      if (!frame || !parent || !isContainer(parent)) continue;
      const clamped = clampInto(at, size, frame.thenBody);
      if (clamped.x === at.x && clamped.y === at.y) continue;
      shift(node.id, { x: clamped.x - at.x, y: clamped.y - at.y });
      moved = true;
    }
    next = { ...next, positions };
    if (!moved && !grew) return next;
  }
  return next;
}

function clampInto(at: Vec2, size: Size, body: Rect): Vec2 {
  return {
    x: size.width >= body.width ? body.x : Math.min(Math.max(at.x, body.x), body.x + body.width - size.width),
    y: size.height >= body.height ? body.y : Math.min(Math.max(at.y, body.y), body.y + body.height - size.height),
  };
}

/**
 * Placement for a node added into a branch body (click-to-add): a free slot
 * fully inside the branch's safe bounds, growing the frame right/down in
 * fixed steps when nothing fits. Occupancy excludes the target frame and
 * its ancestors — their rects merely contain the search area.
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
  if (!node || !isContainer(node)) return null;
  const frame = iframes(project).get(frameId);
  if (!frame) return null;
  const anchor = project.positions[frameId] ?? { x: 0, y: 0 };
  const skip = containerSkipSet(project, frameId);
  const occupied = occupiedRects(project).filter(rect => !skip.has(rect.id));
  let width = frame.rect.width;
  let height = frame.rect.height;
  const boundsFor = (): Rect => {
    return frameZones({ x: anchor.x, y: anchor.y, width, height }).thenBody;
  };
  // Guarantee one slot geometrically fits before searching for emptiness,
  // so a selected IF never silently loses the node to a viewport fallback.
  height = Math.max(height, size.height + IF_HEADER + IF_PADDING * 2);
  width = Math.max(width, size.width + IF_PADDING * 2);
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

/** Rects of every node — IF/ELSE containers at their effective frames. */
export function occupiedRects(project: VisualProject): (Rect & { id: string })[] {
  const frames = iframes(project);
  return project.nodes.map(node => {
    const frame = isContainer(node) ? frames.get(node.id) : undefined;
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
 * Intent only: which branch a dragged node's CENTER points at. The IF
 * header and the branch label strips are not content space — a center
 * there means "outside", as does a center anywhere else off the bodies.
 * The deepest frame wins; ties break on frame id (then THEN), keeping the
 * verdict deterministic. This never places a node — resolveNodeDrop does.
 */
export function containmentTarget(params: {
  movedRect: Rect;
  frames: Iterable<Frame>;
}): ScopeTarget | undefined {
  const center = { x: params.movedRect.x + params.movedRect.width / 2, y: params.movedRect.y + params.movedRect.height / 2 };
  let best: { frame: Frame; branch: IfBranch } | undefined;
  for (const frame of params.frames) {
    const body = frame.thenBody;
    if (center.x < body.x || center.x > body.x + body.width) continue;
    if (center.y < body.y || center.y > body.y + body.height) continue;
    const branch: IfBranch = 'then';
    if (!best || frame.depth > best.frame.depth
        || (frame.depth === best.frame.depth
            && (frame.id === best.frame.id ? branch === 'then' : frame.id < best.frame.id))) {
      best = { frame, branch };
    }
  }
  return best && { parent: best.frame.id, branch: best.branch };
}

/**
 * The single drop-normalization rule, used for existing-node drags and
 * contract-function drops alike. The dragged center only chooses intent
 * (THEN / ELSE / outside); the returned position always satisfies the
 * spatial invariant for the chosen scope:
 *
 * - branch target: the full node rect clamped into that body's safe bounds
 *   (only as much as necessary; frame growth for oversized nodes follows on
 *   commit via expandIfFrames, which widens the frame before anything else);
 * - no target: scope cleared and, if the rect still intersects any frame,
 *   the minimum deterministic translation that clears it (+ OUTSIDE_GAP),
 *   iterated so nested/overlapping frames cannot trap the node.
 *
 * Excluded frames (the dragged subtree's own) never capture the node.
 */
export function resolveNodeDrop(params: {
  project: VisualProject;
  node: GraphNode;
  desiredPosition: Vec2;
  excludedFrames?: ReadonlySet<string>;
}): { position: Vec2; scope: ScopeTarget | null } {
  const { project, node, desiredPosition } = params;
  const frames = iframes(project);
  const obstacles = [...frames.values()]
    .filter(f => !params.excludedFrames?.has(f.id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const size = effectiveSize(project, node, frames);
  const movedRect: Rect = { x: desiredPosition.x, y: desiredPosition.y, width: size.width, height: size.height };
  const scope = containmentTarget({ movedRect, frames: obstacles }) ?? null;
  if (scope !== null) {
    const frame = obstacles.find(f => f.id === scope.parent)!;
    return { position: clampInto(desiredPosition, size, frame.thenBody), scope };
  }
  return { position: pushOutOfFrames(desiredPosition, size, obstacles), scope: null };
}

/**
 * Minimum deterministic translation clearing every obstacle frame
 * (iterated, so nested/overlapping frames cannot trap the node). Ties
 * resolve in fixed order: right, left, down, up.
 */
function pushOutOfFrames(from: Vec2, size: Size, obstacles: readonly Frame[]): Vec2 {
  let position = { ...from };
  for (let pass = 0; pass < 64; pass++) {
    const rect: Rect = { x: position.x, y: position.y, width: size.width, height: size.height };
    const hit = obstacles.find(f => intersects(rect, f.rect));
    if (!hit) break;
    const candidates: readonly (readonly [number, number])[] = [
      [hit.rect.x + hit.rect.width + OUTSIDE_GAP - position.x, 0],
      [hit.rect.x - OUTSIDE_GAP - (position.x + size.width), 0],
      [0, hit.rect.y + hit.rect.height + OUTSIDE_GAP - position.y],
      [0, hit.rect.y - OUTSIDE_GAP - (position.y + size.height)],
    ];
    const [dx, dy] = candidates.reduce((a, b) =>
      Math.abs(b[0]) + Math.abs(b[1]) < Math.abs(a[0]) + Math.abs(a[1]) ? b : a);
    position = { x: position.x + dx, y: position.y + dy };
  }
  return position;
}

/**
 * Normalizes a whole drag gesture (one primary plus any independently
 * dragged group members) into final positions + changed semantic scopes.
 * Each dragged node gets its own resolveNodeDrop verdict against every
 * frame except the dragged subtree's own; semantic descendants ride their
 * owner's normalized delta untouched. Order of `desired` only affects
 * nothing: each node resolves against the pre-drag geometry independently.
 */
export function normalizeDrag(project: VisualProject, desired: Readonly<Record<string, Vec2>>): {
  changes: Record<string, Vec2>;
  scopes: Record<string, ScopeTarget | null>;
} {
  const changes: Record<string, Vec2> = {};
  const scopes: Record<string, ScopeTarget | null> = {};
  const subtree = new Set<string>();
  for (const id of Object.keys(desired)) {
    subtree.add(id);
    for (const d of descendants(project, id)) subtree.add(d);
    const node = project.nodes.find(candidate => candidate.id === id);
    if (node && isContainer(node)) {
      const paired = node.kind === 'if' ? pairedElse(project, node.id) : pairedIf(project, node.id);
      if (paired) {
        subtree.add(paired.id);
        for (const d of descendants(project, paired.id)) subtree.add(d);
      }
    }
  }
  for (const [id, wanted] of Object.entries(desired)) {
    const node = project.nodes.find(n => n.id === id);
    if (!node) continue;
    const resolved = resolveNodeDrop({ project, node, desiredPosition: wanted, excludedFrames: subtree });
    changes[id] = resolved.position;
    const current: ScopeTarget | null = node.parent === undefined
      ? null
      : { parent: node.parent, branch: node.branch ?? 'then' };
    const changed = resolved.scope === null
      ? current !== null
      : current === null || current.parent !== resolved.scope.parent || current.branch !== resolved.scope.branch;
    if (changed) scopes[id] = resolved.scope;
    const saved = project.positions[id] ?? { x: 0, y: 0 };
    const delta = { x: resolved.position.x - saved.x, y: resolved.position.y - saved.y };
    for (const childId of descendants(project, id)) {
      if (changes[childId] !== undefined) continue;
      const before = project.positions[childId] ?? { x: 0, y: 0 };
      changes[childId] = { x: before.x + delta.x, y: before.y + delta.y };
    }
    if (changed && isContainer(node)) {
      const paired = node.kind === 'if' ? pairedElse(project, node.id) : pairedIf(project, node.id);
      if (paired && desired[paired.id] === undefined) {
        const pairedBefore = project.positions[paired.id] ?? { x: 0, y: 0 };
        changes[paired.id] = { x: pairedBefore.x + delta.x, y: pairedBefore.y + delta.y };
        for (const childId of descendants(project, paired.id)) {
          if (changes[childId] !== undefined) continue;
          const before = project.positions[childId] ?? { x: 0, y: 0 };
          changes[childId] = { x: before.x + delta.x, y: before.y + delta.y };
        }
      }
    }
  }
  return { changes, scopes };
}

/** True when the rects overlap with positive area (touching edges is fine). */
function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width
    && a.y < b.y + b.height && b.y < a.y + a.height;
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
