import {
  inputPorts, outputPorts, canConnect, type PortSpec,
} from './ports';
import type { GraphNode, VisualProject } from './model';

/**
 * Graph-level validation and deterministic ordering, run before lowering.
 * Errors are phrased at graph level (node + port) so the canvas can point
 * at them instead of surfacing compiler internals.
 */

export interface GraphDiagnostic {
  readonly message: string;
  readonly node?: string;
  readonly port?: string;
}

export function validateProject(project: VisualProject): GraphDiagnostic[] {
  const diagnostics: GraphDiagnostic[] = [];
  const byId = new Map<string, GraphNode>();
  for (const node of project.nodes) {
    if (byId.has(node.id)) diagnostics.push({ node: node.id, message: `Duplicate node id: ${node.id}` });
    byId.set(node.id, node);
  }
  const edgeIds = new Set<string>();
  for (const edge of project.edges) {
    if (edgeIds.has(edge.id)) diagnostics.push({ message: `Duplicate edge id: ${edge.id}` });
    edgeIds.add(edge.id);
  }

  for (const node of project.nodes) {
    const chain = new Set<string>([node.id]);
    let parent = node.parent;
    while (parent !== undefined) {
      if (chain.has(parent)) {
        diagnostics.push({ node: node.id, message: 'Node is nested inside itself through a cycle of IF blocks' });
        break;
      }
      chain.add(parent);
      const parentIf = byId.get(parent);
      if (!parentIf) {
        diagnostics.push({ node: node.id, message: 'Belongs to a missing IF block' });
        break;
      }
      if (parentIf.kind !== 'if') {
        diagnostics.push({ node: node.id, message: `Parent "${parent}" is not an IF block` });
        break;
      }
      parent = parentIf.parent;
    }
    if (node.kind === 'call') {
      const contract = project.contracts.find(c => c.id === node.contractId);
      if (!contract) diagnostics.push({ node: node.id, message: 'References a missing contract resource' });
      else if (!contract.functions.some(f => f.signature === node.signature)) {
        diagnostics.push({ node: node.id, message: `Contract "${contract.name}" no longer has ${node.signature}` });
      }
    }
    if (node.kind === 'literal') {
      const ok = node.literalType === 'uint' ? /^(0x[0-9a-fA-F]+|\d+)$/.test(node.literal)
        : node.literalType === 'address' ? /^0x[0-9a-fA-F]{40}$/.test(node.literal)
        : node.literal === 'true' || node.literal === 'false';
      if (!ok) diagnostics.push({ node: node.id, message: `Literal "${node.literal}" is not a valid ${node.literalType}` });
    }
    if (node.kind === 'return' && node.decoder === 'word'
        && !(Number.isSafeInteger(node.offset ?? 0) && (node.offset ?? 0) >= 0 && (node.offset ?? 0) % 32 === 0)) {
      diagnostics.push({ node: node.id, message: 'word() offset must be a non-negative multiple of 32' });
    }
  }

  const drivers = new Map<string, number>();
  for (const edge of project.edges) {
    const source = byId.get(edge.from.node);
    const target = byId.get(edge.to.node);
    if (!source) { diagnostics.push({ node: edge.to.node, message: `Edge source node "${edge.from.node}" is missing` }); continue; }
    if (!target) { diagnostics.push({ node: edge.from.node, message: `Edge target node "${edge.to.node}" is missing` }); continue; }
    const sourcePort = outputPorts(source).find(p => p.name === edge.from.port);
    const targetPort = inputPorts(target, project).find(p => p.name === edge.to.port);
    if (!sourcePort) { diagnostics.push({ node: source.id, port: edge.from.port, message: `Output port "${edge.from.port}" no longer exists` }); continue; }
    if (!targetPort) { diagnostics.push({ node: target.id, port: edge.to.port, message: `Input port "${edge.to.port}" no longer exists` }); continue; }
    if (!canConnect(sourcePort, targetPort)) {
      diagnostics.push({
        node: target.id, port: edge.to.port,
        message: `Cannot feed ${targetPort.label} from a ${sourcePort.kind} output`,
      });
    }
    const key = `${edge.to.node}:${edge.to.port}`;
    drivers.set(key, (drivers.get(key) ?? 0) + 1);
    if (source.id === target.id) {
      diagnostics.push({ node: source.id, message: 'Node feeds itself' });
    } else if (!inScope(source, target, byId)) {
      diagnostics.push({
        node: target.id,
        message: 'Value produced inside an IF block cannot be used outside that block',
      });
    } else if (edge.from.port === 'result' && (source.parent ?? '') !== (target.parent ?? '')) {
      diagnostics.push({
        node: target.id,
        message: 'Return data must be decoded in the same IF block as its call',
      });
    }
  }
  for (const node of project.nodes) {
    for (const port of inputPorts(node, project)) {
      const count = drivers.get(`${node.id}:${port.name}`) ?? 0;
      if (count > 1) diagnostics.push({ node: node.id, port: port.name, message: `${port.label} has ${count} inputs; connect exactly one` });
      if (count === 0 && !(node.kind === 'call' && port.name === 'value')) {
        diagnostics.push({ node: node.id, port: port.name, message: `${port.label} is missing an input` });
      }
    }
  }

  const { cycle } = stableOrder(project);
  if (cycle.length > 0) {
    diagnostics.push({ node: cycle[0], message: `Value cycle detected through: ${cycle.join(' → ')}` });
  }
  return diagnostics;
}

