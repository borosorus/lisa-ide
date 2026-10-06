import { createContext, useContext } from 'react';
import type { BrowserProvider, JsonRpcSigner } from 'ethers';
import type { AccountReader } from '../lisa-account/types';
import { LisaError } from '../lisa-account/types';

/**
 * The only wallet surface the app sees (AGENTS.md §1): connection/session state,
 * nothing protocol-specific. Kept apart from `WalletSessionContext.tsx` so that
 * importing `App` never imports Web3-Onboard — components read this context and
 * tests can provide a plain object.
 */

export interface WalletSession {
  readonly status: 'disconnected' | 'loading' | 'ready' | 'error';
  readonly provider: BrowserProvider | null;
  readonly signer: JsonRpcSigner | null;
  /** The provider adapted to the pure read interface the LISA layer consumes. */
  readonly reader: AccountReader | null;
  readonly account: string | null;
  /** Active chain id as a decimal string, read back from the wallet. */
  readonly chainId: string | null;
  /** Normalized message for `status === 'error'` (§12). */
  readonly message: string | null;

  connectWallet(): Promise<void>;
  disconnectWallet(): Promise<void>;
  switchChain(chainId: string): Promise<void>;
  /**
   * Accounts the wallet reports as connected *right now*. A signer caches its
   * address, so this is the only way to honour "verify the account has not
   * changed" immediately before sending (§14).
   */
  walletAccounts(): Promise<string[]>;
}

function unavailable(action: string): Promise<never> {
  return Promise.reject(new LisaError('WALLET_DISCONNECTED', `Wallet transport is not initialized; cannot ${action}.`));
}

/** Default outside a provider, e.g. in unit tests that render `<App />` alone. */
export const DISCONNECTED_SESSION: WalletSession = {
  status: 'disconnected',
  provider: null,
  signer: null,
  reader: null,
  account: null,
  chainId: null,
  message: null,
  connectWallet: () => unavailable('connect'),
  disconnectWallet: () => unavailable('disconnect'),
  switchChain: () => unavailable('switch network'),
  walletAccounts: async () => [],
};

export const WalletSessionContext = createContext<WalletSession>(DISCONNECTED_SESSION);

export function useWalletSession(): WalletSession {
  return useContext(WalletSessionContext);
}
