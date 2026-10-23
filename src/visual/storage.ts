import { SOURCE_STORAGE_KEY } from '../editor/sourceStorage';
import {
  BINARY_OPS, clampFrameSize, CONTEXT_NAMES, canonicalWordType, isValidLiteral, outputHeadOffsets,
  emptyProject,
  type BinaryOp, type CallFailureMode, type ContextName, type GraphEdge, type GraphNode, type IfBranch, type IfFrameSize, type Vec2, type VisualProject,
} from './model';
import { canonicalInputType, isValidAddress } from './abi';
import { isBytesHex } from '../compile/hex';
import type { ContractFunction, ContractResource } from './model';
import { migrateEmbeddedElse } from './migrateEmbeddedElse';

/**
 * Versioned project persistence. A malformed save must never brick the app:
 * callers get null and fall back to a fresh project.
 */

export const PROJECT_STORAGE_KEY = 'lisa-ide.project.v1';

export type AuthoringMode = 'code' | 'visual';

export interface StoredProject {
  readonly version: 1 | 2 | 3;
  readonly mode: AuthoringMode;
  readonly codeSource: string | null;
  readonly visual: VisualProject;
}

type ReadStorage = Pick<Storage, 'getItem'>;
type WriteStorage = Pick<Storage, 'setItem'>;

function defaultStorage(): ReadStorage & WriteStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function saveStoredProject(
  project: StoredProject,
  storage: WriteStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(PROJECT_STORAGE_KEY, JSON.stringify(project));
  } catch {
    // Storage failures must not make the in-memory project unusable.
  }
}

/** Load the current project, migrating a legacy v1 code-only draft if needed. */
export function loadStoredProject(
  storage: ReadStorage | null = defaultStorage(),
): StoredProject | null {
  if (!storage) return null;
  let raw: string | null = null;
  try {
    raw = storage.getItem(PROJECT_STORAGE_KEY);
    if (raw === null) {
      const legacy = storage.getItem(SOURCE_STORAGE_KEY);
      return legacy === null ? null : { version: 3, mode: 'code', codeSource: legacy, visual: emptyProject() };
    }
  } catch {
    return null;
  }
  try {
    return parseStoredProject(raw);
  } catch {
    return null;
  }
}

