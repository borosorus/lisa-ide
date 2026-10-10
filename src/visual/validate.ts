import {
  inputPorts, outputPorts, canConnect, type PortSpec,
} from './ports';
import { isBytesHex } from '../compile/hex';
import { isValidLiteral, type GraphNode, type IfBranch, type VisualProject } from './model';

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

/** Everything wrong with one node: all messages, and the ports implicated. */
export interface NodeErrors {
  readonly messages: readonly string[];
  readonly ports: ReadonlySet<string>;
}

/**
 * Group diagnostics by node for canvas rendering. Node-less diagnostics
 * belong only to the global summary; a diagnostic naming a port marks both
 * the port and its node. Pure — components must not re-derive validity.
 */
export function indexDiagnostics(diagnostics: readonly GraphDiagnostic[]): ReadonlyMap<string, NodeErrors> {
  const byNode = new Map<string, { messages: string[]; ports: Set<string> }>();
  for (const d of diagnostics) {
    if (!d.node) continue;
    const entry = byNode.get(d.node) ?? { messages: [], ports: new Set<string>() };
    entry.messages.push(d.message);
    if (d.port) entry.ports.add(d.port);
    byNode.set(d.node, entry);
  }
  return new Map([...byNode].map(([id, e]) => [id, { messages: e.messages, ports: e.ports } as NodeErrors]));
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
    // Branch invariants: membership is semantic and only exists inside a block.
    if (node.parent === undefined && node.branch !== undefined) {
      diagnostics.push({ node: node.id, message: 'Names an IF branch without belonging to an IF block' });
    }
    if (node.branch === 'else') {
      const directParent = node.parent === undefined ? undefined : byId.get(node.parent);
      if (directParent?.kind === 'if' && directParent.hasElse !== true) {
        diagnostics.push({ node: node.id, message: 'Sits in an ELSE branch, but its IF block has no ELSE' });
      }
    }
    if (node.kind === 'call') {
      const contract = project.contracts.find(c => c.id === node.contractId);
      if (!contract) diagnostics.push({ node: node.id, message: 'References a missing contract resource' });
      else if (!contract.functions.some(f => f.signature === node.signature)) {
        diagnostics.push({ node: node.id, message: `Contract "${contract.name}" no longer has ${node.signature}` });
      }
    }
    if (node.kind === 'literal' && !isValidLiteral(node.literalType, node.literal)) {
      diagnostics.push({ node: node.id, message: `Literal "${node.literal}" is not a valid ${node.literalType}` });
    }
    if (node.kind === 'keccak' && !isBytesHex(node.data)) {
      diagnostics.push({ node: node.id, message: `Hash data "${node.data}" is not 0x-prefixed byte data` });
    }
    if (node.kind === 'rawcall' && !isBytesHex(node.calldata)) {
      // The field row is marked through the port set: 'calldata' is a field,
      // not a port, but the canvas marks either the same way.
      diagnostics.push({ node: node.id, port: 'calldata', message: `Calldata "${node.calldata}" is not 0x-prefixed byte data` });
    }
  }

  const drivers = new Map<string, number>();
  for (const edge of project.edges) {
    const source = byId.get(edge.from.node);
    const target = byId.get(edge.to.node);
    if (!source) { diagnostics.push({ node: edge.to.node, message: `Edge source node "${edge.from.node}" is missing` }); continue; }
    if (!target) { diagnostics.push({ node: edge.from.node, message: `Edge target node "${edge.to.node}" is missing` }); continue; }
    const sourcePort = outputPorts(source, project).find(p => p.name === edge.from.port);
    const targetPort = inputPorts(target, project).find(p => p.name === edge.to.port);
    if (!sourcePort) { diagnostics.push({ node: source.id, port: edge.from.port, message: `Output port "${edge.from.port}" no longer exists` }); continue; }
    if (!targetPort) { diagnostics.push({ node: target.id, port: edge.to.port, message: `Input port "${edge.to.port}" no longer exists` }); continue; }
    if (sourcePort.connectable === false || targetPort.connectable === false) {
      diagnostics.push({
        node: target.id, port: edge.to.port,
        message: `Cannot connect through ${sourcePort.name}: ${sourcePort.reason ?? 'port is not connectable'}`,
      });
    } else if (!canConnect(sourcePort, targetPort)) {
      diagnostics.push({
        node: target.id, port: edge.to.port,
        message: `Cannot feed ${targetPort.label} from a ${sourcePort.kind} output`,
      });
    }
    const key = `${edge.to.node}:${edge.to.port}`;
    drivers.set(key, (drivers.get(key) ?? 0) + 1);
    if (source.id === target.id) {
      diagnostics.push({ node: source.id, message: 'Node feeds itself' });
    } else {
      const violation = scopeViolation(source, target, byId);
      if (violation) diagnostics.push({ node: target.id, message: violation });
    }
  }
  const live = emittedReach(project);

  for (const node of project.nodes) {
    for (const port of inputPorts(node, project)) {
      const count = drivers.get(`${node.id}:${port.name}`) ?? 0;
      if (count > 1) diagnostics.push({ node: node.id, port: port.name, message: `${port.label} has ${count} inputs; connect exactly one` });
      if (count === 0 && !portIsOptional(node, port.name)) {
        diagnostics.push({ node: node.id, port: port.name, message: `${port.label} is missing an input` });
      }
    }
    // A balance is an expression with a side effect to read: followed nowhere,
    // it lowers to no instruction at all. Other pure nodes stay inert-but-legal
    // on the canvas, so only the one that looks like a check is refused.
    if (node.kind === 'balance' && !live.has(node.id)) {
      diagnostics.push({ node: node.id, port: 'out', message: 'Balance is never read; connect it to a call input, a guard, or an IF condition' });
    }
  }

  const { cycle } = stableOrder(project);
  if (cycle.length > 0) {
    diagnostics.push({ node: cycle[0], message: `Value cycle detected through: ${cycle.join(' → ')}` });
  }
  return diagnostics;
}

