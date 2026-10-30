import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Wallet, ZeroAddress, getAddress, verifyTypedData } from 'ethers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsonRpcSigner } from 'ethers';
import { lisaAccountInterface } from '../lisa-account/abi';
import type { AccountReader, DeploymentConfig } from '../lisa-account/types';
import type { CompileOutput } from '../compile/types';
import { buildSafeTx, safeInterface, safeTypedData, type SafeTx } from './safe';
import { referenceSafeTransactionHash } from '../test/safeReference';
import { WalletExecutionPanel } from './WalletExecutionPanel';
import { ExecuteActions } from './ExecuteActions';
import { ExecutionDialog } from './ExecutionDialog';
import { useWalletExecution } from './useWalletExecution';
import { WalletSessionContext, DISCONNECTED_SESSION, type WalletSession } from './session';

/**
 * Safe execution, end to end through the real controller: one owner key signs a
 * Safe transaction, the Safe delegatecalls the LISA runtime with the compiled
 * program, and nothing touches a chain until the review is confirmed.
 *
 * Choosing the Safe goes through the address-book dialog, so the tests drive it
 * the way a user does: open it, verify and remember, and only then execute.
 */

const OWNER_WALLET = new Wallet(`0x${'11'.repeat(32)}`);
const STRANGER_WALLET = new Wallet(`0x${'22'.repeat(32)}`);
const OWNER = OWNER_WALLET.address;
const STRANGER = STRANGER_WALLET.address;
const SAFE = '0x1234567890abcdef1234567890abcdef12345678';
const OTHER_SAFE = '0x0987654321098765432109876543210987654321';
const IMPL = '0x3333333333333333333333333333333333333333';
const RUNTIME = '0x4444444444444444444444444444444444444444';

const CHAIN = '1';
const CONFIGURED: DeploymentConfig = { kind: 'configured', chainId: CHAIN, runtime: RUNTIME, implementation: IMPL };
const OUTPUT: CompileOutput = {
  program: '0x6001',
  programHash: '0xaaaabbbbccccddddeeeeffff000011112222333344445555666677778888999a',
  byteSize: 2,
  instructionCount: 2,
  disassembly: ['PUSH1 0x00'],
};

const delegatedTo = (address: string) => `0xef0100${address.slice(2)}`;
const safeSelector = (name: string) => safeInterface.getFunction(name)!.selector;

interface Fake {
  readonly session: WalletSession;
  readonly reader: AccountReader;
  readonly sendTransaction: ReturnType<typeof vi.fn>;
  readonly signTypedData: ReturnType<typeof vi.fn>;
  /** What the wallet reports right now; a test can move it mid-flight. */
  readonly live: { account: string; chainId: string; accounts: string[] };
  /** What the Safe reports as its next nonce; a test can move it mid-flight. */
  readonly nonce: { value: bigint };
  /** When set, the Safe answers this instead of the digest it should compute. */
  readonly hash: { value: string | null };
}

interface Options {
  safeCode?: string;
  safeVersion?: string;
  /** Replaced by a throw to model a contract that is not a Safe. */
  versionCall?: () => never;
  owners?: string[];
  threshold?: bigint;
  nonce?: bigint;
  runtimeCode?: string;
  account?: string;
  signerAccount?: string;
  chainId?: string;
  signerChainId?: string;
  walletAccounts?: string[];
  output?: CompileOutput | null;
  config?: DeploymentConfig;
  send?: () => Promise<{ hash: string; wait: () => Promise<{ status: number; blockNumber: number } | null> }>;
  sign?: (domain: Parameters<typeof verifyTypedData>[0], types: Parameters<typeof verifyTypedData>[1], value: SafeTx) => Promise<string>;
  hash?: string;
}

/** Decode `getTransactionHash` calldata back into the struct the Safe hashes. */
function fromHashCall(data: string): SafeTx {
  const [to, value, bytes, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, nonce] =
    safeInterface.decodeFunctionData('getTransactionHash', data);
  return {
    to: to as string, value: value as bigint, data: bytes as string, operation: operation as 1,
    safeTxGas: safeTxGas as bigint, baseGas: baseGas as bigint, gasPrice: gasPrice as bigint,
    gasToken: gasToken as string, refundReceiver: refundReceiver as string, nonce: nonce as bigint,
  };
}