/**
 * Deterministic emission order: dependencies first; among independent
 * nodes, the order they were added to the project (array order), never
 * canvas positions.
 */
export function stableOrder(project: VisualProject): { order: string[]; cycle: string[] } {
  const byId = new Map(project.nodes.map(n => [n.id, n]));
  const deps = new Map<string, Set<string>>(project.nodes.map(n => [n.id, new Set<string>()]));
  for (const edge of project.edges) {
    if (edge.from.node === edge.to.node) continue;
    if (!byId.has(edge.from.node) || !byId.has(edge.to.node)) continue;
    deps.get(edge.to.node)?.add(edge.from.node);
  }
  // A body node's constants are emitted inside its IF statement, so the IF
  // block itself must wait for everything its body depends on.
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of project.nodes) {
      if (!node.parent) continue;
      const set = deps.get(node.parent);
      const own = deps.get(node.id);
      if (!set || !own) continue;
      if (!set.has(node.id)) { set.add(node.id); changed = true; }
      for (const d of own) if (!set.has(d)) { set.add(d); changed = true; }
    }
  }
  const done = new Set<string>();
  const order: string[] = [];
  while (order.length < project.nodes.length) {
    const next = project.nodes.find(n => !done.has(n.id) && [...deps.get(n.id)!].every(d => done.has(d)));
    if (!next) break;
    done.add(next.id);
    order.push(next.id);
  }
  return { order, cycle: project.nodes.filter(n => !done.has(n.id)).map(n => n.id) };
}

/** Ids of IF blocks enclosing a node, outermost first. */
export function scopeChain(node: GraphNode, byId: Map<string, GraphNode>): string[] {
  const chain: string[] = [];
  let parent = node.parent;
  const guard = new Set<string>([node.id]);
  while (parent !== undefined && !guard.has(parent)) {
    guard.add(parent);
    chain.push(parent);
    parent = byId.get(parent)?.parent;
  }
  return chain.reverse();
}

/** A value may only flow into an equal-or-deeper scope than it was produced in. */
function inScope(source: GraphNode, target: GraphNode, byId: Map<string, GraphNode>): boolean {
  const sourceScope = scopeChain(source, byId);
  const targetScope = scopeChain(target, byId);
  if (sourceScope.length <= targetScope.length) {
    return sourceScope.every((id, index) => targetScope[index] === id);
  }
  return false;
}

export type { PortSpec };
