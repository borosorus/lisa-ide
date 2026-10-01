import type { ContractFunction, Mutability } from './model';

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
  if (typeof type !== 'string') return null;
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

export function isValidAddress(address: unknown): address is string {
  return typeof address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(address);
}

function isEntry(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function paramTypes(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const types: string[] = [];
  for (const param of value) {
    if (!isEntry(param) || typeof param.type !== 'string') return null;
    types.push(param.type);
  }
  return types;
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
    const inputs = paramTypes(entry.inputs ?? []);
    const outputs = paramTypes(entry.outputs ?? []);
    if (!inputs || !outputs) {
      rejected.push({ name: entry.name, reason: 'inputs/outputs must be ABI parameter lists' });
      continue;
    }
    const mutability = typeof entry.stateMutability === 'string' && MUTABILITIES.includes(entry.stateMutability)
      ? entry.stateMutability as Mutability
      : 'nonpayable';
    const canonical: string[] = [];
    let unsupported: string | null = null;
    for (const input of inputs) {
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
      rejected.push({ name: `${entry.name}(${inputs.join(',')})`, reason: `unsupported argument type: ${unsupported}` });
      continue;
    }
    const signature = `${entry.name}(${canonical.join(',')})`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    functions.push({
      signature,
      name: entry.name,
      inputs: canonical,
      outputs,
      mutability,
    });
  }

  if (functions.length === 0 && rejected.length === 0) {
    throw new AbiError('ABI contains no callable functions');
  }
  return { functions, rejected };
}
