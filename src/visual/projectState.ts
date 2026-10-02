import {
  clampFrameSize, createId, IF_DEFAULT_SIZE,
  type ContractResource, type GraphEdge, type GraphNode, type IfBranch, type IfFrameSize, type ScopeTarget, type Vec2, type VisualProject,
} from './model';
import { expandIfFrames } from './containment';

/**
 * Pure VisualProject transitions. Every edit to semantic data lives here so
 * the React layer stays thin and the semantics stay unit-testable.
 */

export function addContract(project: VisualProject, contract: Omit<ContractResource, 'id'>): VisualProject {
  const id = createId(project.contracts.map(c => c.id), 'c');
  return { ...project, contracts: [...project.contracts, { ...contract, id }] };
}

export function updateContract(
  project: VisualProject, id: string, patch: Partial<Pick<ContractResource, 'name' | 'address'>>,
): VisualProject {
  // Call nodes reference contracts by id, so an address change applies everywhere.
  return {
    ...project,
    contracts: project.contracts.map(c => (c.id === id ? { ...c, ...patch } : c)),
  };
}

export function removeContract(project: VisualProject, id: string): VisualProject {
  const removed = project.nodes.filter(n => n.kind === 'call' && n.contractId === id).map(n => n.id);
  const withoutCalls = dropNodes(project, removed);
  return { ...withoutCalls, contracts: withoutCalls.contracts.filter(c => c.id !== id) };
}

export function addNode(
  project: VisualProject, node: VisualProject['nodes'][number], position: Vec2,
): VisualProject {
  const added: VisualProject = {
    ...project,
    nodes: [...project.nodes, node],
    positions: { ...project.positions, [node.id]: position },
    ...(node.kind === 'if'
      ? { frameSizes: { ...project.frameSizes, [node.id]: IF_DEFAULT_SIZE } }
      : {}),
  };
  // Adding inside a frame may require the frame to grow around its new member.
  return expandIfFrames(added);
}

export function setNodePosition(project: VisualProject, id: string, position: Vec2): VisualProject {
  if (!project.nodes.some(n => n.id === id)) return project;
  return { ...project, positions: { ...project.positions, [id]: position } };
}

export function moveSelectedNodes(project: VisualProject, deltas: Readonly<Record<string, Vec2>>): VisualProject {
  let next = project;
  for (const [id, delta] of Object.entries(deltas)) {
    const current = next.positions[id];
    if (current) next = setNodePosition(next, id, { x: current.x + delta.x, y: current.y + delta.y });
  }
  return next;
}

/** Remove nodes plus any edges touching them. If-bodies are cascaded: their children go too. */
export function removeNodes(project: VisualProject, ids: Iterable<string>): VisualProject {
  const doomed = new Set<string>();
  const queue = [...ids];
  const byId = new Map(project.nodes.map(n => [n.id, n]));
  while (queue.length) {
    const id = queue.pop()!;
    if (doomed.has(id) || !byId.has(id)) continue;
    doomed.add(id);
    for (const node of project.nodes) {
      if (node.parent === id && !doomed.has(node.id)) queue.push(node.id);
    }
  }
  return dropNodes(project, [...doomed]);
}

function dropNodes(project: VisualProject, ids: string[]): VisualProject {
  if (ids.length === 0) return project;
  const doomed = new Set(ids);
  const touches = (edge: GraphEdge, set: Set<string>) =>
    set.has(edge.from.node) || set.has(edge.to.node);
  const nodes = project.nodes.filter(n => !doomed.has(n.id));
  const idsAfter = new Set(nodes.map(n => n.id));
  return {
    ...project,
    nodes,
    edges: project.edges.filter(e => touches(e, doomed) ? false : (idsAfter.has(e.from.node) && idsAfter.has(e.to.node))),
    positions: Object.fromEntries(Object.entries(project.positions).filter(([id]) => idsAfter.has(id))),
    frameSizes: Object.fromEntries(Object.entries(project.frameSizes ?? {}).filter(([id]) => idsAfter.has(id))),
  };
}

export function addEdge(project: VisualProject, edge: Omit<GraphEdge, 'id'>): VisualProject {
  const id = createId(project.edges.map(e => e.id), 'e');
  return { ...project, edges: [...project.edges, { ...edge, id }] };
}

/** Connect a source port to an input port, replacing any existing driver. */
export function connectPort(project: VisualProject, edge: Omit<GraphEdge, 'id'>): VisualProject {
  const without = project.edges.filter(e => e.to.node !== edge.to.node || e.to.port !== edge.to.port);
  return addEdge({ ...project, edges: without }, edge);
}

