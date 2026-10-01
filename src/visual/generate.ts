import {
  canonicalWordType, isReadFunction, outputHeadOffsets,
  type ContractResource, type GraphEndpoint, type GraphNode, type VisualProject,
} from './model';
import { findFunction } from './ports';
import { stableOrder, validateProject, type GraphDiagnostic } from './validate';

/**
 * Deterministic lowering: graph -> readable LISA authoring source.
 *
 * The generated source IS the compile input: the visual pipeline feeds it to
 * the exact same restricted evaluator the code mode uses, so a graph always
 * compiles to the bytes its generated source describes. Positions never
 * affect output; node and contract order do.
 */

export class GraphError extends Error {
  readonly diagnostics: readonly GraphDiagnostic[];
  constructor(diagnostics: readonly GraphDiagnostic[]) {
    super(diagnostics[0]?.message ?? 'Invalid graph');
    this.name = 'GraphError';
    this.diagnostics = diagnostics;
  }
}

const RESERVED = new Set([
  'p', 'createProgram', 'encodeCall', 'rawCalldata',
  'SELF', 'CALLER', 'GAS', 'TIMESTAMP', 'SELFBALANCE',
]);

type CallNode = Extract<GraphNode, { kind: 'call' }>;

interface Context {
  project: VisualProject;
  byId: Map<string, GraphNode>;
  /** The single feeding edge per input port (`${node}:${port}`). */
  feed: Map<string, GraphEndpoint>;
  /** Output indices consumed from each call, ascending and deduplicated. */
  usedOutputs: Map<string, number[]>;
  names: NamePool;
}

export function generateVisualSource(project: VisualProject): string {
  const diagnostics = validateProject(project);
  if (diagnostics.length > 0) throw new GraphError(diagnostics);

  const ctx: Context = {
    project,
    byId: new Map(project.nodes.map(n => [n.id, n])),
    feed: new Map(project.edges.map(e => [`${e.to.node}:${e.to.port}`, e.from])),
    usedOutputs: collectUsedOutputs(project),
    names: new NamePool(),
  };

  const lines: string[] = ['const p = createProgram();'];
  for (const contract of project.contracts) {
    if (project.nodes.some(n => n.kind === 'call' && n.contractId === contract.id)) {
      const varName = ctx.names.assign(`c_${identifier(contract.name)}`, contractKey(contract));
      push(lines, '', `const ${varName} = "${contract.address.toLowerCase()}";`);
    }
  }
  const { order } = stableOrder(project);
  emitScope(ctx, order, undefined, lines, 0);
  push(lines, '', 'return p;');
  return lines.join('\n');
}

function push(lines: string[], ...texts: string[]): void {
  for (const text of texts) {
    if (text === '') {
      if (lines[lines.length - 1] !== '') lines.push('');
    } else {
      lines.push(text);
    }
  }
}

function collectUsedOutputs(project: VisualProject): Map<string, number[]> {
  const used = new Map<string, Set<number>>();
  for (const edge of project.edges) {
    const index = /^out:(\d+)$/.exec(edge.from.port);
    if (index && project.nodes.some(n => n.id === edge.from.node && n.kind === 'call')) {
      const set = used.get(edge.from.node) ?? new Set<number>();
      set.add(Number(index[1]));
      used.set(edge.from.node, set);
    }
  }
  return new Map([...used].map(([id, set]) => [id, [...set].sort((a, b) => a - b)]));
}

function emitScope(ctx: Context, order: readonly string[], parent: string | undefined, lines: string[], depth: number): void {
  const pad = '  '.repeat(depth);
  for (const id of order) {
    const node = ctx.byId.get(id)!;
    if ((node.parent ?? undefined) !== parent) continue;
    if (node.kind === 'call') {
      if (depth === 0) push(lines, '');
      emitCall(ctx, node, lines, pad);
    } else if (node.kind === 'if') {
      if (depth === 0) push(lines, '');
      lines.push(`${pad}p.if(${exprOf(ctx, id, 'condition')}, () => {`);
      emitScope(ctx, order, id, lines, depth + 1);
      lines.push(`${pad}});`);
    }
  }
}

