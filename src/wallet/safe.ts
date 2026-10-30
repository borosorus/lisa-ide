import {
  getAddress, Interface, isAddress, TypedDataEncoder, verifyTypedData, ZeroAddress,
  type TypedDataDomain, type TypedDataField,
} from 'ethers';
import { bytesFromHex, hexFromBytes } from '../compile/hex';
import { LisaError, type AccountReader, type DeploymentConfig } from '../lisa-account/types';

/**
 * The Safe subset this app needs, kept apart from any UI or provider code.
 *
 * A single-owner (1-of-1) Safe can run a LISA program with no delegation and no
 * module installed: one `execTransaction` whose `to` is the configured runtime,
 * `data` is the program, and `operation` is DELEGATECALL. The Safe delegatecalls
 * the runtime itself, so the program runs with the Safe's authority — `SELF` is
 * the Safe, `CALLER` is the owner that sent the transaction, and every external
 * call the program makes has the Safe as its `msg.sender`.
 *
 * Everything here is pure except `inspectSafeExecution`, which takes the same
 * `AccountReader` the LISA layer uses and only reads.
 */

/** The only Safe versions whose transaction hashing this module can reproduce. */
const SUPPORTED_VERSION = /^1\.(?:3\.0|4\.1)(?:\+L2)?$/;

export const SAFE_ABI = [
  'function VERSION() view returns (string)',
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)',
] as const;

export const safeInterface = new Interface(SAFE_ABI);

/** `Enum.Operation.DelegateCall` — the Safe executes the payload in its own context. */
export const DELEGATE_CALL = 1 as const;

