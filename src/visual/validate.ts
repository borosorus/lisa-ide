import {
  inputPorts, outputPorts, canConnect, type PortSpec,
} from './ports';
import { isBytesHex } from '../compile/hex';
import { isStatementNode, isValidLiteral, type GraphNode, type VisualProject } from './model';
import { activeNodeIds, isContainer, pairedElse, validElsePair } from './controlFlow';

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
  const active = activeNodeIds(project);
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
        diagnostics.push({ node: node.id, message: 'Belongs to a missing container' });
        break;
      }
      if (!isContainer(parentIf)) {
        diagnostics.push({ node: node.id, message: `Parent "${parent}" is not a container` });
        break;
      }
      parent = parentIf.parent;
    }
    if (isStatementNode(node) && node.executionAfter !== undefined) {
      const predecessor = byId.get(node.executionAfter);
      if (!predecessor) {
        diagnostics.push({ node: node.id, message: `Execution predecessor "${node.executionAfter}" is missing` });
      } else if (!isStatementNode(predecessor)) {
        diagnostics.push({ node: node.id, message: 'Execution order must reference another statement' });
      } else if (predecessor.id === node.id) {
        diagnostics.push({ node: node.id, message: 'A statement cannot run after itself' });
      } else if (active.has(node.id) && !active.has(predecessor.id)) {
        diagnostics.push({ node: node.id, message: 'Execution order cannot reference an inactive ELSE branch' });
      } else if (predecessor.parent !== node.parent) {
        diagnostics.push({ node: node.id, message: 'Execution order can only reference a statement in the same scope' });
      }
    }
    if (!active.has(node.id)) continue;
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
    if (edge.kind === 'control') {
      if (!validElsePair(project, edge)) diagnostics.push({ node: target.id, port: edge.to.port,
        message: 'Control connections must pair one sibling IF with one ELSE container' });
      else drivers.set(`${target.id}:${edge.to.port}`, (drivers.get(`${target.id}:${edge.to.port}`) ?? 0) + 1);
      continue;
    }
    if (!active.has(target.id)) continue;
    if (!active.has(source.id)) {
      diagnostics.push({ node: target.id, port: edge.to.port, message: 'Cannot use a node from an ELSE container that is not connected to an IF' });
      continue;
    }
    const sourcePort = outputPorts(source, project).find(p => p.name === edge.from.port);
    const targetPort = inputPorts(target, project).find(p => p.name === edge.to.port);
    if (!sourcePort) { diagnostics.push({ node: source.id, port: edge.from.port, message: `Output port "${edge.from.port}" no longer exists` }); continue; }
    if (!targetPort) { diagnostics.push({ node: target.id, port: edge.to.port, message: `Input port "${edge.to.port}" no longer exists` }); continue; }
    if (sourcePort.kind === 'control' || targetPort.kind === 'control') {
      diagnostics.push({ node: target.id, port: edge.to.port, message: 'IF/ELSE links must use a control connection' });
    } else if (sourcePort.connectable === false || targetPort.connectable === false) {
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
    if (!active.has(node.id)) continue;
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
    diagnostics.push({ node: cycle[0], message: `Execution dependency cycle detected through: ${cycle.join(' → ')}` });
  }
  if (diagnostics.length === 0) diagnostics.push(...validateTryResults(project));
  return diagnostics;
}

/** The IF whose successful arm owns each try-call's decoded ABI outputs. */
export function tryOutputGates(project: VisualProject): Map<string, string> {
  const byId = new Map(project.nodes.map(node => [node.id, node]));
  const active = activeNodeIds(project);
  const gates = new Map<string, string>();
  for (const call of project.nodes) {
    if (!active.has(call.id) || call.kind !== 'call' || call.failureMode !== 'continue') continue;
    const outputEdges = project.edges.filter(edge => edge.kind !== 'control' && edge.from.node === call.id
      && active.has(edge.to.node) && /^out:\d+$/.test(edge.from.port));
    if (outputEdges.length === 0) continue;
    const candidates = project.edges
      .filter(edge => edge.kind !== 'control' && edge.from.node === call.id && edge.from.port === 'success'
        && edge.to.port === 'condition' && byId.get(edge.to.node)?.kind === 'if')
      .map(edge => byId.get(edge.to.node)!)
      .sort((a, b) => scopeChain(a, byId).length - scopeChain(b, byId).length);
    const gate = candidates.find(candidate => outputEdges.every(edge => {
      const target = byId.get(edge.to.node);
      return target && active.has(target.id) && scopeChain(target, byId).includes(candidate.id);
    }));
    if (gate) gates.set(call.id, gate.id);
  }
  return gates;
}

