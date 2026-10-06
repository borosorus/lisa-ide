import { getAddress } from 'ethers';
import { lisaAccountInterface } from './abi';
import type { AccountReader, DelegationCode, DeploymentConfig, LisaAccountStatus } from './types';

/**
 * Account inspection (AGENTS.md §4). Reads code, parses the EIP-7702 designator,
 * and only then probes `lisaRuntime()`. Every unrecognised shape fails closed —
 * nothing here can put the app in a state where it would execute a program
 * through an undelegated or foreign account.
 */

const DESIGNATOR_PREFIX = '0xef0100';
/** EIP-7702: 0xef0100 ++ 20-byte implementation address, and nothing else. */
const DESIGNATOR_HEX_LENGTH = 2 + 6 + 40;

/** Short, UI-safe reason: keeps long provider payloads out of the interface (§12). */
function reasonText(cause: unknown): string {
  const node = cause as { shortMessage?: string } | null;
  const text = cause instanceof Error ? node?.shortMessage ?? cause.message : String(cause);
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 140 ? `${flat.slice(0, 137)}...` : flat;
}

export function parseDelegationCode(code: string | null | undefined): DelegationCode {
  const text = (code ?? '').trim().toLowerCase();
  if (text === '' || text === '0x') return { kind: 'none' };
  if (!/^0x[0-9a-f]+$/.test(text)) return { kind: 'invalid', reason: 'account code is not hex data' };
  if (!text.startsWith(DESIGNATOR_PREFIX)) {
    return { kind: 'invalid', reason: 'account code is not an EIP-7702 delegation designator' };
  }
  if (text.length !== DESIGNATOR_HEX_LENGTH) {
    return { kind: 'invalid', reason: `delegation designator must be 23 bytes, got ${(text.length - 2) / 2}` };
  }
  try {
    return { kind: 'delegated', implementation: getAddress(`0x${text.slice(8)}`) };
  } catch {
    return { kind: 'invalid', reason: 'delegation designator carries no usable address' };
  }
}

export async function inspectLisaAccount(
  reader: AccountReader,
  account: string,
  config: DeploymentConfig,
): Promise<LisaAccountStatus> {
  if (config.kind === 'unconfigured') return { kind: 'unconfigured' };
  if (config.kind === 'invalid') return { kind: 'invalid-config', reason: config.reason };

  const delegation = parseDelegationCode(await reader.getCode(account));
  if (delegation.kind === 'none') return { kind: 'undelegated' };
  if (delegation.kind === 'invalid') return { kind: 'invalid-delegation', reason: delegation.reason };
  if (delegation.implementation.toLowerCase() !== config.implementation.toLowerCase()) {
    return { kind: 'other-delegation', implementation: delegation.implementation };
  }

  let runtime: string;
  try {
    const result = await reader.call({
      to: account,
      data: lisaAccountInterface.encodeFunctionData('lisaRuntime'),
    });
    runtime = getAddress(lisaAccountInterface.decodeFunctionResult('lisaRuntime', result)[0] as string);
  } catch (cause) {
    return {
      kind: 'invalid-lisa',
      implementation: delegation.implementation,
      reason: `lisaRuntime() could not be read: ${reasonText(cause)}`,
    };
  }

  if (runtime.toLowerCase() === config.runtime.toLowerCase()) {
    return { kind: 'ready', implementation: delegation.implementation, runtime };
  }
  return { kind: 'runtime-mismatch', implementation: delegation.implementation, runtime, expected: config.runtime };
}

export function isLisaAccountReady(status: LisaAccountStatus): status is Extract<LisaAccountStatus, { kind: 'ready' }> {
  return status.kind === 'ready';
}
