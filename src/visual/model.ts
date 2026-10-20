/**
 * Semantic graph model for visual projects. Canonical program semantics;
 * React Flow structures are projections of this data and never canonical.
 * Everything here is plain JSON-serializable data with no React imports.
 */

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export type Mutability = 'pure' | 'view' | 'nonpayable' | 'payable';
export type CallFailureMode = 'revert' | 'continue';

/** One ABI function, canonicalized: `name(type,type)` plus metadata. */
export interface ContractFunction {
  readonly signature: string;
  readonly name: string;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly mutability: Mutability;
  /** ABI parameter names, aligned with `inputs`; null where the ABI has none. */
  readonly inputNames?: readonly (string | null)[];
  /** ABI output names, aligned with `outputs`; null where the ABI has none. */
  readonly outputNames?: readonly (string | null)[];
}

/**
 * Head-position byte offsets for decoding output words, aligned with
 * `outputs`: word(i) where earlier static outputs, one head slot per dynamic
 * predecessor. Null when a predecessor's head width cannot be established
 * (tuples), in which case that output and the ones after it are not safely
 * decodable.
 */
export function outputHeadOffsets(outputs: readonly string[]): (number | null)[] {
  const offsets: (number | null)[] = [];
  let cursor = 0;
  let broken = false;
  for (const type of outputs) {
    if (broken) { offsets.push(null); continue; }
    const width = headWidth(type, 0);
    if (width === null) {
      broken = true;
      offsets.push(null);
    } else {
      offsets.push(cursor);
      cursor += width * 32;
    }
  }
  return offsets;
}

/** Bytes an output occupies in the return-data head; null when unknown. */
function headWidth(type: string, depth: number): number | null {
  if (depth > 4) return null;
  if (canonicalWordType(type)) return 1;
  if (type === 'string' || type === 'bytes' || type.endsWith('[]')) return 1;
  const array = /^(.*)\[(\d+)\]$/.exec(type);
  if (array) {
    const count = Number(array[2]);
    if (count > 256) return null;
    const innerDynamic = isDynamicType(array[1], depth + 1);
    if (innerDynamic === null) return null;
    // A fixed array of dynamic elements is itself dynamic: one head pointer.
    if (innerDynamic) return 1;
    const inner = headWidth(array[1], depth + 1);
    return inner === null ? null : inner * count;
  }
  return null;
}

/** Whether an ABI type encodes with a tail; null when the type is unknown. */
function isDynamicType(type: string, depth: number): boolean | null {
  if (depth > 4) return null;
  if (canonicalWordType(type)) return false;
  if (type === 'string' || type === 'bytes' || type.endsWith('[]')) return true;
  const array = /^(.*)\[(\d+)\]$/.exec(type);
  if (array) return isDynamicType(array[1], depth + 1);
  return null;
}

/** Static one-word ABI types the decoder can read: uintN, address, bool, bytesN. */
export function canonicalWordType(type: string): string | null {
  if (type === 'address' || type === 'bool') return type;
  if (type === 'uint') return 'uint256';
  const uint = /^uint(\d{1,3})$/.exec(type);
  if (uint) {
    const width = Number(uint[1]);
    return width >= 8 && width <= 256 && width % 8 === 0 ? `uint${width}` : null;
  }
  const bytes = /^bytes(\d{1,2})$/.exec(type);
  if (bytes) {
    const width = Number(bytes[1]);
    return width >= 1 && width <= 32 ? `bytes${width}` : null;
  }
  return null;
}

export function isReadFunction(fn: ContractFunction): boolean {
  return fn.mutability === 'view' || fn.mutability === 'pure';
}

/** A contract instance added once per project; call nodes reference it by id. */
export interface ContractResource {
  readonly id: string;
  readonly name: string;
  readonly address: string;
  readonly functions: readonly ContractFunction[];
}

export type PortKind = 'value' | 'address' | 'bool' | 'condition' | 'control';

export const CONTEXT_NAMES = ['SELF', 'CALLER', 'GAS', 'TIMESTAMP', 'SELFBALANCE'] as const;
export type ContextName = (typeof CONTEXT_NAMES)[number];

export const BINARY_OPS = ['add', 'sub', 'mul', 'div', 'lt', 'gt', 'eq'] as const;
export type BinaryOp = (typeof BINARY_OPS)[number];

export const LITERAL_TYPES = ['uint', 'address', 'bool'] as const;
export type LiteralType = (typeof LITERAL_TYPES)[number];

/** Byte data a new hash node starts with: valid empty-ish data, one byte. */
export const DEFAULT_HASH_DATA = '0x00';

/** Byte data a new raw call starts with: empty calldata, a plain call. */
export const DEFAULT_RAW_CALLDATA = '0x';