function fake(options: Options = {}): Fake {
  const live = {
    account: options.account ?? OWNER,
    chainId: options.signerChainId ?? options.chainId ?? CHAIN,
    accounts: options.walletAccounts ?? [options.account ?? OWNER],
  };
  const nonce = { value: options.nonce ?? 0n };
  const hash = { value: options.hash ?? null };
  const safeCode = options.safeCode ?? '0x6080604052348015';
  const owners = options.owners ?? [OWNER];
  const reader: AccountReader = {
    getCode: vi.fn(async (address: string) => {
      const lower = address.toLowerCase();
      if (lower === RUNTIME.toLowerCase()) return options.runtimeCode ?? '0x6080604052348015';
      if (lower === SAFE.toLowerCase() || lower === OTHER_SAFE.toLowerCase()) return safeCode;
      // The connected account is a delegated LisaAccount; in Safe mode its
      // inspection is irrelevant, but it must not fail for the wrong reason.
      return delegatedTo(IMPL);
    }),
    call: vi.fn(async ({ to, data }: { to: string; data: string }) => {
      const which = data.slice(0, 10);
      if (to.toLowerCase() !== SAFE.toLowerCase() && to.toLowerCase() !== OTHER_SAFE.toLowerCase()) {
        return lisaAccountInterface.encodeFunctionResult('lisaRuntime', [RUNTIME]);
      }
      // A small Safe: it answers from the same state and hashes with the
      // contract's own formula, so the app is checked against a second source.
      if (which === safeSelector('VERSION')) {
        if (options.versionCall) options.versionCall();
        return safeInterface.encodeFunctionResult('VERSION', [options.safeVersion ?? '1.4.1']);
      }
      if (which === safeSelector('getOwners')) return safeInterface.encodeFunctionResult('getOwners', [owners]);
      if (which === safeSelector('getThreshold')) return safeInterface.encodeFunctionResult('getThreshold', [options.threshold ?? 1n]);
      if (which === safeSelector('nonce')) return safeInterface.encodeFunctionResult('nonce', [nonce.value]);
      if (which === safeSelector('getTransactionHash')) {
        if (hash.value !== null) return safeInterface.encodeFunctionResult('getTransactionHash', [hash.value]);
        // A Safe hashes with its own chain's domain, so the fake follows the
        // chain the wallet is on rather than the one the test started from.
        return safeInterface.encodeFunctionResult('getTransactionHash', [
          referenceSafeTransactionHash(live.chainId, getAddress(SAFE), fromHashCall(data)),
        ]);
      }
      throw new Error(`unexpected Safe call ${which}`);
    }),
  };
  const sendTransaction = options.send === undefined
    // A Safe transaction increments the Safe's nonce when it executes, so a
    // second review has to be built on the nonce this leaves behind.
    ? vi.fn(async () => {
      nonce.value += 1n;
      return { hash: `0x${'ce'.repeat(32)}`, wait: async () => ({ status: 1, blockNumber: 42 }) };
    })
    : vi.fn(options.send);
  // Signing happens with a real key: a signature that does not recover the owner
  // must be rejected, and that can only be tested with real ECDSA.
  const signTypedData = vi.fn(options.sign ?? (async (domain, types, value) => OWNER_WALLET.signTypedData(
    domain, types, value as unknown as Record<string, unknown>,
  )));
  // Fixing the cache at its initial value is what makes a switch look like a lag.
  const cachedChainId = live.chainId;
  const session: WalletSession = {
    ...DISCONNECTED_SESSION,
    status: 'ready',
    reader,
    account: options.account ?? OWNER,
    chainId: options.chainId ?? CHAIN,
    walletAccounts: vi.fn(async () => live.accounts),
    switchChain: vi.fn(async () => {}),
    signer: {
      getAddress: vi.fn(async () => options.signerAccount ?? live.account),
      sendTransaction,
      signTypedData,
      provider: {
        // BrowserProvider answers `getNetwork()` from a cache that lags a real
        // switch, so the fake keeps that cache stale and reports the live chain
        // only through the EIP-1193 request — the way a wallet extension behaves.
        getNetwork: vi.fn(async () => ({ chainId: BigInt(cachedChainId) })),
        send: vi.fn(async (method: string) => {
          if (method === 'eth_chainId') return `0x${BigInt(live.chainId).toString(16)}`;
          throw new Error(`unexpected provider method ${method}`);
        }),
      },
    } as unknown as JsonRpcSigner,
  };
  return { session, reader, sendTransaction, signTypedData, live, nonce, hash };
}

