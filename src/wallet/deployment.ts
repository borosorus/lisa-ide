import { deploymentForChain } from '../lisa-account/config';
import type { DeploymentConfig } from '../lisa-account/types';

export function deploymentLabel(config: DeploymentConfig): string {
  if (config.kind === 'configured') return `Chain ${config.chainId} · runtime ${config.runtime}`;
  if (config.kind === 'invalid') return `Deployment configuration rejected: ${config.reason}`;
  return 'No LISA deployment is configured for this network.';
}

export { deploymentForChain };
