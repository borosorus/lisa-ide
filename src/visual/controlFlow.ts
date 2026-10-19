import type { GraphEdge, GraphNode, VisualProject } from './model';

export function isContainer(node: GraphNode): node is Extract<GraphNode, { kind: 'if' | 'else' }> {
  return node.kind === 'if' || node.kind === 'else';
}

export function pairedElse(project: VisualProject, ifId: string): GraphNode | undefined {
  const node = project.nodes.find(candidate => candidate.id === ifId);
  if (node?.kind !== 'if') return undefined;
  const edge = project.edges.find(candidate => candidate.kind === 'control' && candidate.from.node === ifId
    && candidate.from.port === 'else' && candidate.to.port === 'if');
  const branch = edge && project.nodes.find(candidate => candidate.id === edge.to.node);
  return branch?.kind === 'else' && branch.parent === node.parent ? branch : undefined;
}

export function pairedIf(project: VisualProject, elseId: string): GraphNode | undefined {
  const node = project.nodes.find(candidate => candidate.id === elseId);
  if (node?.kind !== 'else') return undefined;
  const edge = project.edges.find(candidate => candidate.kind === 'control' && candidate.to.node === elseId
    && candidate.to.port === 'if' && candidate.from.port === 'else');
  const parent = edge && project.nodes.find(candidate => candidate.id === edge.from.node);
  return parent?.kind === 'if' && parent.parent === node.parent ? parent : undefined;
}

export function validElsePair(project: VisualProject, edge: GraphEdge): boolean {
  return edge.kind === 'control' && edge.from.port === 'else' && edge.to.port === 'if'
    && canPairElse(project, edge.from.node, edge.to.node, edge.id);
}

export function canPairElse(project: VisualProject, ifId: string, elseId: string, ignoreEdgeId?: string): boolean {
  const source = project.nodes.find(node => node.id === ifId);
  const target = project.nodes.find(node => node.id === elseId);
  if (source?.kind !== 'if' || target?.kind !== 'else' || source.parent !== target.parent) return false;
  // A new ELSE connection replaces the IF's current link. Its former ELSE
  // becomes an editable orphan; an ELSE already owned by another IF cannot
  // be stolen without deleting that connection first.
  return !project.edges.some(existing => existing.kind === 'control' && existing.id !== ignoreEdgeId
    && (existing.to.node === target.id || (ignoreEdgeId !== undefined && existing.from.node === source.id)));
}

/** Nodes inside a disconnected ELSE (including nested contents) are dormant. */
export function activeNodeIds(project: VisualProject): Set<string> {
  const byId = new Map(project.nodes.map(node => [node.id, node]));
  const active = new Set<string>();
  const isActive = (node: GraphNode, seen = new Set<string>()): boolean => {
    if (active.has(node.id)) return true;
    if (seen.has(node.id)) return false;
    seen.add(node.id);
    if (node.kind === 'else' && !pairedIf(project, node.id)) return false;
    if (node.parent === undefined) return true;
    const parent = byId.get(node.parent);
    return parent !== undefined && isContainer(parent) && isActive(parent, seen);
  };
  for (const node of project.nodes) if (isActive(node)) active.add(node.id);
  return active;
}