function Harness({ output, config }: { output: CompileOutput | null; config?: DeploymentConfig }) {
  const execution = useWalletExecution(output, config);
  return <>
    <WalletExecutionPanel execution={execution} />
    <ExecuteActions execution={execution} />
    <ExecutionDialog execution={execution} />
  </>;
}

function panel(session: WalletSession, over: { output?: CompileOutput | null; config?: DeploymentConfig } = {}) {
  const output: CompileOutput | null = 'output' in over ? (over.output as CompileOutput | null) : OUTPUT;
  return <WalletSessionContext.Provider value={session}>
    <Harness output={output} config={over.config ?? CONFIGURED} />
  </WalletSessionContext.Provider>;
}

/** Let the hook resolve its own per-chain deployment instead of overriding it. */
function panelOnDeployment(session: WalletSession) {
  return <WalletSessionContext.Provider value={session}>
    <Harness output={OUTPUT} />
  </WalletSessionContext.Provider>;
}

async function statusIs(label: string | RegExp) {
  await waitFor(() => expect(screen.getByTestId('lisa-status')).toHaveTextContent(label), { timeout: 2000 });
}

const execute = () => screen.getByRole('button', { name: 'Execute program' });
const addField = () => screen.getByRole('textbox', { name: 'Safe address' });
// The same button opens the book whether or not a Safe is already chosen.
const openBook = () => fireEvent.click(screen.getByRole('button', { name: /^(Use Safe|Safe 0x)/ }));

/** Type an address into the dialog and ask it to verify and remember. */
async function verifyAndRemember(address: string = SAFE) {
  fireEvent.change(addField(), { target: { value: address } });
  fireEvent.click(screen.getByRole('button', { name: 'Verify and remember Safe' }));
}

async function chooseSafe(address: string = SAFE) {
  openBook();
  await verifyAndRemember(address);
  await statusIs('Ready (Safe)');
  // The dialog hands the strip over completely once it closes.
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
}

async function reviewSafe(address: string = SAFE) {
  await chooseSafe(address);
  fireEvent.click(execute());
  await screen.findByRole('button', { name: 'Sign and execute' });
}

/** Nothing may become the target of an execution until it has verified. */
function noActiveSafe() {
  expect(window.localStorage.getItem('lisa-ide.active-safe.v1')).toBeNull();
  expect(window.localStorage.getItem('lisa-ide.saved-safes.v1')).toBeNull();
}

