import { describe, expect, it } from 'vitest';
import { DEFAULT_CHAIN_ID, deploymentForChain, parseDeploymentConfig } from './config';

const IMPLEMENTATION = '0x7f5F0a949f5F9Dc78d1F8e7F648Ec12AF24ADa82';
const RUNTIME = '0x8f024da6317209Eb756f34D3D489A5b4de6152DC';
const MAINNET_IMPLEMENTATION = '0xE702F9FB288Bb97d359DA5eCB42532EAC6078871';
const MAINNET_RUNTIME = '0x7F6b058AAF78BC690f781F0914499C460Ff342D9';

describe('per-chain deployment config', () => {
  it('uses mainnet as the preferred network', () => {
    expect(DEFAULT_CHAIN_ID).toBe('1');
  });

  it('resolves the configured Sepolia deployment', () => {
    expect(deploymentForChain('0xaa36a7')).toEqual({
      kind: 'configured', chainId: '11155111', runtime: RUNTIME, implementation: IMPLEMENTATION,
    });
  });

  it('resolves the configured mainnet deployment', () => {
    expect(deploymentForChain('1')).toEqual({
      kind: 'configured', chainId: '1', runtime: MAINNET_RUNTIME, implementation: MAINNET_IMPLEMENTATION,
    });
  });

  it('fails closed for unsupported or invalid chain ids', () => {
    expect(deploymentForChain('137')).toEqual({ kind: 'unconfigured' });
    expect(deploymentForChain('not-a-chain')).toEqual({ kind: 'invalid', reason: 'Invalid connected chain id: not-a-chain' });
  });

  it('rejects partial, malformed, or zero-address static entries', () => {
    expect(parseDeploymentConfig('1', {
      name: 'Mainnet', runtime: null, accountImplementation: IMPLEMENTATION,
    })).toEqual({ kind: 'invalid', reason: 'Mainnet: runtime is not configured' });
    expect(parseDeploymentConfig('1', {
      name: 'Mainnet', runtime: 'bad', accountImplementation: IMPLEMENTATION,
    })).toEqual({ kind: 'invalid', reason: 'Mainnet runtime is not a 20-byte address' });
    expect(parseDeploymentConfig('1', {
      name: 'Mainnet', runtime: RUNTIME, accountImplementation: '0x0000000000000000000000000000000000000000',
    })).toEqual({ kind: 'invalid', reason: 'Mainnet account implementation is the zero address' });
  });
});
