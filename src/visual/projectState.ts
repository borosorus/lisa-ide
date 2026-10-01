import {
  createId,
  type ContractResource, type GraphEdge, type GraphNode, type Vec2, type VisualProject,
} from './model';

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
  return {
    ...project,
    nodes: [...project.nodes, node],
    positions: { ...project.positions, [node.id]: position },
  };
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

/** Patch editable node fields; identity (id/kind/parent) stays stable. */
export function updateNode(project: VisualProject, id: string, patch: Record<string, unknown>): VisualProject {
  return {
    ...project,
    nodes: project.nodes.map(n => (n.id === id ? { ...n, ...patch, id: n.id, kind: n.kind } as GraphNode : n)),
  };
}

export function removeEdge(project: VisualProject, id: string): VisualProject {
  return { ...project, edges: project.edges.filter(e => e.id !== id) };
}

export function setNodeParent(project: VisualProject, nodeId: string, parent: string | undefined): VisualProject {
  return {
    ...project,
    nodes: project.nodes.map(n => {
      if (n.id !== nodeId) return n;
      const { parent: _gone, ...rest } = n;
      return parent === undefined ? (rest as VisualProject['nodes'][number]) : { ...rest, parent } as VisualProject['nodes'][number];
    }),
  };
}
