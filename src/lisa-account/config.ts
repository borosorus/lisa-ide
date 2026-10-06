import { getAddress, isAddress } from 'ethers';
import { normalizeChainId } from './chain';
import type { DeploymentConfig } from './types';

/**
 * Deployment configuration (AGENTS.md §3): one deployment on one chain, fully
 * specified or absent. Nothing here reads `import.meta.env` — callers hand in the
 * values so this stays unit-testable without env stubbing.
 */

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export const CHAIN_ID_ENV = 'VITE_LISA_CHAIN_ID';
export const RUNTIME_ENV = 'VITE_LISA_RUNTIME_ADDRESS';
export const IMPLEMENTATION_ENV = 'VITE_LISA_ACCOUNT_IMPLEMENTATION_ADDRESS';

/** Reported, and required together, in this order. */
const ENV_ORDER = [CHAIN_ID_ENV, RUNTIME_ENV, IMPLEMENTATION_ENV] as const;

export type DeploymentEnv = Partial<Record<(typeof ENV_ORDER)[number], string>>;

function present(value: string | undefined): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > 0 && text !== 'undefined' ? text : null;
}

/** Same 20-byte shape the visual editor requires, and an explicit `0x` prefix. */
const ADDRESS_SHAPE = /^0x[0-9a-fA-F]{40}$/;

function reject(...parts: readonly string[]): DeploymentConfig {
  return { kind: 'invalid', reason: parts.join(' ') };
}

function check(name: string, value: string): DeploymentConfig | null {
  // ethers also accepts a prefix-less address; a config value missing `0x` is a
  // copy/paste mistake, so fail closed rather than silently repair it.
  if (!ADDRESS_SHAPE.test(value) || !isAddress(value)) return reject(name, 'is not a 20-byte address');
  if (value.toLowerCase() === ZERO_ADDRESS) return reject(name, 'is the zero address');
  return null;
}

/** Missing variables are a normal state; partial or malformed ones are not (§3). */
export function parseDeploymentConfig(env: DeploymentEnv): DeploymentConfig {
  const values: Record<(typeof ENV_ORDER)[number], string | null> = {
    [CHAIN_ID_ENV]: present(env[CHAIN_ID_ENV]),
    [RUNTIME_ENV]: present(env[RUNTIME_ENV]),
    [IMPLEMENTATION_ENV]: present(env[IMPLEMENTATION_ENV]),
  };
  if (values[CHAIN_ID_ENV] === null && values[RUNTIME_ENV] === null && values[IMPLEMENTATION_ENV] === null) {
    return { kind: 'unconfigured' };
  }
  const missing = ENV_ORDER.find(name => values[name] === null);
  if (missing !== undefined) return reject(missing, 'is not set');

  // `0` parses as a number but is not a chain anyone can deploy on.
  const chainId = normalizeChainId(values[CHAIN_ID_ENV]);
  if (chainId === null || chainId === '0') return reject(CHAIN_ID_ENV, `is not a chain id: ${values[CHAIN_ID_ENV]}`);

  const invalid = check(RUNTIME_ENV, values[RUNTIME_ENV]!) ?? check(IMPLEMENTATION_ENV, values[IMPLEMENTATION_ENV]!);
  if (invalid !== null) return invalid;

  return {
    kind: 'configured',
    chainId,
    runtime: getAddress(values[RUNTIME_ENV]!),
    implementation: getAddress(values[IMPLEMENTATION_ENV]!),
  };
}
