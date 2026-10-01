import { canonicalWordType, type ContractFunction, type Mutability } from './model';

/**
 * Paste-an-ABI-JSON parsing. Produces canonical function signatures that
 * encodeCall understands, plus metadata for grouping. Unsupported entries
 * are reported with a reason instead of being silently dropped.
 */

export interface AbiRejection {
  readonly name: string;
  readonly reason: string;
}

export interface AbiParseResult {
  readonly functions: readonly ContractFunction[];
  readonly rejected: readonly AbiRejection[];
}

export class AbiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AbiError';
  }
}

const MUTABILITIES: readonly string[] = ['pure', 'view', 'nonpayable', 'payable'];

/** Types encodeCall can place into an argument word (static ABI subset). */
export function canonicalInputType(type: unknown): string | null {
  return typeof type === 'string' ? canonicalWordType(type) : null;
}

export function isValidAddress(address: unknown): address is string {
  return typeof address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(address);
}

function isEntry(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface ParsedParams {
  readonly types: readonly string[];
  readonly names: readonly (string | null)[];
}

function parseParams(value: unknown): ParsedParams | null {
  if (!Array.isArray(value)) return null;
  const types: string[] = [];
  const names: (string | null)[] = [];
  for (const param of value) {
    if (!isEntry(param) || typeof param.type !== 'string') return null;
    types.push(param.type);
    names.push(typeof param.name === 'string' && param.name.length > 0 ? param.name : null);
  }
  return { types, names };
}

export function parseAbiJson(text: string): AbiParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AbiError('ABI is not valid JSON');
  }
  if (!Array.isArray(parsed)) throw new AbiError('ABI must be a JSON array of ABI entries');

  const functions: ContractFunction[] = [];
  const rejected: AbiRejection[] = [];
  const seen = new Set<string>();

  for (const entry of parsed) {
    if (!isEntry(entry)) continue;
    const type = entry.type ?? 'function';
    if (type !== 'function') continue; // events/errors/constructors are not callable functions
    if (typeof entry.name !== 'string' || entry.name.length === 0) continue;
    const inputs = parseParams(entry.inputs ?? []);
    const outputs = parseParams(entry.outputs ?? []);
    if (!inputs || !outputs) {
      rejected.push({ name: entry.name, reason: 'inputs/outputs must be ABI parameter lists' });
      continue;
    }
    const mutability = typeof entry.stateMutability === 'string' && MUTABILITIES.includes(entry.stateMutability)
      ? entry.stateMutability as Mutability
      : 'nonpayable';
    const canonical: string[] = [];
    let unsupported: string | null = null;
    for (const input of inputs.types) {
      const kind = canonicalInputType(input);
      if (kind === null) {
        unsupported = input;
        break;
      }
      if (/^bytes\d/.test(kind)) {
        // encodeCall only accepts bytesN arguments as compile-time constants
        // (hex strings / byte arrays), which the graph cannot author yet.
        unsupported = `${input} (bytesN arguments are not supported yet)`;
        break;
      }
      canonical.push(kind);
    }
    if (unsupported) {
      rejected.push({ name: `${entry.name}(${inputs.types.join(',')})`, reason: `unsupported argument type: ${unsupported}` });
      continue;
    }
    const signature = `${entry.name}(${canonical.join(',')})`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    functions.push({
      signature,
      name: entry.name,
      inputs: canonical,
      ...(inputs.names.some(n => n !== null) ? { inputNames: inputs.names } : {}),
      // Word-typed outputs canonicalize; anything else keeps its raw ABI
      // text so the canvas can label it while marking it non-connectable.
      outputs: outputs.types.map(type => canonicalWordType(type) ?? type),
      ...(outputs.names.some(n => n !== null) ? { outputNames: outputs.names } : {}),
      mutability,
    });
  }

  if (functions.length === 0 && rejected.length === 0) {
    throw new AbiError('ABI contains no callable functions');
  }
  return { functions, rejected };
}
