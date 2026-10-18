import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CompileOutput } from '../compile/types';
import { inspectLisaAccount } from '../lisa-account/inspect';
import { prepareExecuteLisaTransaction } from '../lisa-account/execute';
import { LisaError, type DeploymentConfig } from '../lisa-account/types';
import { DEPLOYMENT, deploymentLabel } from './deployment';
import { broadcastHash, normalizeError } from './errors';
import {
  canExecute, deriveGate,
  IDLE,
  normalizeChainId,
  type ExecutionGate, type Inspection, type SessionSnapshot, type TransactionPhase,
} from './executionState';
import { useWalletSession, type WalletSession } from './session';

/**
 * The execution controller: every gate, phase, and race-check the execution
 * surface needs, owned once by whoever composes the wallet components (§6, §14).
 * It never compiles and never touches a private key — it consumes the
 * CompileOutput the IDE is already showing and the session the wallet reports.
 */

/**
 * A phase survives a new compile when it is either an on-chain fact already
 * earned or a broadcast still being tracked. Intent — a review not yet sent —
 * does not: a changed program makes an unconfirmed review stale. A failure
 * that carries a hash was broadcast and must outlive the compile, because the
 * hash is the only handle left to learn the outcome (§8).
 */
function keepPhase(phase: TransactionPhase): boolean {
  if (PHASES_THAT_SURVIVE.has(phase.kind)) return true;
  return phase.kind === 'failed' && phase.txHash !== null && phase.txHash !== '';
}
const PHASES_THAT_SURVIVE = new Set(['submitted', 'confirmed', 'reverted']);

/** What the reviewed transaction was built on, captured at the moment of review. */
interface Intent {
  readonly program: string;
  readonly account: string;
  readonly chainId: string;
}

export interface GateAlert {
  readonly severity: 'error' | 'info' | 'success';
  readonly text: string;
}

export interface ExecutionController {
  readonly session: WalletSession;
  readonly config: DeploymentConfig;
  /** The program execution may see: null for an imported artifact (§4). */
  readonly output: CompileOutput | null;
  readonly gate: ExecutionGate;
  readonly phase: TransactionPhase;
  readonly canExecute: boolean;
  readonly alert: GateAlert | null;
  /** Begin the explicit review; nothing is sent by this click. */
  review(): void;
  /** The one path to a broadcast, after a reviewed intent still matches live state. */
  send(): Promise<void>;
  /** Abandon the review without sending. */
  cancelReview(): void;
  /**
   * Close the review window without abandoning the transaction. Purely visual:
   * receipt tracking lives in the controller, so pending and failure details
   * remain available inline after dismissal. Confirmed success stays dialog-only.
   */
  dismiss(): void;
  /** True while the execution dialog should be on screen. */
  readonly dialogOpen: boolean;
  requestSwitch(): Promise<void>;
  readonly switching: boolean;
  readonly switchMessage: string | null;
}

function gateAlert(gate: ExecutionGate): GateAlert | null {
  switch (gate.kind) {
    case 'wallet-disconnected': return { severity: 'info', text: 'Connect a wallet to inspect its LisaAccount.' };
    case 'wallet-error': return { severity: 'error', text: gate.reason };
    case 'unconfigured': return { severity: 'info', text: `LISA deployment not configured. ${deploymentLabel()}` };
    case 'invalid-config': return { severity: 'error', text: deploymentLabel({ kind: 'invalid', reason: gate.reason }) };
    case 'undelegated': return { severity: 'info', text: 'This account has no EIP-7702 delegation. Execution stays disabled until it is delegated to the configured LisaAccount.' };
    case 'other-delegation': return { severity: 'error', text: `Account is delegated to ${gate.implementation}, not the configured LisaAccount implementation.` };
    case 'invalid-delegation': return { severity: 'error', text: `Delegation designator is malformed: ${gate.reason}` };
    case 'invalid-lisa': return { severity: 'error', text: `Delegated to the configured LisaAccount but ${gate.reason}` };
    case 'runtime-no-code': return { severity: 'error', text: `Configured runtime ${gate.runtime} has no code deployed. Check VITE_LISA_RUNTIME_ADDRESS.` };
    case 'runtime-mismatch': return { severity: 'error', text: `LisaAccount runtime ${gate.runtime} does not match the configured runtime ${gate.expected}.` };
    case 'wrong-chain': return { severity: 'error', text: `Connected to chain ${gate.actual}; the configured LISA deployment is on chain ${gate.expected}. The account is not inspected or executed here.` };
    case 'rpc-error': return { severity: 'error', text: gate.reason };
    // One message covers both ways there is no executable program (§4).
    case 'no-program': return { severity: 'info', text: 'No current compiled program. Compile from the editor to enable execution; an imported artifact is inspected, never executed.' };
    default: return null;
  }
}

