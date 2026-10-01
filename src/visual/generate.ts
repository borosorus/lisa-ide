import {
  isReadFunction, type ContractResource, type GraphNode, type VisualProject,
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
type ReturnNode = Extract<GraphNode, { kind: 'return' }>;

interface Context {
  project: VisualProject;
  byId: Map<string, GraphNode>;
  /** `${node}:${port}` of the single feeding edge, per input port. */
  feed: Map<string, string>;
  /** Return-node ids per call, in stable emission order. */
  returnsByCall: Map<string, string[]>;
  names: NamePool;
}

export function generateVisualSource(project: VisualProject): string {
  const diagnostics = validateProject(project);
  if (diagnostics.length > 0) throw new GraphError(diagnostics);

  const ctx: Context = {
    project,
    byId: new Map(project.nodes.map(n => [n.id, n])),
    feed: new Map(project.edges.map(e => [`${e.to.node}:${e.to.port}`, `${e.from.node}:${e.from.port}`])),
    returnsByCall: new Map(),
    names: new NamePool(),
  };

  for (const contract of project.contracts) {
    if (project.nodes.some(n => n.kind === 'call' && n.contractId === contract.id)) {
      ctx.names.assign(`c_${identifier(contract.name)}`, contractKey(contract));
    }
  }

  const { order } = stableOrder(project);
  for (const id of order) {
    const node = ctx.byId.get(id);
    if (node?.kind !== 'return') continue;
    const source = ctx.feed.get(`${id}:result`);
    if (source) {
      const callId = source.slice(0, source.lastIndexOf(':'));
      ctx.returnsByCall.set(callId, [...(ctx.returnsByCall.get(callId) ?? []), id]);
    }
  }

  const lines: string[] = ['const p = createProgram();'];
  for (const contract of project.contracts) {
    const varName = ctx.names.get(contractKey(contract));
    if (varName) push(lines, '', `const ${varName} = "${contract.address.toLowerCase()}";`);
  }
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

  const decoders = ctx.returnsByCall.get(node.id) ?? [];
  if (decoders.length === 0) {
    lines.push(`${pad}${callText};`);
  } else if (decoders.length === 1) {
    const ret = ctx.byId.get(decoders[0]) as ReturnNode;
    lines.push(`${pad}const ${ctx.names.assign(`${identifier(fn.name)}_${identifier(node.id)}`, `ret:${ret.id}`)} = ${callText}.${decoderCall(ret)};`);
  } else {
    const handle = ctx.names.assign(`r_${identifier(node.id)}`, `call:${node.id}`);
    lines.push(`${pad}const ${handle} = ${callText};`);
    for (const retId of decoders) {
      const ret = ctx.byId.get(retId) as ReturnNode;
      const varName = ctx.names.assign(`${identifier(fn.name)}_${decoderTag(ret)}_${identifier(ret.id)}`, `ret:${retId}`);
      lines.push(`${pad}const ${varName} = ${handle}.${decoderCall(ret)};`);
    }
  }
}

/** Expression text for whatever feeds `${nodeId}:${port}`; pure nodes inline. */
function exprOf(ctx: Context, nodeId: string, port: string): string {
  const source = ctx.feed.get(`${nodeId}:${port}`);
  if (!source) throw new GraphError([{ node: nodeId, port, message: `Input port "${port}" has no source` }]);
  return exprOfSource(ctx, source);
}

/** Source keys are `${nodeId}:${port}` where ports never contain ':'. */
function exprOfSource(ctx: Context, sourceKey: string): string {
  const nodeId = sourceKey.slice(0, sourceKey.lastIndexOf(':'));
  const node = ctx.byId.get(nodeId);
  if (!node) throw new GraphError([{ node: nodeId, message: `Missing node "${nodeId}"` }]);
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
    case 'return': {
      const name = ctx.names.get(`ret:${nodeId}`);
      if (!name) {
        throw new GraphError([{ node: nodeId, message: 'Decoder was never emitted before use' }]);
      }
      return name;
    }
    default:
      throw new GraphError([{ node: nodeId, message: `Node "${nodeId}" cannot produce a value` }]);
  }
}

function literalText(node: Extract<GraphNode, { kind: 'literal' }>): string {
  if (node.literalType === 'address') return `"${node.literal.toLowerCase()}"`;
  if (node.literalType === 'bool') return node.literal;
  return `${BigInt(node.literal).toString(10)}n`;
}

function decoderCall(node: ReturnNode): string {
  return node.decoder === 'word' ? `word(${node.offset ?? 0})` : `${node.decoder}()`;
}

function decoderTag(node: ReturnNode): string {
  return node.decoder === 'word' ? `w${(node.offset ?? 0) / 32}` : node.decoder;
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
