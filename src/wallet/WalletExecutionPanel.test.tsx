import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { JsonRpcSigner } from 'ethers';
import { encodeExecuteLisa } from '../lisa-account/execute';
import { lisaAccountInterface } from '../lisa-account/abi';
import type { AccountReader, DeploymentConfig } from '../lisa-account/types';
import type { CompileOutput } from '../compile/types';
import { WalletExecutionPanel } from './WalletExecutionPanel';
import { ExecuteActions } from './ExecuteActions';
import { useWalletExecution } from './useWalletExecution';
import { WalletSessionContext, DISCONNECTED_SESSION, type WalletSession } from './session';

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const OTHER_ACCOUNT = '0x2222222222222222222222222222222222222222';
const IMPL = '0x3333333333333333333333333333333333333333';
const RUNTIME = '0x4444444444444444444444444444444444444444';
const FOREIGN = '0x5555555555555555555555555555555555555555';

/** The fake session's chain and the chain its deployment is configured for. */
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
const runtimeWord = (address: string) => lisaAccountInterface.encodeFunctionResult('lisaRuntime', [address]);

interface Fake {
  readonly session: WalletSession;
  readonly reader: AccountReader;
  readonly sendTransaction: ReturnType<typeof vi.fn>;
  /** What the wallet reports right now; a test can move it mid-flight. */
  readonly live: { account: string; chainId: string; accounts: string[] };
}

interface Options {
  code?: string | ((address: string) => Promise<string>);
  /** What sits at the configured runtime address; anything non-empty counts as deployed. */
  runtimeCode?: string | (() => Promise<string>);
  runtimeAddress?: string;
  account?: string;
  /** What the signer reports at signing time; differs from `account` to test races. */
  signerAccount?: string;
  chainId?: string;
  signerChainId?: string;
  /** What the wallet itself reports as connected, independent of the signer. */
  walletAccounts?: string[];
  output?: CompileOutput | null;
  config?: DeploymentConfig;
  send?: () => Promise<{ hash: string; wait: () => Promise<{ status: number; blockNumber: number } | null> }>;
  switchChain?: (chainId: string) => Promise<void>;
}

function fake(options: Options = {}): Fake {
  const code = options.code ?? delegatedTo(IMPL);
  const runtimeCode = options.runtimeCode ?? '0x6080604052';
  const live = {
    account: options.account ?? ACCOUNT,
    chainId: options.signerChainId ?? options.chainId ?? CHAIN,
    accounts: options.walletAccounts ?? [options.account ?? ACCOUNT],
  };
  const reader: AccountReader = {
    // Address-aware, as a real reader is: the delegation lives on the account, the
    // bytecode on the runtime, and conflating them would hide a missing deployment.
    getCode: vi.fn(async (address: string) => (address.toLowerCase() === RUNTIME.toLowerCase()
      ? typeof runtimeCode === 'function' ? runtimeCode() : runtimeCode
      : typeof code === 'function' ? code(address) : code)),
    call: vi.fn(async () => runtimeWord(options.runtimeAddress ?? RUNTIME)),
  };
  const sendTransaction = options.send === undefined
    ? vi.fn(async () => ({ hash: `0x${'ce'.repeat(32)}`, wait: async () => ({ status: 1, blockNumber: 42 }) }))
    : vi.fn(options.send);
  const session: WalletSession = {
    ...DISCONNECTED_SESSION,
    status: 'ready',
    reader,
    account: options.account ?? ACCOUNT,
    chainId: options.chainId ?? CHAIN,
    walletAccounts: vi.fn(async () => live.accounts),
    switchChain: vi.fn(options.switchChain ?? (async () => {})),
    signer: {
      getAddress: vi.fn(async () => options.signerAccount ?? live.account),
      sendTransaction,
      provider: { getNetwork: vi.fn(async () => ({ chainId: BigInt(live.chainId) })) },
    } as unknown as JsonRpcSigner,
  };
  return { session, reader, sendTransaction, live };
}