function emitCall(ctx: Context, node: CallNode, lines: string[], pad: string): void {
  const fn = findFunction(ctx.project, node.contractId, node.signature);
  const contract = ctx.project.contracts.find(c => c.id === node.contractId);
  if (!fn || !contract) throw new GraphError([{ node: node.id, message: 'Missing contract or function' }]);
  const target = ctx.names.get(contractKey(contract)) ?? `"${contract.address.toLowerCase()}"`;
  const args = fn.inputs.map((_, index) => exprOf(ctx, node.id, `arg:${index}`));
  const valueFeed = fn.mutability === 'payable' ? ctx.feed.get(`${node.id}:value`) : undefined;
  const encoded = `encodeCall("${node.signature}"${args.length ? `, [${args.join(', ')}]` : ''})`;
  const callText = `p.${isReadFunction(fn) ? 'staticCall' : 'call'}(${target}, ${encoded}`
    + (valueFeed ? `, ${exprOfSource(ctx, valueFeed)}` : '') + ')';

  // Decoding happens at the call site because return data goes stale after
  // the next call; only outputs an edge consumes get a decoded constant.
  const used = ctx.usedOutputs.get(node.id) ?? [];
  if (used.length === 0) {
    lines.push(`${pad}${callText};`);
  } else if (used.length === 1) {
    const name = ctx.names.assign(`${identifier(fn.name)}_${identifier(node.id)}`, decodeKey(node.id, used[0]));
    lines.push(`${pad}const ${name} = ${callText}.${decoderCall(fn, used[0])};`);
  } else {
    const handle = ctx.names.assign(`r_${identifier(node.id)}`, `call:${node.id}`);
    lines.push(`${pad}const ${handle} = ${callText};`);
    for (const index of used) {
      const name = ctx.names.assign(
        `${identifier(fn.name)}_${identifier(node.id)}_out${index}`, decodeKey(node.id, index),
      );
      lines.push(`${pad}const ${name} = ${handle}.${decoderCall(fn, index)};`);
    }
  }
}

/** The word for output `index` sits at its head offset; word 0 gets its alias. */
function decoderCall(fn: { outputs: readonly string[] }, index: number): string {
  const offset = outputHeadOffsets(fn.outputs)[index] ?? 0;
  if (offset !== 0) return `word(${offset})`;
  const type = canonicalWordType(fn.outputs[index]) ?? 'uint256';
  return type === 'bool' ? 'bool()' : /^bytes\d+$/.test(type) ? 'bytes32()' : 'uint256()';
}

function decodeKey(callId: string, index: number): string {
  return `out:${callId}:${index}`;
}

/** Expression text for whatever feeds an input port; pure nodes inline. */
function exprOf(ctx: Context, nodeId: string, port: string): string {
  const source = ctx.feed.get(`${nodeId}:${port}`);
  if (!source) throw new GraphError([{ node: nodeId, port, message: `Input port "${port}" has no source` }]);
  return exprOfSource(ctx, source);
}

function exprOfSource(ctx: Context, source: GraphEndpoint): string {
  const node = ctx.byId.get(source.node);
  if (!node) throw new GraphError([{ node: source.node, message: `Missing node "${source.node}"` }]);
  switch (node.kind) {
    case 'context':
      return node.name;
    case 'literal':
      return literalText(node);
    case 'binary': {
      const lhs = exprOf(ctx, node.id, 'lhs');
      const rhs = exprOf(ctx, node.id, 'rhs');
      return `(${lhs}).${node.op}(${rhs})`;
    }
    case 'call': {
      const index = /^out:(\d+)$/.exec(source.port)?.[1];
      const name = index === undefined ? undefined : ctx.names.get(decodeKey(node.id, Number(index)));
      if (!name) {
        throw new GraphError([{ node: node.id, port: source.port, message: 'Call output was never decoded at its call site' }]);
      }
      return name;
    }
    default:
      throw new GraphError([{ node: node.id, message: `Node "${node.id}" cannot produce a value` }]);
  }
}

function literalText(node: Extract<GraphNode, { kind: 'literal' }>): string {
  if (node.literalType === 'address') return `"${node.literal.toLowerCase()}"`;
  if (node.literalType === 'bool') return node.literal;
  return `${BigInt(node.literal).toString(10)}n`;
}

function contractKey(contract: ContractResource): string {
  return `contract:${contract.id}`;
}

function identifier(text: string): string {
  let safe = text.replace(/[^A-Za-z0-9_$]/g, '_').replace(/^(\d)/, '_$1');
  if (safe.length === 0) safe = 'x';
  if (RESERVED.has(safe)) safe = `${safe}_`;
  return safe;
}

class NamePool {
  private assigned = new Map<string, string>();
  private used = new Set<string>();

  assign(base: string, key: string): string {
    const existing = this.assigned.get(key);
    if (existing) return existing;
    let candidate = base;
    for (let i = 2; this.used.has(candidate); i++) candidate = `${base}_${i}`;
    this.used.add(candidate);
    this.assigned.set(key, candidate);
    return candidate;
  }

  get(key: string): string | undefined {
    return this.assigned.get(key);
  }
}