export function useWalletExecution(
  output: CompileOutput | null,
  config: DeploymentConfig = DEPLOYMENT,
): ExecutionController {
  const session = useWalletSession();
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [inspectionError, setInspectionError] = useState<string | null>(null);
  const [phase, setPhase] = useState<TransactionPhase>(IDLE);
  // The execution window is requested by review() and withdrawn by the user;
  // it survives the phase transitions of the transaction it is watching, and
  // hides itself the moment there is no phase left to watch.
  const [dialogRequested, setDialogRequested] = useState(false);
  const intent = useRef<Intent | null>(null);
  // A broadcast is in flight between the awaiting transition and the receipt
  // (or its failure). While this is true, no input change may drop the phase
  // to idle: that would hide the one status the user is waiting on and let a
  // second review race the send still resolving. Cleared on every terminal.
  const sendInFlight = useRef(false);
  const mounted = useRef(false);
  // StrictMode replays mount effects, so "is this instance still alive?" has to be
  // answered by the setup half rather than the initial value, or StrictMode's
  // cleanup would discard every result that arrives afterwards.
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false };
  }, []);

  // Updated on every render so the last checkpoint before broadcasting can see a
  // state that arrived while an earlier await was still in flight.
  const now = useRef<{
    program: string | null;
    account: string | null;
    chainId: string | null;
    status: WalletSession['status'];
  }>({ program: output?.program ?? null, account: session.account, chainId: session.chainId, status: session.status });
  now.current = { program: output?.program ?? null, account: session.account, chainId: session.chainId, status: session.status };

  const snapshot = useMemo<SessionSnapshot>(() => ({
    status: session.status, account: session.account, chainId: session.chainId, message: session.message,
  }), [session.status, session.account, session.chainId, session.message]);
  const gate = deriveGate({
    session: snapshot, config, inspection, inspectionError, hasProgram: output !== null,
  });

  // Inspect the account the session is on now; a result for any other
  // account/chain pair is never usable, so the key is stored with it (§14).
  const { reader, account, chainId } = session;
  useEffect(() => {
    setInspection(null);
    setInspectionError(null);
    if (reader === null || account === null || chainId === null || config.kind !== 'configured') return;
    // On another chain there is nothing to look at: getCode and call would read
    // some other network's account and be reported as if it belonged here (§2).
    if (chainId !== config.chainId) return;
    let live = true;
    void (async () => {
      try {
        const status = await inspectLisaAccount(reader, account, config);
        if (live && mounted.current) setInspection({ account, chainId, status });
      } catch (cause) {
        if (live && mounted.current) setInspectionError(normalizeError(cause).message);
      }
    })();
    return () => { live = false };
  }, [reader, account, chainId, config]);

  // A new or replaced compile result drops any pending intent, but not a receipt
  // already earned. An account or chain change drops the receipt too: it belongs
  // to the session it was taken on (§14, §16).
  useEffect(() => {
    setPhase(current => (keepPhase(current) || sendInFlight.current ? current : IDLE));
    intent.current = null;
  }, [account, chainId, output]);
  useEffect(() => {
    setPhase(current => (sendInFlight.current ? current : IDLE));
    intent.current = null;
  }, [account, chainId]);

  const review = useCallback(() => {
    if (output === null || session.account === null || session.chainId === null) return;
    intent.current = { program: output.program, account: session.account, chainId: session.chainId };
    setDialogRequested(true);
    setPhase({ kind: 'review' });
  }, [output, session.account, session.chainId]);

  // Closing the window is purely visual once there is a live transaction to
  // track: the receipt keeps updating in the controller either way (§8).
  const dismiss = useCallback(() => setDialogRequested(false), []);

  // Switching is offered, never performed: the wallet asks, the user answers (§2).
  const [switching, setSwitching] = useState(false);
  const [switchMessage, setSwitchMessage] = useState<string | null>(null);
  const requestSwitch = useCallback(async () => {
    if (config.kind !== 'configured') return;
    setSwitching(true);
    setSwitchMessage(null);
    try {
      await session.switchChain(config.chainId);
    } catch (cause) {
      setSwitchMessage(normalizeError(cause).message);
    } finally {
      setSwitching(false);
    }
  }, [config, session]);

  const send = useCallback(async () => {
    const wanted = intent.current;
    if (wanted === null) {
      setPhase({ kind: 'failed', txHash: null, message: 'Nothing was reviewed — nothing was sent.' });
      return;
    }
    if (config.kind !== 'configured' || session.signer === null || session.reader === null) {
      setPhase({ kind: 'failed', txHash: null, message: 'Wallet session is no longer ready.' });
      return;
    }
    // The reviewed chain has to satisfy two claims at once: the one the review
    // rested on, and the one the deployment names. The gate refuses a review on
    // another chain; this refuses to trust that the gate still applies.
    if (wanted.chainId !== config.chainId) {
      setPhase({ kind: 'failed', txHash: null, message: `Review is for chain ${wanted.chainId}; the deployment is on ${config.chainId} — nothing was sent.` });
      return;
    }
    // Everything the review rested on, read from the live values rather than from
    // anything this closure captured, and re-checked after every await below.
    const unchanged = () => {
      const live = now.current;
      return live.status === 'ready' && live.program === wanted.program
        && (live.account ?? '').toLowerCase() === wanted.account.toLowerCase()
        && live.chainId === wanted.chainId;
    };
    if (!unchanged()) {
      setPhase({ kind: 'failed', txHash: null, message: 'Program, account, or chain changed after review — nothing was sent.' });
      return;
    }
    setPhase({ kind: 'awaiting-confirmation' });
    sendInFlight.current = true;
    let txHash = '';
    try {
      // Both facts come from the wallet rather than the last render, and each has
      // to match the value the review was built on and the one the deployment
      // names. `stage` only words the message; the claim is the same each time.
      const walletUnchanged = async (stage: string) => {
        const [accounts, network] = await Promise.all([
          session.walletAccounts(),
          session.signer!.provider.getNetwork(),
        ]);
        if (accounts.length === 0) {
          throw new LisaError('WALLET_DISCONNECTED', 'Wallet reports no connected account — nothing was sent.');
        }
        if (!accounts.some(a => a.toLowerCase() === wanted.account.toLowerCase())) {
          throw new LisaError('WALLET_DISCONNECTED', `Connected account changed ${stage} — nothing was sent.`);
        }
        const liveChain = normalizeChainId(network.chainId);
        if (liveChain !== wanted.chainId || liveChain !== config.chainId) {
          throw new LisaError('WRONG_CHAIN', `Connected chain changed ${stage} — nothing was sent.`);
        }
      };
      // A JsonRpcSigner caches the address it was built with, so asking it who is
      // connected says nothing about the wallet now. Ask the wallet instead (§14).
      const signerAddress = await session.signer.getAddress();
      if (!unchanged()) throw new LisaError('WALLET_DISCONNECTED', 'Session changed while checking — nothing was sent.');
      if (signerAddress.toLowerCase() !== wanted.account.toLowerCase()) {
        throw new LisaError('WALLET_DISCONNECTED', 'Connected account changed before sending — nothing was sent.');
      }
      await walletUnchanged('before sending');
      const status = await inspectLisaAccount(session.reader, wanted.account, config);
      if (status.kind !== 'ready') {
        throw new LisaError(
          status.kind === 'runtime-mismatch' ? 'RUNTIME_MISMATCH' : 'UNKNOWN_DELEGATION',
          `Account is no longer a ready LisaAccount (${status.kind}) — nothing was sent.`,
        );
      }
      // Reading the chain and the delegation takes time, and the wallet can move
      // during it. The last render is not evidence of what the wallet is on now,
      // so ask again immediately before the one thing that cannot be undone.
      await walletUnchanged('while checking');
      if (!unchanged()) {
        throw new LisaError('WALLET_DISCONNECTED', 'Program, account, or chain changed while checking — nothing was sent.');
      }
      const transaction = prepareExecuteLisaTransaction({ account: wanted.account, program: wanted.program, status });
      const sent = await session.signer.sendTransaction(transaction);
      txHash = sent.hash ?? '';
      if (!mounted.current) return;
      setPhase({ kind: 'submitted', txHash });
      const receipt = await sent.wait();
      if (!mounted.current) return;
      if (receipt === null) setPhase({ kind: 'failed', txHash, message: 'No receipt received.' });
      else if (receipt.status === 1) setPhase({ kind: 'confirmed', txHash, blockNumber: receipt.blockNumber });
      else if (receipt.status === 0) setPhase({ kind: 'reverted', txHash });
      else setPhase({ kind: 'failed', txHash, message: 'Receipt status is unavailable.' });
    } catch (cause) {
      if (!mounted.current) return;
      const error = normalizeError(cause);
      // A broadcast can succeed while tracking it fails; the hash has to survive
      // that, or there is no way left to find out what happened.
      const broadcast = txHash === '' ? broadcastHash(cause) : null;
      // No automatic retry, in any branch (§8).
      if (broadcast !== null) {
        setPhase({ kind: 'failed', txHash: broadcast, message: 'Submitted but not trackable — follow the hash for its result.' });
      } else {
        setPhase(error.code === 'TRANSACTION_REVERTED'
          ? { kind: 'reverted', txHash }
          : { kind: 'failed', txHash: txHash === '' ? null : txHash, message: error.message });
      }
    } finally {
      // Whatever the outcome, the broadcast is no longer unresolved — input
      // changes may resume clearing the phase from here on.
      sendInFlight.current = false;
    }
  }, [config, session.signer, session.reader, session.walletAccounts]);

  const cancelReview = useCallback(() => {
    intent.current = null;
    setDialogRequested(false);
    setPhase(IDLE);
  }, []);

  return {
    session, config, output, gate, phase,
    canExecute: canExecute(gate),
    alert: gateAlert(gate),
    // A requested window with nothing left to watch is no window at all.
    dialogOpen: dialogRequested && phase.kind !== 'idle',
    review, send, cancelReview, dismiss, requestSwitch, switching, switchMessage,
  };
}