/** The composition App owns: controller + strip view (+ Output-side action), under a fake session. */
function Harness({ output, config, location = 'strip' }: {
  output: CompileOutput | null;
  config: DeploymentConfig;
  location?: 'strip' | 'output';
}) {
  const execution = useWalletExecution(output, config);
  return <>
    <WalletExecutionPanel execution={execution} executeLocation={location} />
    {location === 'output' && <ExecuteActions execution={execution} />}
  </>;
}

function panel(session: WalletSession, over: { output?: CompileOutput | null; config?: DeploymentConfig } = {}) {
  // `null` must stay null: it means "no current compiled program" (§6).
  const output: CompileOutput | null = 'output' in over ? (over.output as CompileOutput | null) : OUTPUT;
  return <WalletSessionContext.Provider value={session}>
    <Harness output={output} config={over.config ?? CONFIGURED} />
  </WalletSessionContext.Provider>;
}

async function statusIs(label: string | RegExp) {
  await waitFor(() => expect(screen.getByTestId('lisa-status')).toHaveTextContent(label), { timeout: 2000 });
}

const execute = () => screen.getByRole('button', { name: 'Execute program' });

async function readyToExecute(): Promise<{ sendTransaction: ReturnType<typeof vi.fn> }> {
  const f = fake();
  render(panel(f.session));
  await statusIs('Ready');
  fireEvent.click(execute());
  await screen.findByText(ACCOUNT);
  return f;
}