export function parseStoredProject(text: string): StoredProject {
  let candidate: unknown;
  try {
    candidate = JSON.parse(text);
  } catch {
    throw new Error('Saved project is not valid JSON');
  }
  if (!isRecord(candidate)) throw new Error('Saved project must be an object');
  if (candidate.version !== 1 && candidate.version !== 2 && candidate.version !== 3) throw new Error(`Unsupported saved project version: ${String(candidate.version)}`);
  if (candidate.mode !== 'code' && candidate.mode !== 'visual') throw new Error('Saved project mode is invalid');
  if (candidate.codeSource !== null && typeof candidate.codeSource !== 'string') {
    throw new Error('Saved project codeSource must be a string or null');
  }
  const visual = parseVisual(candidate.visual, candidate.version);
  return {
    version: 3,
    mode: candidate.mode,
    codeSource: candidate.codeSource as string | null,
    visual,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseVisual(value: unknown, version: 1 | 2 | 3): VisualProject {
  if (!isRecord(value)) throw new Error('Saved visual project must be an object');
  const contracts = parseItems(value.contracts, parseContract, 'contracts');
  if (!Array.isArray(value.nodes)) throw new Error('Saved nodes must be an array');
  const nodes: GraphNode[] = [];
  const decoders = new Map<string, LegacyDecoder>();
  for (const entry of value.nodes) {
    const node = parseNode(entry);
    if (node) nodes.push(node);
    else {
      const decoder = parseLegacyDecoder(entry);
      if (decoder) decoders.set(decoder.id, decoder);
    }
  }
  const nodeIds = new Set(nodes.map(n => n.id));
  const parsedFrames = parseFrameSizes(value.frameSizes, new Set(nodes.filter(n => n.kind === 'if' || n.kind === 'else').map(n => n.id)));
  const parsedEdges = parseItems(value.edges, parseEdge, 'edges');
  // Fold the old explicit-decoder graphs onto the call's own output ports.
  const { kept, legacy } = splitLegacyEdges(parsedEdges, new Set(decoders.keys()));
  let edges = [...kept, ...foldLegacyDecoders(legacy, decoders, nodes, contracts)]
    .filter(e => nodeIds.has(e.from.node) && nodeIds.has(e.to.node));
  let positions = parsePositions(value.positions);
  let frameSizes = parsedFrames;
  if (version === 1) {
    const migrated = migrateEmbeddedElse({ nodes, edges, positions, frameSizes });
    nodes.splice(0, nodes.length, ...migrated.nodes);
    edges = migrated.edges;
    positions = migrated.positions;
    frameSizes = migrated.frameSizes;
  }
  for (const [index, node] of nodes.entries()) {
    const { branch: _legacyBranch, hasElse: _legacyElse, ...canonical } = node as GraphNode & { hasElse?: boolean };
    nodes[index] = canonical as GraphNode;
  }
  const migratedNodeIds = new Set(nodes.map(n => n.id));
  return {
    contracts,
    nodes,
    edges,
    positions: Object.fromEntries(Object.entries(positions).filter(([id]) => migratedNodeIds.has(id))),
    frameSizes,
  };
}

/** Invalid individual entries are dropped; a malformed container is fatal. */
function parseItems<T>(
  value: unknown, item: (entry: unknown) => T | null, label: string,
): T[] {
  if (!Array.isArray(value)) throw new Error(`Saved ${label} must be an array`);
  return value.map(entry => item(entry)).filter((entry): entry is T => entry !== null);
}

function parseContract(value: unknown): ContractResource | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string') return null;
  if (!isValidAddress(value.address)) return null;
  if (!Array.isArray(value.functions)) return null;
  const functions: ContractFunction[] = [];
  for (const entry of value.functions) {
    if (!isRecord(entry) || typeof entry.signature !== 'string' || typeof entry.name !== 'string') return null;
    const list = (types: unknown): readonly string[] | null => {
      if (!Array.isArray(types) || !types.every(t => typeof t === 'string')) return null;
      return types as string[];
    };
    const inputs = list(entry.inputs);
    const outputs = list(entry.outputs);
    if (!inputs || !outputs) return null;
    if (inputs.some(t => canonicalInputType(t) === null)) return null;
    if (!signatureMatches(entry.signature, entry.name, inputs)) return null;
    const names = (value: unknown, len: number): (string | null)[] | undefined | false => {
      if (value === undefined) return undefined;
      if (!Array.isArray(value) || value.length !== len || !value.every(n => n === null || typeof n === 'string')) return false;
      return value as (string | null)[];
    };
    const inputNames = names(entry.inputNames, inputs.length);
    const outputNames = names(entry.outputNames, outputs.length);
    if (inputNames === false || outputNames === false) return null;
    const mutability = entry.mutability;
    if (mutability !== 'pure' && mutability !== 'view' && mutability !== 'nonpayable' && mutability !== 'payable') return null;
    functions.push({
      signature: entry.signature, name: entry.name, inputs, outputs, mutability,
      ...(inputNames ? { inputNames } : {}),
      ...(outputNames ? { outputNames } : {}),
    });
  }
  return { id: value.id, name: value.name, address: value.address, functions };
}

function signatureMatches(signature: string, name: string, inputs: readonly string[]): boolean {
  return signature === `${name}(${inputs.join(',')})`;
}

function parseNode(value: unknown): GraphNode | null {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.length === 0) return null;
  if (value.parent !== undefined && typeof value.parent !== 'string') return null;
  if (value.branch !== undefined && value.branch !== 'then' && value.branch !== 'else') return null;
  if (value.hasElse !== undefined && typeof value.hasElse !== 'boolean') return null;
  if (value.autoSuccessFor !== undefined && typeof value.autoSuccessFor !== 'string') return null;
  const failureMode = parseCallFailureMode(value.failureMode);
  if (failureMode === null) return null;
  // Branch metadata exists exactly inside a block; a stray branch on a
  // top-level node is stripped rather than losing the node.
  const base = value.parent === undefined
    ? { id: value.id }
    : {
        id: value.id, parent: value.parent as string,
        ...(value.branch === undefined ? {} : { branch: value.branch as IfBranch }),
      };
  // Keep string references even when stale or out of scope so project
  // validation can show an actionable diagnostic instead of silently losing it.
  const statementBase = { ...base, ...(typeof value.executionAfter === 'string' && value.executionAfter.length > 0
    ? { executionAfter: value.executionAfter } : {}) };
  switch (value.kind) {
    case 'call':
      if (typeof value.contractId !== 'string' || typeof value.signature !== 'string') return null;
      return { ...statementBase, kind: 'call', contractId: value.contractId, signature: value.signature,
        ...(failureMode === undefined ? {} : { failureMode }) };
    case 'context':
      if (!CONTEXT_NAMES.includes(value.name as never)) return null;
      return { ...base, kind: 'context', name: value.name as ContextName };
    case 'literal': {
      if (value.literalType !== 'uint' && value.literalType !== 'address' && value.literalType !== 'bool') return null;
      if (typeof value.literal !== 'string') return null;
      if (!isValidLiteral(value.literalType, value.literal)) return null;
      return { ...base, kind: 'literal', literalType: value.literalType, literal: value.literal };
    }
    case 'binary':
      if (!BINARY_OPS.includes(value.op as never)) return null;
      return { ...base, kind: 'binary', op: value.op as BinaryOp };
    case 'balance':
      return { ...base, kind: 'balance' };
    case 'keccak':
      if (typeof value.data !== 'string' || !isBytesHex(value.data)) return null;
      return { ...statementBase, kind: 'keccak', data: value.data };
    case 'send':
      return { ...statementBase, kind: 'send', ...(failureMode === undefined ? {} : { failureMode }) };
    case 'rawcall':
      if (typeof value.calldata !== 'string' || !isBytesHex(value.calldata)) return null;
      return { ...statementBase, kind: 'rawcall', calldata: value.calldata,
        ...(failureMode === undefined ? {} : { failureMode }) };
    case 'guard':
      return { ...statementBase, kind: 'guard' };
    case 'if':
      return { ...statementBase, kind: 'if', ...(value.hasElse === true ? { hasElse: true } : {}),
        ...(typeof value.autoSuccessFor === 'string' ? { autoSuccessFor: value.autoSuccessFor } : {}) };
    case 'else':
      return { ...base, kind: 'else' };
    default:
      return null;
  }
}