function seedBook(entry: { address: string; chainId: string }) {
  window.localStorage.setItem('lisa-ide.saved-safes.v1', JSON.stringify([entry]));
  window.localStorage.setItem('lisa-ide.active-safe.v1', JSON.stringify(entry));
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('Safe accounts dialog', () => {
  it('starts from the account path and only reads a Safe once one is chosen', async () => {
    const f = fake();
    render(panel(f.session));
    await statusIs('Ready');
    expect(screen.getByRole('button', { name: 'Use Safe' })).toBeInTheDocument();
    expect(f.reader.getCode).not.toHaveBeenCalledWith(SAFE);
    expect(f.signTypedData).not.toHaveBeenCalled();

    openBook();
    expect(screen.getByRole('dialog', { name: 'Safe accounts' })).toBeInTheDocument();
    expect(screen.getByText(/No Safe addresses saved in this browser yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Verify and remember Safe' })).toBeDisabled();
  });

  it('refuses an input that is not a 20-byte address without reading anything', async () => {
    const f = fake();
    render(panel(f.session));
    openBook();
    fireEvent.change(addField(), { target: { value: '0xdead' } });
    expect(screen.getByText('That is not a 20-byte address.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Verify and remember Safe' })).toBeDisabled();
    expect(f.reader.getCode).not.toHaveBeenCalledWith('0xdead');
  });

  it('reports a Safe address with no code deployed (§3)', async () => {
    const f = fake({ safeCode: '0x' });
    render(panel(f.session));
    openBook();
    await verifyAndRemember();
    expect(await screen.findByText(/No contract is deployed at/i)).toBeInTheDocument();
    noActiveSafe();
    expect(f.sendTransaction).not.toHaveBeenCalled();
  });

  it('reports a Safe that needs more than one signature', async () => {
    const f = fake({ threshold: 2n, owners: [OWNER, STRANGER] });
    render(panel(f.session));
    openBook();
    await verifyAndRemember();
    expect(await screen.findByText(/requires 2 signatures/i)).toBeInTheDocument();
    noActiveSafe();
    expect(f.sendTransaction).not.toHaveBeenCalled();
  });

  it('reports an account that is not an owner of the Safe', async () => {
    const f = fake({ owners: [STRANGER] });
    render(panel(f.session));
    openBook();
    await verifyAndRemember();
    expect(await screen.findByText(/is not an owner of Safe/i)).toBeInTheDocument();
    noActiveSafe();
    expect(f.sendTransaction).not.toHaveBeenCalled();
  });

  it('refuses a Safe version whose hashing it cannot reproduce', async () => {
    const f = fake({ safeVersion: '1.2.0' });
    render(panel(f.session));
    openBook();
    await verifyAndRemember();
    expect(await screen.findByText(/reports version 1\.2\.0/i)).toBeInTheDocument();
    noActiveSafe();
    expect(f.sendTransaction).not.toHaveBeenCalled();
  });

  it('reports an address that does not answer as a Safe', async () => {
    const f = fake({ versionCall: () => { throw new Error('execution reverted') } });
    render(panel(f.session));
    openBook();
    await verifyAndRemember();
    expect(await screen.findByText(/does not answer as a Safe/i)).toBeInTheDocument();
    noActiveSafe();
    expect(f.sendTransaction).not.toHaveBeenCalled();
  });

  it('verifies, remembers, and closes on success', async () => {
    const f = fake();
    render(panel(f.session));
    await chooseSafe();
    // Closing on success leaves the strip as the one place the target is shown.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: `Safe ${getAddress(SAFE).slice(0, 6)}…${getAddress(SAFE).slice(-4)}` })).toBeInTheDocument();
    expect(f.reader.getCode).toHaveBeenCalledWith(getAddress(SAFE));
  });

  it('remembers the chosen Safe across mounts, on its own chain', async () => {
    const first = fake();
    const { unmount } = render(panel(first.session));
    await chooseSafe();
    unmount();

    const second = fake();
    render(panel(second.session));
    // Restored from storage, verified again, with nothing re-typed or re-opened.
    await statusIs('Ready (Safe)');
    expect(screen.queryByRole('button', { name: 'Use Safe' })).not.toBeInTheDocument();
  });

  it('stops using the Safe without forgetting it', async () => {
    const f = fake();
    render(panel(f.session));
    await chooseSafe();
    openBook();
    fireEvent.click(screen.getByRole('button', { name: 'Stop using this Safe' }));
    await statusIs(/^Ready$/);
    // Still listed, still saved.
    expect(screen.getByText(getAddress(SAFE))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Use Safe 0x1234…5678 on chain 1/ })).toBeInTheDocument();
  });

  it('removes a saved entry and stops using it when it was the active one', async () => {
    const f = fake();
    render(panel(f.session));
    await chooseSafe();
    openBook();
    fireEvent.click(screen.getByRole('button', { name: /Remove saved Safe 0x1234…5678 on chain 1/ }));
    expect(screen.getByText(/No Safe addresses saved in this browser yet/i)).toBeInTheDocument();
    await statusIs(/^Ready$/);
    expect(window.localStorage.getItem('lisa-ide.active-safe.v1')).toBeNull();
    // The strip goes back to the account target rather than to a missing entry.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Use Safe' })).toBeInTheDocument();
  });

  it('offers the switch for an entry pinned to another chain instead of reading it here (§2)', async () => {
    const f = fake();
    seedBook({ address: getAddress(SAFE), chainId: '11155111' });
    render(panel(f.session));
    await statusIs('Safe saved on another network');
    expect(f.reader.getCode).not.toHaveBeenCalledWith(getAddress(SAFE));

    openBook();
    expect(screen.getByRole('button', { name: /Switch network and use Safe 0x1234…5678 on chain 11155111/ })).toBeInTheDocument();
    expect(screen.getByText(/Chain 11155111 · not the connected network/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Switch network and use Safe/ }));
    // A wallet that resolves the switch without switching is refused, not trusted.
    expect(await screen.findByText(/still on chain 1, not 11155111/i)).toBeInTheDocument();
  });

  it('switches to the Safe’s chain and verifies there, even while the provider still reports the old one', async () => {
    const f = fake();
    // The wallet really switches. BrowserProvider's `getNetwork()` is still the
    // cached chain it was built with, which is exactly what a wallet extension
    // looks like between `wallet_switchEthereumChain` and its `chainChanged` event.
    const switched = vi.fn(async (chainId: string) => {
      f.live.chainId = chainId;
      (f.session as unknown as { chainId: string }).chainId = chainId;
    });
    f.session.switchChain = switched;
    // Saved, but not chosen: the entry is on a chain the wallet is not on.
    window.localStorage.setItem('lisa-ide.saved-safes.v1', JSON.stringify([{ address: getAddress(SAFE), chainId: '11155111' }]));
    render(panelOnDeployment(f.session));
    // The account path is irrelevant here: the real deployments are in use, so
    // the fake account is delegated to something else.
    await statusIs('Delegated to another implementation');

    openBook();
    fireEvent.click(screen.getByRole('button', { name: /Switch network and use Safe/ }));
    await statusIs('Ready (Safe)');
    expect(switched).toHaveBeenCalledWith('11155111');
    // Verified on, and remembered against, the chain it actually lives on.
    expect(JSON.parse(window.localStorage.getItem('lisa-ide.active-safe.v1') ?? 'null'))
      .toEqual({ address: getAddress(SAFE), chainId: '11155111' });

    fireEvent.click(execute());
    await screen.findByRole('button', { name: 'Sign and execute' });
    fireEvent.click(screen.getByRole('button', { name: 'Sign and execute' }));
    expect(await screen.findByText('Confirmed')).toBeInTheDocument();
    // The digest and the broadcast are pinned to Sepolia, not to the stale cache.
    expect(f.signTypedData.mock.calls[0][0]).toMatchObject({ chainId: 11155111n });
    expect((f.sendTransaction.mock.calls[0][0] as { chainId: bigint }).chainId).toBe(11155111n);
  });

  it('stays open while a verification is in flight, because its answer still changes the target', async () => {
    const f = fake();
    let release!: () => void;
    const parked = new Promise<void>(resolve => { release = resolve });
    const call = f.session.reader!.call as ReturnType<typeof vi.fn>;
    const original = call.getMockImplementation()!;
    call.mockImplementation(async (input: { to: string; data: string }) => {
      if (input.data.slice(0, 10) === safeSelector('getThreshold')) await parked;
      return original(input);
    });

    render(panel(f.session));
    openBook();
    await verifyAndRemember();
    // Nothing may close the window out from under a read that is still running.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled());
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'Safe accounts' })).toBeInTheDocument();

    release();
    await statusIs('Ready (Safe)');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('switches networks from the strip when the active Safe lives elsewhere', async () => {
    const f = fake();
    seedBook({ address: getAddress(SAFE), chainId: '11155111' });
    render(panel(f.session));
    await statusIs('Safe saved on another network');
    fireEvent.click(screen.getByRole('button', { name: 'Switch network' }));
    await waitFor(() => expect(f.session.switchChain).toHaveBeenCalledWith('11155111'));
  });
});

