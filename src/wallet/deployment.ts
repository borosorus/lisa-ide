import { CHAIN_ID_ENV, IMPLEMENTATION_ENV, RUNTIME_ENV, parseDeploymentConfig } from '../lisa-account/config';
import type { DeploymentConfig } from '../lisa-account/types';

/**
 * The single place the app reads Vite env. The variables are
 * optional as a set: an unconfigured build still starts, still connects a wallet,
 * and simply keeps every LISA action disabled. Half a deployment is not a
 * deployment, so it reports which variable is missing instead of guessing.
 */
export const DEPLOYMENT: DeploymentConfig = parseDeploymentConfig({
  VITE_LISA_CHAIN_ID: import.meta.env.VITE_LISA_CHAIN_ID,
  VITE_LISA_RUNTIME_ADDRESS: import.meta.env.VITE_LISA_RUNTIME_ADDRESS,
  VITE_LISA_ACCOUNT_IMPLEMENTATION_ADDRESS: import.meta.env.VITE_LISA_ACCOUNT_IMPLEMENTATION_ADDRESS,
});

export function deploymentLabel(config: DeploymentConfig = DEPLOYMENT): string {
  if (config.kind === 'configured') return `Chain ${config.chainId} · runtime ${config.runtime}`;
  if (config.kind === 'invalid') return `Deployment configuration rejected: ${config.reason}`;
  return `Set ${CHAIN_ID_ENV}, ${RUNTIME_ENV} and ${IMPLEMENTATION_ENV} to enable execution.`;
}
