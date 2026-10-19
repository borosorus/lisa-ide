import {
  clampFrameSize, createId, IF_DEFAULT_SIZE,
  type ContractResource, type GraphEdge, type GraphNode, type IfBranch, type IfFrameSize, type ScopeTarget, type Vec2, type VisualProject,
} from './model';
import { descendants, expandIfFrames } from './containment';
import { tryOutputGates } from './validate';

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

/** Clear the graph while keeping imported contract resources available. */
export function resetCanvas(project: VisualProject): VisualProject {
  return { ...project, nodes: [], edges: [], positions: {}, frameSizes: {} };
}

/**
 * Duplicate one node, or an IF and its nested contents. Input edges into the
 * copied group are cloned so the copy keeps its inputs; output edges leaving
 * the group stay with the original to avoid silently rewiring consumers.
 */
export function duplicateNode(
  project: VisualProject,
  sourceId: string,
  position: Vec2,
): { project: VisualProject; nodeId: string; externalTryResultsOmitted: boolean } | null {
  const source = project.nodes.find(node => node.id === sourceId);
  if (!source) return null;

  const copiedIds = new Set([sourceId, ...(source.kind === 'if' ? descendants(project, sourceId) : [])]);
  const originals = project.nodes.filter(node => copiedIds.has(node.id));
  const idMap = new Map<string, string>();
  const usedNodeIds = project.nodes.map(node => node.id);
  for (const node of originals) {
    const id = createId(usedNodeIds, 'dup');
    usedNodeIds.push(id);
    idMap.set(node.id, id);
  }

  const sourcePosition = project.positions[sourceId] ?? { x: 0, y: 0 };
  const delta = { x: position.x - sourcePosition.x, y: position.y - sourcePosition.y };
  const cloneNode = (node: GraphNode): GraphNode => {
    const id = idMap.get(node.id)!;
    const parent = node.parent === undefined ? undefined : idMap.get(node.parent) ?? node.parent;
    let clone = {
      ...node,
      id,
      ...(parent === undefined ? {} : { parent }),
    } as GraphNode;
    if (node.parent !== undefined && parent === undefined) {
      const { parent: _parent, branch: _branch, ...unscoped } = clone;
      clone = unscoped as GraphNode;
    }
    if (clone.kind === 'if' && clone.autoSuccessFor !== undefined) {
      const owner = idMap.get(clone.autoSuccessFor);
      if (owner !== undefined) clone = { ...clone, autoSuccessFor: owner };
      else {
        const { autoSuccessFor: _owner, ...manual } = clone;
        clone = manual;
      }
    }
    return clone;
  };
  const copiedNodes = originals.map(cloneNode);
  const nodesById = new Map(project.nodes.map(node => [node.id, node] as const));
  const tryGates = tryOutputGates(project);
  // A decoded try-call result belongs to one success IF. When that IF is
  // duplicated without its producing call, sharing the external result edges
  // would split consumers across two gates and invalidate the original graph.
  const externalTryCalls = new Set(project.edges.flatMap(edge => {
    if (!copiedIds.has(edge.to.node) || edge.to.port !== 'condition' || edge.from.port !== 'success'
        || copiedIds.has(edge.from.node)) return [];
    const owner = nodesById.get(edge.from.node);
    return owner?.kind === 'call' && tryGates.get(owner.id) === edge.to.node ? [owner.id] : [];
  }));
  let externalTryResultsOmitted = false;
  const usedEdgeIds = project.edges.map(edge => edge.id);
  const copiedEdges = project.edges
    .filter(edge => {
      if (!copiedIds.has(edge.to.node)) return false;
      const owner = nodesById.get(edge.from.node);
      if (owner?.kind === 'call' && externalTryCalls.has(owner.id) && /^out:\d+$/.test(edge.from.port)) {
        externalTryResultsOmitted = true;
        return false;
      }
      return true;
    })
    .map(edge => {
      const id = createId(usedEdgeIds, 'e');
      usedEdgeIds.push(id);
      return {
        id,
        from: { ...edge.from, node: idMap.get(edge.from.node) ?? edge.from.node },
        to: { ...edge.to, node: idMap.get(edge.to.node)! },
      };
    });
  const positions = { ...project.positions };
  for (const node of originals) {
    const id = idMap.get(node.id)!;
    const at = project.positions[node.id] ?? { x: 0, y: 0 };
    positions[id] = { x: at.x + delta.x, y: at.y + delta.y };
  }
  positions[idMap.get(sourceId)!] = position;
  const frameSizes = { ...project.frameSizes };
  for (const node of originals) {
    if (node.kind !== 'if') continue;
    const size = project.frameSizes[node.id];
    if (size) frameSizes[idMap.get(node.id)!] = { ...size };
  }
  const next: VisualProject = {
    ...project,
    nodes: [...project.nodes, ...copiedNodes],
    edges: [...project.edges, ...copiedEdges],
    positions,
    frameSizes,
  };
  return { project: expandIfFrames(next), nodeId: idMap.get(sourceId)!, externalTryResultsOmitted };
}

