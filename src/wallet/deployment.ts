import { parseDeploymentConfig } from '../lisa-account/config';
import type { DeploymentConfig } from '../lisa-account/types';

/**
 * The single place the app reads Vite env (AGENTS.md §3). Both variables are
 * optional: an unconfigured build still starts, still connects a wallet, and
 * simply keeps every LISA action disabled.
 */
export const DEPLOYMENT: DeploymentConfig = parseDeploymentConfig({
  VITE_LISA_RUNTIME_ADDRESS: import.meta.env.VITE_LISA_RUNTIME_ADDRESS,
  VITE_LISA_ACCOUNT_IMPLEMENTATION_ADDRESS: import.meta.env.VITE_LISA_ACCOUNT_IMPLEMENTATION_ADDRESS,
});

export function deploymentLabel(config: DeploymentConfig = DEPLOYMENT): string {
  if (config.kind === 'configured') return `Runtime ${config.runtime}`;
  if (config.kind === 'invalid') return `Deployment configuration rejected: ${config.reason}`;
  return 'Set VITE_LISA_RUNTIME_ADDRESS and VITE_LISA_ACCOUNT_IMPLEMENTATION_ADDRESS to enable execution.';
}