/** Node kinds whose lowering emits a statement whether or not anything reads them. */
const EMITTING = new Set<GraphNode['kind']>(['call', 'if', 'guard', 'keccak', 'send', 'rawcall']);

/**
 * Input ports that may stay unconnected: the payable value of a call and of a
 * raw call lower to an omitted third argument. A Send's value is never
 * optional — an empty transfer is a mistake, not a call.
 */
function portIsOptional(node: GraphNode, port: string): boolean {
  return port === 'value' && (node.kind === 'call' || node.kind === 'rawcall');
}

/**
 * Nodes an emitted statement actually reaches: start at the nodes that lower
 * to statements of their own and follow their inputs backwards. A pure node
 * outside this set contributes no instruction at all, wherever it sits.
 */
function emittedReach(project: VisualProject): Set<string> {
  const inputs = new Map<string, string[]>();
  for (const edge of project.edges) {
    const sources = inputs.get(edge.to.node);
    if (sources) sources.push(edge.from.node);
    else inputs.set(edge.to.node, [edge.from.node]);
  }
  const reached = new Set<string>();
  const pending = project.nodes.filter(node => EMITTING.has(node.kind)).map(node => node.id);
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (reached.has(id)) continue;
    reached.add(id);
    for (const source of inputs.get(id) ?? []) pending.push(source);
  }
  return reached;
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

/** IF scopes enclosing a node, outermost first, each identified by block + branch.
 *  A nested IF belongs to its parent's branch; its own THEN/ELSE entries appear
 *  only in the chains of nodes inside its body. Children saved before ELSE
 *  existed carry no branch and count as THEN. */
export function scopeChain(node: GraphNode, byId: Map<string, GraphNode>): { id: string; branch: IfBranch }[] {
  const chain: { id: string; branch: IfBranch }[] = [];
  let child: GraphNode = node;
  let parent = node.parent;
  const guard = new Set<string>([node.id]);
  while (parent !== undefined && !guard.has(parent)) {
    guard.add(parent);
    chain.push({ id: parent, branch: child.branch === 'else' ? 'else' : 'then' });
    child = byId.get(parent) ?? child;
    parent = byId.get(parent)?.parent;
  }
  return chain.reverse();
}

/**
 * Why a value may not flow from source to target, or undefined when the
 * flow is legal: the source's scope chain must be a prefix of the target's
 * (same scope or a descendant). Also governs result edges: the builder
 * decodes return data in the call's branch and any block nested inside it,
 * never across a sibling or after the join.
 */
export function scopeViolation(source: GraphNode, target: GraphNode, byId: Map<string, GraphNode>): string | undefined {
  const sourceScope = scopeChain(source, byId);
  const targetScope = scopeChain(target, byId);
  const shared = Math.min(sourceScope.length, targetScope.length);
  for (let i = 0; i < shared; i++) {
    if (sourceScope[i].id !== targetScope[i].id || sourceScope[i].branch !== targetScope[i].branch) {
      return 'Value was produced in a different IF branch; branches are separate scopes and never share values';
    }
  }
  if (sourceScope.length > targetScope.length) {
    return 'Value produced inside an IF block cannot be used outside that block';
  }
  return undefined;
}

export type { PortSpec };