describe('Safe execution', () => {
  it('signs the Safe transaction and delegatecalls the runtime with the program', async () => {
    const f = fake();
    render(panel(f.session));
    await reviewSafe();

    // The review names the Safe, the signer, the runtime, the nonce, and no value.
    expect(screen.getByText(getAddress(SAFE))).toBeInTheDocument();
    expect(screen.getByText(OWNER)).toBeInTheDocument();
    expect(screen.getByText(RUNTIME)).toBeInTheDocument();
    expect(screen.getByText('execTransaction · delegatecall')).toBeInTheDocument();
    expect(screen.getByText(/Safe nonce/)).toBeInTheDocument();
    expect(screen.getByText(/value 0 wei/i)).toBeInTheDocument();
    expect(screen.getByText(OUTPUT.programHash)).toBeInTheDocument();
    // Nothing is sent by opening the review.
    expect(f.signTypedData).not.toHaveBeenCalled();
    expect(f.sendTransaction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Sign and execute' }));
    expect(await screen.findByText('Confirmed')).toBeInTheDocument();
    expect(screen.getByText('block 42')).toBeInTheDocument();

    // One typed-data request over exactly the transaction that would be sent.
    expect(f.signTypedData).toHaveBeenCalledOnce();
    const [domain, types, value] = f.signTypedData.mock.calls[0];
    expect(domain).toEqual({ chainId: 1n, verifyingContract: getAddress(SAFE) });
    expect(value).toEqual({
      to: RUNTIME, value: 0n, data: OUTPUT.program, operation: 1,
      safeTxGas: 0n, baseGas: 0n, gasPrice: 0n,
      gasToken: ZeroAddress, refundReceiver: ZeroAddress, nonce: 0n,
    });

    // The broadcast is the Safe's own execTransaction, not executeLisa.
    expect(f.sendTransaction).toHaveBeenCalledOnce();
    const sent = f.sendTransaction.mock.calls[0][0] as { to: string; data: string; value: bigint; chainId: bigint };
    expect(sent.value).toBe(0n);
    // Pinned to the reviewed chain, so a wallet that moved cannot send it elsewhere.
    expect(sent.chainId).toBe(1n);
    expect(sent.to.toLowerCase()).toBe(SAFE.toLowerCase());
    const [to, txValue, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, signature] =
      safeInterface.decodeFunctionData('execTransaction', sent.data);
    expect(to).toBe(RUNTIME);
    expect(txValue).toBe(0n);
    // The compiled program is the calldata the Safe delegatecalls.
    expect(data).toBe(OUTPUT.program);
    expect(operation).toBe(1n);
    expect([safeTxGas, baseGas, gasPrice]).toEqual([0n, 0n, 0n]);
    expect([gasToken, refundReceiver]).toEqual([ZeroAddress, ZeroAddress]);
    // And the signature really authorises that transaction.
    const typed = safeTypedData(CHAIN, SAFE, buildSafeTx({ runtime: RUNTIME, program: OUTPUT.program, nonce: 0n }));
    expect(verifyTypedData(typed.domain, typed.types, typed.value, signature as string)).toBe(OWNER);
  });

  it('passes a long program through unchanged, byte for byte', async () => {
    const program = `0x${'a1'.repeat(400)}`;
    const f = fake();
    render(panel(f.session, { output: { ...OUTPUT, program, byteSize: 400 } }));
    await reviewSafe();
    fireEvent.click(screen.getByRole('button', { name: 'Sign and execute' }));
    await screen.findByText('Confirmed');
    const sent = f.sendTransaction.mock.calls[0][0] as { data: string };
    const [, , data] = safeInterface.decodeFunctionData('execTransaction', sent.data);
    expect(data).toBe(program);
  });

  it('aborts when the Safe nonce moved after the review (§14)', async () => {
    const f = fake({ nonce: 0n });
    render(panel(f.session));
    await reviewSafe();
    f.nonce.value = 1n;
    fireEvent.click(screen.getByRole('button', { name: 'Sign and execute' }));
    expect(await screen.findByText(/nonce moved from 0 to 1/i)).toBeInTheDocument();
    // Nothing was signed, so there is no signature that could be reused either.
    expect(f.signTypedData).not.toHaveBeenCalled();
    expect(f.sendTransaction).not.toHaveBeenCalled();

    // The refusal also invalidates the inspection it rested on: the next review
    // must read the Safe again rather than repeat the same refusal forever.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(execute()).toBeEnabled());
    fireEvent.click(execute());
    await screen.findByRole('button', { name: 'Sign and execute' });
    fireEvent.click(screen.getByRole('button', { name: 'Sign and execute' }));
    expect(await screen.findByText('block 42')).toBeInTheDocument();
    expect(f.signTypedData.mock.calls[0][2]).toMatchObject({ nonce: 1n });
    expect(f.sendTransaction).toHaveBeenCalledOnce();
  });

  it('aborts when the Safe reports a different transaction hash', async () => {
    const f = fake({ hash: `0x${'de'.repeat(32)}` });
    render(panel(f.session));
    await reviewSafe();
    fireEvent.click(screen.getByRole('button', { name: 'Sign and execute' }));
    expect(await screen.findByText(/different transaction hash/i)).toBeInTheDocument();
    expect(f.signTypedData).not.toHaveBeenCalled();
    expect(f.sendTransaction).not.toHaveBeenCalled();
  });

  it('aborts when the wallet signs with a key that is not the reviewed owner', async () => {
    const f = fake({
      sign: async (domain, types, value) => STRANGER_WALLET.signTypedData(
        domain, types, value as unknown as Record<string, unknown>,
      ),
    });
    render(panel(f.session));
    await reviewSafe();
    fireEvent.click(screen.getByRole('button', { name: 'Sign and execute' }));
    expect(await screen.findByText(/not the reviewed owner/i)).toBeInTheDocument();
    expect(f.sendTransaction).not.toHaveBeenCalled();
  });

  it('refuses an approved-hash signature marker instead of sending it', async () => {
    const f = fake({
      sign: async (domain, types, value) => {
        const signature = await OWNER_WALLET.signTypedData(domain, types, value as unknown as Record<string, unknown>);
        // v = 1 would make the Safe treat the hash as pre-approved.
        return `${signature.slice(0, 130)}01`;
      },
    });
    render(panel(f.session));
    await reviewSafe();
    fireEvent.click(screen.getByRole('button', { name: 'Sign and execute' }));
    expect(await screen.findByText(/only accepts 27 or 28/i)).toBeInTheDocument();
    expect(f.sendTransaction).not.toHaveBeenCalled();
  });

  it('re-checks the wallet after signing, before the broadcast', async () => {
    let release!: (signature: string) => void;
    const parked = new Promise<string>(resolve => { release = resolve });
    const f = fake({
      sign: async () => parked,
    });
    render(panel(f.session));
    await reviewSafe();
    fireEvent.click(screen.getByRole('button', { name: 'Sign and execute' }));
    await waitFor(() => expect(f.signTypedData).toHaveBeenCalledOnce());
    // The wallet says a different account is connected while the prompt is open.
    f.live.accounts = [STRANGER];
    release(await OWNER_WALLET.signTypedData(
      safeTypedData(CHAIN, SAFE, buildSafeTx({ runtime: RUNTIME, program: OUTPUT.program, nonce: 0n })).domain,
      safeTypedData(CHAIN, SAFE, buildSafeTx({ runtime: RUNTIME, program: OUTPUT.program, nonce: 0n })).types,
      buildSafeTx({ runtime: RUNTIME, program: OUTPUT.program, nonce: 0n }),
    ));
    expect(await screen.findByText(/account changed after signing/i)).toBeInTheDocument();
    expect(f.sendTransaction).not.toHaveBeenCalled();
  });

  it('re-reads the Safe after a receipt, so a second run is reviewed on the next nonce', async () => {
    const f = fake({ nonce: 0n });
    render(panel(f.session));
    await reviewSafe();
    fireEvent.click(screen.getByRole('button', { name: 'Sign and execute' }));
    await screen.findByText('Confirmed');
    // The transaction itself moved the Safe's nonce to 1.
    expect(f.nonce.value).toBe(1n);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(execute()).toBeEnabled());
    fireEvent.click(execute());
    await screen.findByRole('button', { name: 'Sign and execute' });
    // A stale inspection would have offered nonce 0 and then been refused.
    expect(f.signTypedData.mock.calls[0][2]).toMatchObject({ nonce: 0n });
    fireEvent.click(screen.getByRole('button', { name: 'Sign and execute' }));
    expect(await screen.findByText('block 42')).toBeInTheDocument();
    expect(f.signTypedData).toHaveBeenCalledTimes(2);
    expect(f.signTypedData.mock.calls[1][2]).toMatchObject({ nonce: 1n });
    expect(f.sendTransaction).toHaveBeenCalledTimes(2);
  });
});