function validateTryResults(project: VisualProject): GraphDiagnostic[] {
  const diagnostics: GraphDiagnostic[] = [];
  const gates = tryOutputGates(project);
  const byId = new Map(project.nodes.map(node => [node.id, node]));
  const active = activeNodeIds(project);
  for (const call of project.nodes) {
    if (!active.has(call.id) || call.kind !== 'call' || call.failureMode !== 'continue') continue;
    const outputEdges = project.edges.filter(edge => edge.kind !== 'control' && edge.from.node === call.id
      && active.has(edge.to.node) && /^out:\d+$/.test(edge.from.port));
    if (outputEdges.length > 0 && !gates.has(call.id)) {
      for (const edge of outputEdges) {
        diagnostics.push({ node: edge.to.node, port: edge.to.port,
          message: 'Try-call return data must be used inside the THEN branch of an IF driven by this call’s success output' });
      }
    }
  }
  if (diagnostics.length > 0) return diagnostics;

  const gatesByIf = new Map<string, string[]>();
  for (const [callId, ifId] of gates) {
    const calls = gatesByIf.get(ifId) ?? [];
    calls.push(callId);
    gatesByIf.set(ifId, calls);
  }
  const { order } = stableOrder(project);
  // Walk the same scope and statement order used by source generation. Any
  // outbound call replaces returndata; an IF preserves it past the join only
  // when both paths leave the same call as the most recent one.
  function visitScope(parent: string | undefined, incoming: string | null): string | null {
    let live = incoming;
    for (const id of order) {
      const node = byId.get(id)!;
      if (!active.has(node.id) || node.parent !== parent || node.kind === 'else') continue;
      if (node.kind === 'if') {
        for (const callId of gatesByIf.get(node.id) ?? []) {
          if (live !== callId) diagnostics.push({ node: node.id, port: 'condition',
            message: `Return data from ${callId} was replaced before its success branch; move that IF before other calls` });
        }
        const thenLive = visitScope(node.id, live);
        const paired = pairedElse(project, node.id);
        const elseLive = paired ? visitScope(paired.id, live) : live;
        live = thenLive === elseLive ? thenLive : null;
      } else if (node.kind === 'call' || node.kind === 'rawcall' || node.kind === 'send') {
        live = node.id;
      }
    }
    return live;
  }
  visitScope(undefined, null);
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
  return port === 'if' || (port === 'value' && (node.kind === 'call' || node.kind === 'rawcall'));
}

/**
 * Nodes an emitted statement actually reaches: start at the nodes that lower
 * to statements of their own and follow their inputs backwards. A pure node
 * outside this set contributes no instruction at all, wherever it sits.
 */
function emittedReach(project: VisualProject): Set<string> {
  const inputs = new Map<string, string[]>();
  for (const edge of project.edges) {
    if (edge.kind === 'control') continue;
    const sources = inputs.get(edge.to.node);
    if (sources) sources.push(edge.from.node);
    else inputs.set(edge.to.node, [edge.from.node]);
  }
  const reached = new Set<string>();
  const active = activeNodeIds(project);
  const pending = project.nodes.filter(node => active.has(node.id) && node.kind !== 'else' && EMITTING.has(node.kind)).map(node => node.id);
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
  const active = activeNodeIds(project);
  const nodes = project.nodes.filter(node => active.has(node.id));
  const byId = new Map(nodes.map(n => [n.id, n]));
  const deps = new Map<string, Set<string>>(nodes.map(n => [n.id, new Set<string>()]));
  for (const edge of project.edges) {
    if (edge.kind === 'control') continue;
    if (edge.from.node === edge.to.node) continue;
    if (!byId.has(edge.from.node) || !byId.has(edge.to.node)) continue;
    deps.get(edge.to.node)?.add(edge.from.node);
  }
  for (const node of nodes) {
    if (!isStatementNode(node) || !node.executionAfter || !byId.has(node.executionAfter)) continue;
    deps.get(node.id)?.add(node.executionAfter);
  }
  // The parent IF waits for producers inside both bodies, while the paired
  // ELSE itself is emitted only inside that IF and is never a root statement.
  for (const node of nodes) {
    if (node.kind !== 'if') continue;
    const paired = pairedElse(project, node.id);
    if (paired && active.has(paired.id)) deps.get(node.id)?.add(paired.id);
  }
  // A body node's constants are emitted inside its IF statement, so the IF
  // block itself must wait for everything its body depends on.
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
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
  while (order.length < nodes.length) {
    const next = nodes.find(n => !done.has(n.id) && [...deps.get(n.id)!].every(d => done.has(d)));
    if (!next) break;
    done.add(next.id);
    order.push(next.id);
  }
  return { order, cycle: nodes.filter(n => !done.has(n.id)).map(n => n.id) };
}

/** IF scopes enclosing a node, outermost first, each identified by block + branch.
 *  A nested IF belongs to its parent's branch; its own THEN/ELSE entries appear
 *  only in the chains of nodes inside its body. Children saved before ELSE
 *  existed carry no branch and count as THEN. */
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
    if (sourceScope[i] !== targetScope[i]) return 'Value was produced in a different container scope; sibling scopes never share values';
  }
  if (sourceScope.length > targetScope.length) {
    return 'Value produced inside a branch container cannot be used outside that container';
  }
  return undefined;
}

export type { PortSpec };