function parseCallFailureMode(value: unknown): CallFailureMode | undefined | null {
  if (value === undefined) return undefined;
  return value === 'revert' || value === 'continue' ? value : null;
}

interface LegacyDecoder {
  readonly id: string;
  /** Byte offset of the decoded word in return data (aliases read word 0). */
  readonly offset: number;
}

function parseLegacyDecoder(value: unknown): LegacyDecoder | null {
  if (!isRecord(value) || typeof value.id !== 'string' || value.kind !== 'return') return null;
  if (value.decoder === 'word') {
    if (typeof value.offset !== 'number' || !Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset % 32 !== 0) return null;
    return { id: value.id, offset: value.offset };
  }
  if (value.decoder !== 'uint256' && value.decoder !== 'bool' && value.decoder !== 'bytes32') return null;
  if (value.offset !== undefined) return null;
  return { id: value.id, offset: 0 };
}

/** Edges that touch a legacy decoder, or old raw-result plumbing. */
function splitLegacyEdges(
  edges: readonly GraphEdge[], decoderIds: ReadonlySet<string>,
): { kept: GraphEdge[]; legacy: GraphEdge[] } {
  const kept: GraphEdge[] = [];
  const legacy: GraphEdge[] = [];
  for (const edge of edges) {
    if (decoderIds.has(edge.from.node) || decoderIds.has(edge.to.node) || edge.from.port === 'result') {
      legacy.push(edge);
    } else {
      kept.push(edge);
    }
  }
  return { kept, legacy };
}

