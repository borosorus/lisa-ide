import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useConnectWallet } from '@web3-onboard/react';
import { BrowserProvider, getAddress } from 'ethers';
import type { AccountReader } from '../lisa-account/types';
import { normalizeError } from './errors';
import { normalizeChainId } from './executionState';
import { WalletSessionContext, type WalletSession } from './session';

/**
 * Adapts one connected Web3-Onboard wallet into a `WalletSession` (AGENTS.md §1).
 * All signing stays in the wallet; this component only resolves the session and
 * keeps account/chain changes observable so readiness can be invalidated (§14).
 */

interface SessionState {
  readonly status: WalletSession['status'];
  readonly account: string | null;
  readonly chainId: string | null;
  readonly message: string | null;
}

const OFF: SessionState = { status: 'disconnected', account: null, chainId: null, message: null };

export function WalletSessionProvider({ children }: { children: ReactNode }) {
  const [{ wallet, connecting }, connect, disconnect] = useConnectWallet();
  const [state, setState] = useState<SessionState>(OFF);
  const [signer, setSigner] = useState<WalletSession['signer']>(null);
  // Bumped by the wallet's own change events so resolution re-runs.
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce(n => n + 1), []);

  const address = wallet?.accounts[0]?.address ?? null;
  const provider = useMemo(() => (wallet ? new BrowserProvider(wallet.provider, 'any') : null), [wallet]);

  useEffect(() => {
    const emitter = wallet?.provider;
    if (!emitter) return;
    const handler = () => refresh();
    emitter.on('accountsChanged', handler);
    emitter.on('chainChanged', handler);
    return () => {
      emitter.removeListener('accountsChanged', handler);
      emitter.removeListener('chainChanged', handler);
    };
  }, [wallet, refresh]);

  useEffect(() => {
    if (!provider) {
      setSigner(null);
      setState(OFF);
      return;
    }
    let live = true;
    setState(current => ({ ...current, status: 'loading', message: null }));
    void (async () => {
      try {
        const [next, network] = await Promise.all([
          address ? provider.getSigner(address) : provider.getSigner(),
          provider.getNetwork(),
        ]);
        if (!live) return;
        const account = getAddress(await next.getAddress());
        setSigner(next);
        setState({ status: 'ready', account, chainId: normalizeChainId(network.chainId), message: null });
      } catch (cause) {
        if (!live) return;
        setSigner(null);
        setState({ status: 'error', account: null, chainId: null, message: normalizeError(cause).message });
      }
    })();
    return () => { live = false; };
  }, [provider, address, nonce]);

  const reader = useMemo<AccountReader | null>(() => (
    provider === null ? null : {
      getCode: account => provider.getCode(account),
      call: transaction => provider.call(transaction),
    }
  ), [provider]);

  const value = useMemo<WalletSession>(() => ({
    status: connecting && state.status === 'disconnected' ? 'loading' : state.status,
    provider,
    signer,
    reader,
    account: state.account,
    chainId: state.chainId,
    message: state.message,
    connectWallet: async () => {
      try {
        await connect();
      } catch (cause) {
        setState({ status: 'error', account: null, chainId: null, message: normalizeError(cause).message });
      }
    },
    disconnectWallet: async () => {
      if (wallet) await disconnect({ label: wallet.label });
      refresh();
    },
    switchChain: async chainId => {
      const target = normalizeChainId(chainId);
      if (target === null) throw new Error('Chain id is not a valid number');
      await provider?.send('wallet_switchEthereumChain', [{ chainId: `0x${BigInt(target).toString(16)}` }]);
      refresh();
    },
    // eth_accounts, not a cached signer address: this is what the wallet is on now.
    walletAccounts: async () => (provider === null
      ? []
      : ((await provider.send('eth_accounts', [])) as string[]).map(getAddress)),
  }), [connecting, state, provider, signer, reader, wallet, connect, disconnect, refresh]);

  return <WalletSessionContext.Provider value={value}>{children}</WalletSessionContext.Provider>;
}