/** The single grammar for literal text, shared by validation, UI, and storage. */
export function isValidLiteral(type: LiteralType, text: string): boolean {
  return type === 'uint' ? /^(0x[0-9a-fA-F]+|\d+)$/.test(text)
    : type === 'address' ? /^0x[0-9a-fA-F]{40}$/.test(text)
    : text === 'true' || text === 'false';
}

/** Which sibling scope of a parent IF a node belongs to. Semantic, not layout. */
export type IfBranch = 'then' | 'else';

/** Semantic scope of a node nested in an IF: its owning block and branch. */
export interface ScopeTarget {
  readonly parent: string;
  /** @deprecated Legacy branch data is migrated to an ELSE container on load. */
  readonly branch: IfBranch;
}

interface NodeBase {
  readonly id: string;
  /** Id of the IF or ELSE container whose body contains this node. */
  readonly parent?: string;
  /** @deprecated Legacy persisted branch marker; converted to container ownership on load. */
  readonly branch?: IfBranch;
}

/** Statement nodes can pin one explicit predecessor; data edges still add their own ordering dependencies. */
type StatementNodeBase = NodeBase & { readonly executionAfter?: string };

export type GraphNode =
  | (StatementNodeBase & { readonly kind: 'call'; readonly contractId: string; readonly signature: string; readonly failureMode?: CallFailureMode })
  | (NodeBase & { readonly kind: 'context'; readonly name: ContextName })
  | (NodeBase & { readonly kind: 'literal'; readonly literalType: LiteralType; readonly literal: string })
  | (NodeBase & { readonly kind: 'binary'; readonly op: BinaryOp })
  | (NodeBase & { readonly kind: 'balance' })
  | (StatementNodeBase & { readonly kind: 'keccak'; readonly data: string })
  | (StatementNodeBase & { readonly kind: 'send'; readonly failureMode?: CallFailureMode })
  | (StatementNodeBase & { readonly kind: 'rawcall'; readonly calldata: string; readonly failureMode?: CallFailureMode })
  | (StatementNodeBase & { readonly kind: 'guard' })
  | (StatementNodeBase & { readonly kind: 'if'; /** @deprecated Legacy embedded ELSE marker; converted on load. */ readonly hasElse?: boolean; /** Auto-created success gate owned by a call node. */ readonly autoSuccessFor?: string })
  | (NodeBase & { readonly kind: 'else' });

export type StatementNode = Extract<GraphNode, { kind: 'call' | 'keccak' | 'send' | 'rawcall' | 'guard' | 'if' }>;

export function isStatementNode(node: GraphNode): node is StatementNode {
  return node.kind === 'call' || node.kind === 'keccak' || node.kind === 'send'
    || node.kind === 'rawcall' || node.kind === 'guard' || node.kind === 'if';
}

export interface GraphEndpoint {
  readonly node: string;
  readonly port: string;
}

/** A new node without its id yet (distributes over the node union). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type GraphNodeDraft = DistributiveOmit<GraphNode, 'id'>;

export interface GraphEdge {
  readonly id: string;
  /** Undefined for value edges; control edges connect an IF to its ELSE container. */
  readonly kind?: 'control';
  readonly from: GraphEndpoint;
  readonly to: GraphEndpoint;
}

/** Persistent visual size of an IF container, in flow pixels. */
export interface IfFrameSize {
  readonly width: number;
  readonly height: number;
}

/** Comfortable starting work area for a new IF; content growth may exceed it. */
export const IF_DEFAULT_SIZE: IfFrameSize = { width: 420, height: 260 };

/** Below this the header or a usable body strip disappears. */
export const IF_MIN_SIZE: IfFrameSize = { width: 260, height: 150 };

export function clampFrameSize(size: IfFrameSize): IfFrameSize {
  return { width: Math.max(size.width, IF_MIN_SIZE.width), height: Math.max(size.height, IF_MIN_SIZE.height) };
}

export interface VisualProject {
  readonly contracts: readonly ContractResource[];
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  /** Presentation metadata only; semantics never read positions. */
  readonly positions: Readonly<Record<string, Vec2>>;
  /** Presentation-only frame sizes of IF nodes; absent entries use IF_DEFAULT_SIZE. */
  readonly frameSizes: Readonly<Record<string, IfFrameSize>>;
}

export function emptyProject(): VisualProject {
  return { contracts: [], nodes: [], edges: [], positions: {}, frameSizes: {} };
}

/** Deterministic unprefixed-collision ids like `n1`, `call3`, `e12`. */
export function createId(taken: Iterable<string>, prefix: string): string {
  const used = new Set(taken);
  for (let i = 1; ; i++) {
    const id = `${prefix}${i}`;
    if (!used.has(id)) return id;
  }
}
