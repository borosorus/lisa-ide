import { init } from '@web3-onboard/react';
import injectedModule from '@web3-onboard/injected-wallets';
import type { InitOptions, OnboardAPI } from '@web3-onboard/core';
import { tokens } from '../theme/tokens';
import { DEFAULT_CHAIN_ID } from '../lisa-account/config';

/**
 * Web3-Onboard setup. Initialization is memoized and lazy: it runs
 * when the app mounts, never on import, so importing anything under `src/wallet`
 * cannot touch the DOM, read storage, or open a wallet modal (which StrictMode's
 * double effect would otherwise do twice).
 */

/**
 * Chains the Onboard picker knows about. The RPC URLs only feed Onboard's own
 * balance/chain bookkeeping — every read and write goes through the wallet's
 * EIP-1193 provider, and the chain actually in use is read back from the wallet
 * rather than assumed from this list.
 */
const chains: NonNullable<InitOptions['chains']> = [
  { id: '0x1', token: 'ETH', label: 'Ethereum', rpcUrl: 'https://ethereum-rpc.publicnode.com' },
  { id: '0xaa36a7', token: 'SepoliaETH', label: 'Sepolia', rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com' },
];

const defaultChainHex = `0x${BigInt(DEFAULT_CHAIN_ID).toString(16)}`;
export const SUPPORTED_CHAINS: InitOptions['chains'] = [
  ...chains.filter(chain => chain.id.toLowerCase() === defaultChainHex),
  ...chains.filter(chain => chain.id.toLowerCase() !== defaultChainHex),
];

const injected = injectedModule();

let instance: OnboardAPI | null = null;

export function getOnboard(): OnboardAPI {
  instance ??= init({
    wallets: [injected],
    chains: SUPPORTED_CHAINS,
    appMetadata: {
      name: 'LISA IDE',
      description: 'Compile and execute LISA programs through a LisaAccount (EIP-7702).',
      recommendedInjectedWallets: [{ name: 'MetaMask', url: 'https://metamask.io' }],
    },
    theme: {
      '--w3o-background-color': tokens.surface.paper,
      '--w3o-foreground-color': tokens.surface.sunken,
      '--w3o-text-color': tokens.text.primary,
      '--w3o-border-color': tokens.border.subtle,
      '--w3o-action-color': tokens.accent.primary,
      '--w3o-border-radius': '10px',
      '--w3o-font-family': 'Inter, system-ui, sans-serif',
    },
    disableFontDownload: true,
    // The app renders its own compact session row (§7), so Onboard's floating
    // account center stays off.
    accountCenter: { desktop: { enabled: false }, mobile: { enabled: false } },
  });
  return instance;
}