/** Patch editable node fields; identity (id/kind/parent/branch) stays stable. */
export function updateNode(project: VisualProject, id: string, patch: Record<string, unknown>): VisualProject {
  // Scope transitions are semantic moves, not field patches — they go
  // through setNodeScope so validation and growth stay in one place.
  const { parent: _p, branch: _b, hasElse: _e, ...fields } = patch;
  return {
    ...project,
    nodes: project.nodes.map(n => (n.id === id ? { ...n, ...fields, id: n.id, kind: n.kind } as GraphNode : n)),
  };
}

export function removeEdge(project: VisualProject, id: string): VisualProject {
  return { ...project, edges: project.edges.filter(e => e.id !== id) };
}

/**
 * Assign or clear a node's IF scope — its owning block and branch. The one
 * semantic containment transition; every canvas gesture funnels here.
 * Rejected eagerly (project unchanged) when the target is unknown, an IF
 * into itself or a descendant, a non-IF node, or an ELSE branch of a block
 * without ELSE. validate.ts remains the final authority for stored graphs.
 */
export function setNodeScope(project: VisualProject, nodeId: string, scope: ScopeTarget | null): VisualProject {
  const node = project.nodes.find(n => n.id === nodeId);
  if (!node) return project;
  if (scope === null) {
    if (node.parent === undefined && node.branch === undefined) return project;
    return patchScope(project, nodeId, undefined, undefined);
  }
  const { parent, branch } = scope;
  if (parent === nodeId) return project;
  const parentIf = project.nodes.find(n => n.id === parent);
  if (!parentIf || parentIf.kind !== 'if') return project;
  if (branch === 'else' && parentIf.hasElse !== true) return project;
  // Walk the target's ancestors: assigning into own subtree would cycle.
  let ancestor: string | undefined = parent;
  const seen = new Set<string>();
  while (ancestor !== undefined && !seen.has(ancestor)) {
    if (ancestor === nodeId) return project;
    seen.add(ancestor);
    ancestor = project.nodes.find(n => n.id === ancestor)?.parent;
  }
  if (node.parent === parent && node.branch === branch) return project;
  return patchScope(project, nodeId, parent, branch);
}

/** Legacy containment calls (drag pre-ELSE): entering a block means THEN. */
export function setNodeParent(project: VisualProject, nodeId: string, parent: string | undefined): VisualProject {
  return setNodeScope(project, nodeId, parent === undefined ? null : { parent, branch: 'then' });
}

function patchScope(
  project: VisualProject, nodeId: string, parent: string | undefined, branch: IfBranch | undefined,
): VisualProject {
  return {
    ...project,
    nodes: project.nodes.map(n => {
      if (n.id !== nodeId) return n;
      const { parent: _gone, branch: _goneB, ...rest } = n;
      return parent === undefined
        ? (rest as VisualProject['nodes'][number])
        : { ...rest, parent, branch } as VisualProject['nodes'][number];
    }),
  };
}

/**
 * Enable the ELSE branch of an IF block. The block gains a second sibling
 * scope; the frame grows (persisted immediately) so both branches have a
 * comfortable work area. Existing children keep their THEN membership.
 */
export function enableElse(project: VisualProject, id: string): VisualProject {
  const node = project.nodes.find(n => n.id === id);
  if (!node || node.kind !== 'if' || node.hasElse === true) return project;
  const next = {
    ...project,
    nodes: project.nodes.map(n => (n.id === id ? { ...n, hasElse: true } : n)),
  };
  return expandIfFrames(next);
}

/**
 * One batched canvas-move transition: apply every absolute position, then
 * the validated scope changes, then persist any frame growth the batch
 * caused. Batching matters — expanding after each intermediate position
 * could grow a nested IF out of a half-moved drag.
 */
export function moveGraphNodes(
  project: VisualProject,
  changes: Readonly<Record<string, Vec2>>,
  scopes: Readonly<Record<string, ScopeTarget | null>> = {},
): VisualProject {
  let next = project;
  for (const [id, position] of Object.entries(changes)) next = setNodePosition(next, id, position);
  for (const [id, scope] of Object.entries(scopes)) next = setNodeScope(next, id, scope);
  return expandIfFrames(next);
}

/**
 * User resize of an IF frame. Presentation only: positions and semantics
 * are untouched. Sizes are clamped up to the minimum, and content that
 * already needs more room keeps the frame at least that large.
 */
export function setNodeFrameSize(project: VisualProject, id: string, size: IfFrameSize): VisualProject {
  const node = project.nodes.find(n => n.id === id);
  if (!node || node.kind !== 'if') return project;
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height)) return project;
  const clamped = clampFrameSize(size);
  const current = project.frameSizes?.[id] ?? IF_DEFAULT_SIZE;
  if (current.width === clamped.width && current.height === clamped.height) {
    // Already at that size; only expansion via content can move it further.
    return expandIfFrames(project);
  }
  return expandIfFrames({ ...project, frameSizes: { ...project.frameSizes, [id]: clamped } });
}
