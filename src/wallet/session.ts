import { createContext, useContext } from 'react';
import type { BrowserProvider, JsonRpcSigner } from 'ethers';
import { hexChainId, normalizeChainId } from '../lisa-account/chain';
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

/** A `provider.send`-shaped function, or nothing when there is no wallet. */
export type ChainSwitchSender = ((method: string, params: unknown[]) => Promise<unknown>) | null;

/**
 * One rule for asking the wallet to change network (§5). A missing transport is a
 * failure, not a no-op: silently resolving here would tell the caller the network
 * changed when nothing was ever sent. Validation happens after the transport
 * check, because "no wallet" is the more actionable fact when disconnected.
 */
export async function requestChainSwitch(send: ChainSwitchSender, chainId: string): Promise<void> {
  if (send === null) throw new LisaError('WALLET_DISCONNECTED', 'Wallet transport is not initialized; cannot switch network.');
  const target = normalizeChainId(chainId);
  if (target === null || target === '0') throw new LisaError('INVALID_CONFIG', `${chainId} is not a chain id to switch to.`);
  await send('wallet_switchEthereumChain', [{ chainId: hexChainId(target) }]);
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
  switchChain: chainId => requestChainSwitch(null, chainId),
  walletAccounts: async () => [],
};

export const WalletSessionContext = createContext<WalletSession>(DISCONNECTED_SESSION);

export function useWalletSession(): WalletSession {
  return useContext(WalletSessionContext);
}
