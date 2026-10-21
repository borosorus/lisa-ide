import { getAddress, isAddress } from 'ethers';
import { normalizeChainId } from './chain';
import type { DeploymentConfig } from './types';
import deployments from './deployments.json';

/**
 * Public deployments shipped with the IDE. The connected wallet's chain selects
 * its entry; the default only controls the preferred network shown by the app.
 */
export const DEFAULT_CHAIN_ID = deployments.defaultChainId;

export interface ChainDeploymentEntry {
  readonly name: string;
  readonly runtime: string | null;
  readonly accountImplementation: string | null;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ADDRESS_SHAPE = /^0x[0-9a-fA-F]{40}$/;

function invalid(reason: string): DeploymentConfig {
  return { kind: 'invalid', reason };
}

function checkAddress(name: string, value: string): string | null {
  if (!ADDRESS_SHAPE.test(value) || !isAddress(value)) return `${name} is not a 20-byte address`;
  if (value.toLowerCase() === ZERO_ADDRESS) return `${name} is the zero address`;
  return null;
}

/** Validate a static per-chain entry before it can enable account execution. */
export function parseDeploymentConfig(chainIdInput: string, entry: ChainDeploymentEntry | undefined): DeploymentConfig {
  const chainId = normalizeChainId(chainIdInput);
  if (chainId === null || chainId === '0') return invalid(`Invalid deployment chain id: ${chainIdInput}`);
  if (entry === undefined || (entry.runtime === null && entry.accountImplementation === null)) {
    return { kind: 'unconfigured' };
  }
  if (entry.runtime === null) return invalid(`${entry.name}: runtime is not configured`);
  if (entry.accountImplementation === null) return invalid(`${entry.name}: account implementation is not configured`);

  const addressError = checkAddress(`${entry.name} runtime`, entry.runtime)
    ?? checkAddress(`${entry.name} account implementation`, entry.accountImplementation);
  if (addressError !== null) return invalid(addressError);

  return {
    kind: 'configured',
    chainId,
    runtime: getAddress(entry.runtime),
    implementation: getAddress(entry.accountImplementation),
  };
}

/** Resolve configuration for the wallet's current chain, never another chain. */
export function deploymentForChain(chainId: string | null): DeploymentConfig {
  if (chainId === null) return { kind: 'unconfigured' };
  const normalized = normalizeChainId(chainId);
  if (normalized === null) return invalid(`Invalid connected chain id: ${chainId}`);
  const entry = deployments.chains[normalized as keyof typeof deployments.chains];
  return parseDeploymentConfig(normalized, entry);
}
