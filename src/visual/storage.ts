import { SOURCE_STORAGE_KEY } from '../editor/sourceStorage';
import {
  BINARY_OPS, CONTEXT_NAMES, isValidLiteral, WORD_DECODERS,
  emptyProject,
  type BinaryOp, type ContextName, type GraphEdge, type GraphNode, type Vec2, type VisualProject,
} from './model';
import { canonicalInputType, isValidAddress } from './abi';
import type { ContractFunction, ContractResource } from './model';

/**
 * Versioned project persistence. A malformed save must never brick the app:
 * callers get null and fall back to a fresh project.
 */

export const PROJECT_STORAGE_KEY = 'lisa-ide.project.v1';

export type AuthoringMode = 'code' | 'visual';

export interface StoredProject {
  readonly version: 1;
  readonly mode: AuthoringMode;
  readonly codeSource: string | null;
  readonly visual: VisualProject;
}

type ReadStorage = Pick<Storage, 'getItem'>;
type WriteStorage = Pick<Storage, 'setItem'>;

function defaultStorage(): ReadStorage & WriteStorage | null {
  return typeof window === 'undefined' ? null : window.localStorage;
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
      return legacy === null ? null : { version: 1, mode: 'code', codeSource: legacy, visual: emptyProject() };
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
  if (candidate.version !== 1) throw new Error(`Unsupported saved project version: ${String(candidate.version)}`);
  if (candidate.mode !== 'code' && candidate.mode !== 'visual') throw new Error('Saved project mode is invalid');
  if (candidate.codeSource !== null && typeof candidate.codeSource !== 'string') {
    throw new Error('Saved project codeSource must be a string or null');
  }
  const visual = parseVisual(candidate.visual);
  return {
    version: 1,
    mode: candidate.mode,
    codeSource: candidate.codeSource as string | null,
    visual,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseVisual(value: unknown): VisualProject {
  if (!isRecord(value)) throw new Error('Saved visual project must be an object');
  const contracts = parseItems(value.contracts, parseContract, 'contracts');
  const nodes = parseItems(value.nodes, parseNode, 'nodes');
  const nodeIds = new Set(nodes.map(n => n.id));
  // Edges dangling from repaired-away nodes cannot mean anything either.
  const edges = parseItems(value.edges, parseEdge, 'edges')
    .filter(e => nodeIds.has(e.from.node) && nodeIds.has(e.to.node));
  const positions = parsePositions(value.positions);
  return {
    contracts,
    nodes,
    edges,
    positions: Object.fromEntries(Object.entries(positions).filter(([id]) => nodeIds.has(id))),
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
  const base = value.parent === undefined ? { id: value.id } : { id: value.id, parent: value.parent as string };
  switch (value.kind) {
    case 'call':
      if (typeof value.contractId !== 'string' || typeof value.signature !== 'string') return null;
      return { ...base, kind: 'call', contractId: value.contractId, signature: value.signature };
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
    case 'return': {
      if (!WORD_DECODERS.includes(value.decoder as never)) return null;
      if (value.decoder === 'word') {
        if (typeof value.offset !== 'number' || !Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset % 32 !== 0) return null;
        return { ...base, kind: 'return', decoder: 'word', offset: value.offset };
      }
      if (value.offset !== undefined) return null;
      return { ...base, kind: 'return', decoder: value.decoder as 'uint256' | 'bool' | 'bytes32' };
    }
    case 'if':
      return { ...base, kind: 'if' };
    default:
      return null;
  }
}

function parseEdge(value: unknown): GraphEdge | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null;
  const endpoint = (entry: unknown): GraphEdge['from'] | null =>
    isRecord(entry) && typeof entry.node === 'string' && typeof entry.port === 'string'
      ? { node: entry.node, port: entry.port }
      : null;
  const from = endpoint(value.from);
  const to = endpoint(value.to);
  if (!from || !to) return null;
  return { id: value.id, from, to };
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