/** Rewire `decoder.out -> consumer` edges onto `call.out:<index> -> consumer`. */
function foldLegacyDecoders(
  legacy: readonly GraphEdge[], decoders: ReadonlyMap<string, LegacyDecoder>,
  nodes: readonly GraphNode[], contracts: readonly ContractResource[],
): GraphEdge[] {
  const byId = new Map(nodes.map(n => [n.id, n]));
  // Each decoder belongs to the call whose raw result fed it.
  const owner = new Map<string, { call: string; offset: number }>();
  for (const edge of legacy) {
    const decoder = decoders.get(edge.to.node);
    if (decoder && edge.to.port === 'result' && byId.get(edge.from.node)?.kind === 'call') {
      owner.set(edge.to.node, { call: edge.from.node, offset: decoder.offset });
    }
  }
  const folded: GraphEdge[] = [];
  for (const edge of legacy) {
    const o = owner.get(edge.from.node);
    if (!o || edge.from.port !== 'out') continue;
    const call = byId.get(o.call);
    if (call?.kind !== 'call') continue;
    const fn = contracts.find(c => c.id === call.contractId)?.functions.find(f => f.signature === call.signature);
    if (!fn) continue;
    const offsets = outputHeadOffsets(fn.outputs);
    const index = offsets.findIndex((offset, i) => offset === o.offset && canonicalWordType(fn.outputs[i]) !== null);
    if (index === -1) continue; // position no longer exists or was never safely decodable
    folded.push({ id: edge.id, from: { node: o.call, port: `out:${index}` }, to: edge.to });
  }
  return folded;
}

function parseEdge(value: unknown): GraphEdge | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null;
  const endpoint = (entry: unknown): GraphEdge['from'] | null =>
    isRecord(entry) && typeof entry.node === 'string' && typeof entry.port === 'string'
      ? { node: entry.node, port: entry.port }
      : null;
  const from = endpoint(value.from);
  const to = endpoint(value.to);
  if (!from || !to || (value.kind !== undefined && value.kind !== 'control')) return null;
  return { id: value.id, ...(value.kind === 'control' ? { kind: 'control' as const } : {}), from, to };
}

function parsePositions(value: unknown): Readonly<Record<string, Vec2>> {
  if (!isRecord(value)) throw new Error('Saved positions must be an object');
  const positions: Record<string, Vec2> = {};
  for (const [id, entry] of Object.entries(value)) {
    if (isRecord(entry) && typeof entry.x === 'number' && typeof entry.y === 'number'
        && Number.isFinite(entry.x) && Number.isFinite(entry.y)) {
      positions[id] = { x: entry.x, y: entry.y };
    }
  }
  return positions;
}

/**
 * Frame sizes are newer optional presentation data: a missing or malformed
 * map is never fatal (old saves predate it), only bad entries drop.
 * Values are clamped up to the minimum so a corrupt tiny size cannot
 * collapse a frame; entries for non-container nodes are dropped.
 */
function parseFrameSizes(value: unknown, ifIds: ReadonlySet<string>): Readonly<Record<string, IfFrameSize>> {
  if (!isRecord(value)) return {};
  const sizes: Record<string, IfFrameSize> = {};
  for (const [id, entry] of Object.entries(value)) {
    if (!ifIds.has(id) || !isRecord(entry)) continue;
    const { width, height } = entry;
    if (typeof width !== 'number' || typeof height !== 'number'
        || !Number.isFinite(width) || !Number.isFinite(height)) continue;
    sizes[id] = clampFrameSize({ width, height });
  }
  return sizes;
}