describe('WalletExecutionPanel', () => {
  it('offers a connection instead of account details while disconnected', () => {
    render(panel(DISCONNECTED_SESSION, { config: CONFIGURED }));
    expect(screen.getByRole('button', { name: 'Connect wallet' })).toBeInTheDocument();
    expect(execute()).toBeDisabled();
  });

  it('says so when no deployment is configured, and keeps execution disabled (§3)', async () => {
    const f = fake();
    render(panel(f.session, { config: { kind: 'unconfigured' } }));
    await statusIs('LISA deployment not configured');
    expect(execute()).toBeDisabled();
    expect(f.reader.getCode).not.toHaveBeenCalled();
  });

  it('disables execution while there is no current compiled program (§6)', async () => {
    const f = fake();
    render(panel(f.session, { output: null }));
    await statusIs('No executable program');
    expect(execute()).toBeDisabled();
  });

  it('reports an undelegated account instead of executing through it (§4)', async () => {
    const f = fake({ code: '0x' });
    render(panel(f.session));
    await statusIs('Account has no LISA delegation');
    expect(execute()).toBeDisabled();
    expect(f.reader.getCode).toHaveBeenCalledWith(ACCOUNT);
    expect(f.reader.call).not.toHaveBeenCalled();
  });

  it('reports a delegation to a different implementation without probing it', async () => {
    const f = fake({ code: delegatedTo(FOREIGN) });
    render(panel(f.session));
    await statusIs('Delegated to another implementation');
    expect(execute()).toBeDisabled();
    expect(screen.getByText(new RegExp(FOREIGN.slice(0, 10), 'i'))).toBeInTheDocument();
    expect(f.reader.call).not.toHaveBeenCalled();
  });

  it('reports a LisaAccount bound to another runtime', async () => {
    const f = fake({ runtimeAddress: FOREIGN });
    render(panel(f.session));
    await statusIs('LisaAccount runtime mismatch');
    expect(execute()).toBeDisabled();
  });

  it('fails closed on a malformed delegation designator', async () => {
    const f = fake({ code: '0xef0100aabb' });
    render(panel(f.session));
    await statusIs('Malformed delegation');
    expect(execute()).toBeDisabled();
  });

  it('reports an inspection transport failure without a raw provider blob', async () => {
    const f = fake({ code: async () => { throw new TypeError('Failed to fetch') } });
    render(panel(f.session));
    await statusIs('Account inspection failed');
    expect(execute()).toBeDisabled();
  });

  it('sends executeLisa to the account itself, only after an explicit confirmation (§8)', async () => {
    const { sendTransaction } = await readyToExecute();
    // The review surface names the destination and the exact program (§14).
    expect(screen.getByText(/value 0 wei/i)).toBeInTheDocument();
    expect(screen.getByText(OUTPUT.programHash)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and send' }));
    expect(await screen.findByText('Confirmed')).toBeInTheDocument();
    expect(screen.getByText('block 42')).toBeInTheDocument();
    expect(sendTransaction).toHaveBeenCalledOnce();
    expect(sendTransaction).toHaveBeenCalledWith({ to: ACCOUNT, data: encodeExecuteLisa('0x6001'), value: 0n });
  });

  it('passes the program bytes through unchanged', async () => {
    const program = `0x${'a1'.repeat(120)}`;
    const f = fake();
    render(panel(f.session, { output: { ...OUTPUT, program, byteSize: 120 } }));
    await statusIs('Ready');
    fireEvent.click(execute());
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm and send' }));
    await screen.findByText('Confirmed');
    const call = f.sendTransaction.mock.calls[0][0] as { data: string };
    const [bytes] = lisaAccountInterface.decodeFunctionData('executeLisa', call.data);
    expect(bytes).toBe(program);
  });

  it('sends nothing when the review is cancelled', async () => {
    const { sendTransaction } = await readyToExecute();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(sendTransaction).not.toHaveBeenCalled();
    expect(execute()).toBeEnabled();
  });

  it('shows a reverted receipt and never retries it (§8)', async () => {
    const f = fake({ send: async () => ({ hash: `0x${'ab'.repeat(32)}`, wait: async () => ({ status: 0, blockNumber: 7 }) }) });
    render(panel(f.session));
    await statusIs('Ready');
    fireEvent.click(execute());
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm and send' }));
    expect(await screen.findByText('Reverted')).toBeInTheDocument();
    expect(screen.getByText(/not retried automatically/i)).toBeInTheDocument();
    await waitFor(() => expect(f.sendTransaction).toHaveBeenCalledOnce());
  });

  it('surfaces a wallet rejection cleanly, with no transaction hash to follow (§12)', async () => {
    const f = fake({
      send: async () => {
        throw Object.assign(new Error('User denied transaction signature.'), { code: 'ACTION_REJECTED' });
      },
    });
    render(panel(f.session));
    await statusIs('Ready');
    fireEvent.click(execute());
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm and send' }));
    expect(await screen.findByText('Request rejected in the wallet.')).toBeInTheDocument();
    expect(screen.getByTestId('lisa-status')).toHaveTextContent('Ready');
    expect(screen.queryByText(new RegExp(`0x${'ce'.repeat(32)}`))).not.toBeInTheDocument();
  });

  it('re-checks the signer before broadcasting and aborts if the account moved', async () => {
    const f = fake({ signerAccount: OTHER_ACCOUNT });
    render(panel(f.session));
    await statusIs('Ready');
    fireEvent.click(execute());
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm and send' }));
    expect(await screen.findByText(/account changed before sending/i)).toBeInTheDocument();
    expect(f.sendTransaction).not.toHaveBeenCalled();
  });

  it('aborts when the chain moved underneath the review', async () => {
    const f = fake({ signerChainId: '11155111' });
    render(panel(f.session));
    await statusIs('Ready');
    fireEvent.click(execute());
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm and send' }));
    expect(await screen.findByText(/chain changed before sending/i)).toBeInTheDocument();
    expect(f.sendTransaction).not.toHaveBeenCalled();
  });

  it('aborts when the delegation stopped being ready before sending', async () => {
    let code = delegatedTo(IMPL);
    const f = fake({ code: async () => code });
    render(panel(f.session));
    await statusIs('Ready');
    fireEvent.click(execute());
    code = '0x';
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm and send' }));
    expect(await screen.findByText(/no longer a ready lisaaccount/i)).toBeInTheDocument();
    expect(f.sendTransaction).not.toHaveBeenCalled();
  });

  it('drops the review and the readiness when the account changes (§14, §16)', async () => {
    const first = fake();
    const { rerender } = render(panel(first.session));
    await statusIs('Ready');
    fireEvent.click(execute());
    await screen.findByText(ACCOUNT);
    // The replacement account's inspection deliberately never settles, so the
    // assertion cannot pass by racing a fresh inspection to completion.
    rerender(panel(fake({ account: OTHER_ACCOUNT, code: () => new Promise<string>(() => {}) }).session));
    await statusIs('Inspecting account…');
    expect(execute()).toBeDisabled();
    expect(first.sendTransaction).not.toHaveBeenCalled();
  });

  it('drops readiness when the chain changes underneath an existing inspection', async () => {
    const first = fake();
    const { rerender } = render(panel(first.session));
    await statusIs('Ready');
    rerender(panel(fake({ chainId: '11155111', code: () => new Promise<string>(() => {}) }).session));
    await statusIs('Connected to the wrong network');
    expect(execute()).toBeDisabled();
  });

  it('reads nothing at all on a chain the deployment is not on (§2)', async () => {
    const switchChain = vi.fn(async () => {});
    const f = fake({ chainId: '11155111', switchChain });
    render(panel(f.session));
    await statusIs(/wrong network/i);
    // Not "unknown account" after a doomed read: the account is simply not here.
    expect(screen.getByRole('status')).toHaveTextContent(/chain 11155111/);
    expect(f.reader.getCode).not.toHaveBeenCalled();
    expect(f.reader.call).not.toHaveBeenCalled();
    expect(execute()).toBeDisabled();
    // Switching is offered, and only happens when the user asks for it (§2).
    expect(switchChain).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Switch network' }));
    await waitFor(() => expect(switchChain).toHaveBeenCalledWith(CHAIN));
  });

  it('keeps the gate explanation in the strip while the action sits with the program', async () => {
    const switchChain = vi.fn(async () => {});
    const f = fake({ chainId: '11155111', switchChain });
    render(<WalletSessionContext.Provider value={f.session}>
      <Harness output={OUTPUT} config={CONFIGURED} location="output" />
    </WalletSessionContext.Provider>);
    await statusIs(/wrong network/i);
    // The strip still owns the status story even though the button lives elsewhere.
    expect(screen.getByRole('status')).toHaveTextContent(/chain 11155111/);
    fireEvent.click(screen.getByRole('button', { name: 'Switch network' }));
    await waitFor(() => expect(switchChain).toHaveBeenCalledWith(CHAIN));
    // The action sits with the program, disabled while the gate refuses (§2).
    expect(execute()).toBeDisabled();
    expect(f.reader.getCode).not.toHaveBeenCalled();
  });

  it('reports a runtime address that has no code, and never calls it ready (§3)', async () => {
    const f = fake({ runtimeCode: '0x' });
    render(panel(f.session));
    await statusIs('Configured runtime has no code');
    expect(execute()).toBeDisabled();
    expect(f.reader.getCode).toHaveBeenCalledWith(RUNTIME);
    expect(f.sendTransaction).not.toHaveBeenCalled();
  });

  it('re-inspects a replacement program only when the account or chain moved', async () => {
    const f = fake();
    const { rerender } = render(panel(f.session));
    await statusIs('Ready');
    const reads = (f.reader.getCode as ReturnType<typeof vi.fn>).mock.calls.length;
    rerender(panel(f.session, { output: { ...OUTPUT, program: '0x6002' } }));
    await statusIs('Ready');
    expect((f.reader.getCode as ReturnType<typeof vi.fn>).mock.calls.length).toBe(reads);
    fireEvent.click(execute());
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm and send' }));
    await screen.findByText('Confirmed');
    // The replacement program is what goes out, not the one first reviewed (§6).
    expect(f.sendTransaction).toHaveBeenCalledWith(expect.objectContaining({ data: encodeExecuteLisa('0x6002') }));
  });

  it('aborts when the wallet reports a different account than the reviewed one', async () => {
    // The signer still names ACCOUNT; only the wallet knows it moved. A cached
    // signer address is not evidence of what is connected now (§14).
    const f = fake({ walletAccounts: [OTHER_ACCOUNT] });
    render(panel(f.session));
    await statusIs('Ready');
    fireEvent.click(execute());
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm and send' }));
    expect(await screen.findByText(/connected account changed before sending/i)).toBeInTheDocument();
    expect(f.sendTransaction).not.toHaveBeenCalled();
  });

  it('aborts when the wallet reports no connected account at all', async () => {
    const f = fake({ walletAccounts: [] });
    render(panel(f.session));
    await statusIs('Ready');
    fireEvent.click(execute());
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm and send' }));
    expect(await screen.findByText(/reports no connected account/i)).toBeInTheDocument();
    expect(f.sendTransaction).not.toHaveBeenCalled();
  });

  it('asks the wallet again after the send-side inspection, not only before it', async () => {
    // The inspection is where the time goes: one read of the runtime completes the
    // panel's readiness, the second one is the send's and is parked here. If the
    // wallet moves during it, nothing may still be broadcast.
    let release!: (code: string) => void;
    const parked = new Promise<string>(resolve => { release = resolve });
    let reads = 0;
    const f = fake({ runtimeCode: async () => (++reads > 1 ? parked : '0x60') });
    render(panel(f.session));
    await statusIs('Ready');
    fireEvent.click(execute());
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm and send' }));
    await waitFor(() => expect(reads).toBe(2));
    f.live.chainId = '11155111';
    release('0x60');
    expect(await screen.findByText(/chain changed while checking/i)).toBeInTheDocument();
    expect(f.sendTransaction).not.toHaveBeenCalled();
  });

  it('aborts when the compiled program is replaced during the pre-send check', async () => {
    let release!: (value: string) => void;
    const pending = new Promise<string>(resolve => { release = resolve });
    let first = true;
    const f = fake({ code: async () => { if (first) { first = false; return delegatedTo(IMPL) } return pending } });
    const { rerender } = render(panel(f.session));
    await statusIs('Ready');
    fireEvent.click(execute());
    await screen.findByText(ACCOUNT);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and send' }));
    // A new compile lands while the send-side inspection is still in flight.
    rerender(panel(f.session, { output: { ...OUTPUT, program: '0x6002' } }));
    release(delegatedTo(IMPL));
    expect(await screen.findByText(/changed while checking/i)).toBeInTheDocument();
    expect(f.sendTransaction).not.toHaveBeenCalled();
  });

  it('keeps a broadcast hash that the provider attached to a tracking failure', async () => {
    const hash = `0x${'9d'.repeat(32)}`;
    const f = fake({
      send: async () => {
        throw Object.assign(new Error('could not detect network'), { info: { sendTransactionHash: hash } });
      },
    });
    render(panel(f.session));
    await statusIs('Ready');
    fireEvent.click(execute());
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm and send' }));
    expect(await screen.findByText(/submitted but not trackable/i)).toBeInTheDocument();
    expect(screen.getByText(hash)).toBeInTheDocument();
  });

  it('offers a fresh explicit execution once a receipt settles', async () => {
    const f = fake();
    render(panel(f.session));
    await statusIs('Ready');
    fireEvent.click(execute());
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm and send' }));
    await screen.findByText('Confirmed');
    // The action returns rather than the panel dead-ending, and a second run is
    // still an explicit choice, never an automatic retry (§8).
    fireEvent.click(await screen.findByRole('button', { name: 'Execute program' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm and send' }));
    await waitFor(() => expect(f.sendTransaction).toHaveBeenCalledTimes(2));
  });

  it('still inspects under StrictMode, whose effects run twice on mount', async () => {
    const f = fake();
    render(<StrictMode>
      <WalletSessionContext.Provider value={f.session}>
        <Harness output={OUTPUT} config={CONFIGURED} />
      </WalletSessionContext.Provider>
    </StrictMode>);
    await statusIs('Ready');
    expect(execute()).toBeEnabled();
  });

  it('drops a receipt earned on another account instead of showing it here', async () => {
    const first = fake();
    const { rerender } = render(panel(first.session));
    await statusIs('Ready');
    fireEvent.click(execute());
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm and send' }));
    await screen.findByText('Confirmed');
    rerender(panel(fake({ account: OTHER_ACCOUNT, code: () => new Promise<string>(() => {}) }).session));
    await statusIs('Inspecting account…');
    expect(screen.queryByText('Confirmed')).not.toBeInTheDocument();
  });
});
