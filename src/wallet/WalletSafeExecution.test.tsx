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
        return safeInterface.encodeFunctionResult('getTransactionHash', [
          referenceSafeTransactionHash(CHAIN, getAddress(SAFE), fromHashCall(data)),
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
      provider: { getNetwork: vi.fn(async () => ({ chainId: BigInt(live.chainId) })) },
    } as unknown as JsonRpcSigner,
  };
  return { session, reader, sendTransaction, signTypedData, live, nonce, hash };
}

function Harness({ output, config }: { output: CompileOutput | null; config: DeploymentConfig }) {
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

async function statusIs(label: string | RegExp) {
  await waitFor(() => expect(screen.getByTestId('lisa-status')).toHaveTextContent(label), { timeout: 2000 });
}

const execute = () => screen.getByRole('button', { name: 'Execute program' });
const addressField = () => screen.getByRole('textbox', { name: 'Safe address' });

async function reviewSafe(address: string = SAFE) {
  fireEvent.click(screen.getByRole('button', { name: 'Safe' }));
  fireEvent.change(addressField(), { target: { value: address } });
  await statusIs('Ready (Safe)');
  fireEvent.click(execute());
  await screen.findByRole('button', { name: 'Sign and execute' });
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('Safe execution', () => {
  it('asks for a Safe address instead of guessing one', async () => {
    const f = fake();
    render(panel(f.session));
    fireEvent.click(screen.getByRole('button', { name: 'Safe' }));
    await statusIs('Add a Safe address');
    expect(execute()).toBeDisabled();
    expect(f.reader.getCode).not.toHaveBeenCalledWith(SAFE);
  });

  it('refuses an address that is not one, without reading anything', async () => {
    const f = fake();
    render(panel(f.session));
    fireEvent.click(screen.getByRole('button', { name: 'Safe' }));
    fireEvent.change(addressField(), { target: { value: '0xdead' } });
    await statusIs('Safe address is not valid');
    expect(execute()).toBeDisabled();
    expect(f.reader.getCode).not.toHaveBeenCalledWith('0xdead');
  });

  it('reports a Safe address with no code deployed (§3)', async () => {
    const f = fake({ safeCode: '0x' });
    render(panel(f.session));
    fireEvent.click(screen.getByRole('button', { name: 'Safe' }));
    fireEvent.change(addressField(), { target: { value: SAFE } });
    await statusIs('Safe address has no code');
    expect(execute()).toBeDisabled();
    expect(f.sendTransaction).not.toHaveBeenCalled();
  });

  it('reports a Safe that needs more than one signature', async () => {
    const f = fake({ threshold: 2n, owners: [OWNER, STRANGER] });
    render(panel(f.session));
    fireEvent.click(screen.getByRole('button', { name: 'Safe' }));
    fireEvent.change(addressField(), { target: { value: SAFE } });
    await statusIs('Safe needs a single owner');
    expect(execute()).toBeDisabled();
  });

  it('reports an account that is not an owner of the Safe', async () => {
    const f = fake({ owners: [STRANGER] });
    render(panel(f.session));
    fireEvent.click(screen.getByRole('button', { name: 'Safe' }));
    fireEvent.change(addressField(), { target: { value: SAFE } });
    await statusIs('Not an owner of this Safe');
    expect(execute()).toBeDisabled();
  });

  it('refuses a Safe version whose hashing it cannot reproduce', async () => {
    const f = fake({ safeVersion: '1.2.0' });
    render(panel(f.session));
    fireEvent.click(screen.getByRole('button', { name: 'Safe' }));
    fireEvent.change(addressField(), { target: { value: SAFE } });
    await statusIs('Unsupported Safe version');
    expect(execute()).toBeDisabled();
  });

  it('reports an address that does not answer as a Safe', async () => {
    const f = fake({ versionCall: () => { throw new Error('execution reverted') } });
    render(panel(f.session));
    fireEvent.click(screen.getByRole('button', { name: 'Safe' }));
    fireEvent.change(addressField(), { target: { value: SAFE } });
    await statusIs('Address is not a Safe');
    expect(execute()).toBeDisabled();
  });

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

  it('keeps the account path selected by default and never reads a Safe there', async () => {
    const f = fake();
    render(panel(f.session));
    await statusIs('Ready');
    expect(screen.queryByRole('textbox', { name: 'Safe address' })).not.toBeInTheDocument();
    expect(f.reader.getCode).not.toHaveBeenCalledWith(SAFE);
    expect(f.signTypedData).not.toHaveBeenCalled();
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

  it('remembers the Safe address for the next visit on the same chain', async () => {
    const first = fake();
    const { unmount } = render(panel(first.session));
    fireEvent.click(screen.getByRole('button', { name: 'Safe' }));
    fireEvent.change(addressField(), { target: { value: SAFE } });
    await statusIs('Ready (Safe)');
    unmount();

    const second = fake();
    render(panel(second.session));
    fireEvent.click(screen.getByRole('button', { name: 'Safe' }));
    // Restored from storage, already checksummed, with nothing re-typed.
    await waitFor(() => expect(addressField()).toHaveValue(getAddress(SAFE)));
    await statusIs('Ready (Safe)');
  });
});
