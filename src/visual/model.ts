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

/** One ABI function, canonicalized: `name(type,type)` plus metadata. */
export interface ContractFunction {
  readonly signature: string;
  readonly name: string;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly mutability: Mutability;
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

export type PortKind = 'value' | 'address' | 'bool' | 'condition' | 'result';

export const CONTEXT_NAMES = ['SELF', 'CALLER', 'GAS', 'TIMESTAMP', 'SELFBALANCE'] as const;
export type ContextName = (typeof CONTEXT_NAMES)[number];

export const BINARY_OPS = ['add', 'sub', 'mul', 'div', 'lt', 'gt', 'eq'] as const;
export type BinaryOp = (typeof BINARY_OPS)[number];

export const WORD_DECODERS = ['uint256', 'bool', 'bytes32', 'word'] as const;
export type WordDecoder = (typeof WORD_DECODERS)[number];

export const LITERAL_TYPES = ['uint', 'address', 'bool'] as const;
export type LiteralType = (typeof LITERAL_TYPES)[number];

/** The single grammar for literal text, shared by validation, UI, and storage. */
export function isValidLiteral(type: LiteralType, text: string): boolean {
  return type === 'uint' ? /^(0x[0-9a-fA-F]+|\d+)$/.test(text)
    : type === 'address' ? /^0x[0-9a-fA-F]{40}$/.test(text)
    : text === 'true' || text === 'false';
}

interface NodeBase {
  readonly id: string;
  /** Id of the IfNode whose body contains this node; absent at top level. */
  readonly parent?: string;
}

export type GraphNode =
  | (NodeBase & { readonly kind: 'call'; readonly contractId: string; readonly signature: string })
  | (NodeBase & { readonly kind: 'context'; readonly name: ContextName })
  | (NodeBase & { readonly kind: 'literal'; readonly literalType: LiteralType; readonly literal: string })
  | (NodeBase & { readonly kind: 'binary'; readonly op: BinaryOp })
  | (NodeBase & { readonly kind: 'return'; readonly decoder: WordDecoder; readonly offset?: number })
  | (NodeBase & { readonly kind: 'if' });

export interface GraphEndpoint {
  readonly node: string;
  readonly port: string;
}

/** A new node without its id yet (distributes over the node union). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type GraphNodeDraft = DistributiveOmit<GraphNode, 'id'>;

export interface GraphEdge {
  readonly id: string;
  readonly from: GraphEndpoint;
  readonly to: GraphEndpoint;
}

export interface VisualProject {
  readonly contracts: readonly ContractResource[];
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  /** Presentation metadata only; semantics never read positions. */
  readonly positions: Readonly<Record<string, Vec2>>;
}

export function emptyProject(): VisualProject {
  return { contracts: [], nodes: [], edges: [], positions: {} };
}

/** Deterministic unprefixed-collision ids like `n1`, `call3`, `e12`. */
export function createId(taken: Iterable<string>, prefix: string): string {
  const used = new Set(taken);
  for (let i = 1; ; i++) {
    const id = `${prefix}${i}`;
    if (!used.has(id)) return id;
  }
}