/**
 * Change how a call handles failure. Continue always has an explicit success
 * branch: reuse a matching connected IF or insert an owned IF immediately
 * after the call in project order. Revert removes an empty owned scaffold;
 * populated branches must be cleared by the user first.
 */
export function setCallFailureMode(
  project: VisualProject,
  callId: string,
  mode: 'revert' | 'continue',
  scaffold?: { id: string; position: Vec2 },
): { project: VisualProject; successIfId?: string; message?: string } {
  const callIndex = project.nodes.findIndex(node => node.id === callId);
  const call = project.nodes[callIndex];
  if (callIndex < 0 || !call || !['call', 'rawcall', 'send'].includes(call.kind)) return { project };

  if (mode === 'continue') {
    const scopedMatch = project.edges.find(edge => edge.from.node === callId && edge.from.port === 'success' &&
      edge.to.port === 'condition' && project.nodes.some(node => node.id === edge.to.node && node.kind === 'if' &&
        node.parent === call.parent && (node.parent === undefined || (node.branch ?? 'then') === (call.branch ?? 'then'))));
    const gateId = scopedMatch?.to.node;
    let next = updateNode(project, callId, { failureMode: mode });
    if (gateId) return { project: next, successIfId: gateId };
    if (!scaffold) return { project: next };
    const gate: GraphNode = { id: scaffold.id, kind: 'if', autoSuccessFor: callId,
      ...(call.parent === undefined ? {} : { parent: call.parent, branch: call.branch ?? 'then' }) };
    next = addNode(next, gate, scaffold.position);
    const ordered = [...next.nodes];
    const insertedIndex = ordered.findIndex(node => node.id === gate.id);
    ordered.splice(insertedIndex, 1);
    const updatedCallIndex = ordered.findIndex(node => node.id === callId);
    ordered.splice(updatedCallIndex + 1, 0, gate);
    next = { ...next, nodes: ordered };
    next = addEdge(next, { from: { node: callId, port: 'success' }, to: { node: gate.id, port: 'condition' } });
    return { project: next, successIfId: gate.id };
  }

  const ownedGate = project.nodes.find(node => node.kind === 'if' && node.autoSuccessFor === callId);
  if (ownedGate) {
    const gateEdge = project.edges.find(edge => edge.from.node === callId && edge.from.port === 'success' &&
      edge.to.node === ownedGate.id && edge.to.port === 'condition');
    if (!gateEdge) {
      if (project.edges.some(edge => edge.from.node === callId && edge.from.port === 'success')) {
        return { project, message: 'Disconnect the success output before switching back to Revert.' };
      }
      const reverted = updateNode(project, callId, { failureMode: mode });
      return { project: { ...reverted, nodes: reverted.nodes.map(node => {
        if (node.kind !== 'if' || node.id !== ownedGate.id) return node;
        const { autoSuccessFor: _owner, ...manualGate } = node;
        return manualGate;
      }) } };
    }
    const hasChildren = project.nodes.some(node => node.parent === ownedGate.id);
    if (hasChildren) return { project, message: 'Empty this success branch before switching back to Revert.' };
    const successEdges = project.edges.filter(edge => edge.from.node === callId && edge.from.port === 'success');
    if (successEdges.some(edge => edge !== gateEdge)) return { project, message: 'Disconnect other success outputs before switching back to Revert.' };
    let next = updateNode(project, callId, { failureMode: mode });
    next = removeNodes(next, [ownedGate.id]);
    return { project: next };
  }
  const connectedGate = project.edges.some(edge => edge.from.node === callId && edge.from.port === 'success');
  if (connectedGate) return { project, message: 'Disconnect the success output before switching back to Revert.' };
  return { project: updateNode(project, callId, { failureMode: mode }) };
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
  // A call owns its autogenerated empty gate. When the call is removed, drop
  // that empty scaffold too; if it contains user work, keep the IF and detach
  // the ownership marker so the user's branch is not silently cascaded.
  const ownedGates = project.nodes.filter(node => node.kind === 'if' && node.autoSuccessFor && doomed.has(node.autoSuccessFor) &&
    project.edges.some(edge => edge.from.node === node.autoSuccessFor && edge.from.port === 'success' &&
      edge.to.node === node.id && edge.to.port === 'condition'));
  for (const gate of ownedGates) {
    if (!project.nodes.some(node => node.parent === gate.id)) doomed.add(gate.id);
  }
  const touches = (edge: GraphEdge, set: Set<string>) =>
    set.has(edge.from.node) || set.has(edge.to.node);
  const nodes = project.nodes.filter(n => !doomed.has(n.id)).map(node =>
    node.kind === 'if' && node.autoSuccessFor && doomed.has(node.autoSuccessFor)
      ? (({ autoSuccessFor: _owner, ...rest }) => rest)(node)
      : node);
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
