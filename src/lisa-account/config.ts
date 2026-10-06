import { getAddress, isAddress } from 'ethers';
import type { DeploymentConfig } from './types';

/**
 * Deployment configuration (AGENTS.md §3): two optional addresses, validated
 * before anything uses them. Nothing here reads `import.meta.env` — callers
 * hand in the values so this stays unit-testable without env stubbing.
 */

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export const RUNTIME_ENV = 'VITE_LISA_RUNTIME_ADDRESS';
export const IMPLEMENTATION_ENV = 'VITE_LISA_ACCOUNT_IMPLEMENTATION_ADDRESS';

export interface DeploymentEnv {
  readonly VITE_LISA_RUNTIME_ADDRESS?: string;
  readonly VITE_LISA_ACCOUNT_IMPLEMENTATION_ADDRESS?: string;
}

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

/** Missing variables are a normal state; malformed ones are not (§3). */
export function parseDeploymentConfig(env: DeploymentEnv): DeploymentConfig {
  const runtime = present(env.VITE_LISA_RUNTIME_ADDRESS);
  const implementation = present(env.VITE_LISA_ACCOUNT_IMPLEMENTATION_ADDRESS);
  if (runtime === null && implementation === null) return { kind: 'unconfigured' };
  if (runtime === null) return reject(RUNTIME_ENV, 'is not set');
  if (implementation === null) return reject(IMPLEMENTATION_ENV, 'is not set');
  const invalid = check(RUNTIME_ENV, runtime) ?? check(IMPLEMENTATION_ENV, implementation);
  if (invalid !== null) return invalid;
  return {
    kind: 'configured',
    runtime: getAddress(runtime),
    implementation: getAddress(implementation),
  };
}