/** Safe 1.3.0+/1.4.1 EIP-712 shape; the order of fields is part of the hash. */
const SAFE_TX_TYPES: Record<string, TypedDataField[]> = {
  SafeTx: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' },
    { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' },
    { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' },
    { name: 'nonce', type: 'uint256' },
  ],
};

export interface SafeTx {
  readonly to: string;
  readonly value: bigint;
  readonly data: string;
  readonly operation: typeof DELEGATE_CALL;
  readonly safeTxGas: bigint;
  readonly baseGas: bigint;
  readonly gasPrice: bigint;
  readonly gasToken: string;
  readonly refundReceiver: string;
  readonly nonce: bigint;
}

export interface SafeTypedData {
  readonly domain: TypedDataDomain;
  readonly types: Record<string, TypedDataField[]>;
  readonly value: SafeTx;
}

export interface SafeTransaction {
  readonly to: string;
  readonly data: string;
  readonly value: bigint;
  /**
   * Pins the request to the reviewed chain. The Safe signature only verifies on
   * that chain, but a wallet that silently moved networks would otherwise send
   * the same calldata to an address that may not be a Safe there — succeeding as
   * a no-op and looking like a completed execution.
   */
  readonly chainId: bigint;
}

/**
 * One Safe on one chain. The chain is part of the identity: the same address is
 * a different account on another network, and a Safe digest only verifies on the
 * chain it was built for (§2, §3).
 */
export interface SafeAddress {
  readonly address: string;
  readonly chainId: string;
}

/** The Safe address as typed, or null when it is not a usable 20-byte address. */
export function parseSafeAddress(value: string): string | null {
  const text = value.trim();
  if (!isAddress(text)) return null;
  return getAddress(text);
}

/**
 * The Safe transaction for one program: delegatecall the configured runtime,
 * no value, no gas refund machinery. Zero gas fields mean "forward everything
 * that is left", which is what a direct execution needs.
 */
export function buildSafeTx(input: {
  readonly runtime: string;
  readonly program: string;
  readonly nonce: bigint;
}): SafeTx {
  if (!isAddress(input.runtime)) throw new LisaError('INVALID_CONFIG', 'Configured runtime is not a valid address.');
  if (input.nonce < 0n) throw new LisaError('UNKNOWN', 'Safe nonce cannot be negative.');
  // Canonicalised so the bytes that are hashed and the bytes that are sent are
  // the same string, whatever casing the compiler emitted.
  const data = hexFromBytes(bytesFromHex(input.program));
  return {
    to: getAddress(input.runtime),
    value: 0n,
    data,
    operation: DELEGATE_CALL,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: ZeroAddress,
    refundReceiver: ZeroAddress,
    nonce: input.nonce,
  };
}

/** `EIP712Domain(uint256 chainId,address verifyingContract)` for one Safe on one chain. */
export function safeTypedData(chainId: string, safe: string, transaction: SafeTx): SafeTypedData {
  return {
    domain: { chainId: BigInt(chainId), verifyingContract: getAddress(safe) },
    types: SAFE_TX_TYPES,
    value: transaction,
  };
}

/** The digest the owner signs; `readSafeTransactionHash` confirms it on-chain. */
export function hashSafeTx(chainId: string, safe: string, transaction: SafeTx): string {
  const typed = safeTypedData(chainId, safe, transaction);
  return TypedDataEncoder.hash(typed.domain, typed.types, typed.value);
}

/** What the Safe itself computes for the same transaction. */
export async function readSafeTransactionHash(reader: AccountReader, safe: string, transaction: SafeTx): Promise<string> {
  const result = await reader.call({
    to: getAddress(safe),
    data: safeInterface.encodeFunctionData('getTransactionHash', [
      transaction.to, transaction.value, transaction.data, transaction.operation,
      transaction.safeTxGas, transaction.baseGas, transaction.gasPrice,
      transaction.gasToken, transaction.refundReceiver, transaction.nonce,
    ]),
  });
  return String(safeInterface.decodeFunctionResult('getTransactionHash', result)[0]).toLowerCase();
}

export async function readSafeNonce(reader: AccountReader, safe: string): Promise<bigint> {
  const result = await reader.call({ to: getAddress(safe), data: safeInterface.encodeFunctionData('nonce') });
  return BigInt(safeInterface.decodeFunctionResult('nonce', result)[0] as bigint);
}

/**
 * A Safe accepts `v` 27/28 as ECDSA, `1` as "this hash was approved" and
 * `> 30` as `eth_sign`. Only the two canonical values mean "the owner signed
 * this transaction", so nothing else is allowed through.
 */
export function normalizeSafeSignature(signature: string): string {
  const text = signature.trim().toLowerCase();
  if (!/^0x[0-9a-f]{130}$/.test(text)) {
    throw new LisaError('SAFE_NOT_READY', 'Wallet returned a signature that is not 65 bytes long.');
  }
  const v = Number.parseInt(text.slice(130), 16);
  if (v !== 27 && v !== 28) {
    throw new LisaError('SAFE_NOT_READY', `Wallet returned signature v=${v}; a Safe only accepts 27 or 28.`);
  }
  return text;
}

/** Recover the signer, or null when the signature does not verify at all. */
export function recoverSafeSigner(chainId: string, safe: string, transaction: SafeTx, signature: string): string | null {
  const typed = safeTypedData(chainId, safe, transaction);
  try {
    return getAddress(verifyTypedData(typed.domain, typed.types, typed.value, signature));
  } catch {
    return null;
  }
}

/** `execTransaction(...)` calldata; the Safe is the transaction's `to`. */
export function prepareSafeExecutionTransaction(input: {
  readonly safe: string;
  readonly chainId: string;
  readonly transaction: SafeTx;
  readonly signature: string;
}): SafeTransaction {
  const { transaction, signature } = input;
  return {
    to: getAddress(input.safe),
    value: 0n,
    chainId: BigInt(input.chainId),
    data: safeInterface.encodeFunctionData('execTransaction', [
      transaction.to, transaction.value, transaction.data, transaction.operation,
      transaction.safeTxGas, transaction.baseGas, transaction.gasPrice,
      transaction.gasToken, transaction.refundReceiver, signature,
    ]),
  };
}

/**
 * Everything that has to be true before a Safe may run a program. Only `ready`
 * is executable and it carries the nonce the review must be signed against.
 */
export type SafeExecutionStatus =
  | { readonly kind: 'unconfigured' }
  | { readonly kind: 'invalid-config'; readonly reason: string }
  | { readonly kind: 'runtime-no-code'; readonly runtime: string }
  | { readonly kind: 'safe-no-code'; readonly safe: string }
  | { readonly kind: 'not-a-safe'; readonly safe: string; readonly reason: string }
  | { readonly kind: 'unsupported-version'; readonly safe: string; readonly version: string }
  | { readonly kind: 'not-owner'; readonly safe: string; readonly owner: string }
  | { readonly kind: 'threshold'; readonly safe: string; readonly threshold: number }
  | {
    readonly kind: 'ready';
    readonly safe: string;
    readonly owner: string;
    readonly runtime: string;
    readonly version: string;
    readonly nonce: bigint;
  };

/** Short, UI-safe reason: keeps long provider payloads out of the interface (§12). */
function reasonText(cause: unknown): string {
  const node = cause as { shortMessage?: string } | null;
  const text = cause instanceof Error ? node?.shortMessage ?? cause.message : String(cause);
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 140 ? `${flat.slice(0, 137)}...` : flat;
}

async function readString(reader: AccountReader, safe: string, method: 'VERSION'): Promise<string> {
  const result = await reader.call({ to: safe, data: safeInterface.encodeFunctionData(method) });
  return String(safeInterface.decodeFunctionResult(method, result)[0]);
}

export async function inspectSafeExecution(
  reader: AccountReader,
  safeInput: string,
  ownerInput: string,
  config: DeploymentConfig,
): Promise<SafeExecutionStatus> {
  if (config.kind === 'unconfigured') return { kind: 'unconfigured' };
  if (config.kind === 'invalid') return { kind: 'invalid-config', reason: config.reason };

  const safe = parseSafeAddress(safeInput);
  if (safe === null) return { kind: 'invalid-config', reason: 'Safe address is not a 20-byte address.' };

  const code = await reader.getCode(safe);
  if (code === null || code.trim() === '' || code.trim().toLowerCase() === '0x') {
    return { kind: 'safe-no-code', safe };
  }

  let version: string;
  let owners: string[];
  let threshold: bigint;
  try {
    version = await readString(reader, safe, 'VERSION');
    const ownersResult = await reader.call({ to: safe, data: safeInterface.encodeFunctionData('getOwners') });
    owners = (safeInterface.decodeFunctionResult('getOwners', ownersResult)[0] as string[]).map(getAddress);
    const thresholdResult = await reader.call({ to: safe, data: safeInterface.encodeFunctionData('getThreshold') });
    threshold = BigInt(safeInterface.decodeFunctionResult('getThreshold', thresholdResult)[0] as bigint);
  } catch (cause) {
    return { kind: 'not-a-safe', safe, reason: `Safe state could not be read: ${reasonText(cause)}` };
  }

  // 1.1.1 and 1.2.0 hash with `EIP712Domain(address verifyingContract)` — no
  // chainId — so a digest built here is a signature those Safes would reject (§3).
  if (!SUPPORTED_VERSION.test(version)) return { kind: 'unsupported-version', safe, version };

  const owner = getAddress(ownerInput);
  if (!owners.some(candidate => candidate.toLowerCase() === owner.toLowerCase())) {
    return { kind: 'not-owner', safe, owner };
  }
  // More than one signature cannot be produced here, so a multi-owner Safe is
  // refused rather than half-executed.
  if (threshold !== 1n) return { kind: 'threshold', safe, threshold: Number(threshold) };

  // A delegatecall target with no code succeeds as a no-op, which would look like
  // a confirmed execution that ran nothing (§3).
  const runtimeCode = await reader.getCode(config.runtime);
  if (runtimeCode === null || runtimeCode.trim() === '' || runtimeCode.trim().toLowerCase() === '0x') {
    return { kind: 'runtime-no-code', runtime: config.runtime };
  }

  let nonce: bigint;
  try {
    nonce = await readSafeNonce(reader, safe);
  } catch (cause) {
    return { kind: 'not-a-safe', safe, reason: `Safe nonce could not be read: ${reasonText(cause)}` };
  }
  return { kind: 'ready', safe, owner, runtime: config.runtime, version, nonce };
}
