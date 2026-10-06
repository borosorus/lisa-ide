import { getAddress, isAddress } from 'ethers';
import { bytesFromHex } from '../compile/hex';
import { lisaAccountInterface } from './abi';
import { LisaError, type LisaAccountStatus } from './types';

/**
 * Transaction preparation (AGENTS.md §5, §8, §9). Pure: it builds calldata and a
 * transaction object, it never sends anything and never touches a provider.
 */

/** A LisaAccount status that is allowed to execute; anything else must not reach here. */
export type ReadyStatus = Extract<LisaAccountStatus, { kind: 'ready' }>;

export interface ExecuteLisaTransaction {
  readonly to: string;
  readonly data: string;
  readonly value: bigint;
}

/** `executeLisa(bytes)` calldata; the program bytes are passed through unchanged. */
export function encodeExecuteLisa(program: string): string {
  return lisaAccountInterface.encodeFunctionData('executeLisa', [bytesFromHex(program)]);
}

/**
 * The transaction always targets the connected account itself: the EOA executes
 * its own delegated LisaAccount, which delegatecalls the configured runtime.
 * Native value stays 0 until the UI grows a labeled value input (§9).
 */
export function prepareExecuteLisaTransaction(input: {
  readonly account: string;
  readonly program: string;
  readonly status: ReadyStatus;
  readonly value?: bigint;
}): ExecuteLisaTransaction {
  if (!isAddress(input.account)) throw new LisaError('WALLET_DISCONNECTED', 'Connected account is not a valid address');
  const value = input.value ?? 0n;
  if (value < 0n) throw new LisaError('UNKNOWN', 'Transaction value must not be negative');
  return { to: getAddress(input.account), data: encodeExecuteLisa(input.program), value };
}
