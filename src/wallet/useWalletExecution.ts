import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JsonRpcSigner } from 'ethers';
import type { CompileOutput } from '../compile/types';
import { inspectLisaAccount } from '../lisa-account/inspect';
import { prepareExecuteLisaTransaction } from '../lisa-account/execute';
import { LisaError, type DeploymentConfig } from '../lisa-account/types';
import { deploymentForChain, deploymentLabel } from './deployment';
import { broadcastHash, normalizeError } from './errors';
import {
  canExecute, deriveGate, describeGate,
  IDLE,
  normalizeChainId,
  type ExecutionGate, type Inspection, type SafeInspection,
  type SessionSnapshot, type TransactionPhase,
} from './executionState';
import {
  buildSafeTx, hashSafeTx, inspectSafeExecution, normalizeSafeSignature, parseSafeAddress,
  prepareSafeExecutionTransaction, readSafeNonce, readSafeTransactionHash, recoverSafeSigner,
  safeTypedData, type SafeAddress,
} from './safe';
import {
  addSafeAddress, readActiveSafe, readSavedSafes, safeAddressKey, sameSafeAddress,
  writeActiveSafe, writeSavedSafes, withoutSafeAddress,
} from './safeSettings';
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

/**
 * What the reviewed transaction was built on, captured at the moment of review.
 * A Safe review additionally captures the nonce: a Safe signature authorises one
 * exact nonce, so a moved nonce is a different transaction, not a retry (§14).
 */
type Intent =
  | { readonly kind: 'eoa'; readonly program: string; readonly account: string; readonly chainId: string }
  | {
    readonly kind: 'safe';
    readonly program: string;
    readonly safe: string;
    readonly owner: string;
    readonly runtime: string;
    readonly chainId: string;
    readonly nonce: bigint;
  };

/** What the review window displays; it is the intent, minus the program it sits beside. */
export type ReviewTarget =
  | { readonly kind: 'eoa'; readonly account: string }
  | {
    readonly kind: 'safe';
    readonly safe: string;
    readonly owner: string;
    readonly runtime: string;
    readonly nonce: bigint;
  };

interface SendState { txHash: string }

interface PreparedTransaction {
  readonly to: string;
  readonly data: string;
  readonly value: bigint;
}

/** Broadcast, then follow the receipt, publishing each phase as it becomes true. */
async function broadcast(
  signer: JsonRpcSigner,
  transaction: PreparedTransaction,
  state: SendState,
  alive: () => boolean,
  update: (phase: TransactionPhase) => void,
): Promise<void> {
  const sent = await signer.sendTransaction(transaction);
  state.txHash = sent.hash ?? '';
  if (!alive()) return;
  update({ kind: 'submitted', txHash: state.txHash });
  const receipt = await sent.wait();
  if (!alive()) return;
  if (receipt === null) update({ kind: 'failed', txHash: state.txHash, message: 'No receipt received.' });
  else if (receipt.status === 1) update({ kind: 'confirmed', txHash: state.txHash, blockNumber: receipt.blockNumber });
  else if (receipt.status === 0) update({ kind: 'reverted', txHash: state.txHash });
  else update({ kind: 'failed', txHash: state.txHash, message: 'Receipt status is unavailable.' });
}

/** Terminal phase for a failed send, with no automatic retry in any branch (§8). */
function settle(
  cause: unknown,
  state: SendState,
  alive: () => boolean,
  update: (phase: TransactionPhase) => void,
): void {
  if (!alive()) return;
  const error = normalizeError(cause);
  // A broadcast can succeed while tracking it fails; the hash has to survive
  // that, or there is no way left to find out what happened.
  const stillBroadcast = state.txHash === '' ? broadcastHash(cause) : null;
  if (stillBroadcast !== null) {
    update({ kind: 'failed', txHash: stillBroadcast, message: 'Submitted but not trackable — follow the hash for its result.' });
    return;
  }
  update(error.code === 'TRANSACTION_REVERTED'
    ? { kind: 'reverted', txHash: state.txHash }
    : { kind: 'failed', txHash: state.txHash === '' ? null : state.txHash, message: error.message });
}

/**
 * The chain the wallet is on right now. `BrowserProvider.getNetwork()` answers
 * from a cached network that only refreshes when the wallet's `chainChanged`
 * event arrives, so immediately after a switch it can still name the chain that
 * was left. The EIP-1193 request is answered from live state; the cached network
 * is the fallback for a provider that does not expose it (§2).
 */
async function liveChainId(provider: JsonRpcSigner['provider']): Promise<string | null> {
  const request = (provider as unknown as {
    send?: (method: string, params: unknown[]) => Promise<unknown>;
  }).send;
  if (typeof request === 'function') {
    try {
      const answer = await request.call(provider, 'eth_chainId', []);
      const chainId = normalizeChainId(typeof answer === 'string' ? answer : String(answer));
      if (chainId !== null) return chainId;
    } catch {
      // Fall through: a cached answer is still better than none.
    }
  }
  try {
    return normalizeChainId((await provider.getNetwork()).chainId);
  } catch {
    return null;
  }
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
  /** Where the reviewed transaction would run; null outside a review. */
  readonly reviewTarget: ReviewTarget | null;
  /**
   * The Safe execution runs through; null means the connected account's own
   * EIP-7702 delegation. An entry is pinned to its chain, so it is chosen on the
   * network it was verified on (§2, §5).
   */
  readonly activeSafe: SafeAddress | null;
  /** Every Safe address saved in this browser, across chains. */
  readonly savedSafes: readonly SafeAddress[];
  /**
   * Make a Safe the execution target and remember it. The Safe is verified on
   * chain first — switching the wallet to its network when it is not the current
   * one — and the promise rejects with a readable reason when it is not usable.
   */
  selectSafe(address: string, chainId: string): Promise<void>;
  /** Go back to executing through the connected account. */
  clearSafe(): void;
  /** Forget a saved Safe; also stops using it when it is the active one. */
  removeSafe(address: string, chainId: string): void;
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
  /** Ask the wallet to switch networks, to `chainId` or to the configured one. */
  requestSwitch(chainId?: string): Promise<void>;
  readonly switching: boolean;
  readonly switchMessage: string | null;
}

function gateAlert(gate: ExecutionGate): GateAlert | null {
  switch (gate.kind) {
    case 'wallet-disconnected': return { severity: 'info', text: 'Connect a wallet to inspect its LisaAccount.' };
    case 'wallet-error': return { severity: 'error', text: gate.reason };
    case 'unconfigured': return { severity: 'info', text: `LISA deployment not configured. ${deploymentLabel({ kind: 'unconfigured' })}` };
    case 'invalid-config': return { severity: 'error', text: deploymentLabel({ kind: 'invalid', reason: gate.reason }) };
    case 'undelegated': return { severity: 'info', text: 'This account has no EIP-7702 delegation. Execution stays disabled until it is delegated to the configured LisaAccount.' };
    case 'other-delegation': return { severity: 'error', text: `Account is delegated to ${gate.implementation}, not the configured LisaAccount implementation.` };
    case 'invalid-delegation': return { severity: 'error', text: `Delegation designator is malformed: ${gate.reason}` };
    case 'invalid-lisa': return { severity: 'error', text: `Delegated to the configured LisaAccount but ${gate.reason}` };
    case 'runtime-no-code': return { severity: 'error', text: `Configured runtime ${gate.runtime} has no code deployed. Check the chain deployment config.` };
    case 'runtime-mismatch': return { severity: 'error', text: `LisaAccount runtime ${gate.runtime} does not match the configured runtime ${gate.expected}.` };
    case 'wrong-chain': return { severity: 'error', text: `Connected to chain ${gate.actual}; the configured LISA deployment is on chain ${gate.expected}. The account is not inspected or executed here.` };
    case 'rpc-error': return { severity: 'error', text: gate.reason };
    // One message covers both ways there is no executable program (§4).
    case 'no-program': return { severity: 'info', text: 'No current compiled program. Compile from the editor to enable execution; an imported artifact is inspected, never executed.' };
    // Switching networks does not move the Safe, so the refusal names both chains.
    case 'safe-other-chain': return { severity: 'info', text: `The active Safe is saved on chain ${gate.expected}, but the wallet is on chain ${gate.actual}. Switch the wallet to chain ${gate.expected} to execute through it, or choose another Safe.` };
    case 'safe-address-invalid': return { severity: 'error', text: 'The saved Safe address is not a 20-byte address, so it is not used. Remove it and add the Safe again.' };
    case 'safe-no-code': return { severity: 'error', text: `No contract is deployed at ${gate.safe} on this chain. Check the address and the connected network.` };
    case 'safe-not-a-safe': return { severity: 'error', text: `${gate.safe} does not answer as a Safe: ${gate.reason}` };
    case 'safe-unsupported-version': return { severity: 'error', text: `Safe ${gate.safe} reports version ${gate.version}. This app signs Safe transactions only for 1.3.0 and 1.4.1, whose hashing it can reproduce exactly.` };
    case 'safe-not-owner': return { severity: 'error', text: `The connected account ${gate.owner} is not an owner of Safe ${gate.safe}, so it cannot authorise its transactions.` };
    case 'safe-threshold': return { severity: 'error', text: `Safe ${gate.safe} requires ${gate.threshold} signatures. Only a 1-of-1 Safe can execute directly from one wallet.` };
    default: return null;
  }
}

export function useWalletExecution(
  output: CompileOutput | null,
  configOverride?: DeploymentConfig,
): ExecutionController {
  const session = useWalletSession();
  // The registry resolver returns a new object. Keep it stable between renders
  // so the account inspection effect doesn't restart while an RPC read is pending.
  const config = useMemo(
    () => configOverride ?? deploymentForChain(session.chainId),
    [configOverride, session.chainId],
  );
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [inspectionError, setInspectionError] = useState<string | null>(null);
  const [safeInspection, setSafeInspection] = useState<SafeInspection | null>(null);
  const [safeInspectionError, setSafeInspectionError] = useState<string | null>(null);
  // The address book and the active entry come from storage, so a reload lands on
  // the same target the user left rather than on a blank field (§5).
  const [savedSafes, setSavedSafes] = useState<SafeAddress[]>(() => readSavedSafes());
  const [activeSafe, setActiveSafe] = useState<SafeAddress | null>(() => readActiveSafe());
  const activeSafeKey = activeSafe === null ? null : safeAddressKey(activeSafe);
  // A settled transaction changed state on chain — the Safe's nonce in
  // particular — so the next review must not be built on the inspection taken
  // before it. Bumped once per settlement, never on a failed send that never
  // reached the chain.
  const [inspectionTick, setInspectionTick] = useState(0);
  const [phase, setPhase] = useState<TransactionPhase>(IDLE);
  // The execution window is requested by review() and withdrawn by the user;
  // it survives the phase transitions of the transaction it is watching, and
  // hides itself the moment there is no phase left to watch.
  const [dialogRequested, setDialogRequested] = useState(false);
  const [reviewTarget, setReviewTarget] = useState<ReviewTarget | null>(null);
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

  // A Safe lives on one chain, and choosing it is what remembers it, so there is
  // no per-render load here: the active entry is either stored or absent (§5).

  const snapshot = useMemo<SessionSnapshot>(() => ({
    status: session.status, account: session.account, chainId: session.chainId, message: session.message,
  }), [session.status, session.account, session.chainId, session.message]);
  const gate = deriveGate({
    session: snapshot, config, inspection, inspectionError, hasProgram: output !== null,
    safe: activeSafe, safeInspection, safeInspectionError,
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

  // The Safe is inspected on its own: it is a different contract, with its own
  // owner list, threshold and nonce, and none of that comes from the account (§4).
  useEffect(() => {
    setSafeInspection(null);
    setSafeInspectionError(null);
    if (activeSafe === null) return;
    if (reader === null || account === null || chainId === null || config.kind !== 'configured') return;
    if (chainId !== config.chainId) return;
    // The entry is pinned to its chain: on another network it is a different
    // account, and the gate refuses it rather than reading something else (§2).
    if (chainId !== activeSafe.chainId) return;
    const safe = parseSafeAddress(activeSafe.address);
    if (safe === null) return;
    let live = true;
    void (async () => {
      try {
        const status = await inspectSafeExecution(reader, safe, account, config);
        if (live && mounted.current) setSafeInspection({ safe, owner: account, chainId, status });
      } catch (cause) {
        if (live && mounted.current) setSafeInspectionError(normalizeError(cause).message);
      }
    })();
    return () => { live = false };
  }, [activeSafeKey, reader, account, chainId, config, inspectionTick]);

  // A transaction that settles is a state change on chain, and the Safe's nonce
  // moves with it. So does a refusal for a moved nonce: the inspection that
  // review rested on is stale either way, and re-reading it is what lets the
  // next execution be reviewed against the state that exists then, not before.
  const settled = phase.kind === 'confirmed' || phase.kind === 'reverted' || phase.kind === 'failed';
  useEffect(() => {
    if (settled) setInspectionTick(tick => tick + 1);
  }, [settled]);

  // A new or replaced compile result drops any pending intent, but not a receipt
  // already earned. An account or chain change drops the receipt too: it belongs
  // to the session it was taken on (§14, §16).
  useEffect(() => {
    setPhase(current => (keepPhase(current) || sendInFlight.current ? current : IDLE));
    intent.current = null;
    setReviewTarget(null);
  }, [account, chainId, output]);
  // The target is part of that context as well: a receipt earned through one Safe
  // says nothing about another, and a review cannot survive being retargeted.
  useEffect(() => {
    setPhase(current => (sendInFlight.current ? current : IDLE));
    intent.current = null;
    setReviewTarget(null);
  }, [account, chainId, activeSafeKey]);

  const review = useCallback(() => {
    if (output === null || session.account === null || session.chainId === null) return;
    if (activeSafe !== null) {
      // A Safe review carries a nonce, which only a ready inspection has.
      if (gate.kind !== 'ready-safe') return;
      intent.current = {
        kind: 'safe', program: output.program, safe: gate.safe, owner: gate.owner,
        runtime: gate.runtime, chainId: session.chainId, nonce: gate.nonce,
      };
      setReviewTarget({ kind: 'safe', safe: gate.safe, owner: gate.owner, runtime: gate.runtime, nonce: gate.nonce });
    } else {
      intent.current = { kind: 'eoa', program: output.program, account: session.account, chainId: session.chainId };
      setReviewTarget({ kind: 'eoa', account: session.account });
    }
    setDialogRequested(true);
    setPhase({ kind: 'review' });
  }, [output, session.account, session.chainId, activeSafe, gate]);

  // Closing the window is purely visual once there is a live transaction to
  // track: the receipt keeps updating in the controller either way (§8).
  const dismiss = useCallback(() => setDialogRequested(false), []);

  // Switching is offered, never performed: the wallet asks, the user answers (§2).
  const [switching, setSwitching] = useState(false);
  const [switchMessage, setSwitchMessage] = useState<string | null>(null);
  const requestSwitch = useCallback(async (chainId?: string) => {
    // The configured chain by default; a Safe pinned to another chain passes its
    // own, because switching networks is how that Safe becomes reachable.
    const target = chainId ?? (config.kind === 'configured' ? config.chainId : null);
    if (target === null) return;
    setSwitching(true);
    setSwitchMessage(null);
    try {
      await session.switchChain(target);
    } catch (cause) {
      setSwitchMessage(normalizeError(cause).message);
    } finally {
      setSwitching(false);
    }
  }, [config, session]);

  /**
   * Choosing a Safe is a claim about a contract, so it is verified once, here,
   * before it becomes the target: switch to the entry's chain if the wallet is
   * elsewhere, then read the Safe exactly as execution will (§14). The refusal is
   * the gate's own sentence, so the dialog and the strip cannot disagree.
   */
  const selectSafe = useCallback(async (addressInput: string, chainIdInput: string) => {
    const address = parseSafeAddress(addressInput);
    if (address === null) throw new LisaError('INVALID_CONFIG', 'Enter a valid 20-byte Safe address.');
    const chainId = normalizeChainId(chainIdInput);
    if (chainId === null) throw new LisaError('INVALID_CONFIG', `"${chainIdInput}" is not a chain id.`);
    if (session.account === null || session.reader === null || session.signer === null) {
      throw new LisaError('WALLET_DISCONNECTED', 'Connect the owner wallet before choosing a Safe.');
    }
    // A live broadcast owns the target: retargeting under it would make the strip
    // describe a transaction it is not sending.
    if (sendInFlight.current) {
      throw new LisaError('SAFE_NOT_READY', 'A transaction is being sent — choose a Safe after it settles.');
    }
    if (session.chainId !== chainId) {
      await session.switchChain(chainId);
      // A wallet can answer a switch request without switching, and the chain
      // that is live now is the only one this Safe can be verified on (§2).
      const live = await liveChainId(session.signer.provider);
      if (live !== chainId) {
        throw new LisaError('WRONG_CHAIN', `The wallet is still on chain ${live ?? 'unknown'}, not ${chainId} — the Safe was not chosen.`);
      }
    }
    const target: SafeAddress = { address, chainId };
    const targetConfig = configOverride ?? deploymentForChain(chainId);
    const status = await inspectSafeExecution(session.reader, address, session.account, targetConfig);
    // A candidate gate, not a bespoke check: verified has to mean "would execute".
    const candidate = deriveGate({
      session: { status: 'ready', account: session.account, chainId, message: null },
      config: targetConfig,
      inspection: null,
      inspectionError: null,
      hasProgram: true,
      safe: target,
      safeInspection: { safe: address, owner: session.account, chainId, status },
      safeInspectionError: null,
    });
    if (candidate.kind !== 'ready-safe') {
      throw new LisaError('SAFE_NOT_READY', gateAlert(candidate)?.text ?? `Safe is not ready: ${describeGate(candidate)}.`);
    }
    const remembered = addSafeAddress(savedSafes, target);
    if (remembered.length !== savedSafes.length) {
      writeSavedSafes(remembered);
      setSavedSafes(remembered);
    }
    if (activeSafeKey !== safeAddressKey(target)) {
      writeActiveSafe(target);
      setActiveSafe(target);
    }
  }, [activeSafeKey, configOverride, savedSafes, session.account, session.chainId, session.reader, session.signer, session.switchChain]);

  /** Back to the connected account; the saved entry stays in the book. */
  const clearSafe = useCallback(() => {
    writeActiveSafe(null);
    setActiveSafe(null);
  }, []);

  const removeSafe = useCallback((addressInput: string, chainIdInput: string) => {
    const address = parseSafeAddress(addressInput);
    const chainId = normalizeChainId(chainIdInput);
    if (address === null || chainId === null) return;
    const entry: SafeAddress = { address, chainId };
    const remaining = withoutSafeAddress(savedSafes, entry);
    writeSavedSafes(remaining);
    setSavedSafes(remaining);
    // Removing the entry the user is executing through cannot leave it active:
    // the next render would otherwise execute through a Safe no longer listed.
    if (activeSafe !== null && sameSafeAddress(activeSafe, entry)) {
      writeActiveSafe(null);
      setActiveSafe(null);
    }
  }, [activeSafe, savedSafes]);

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
    // The target is a claim too: a review of the account cannot become a Safe
    // transaction (or one Safe another) after the fact.
    const liveTarget = activeSafe === null ? 'eoa' : safeAddressKey(activeSafe);
    const wantedTarget = wanted.kind === 'eoa' ? 'eoa' : safeAddressKey({ address: wanted.safe, chainId: wanted.chainId });
    if (wantedTarget !== liveTarget) {
      setPhase({ kind: 'failed', txHash: null, message: 'Execution target changed after review — nothing was sent.' });
      return;
    }
    const expectedAccount = wanted.kind === 'eoa' ? wanted.account : wanted.owner;
    // Everything the review rested on, read from the live values rather than from
    // anything this closure captured, and re-checked after every await below.
    const unchanged = () => {
      const live = now.current;
      return live.status === 'ready' && live.program === wanted.program
        && (live.account ?? '').toLowerCase() === expectedAccount.toLowerCase()
        && live.chainId === wanted.chainId;
    };
    if (!unchanged()) {
      setPhase({ kind: 'failed', txHash: null, message: 'Program, account, or chain changed after review — nothing was sent.' });
      return;
    }
    // Both facts come from the wallet rather than the last render, and each has
    // to match the value the review was built on and the one the deployment
    // names. `stage` only words the message; the claim is the same each time.
    const walletUnchanged = async (stage: string) => {
      const [accounts, liveChain] = await Promise.all([
        session.walletAccounts(),
        liveChainId(session.signer!.provider),
      ]);
      if (accounts.length === 0) {
        throw new LisaError('WALLET_DISCONNECTED', 'Wallet reports no connected account — nothing was sent.');
      }
      if (!accounts.some(a => a.toLowerCase() === expectedAccount.toLowerCase())) {
        throw new LisaError('WALLET_DISCONNECTED', `Connected account changed ${stage} — nothing was sent.`);
      }
      if (liveChain !== wanted.chainId || liveChain !== config.chainId) {
        throw new LisaError('WRONG_CHAIN', `Connected chain changed ${stage} — nothing was sent.`);
      }
    };
    setPhase({ kind: 'awaiting-confirmation' });
    sendInFlight.current = true;
    const state: SendState = { txHash: '' };
    const alive = () => mounted.current;
    const update = (next: TransactionPhase) => setPhase(next);

    /**
     * The Safe path: prove the Safe still says what the review said, sign the
     * exact digest the Safe computes, and only then send. Each `unchanged` /
     * `walletUnchanged` re-check exists because the one before it took time.
     */
    async function sendSafe(reviewed: Extract<Intent, { kind: 'safe' }>): Promise<void> {
      const status = await inspectSafeExecution(session.reader!, reviewed.safe, reviewed.owner, config);
      if (status.kind !== 'ready') {
        throw new LisaError('SAFE_NOT_READY', `Safe is no longer ready (${status.kind}) — nothing was sent.`);
      }
      if (status.runtime.toLowerCase() !== reviewed.runtime.toLowerCase()) {
        throw new LisaError('RUNTIME_MISMATCH', `Safe would delegatecall ${status.runtime}, not the reviewed ${reviewed.runtime} — nothing was sent.`);
      }
      // A Safe signature authorises one nonce. Reusing it under another nonce is
      // not a retry, it is a different transaction, so refusal is the only answer.
      if (status.nonce !== reviewed.nonce) {
        throw new LisaError('SAFE_NOT_READY', `Safe nonce moved from ${reviewed.nonce} to ${status.nonce} — nothing was sent.`);
      }

      const transaction = buildSafeTx({ runtime: reviewed.runtime, program: reviewed.program, nonce: reviewed.nonce });
      // The Safe computes this hash itself. If the two ever disagree, the
      // signature would cover a digest the Safe never accepts; and a disagreement
      // would mean this module's EIP-712 shape does not match the deployment.
      const onchain = await readSafeTransactionHash(session.reader!, reviewed.safe, transaction);
      if (onchain !== hashSafeTx(reviewed.chainId, reviewed.safe, transaction)) {
        throw new LisaError('SAFE_NOT_READY', 'Safe reports a different transaction hash — nothing was sent.');
      }

      await walletUnchanged('while checking');
      if (!unchanged()) {
        throw new LisaError('WALLET_DISCONNECTED', 'Program, account, or chain changed while checking — nothing was sent.');
      }

      const typed = safeTypedData(reviewed.chainId, reviewed.safe, transaction);
      const signature = normalizeSafeSignature(await session.signer!.signTypedData(typed.domain, typed.types, typed.value));
      // The wallet is asked to sign, not told what to sign: if it signed with any
      // other key the Safe would reject it, and the user would have authorised
      // something this review never showed.
      if (recoverSafeSigner(reviewed.chainId, reviewed.safe, transaction, signature)?.toLowerCase() !== reviewed.owner.toLowerCase()) {
        throw new LisaError('SAFE_NOT_READY', 'Wallet signed with a key that is not the reviewed owner — nothing was sent.');
      }

      await walletUnchanged('after signing');
      if (!unchanged()) {
        throw new LisaError('WALLET_DISCONNECTED', 'Program, account, or chain changed after signing — nothing was sent.');
      }
      // Signing is where the wallet's own prompt can take minutes, so the nonce is
      // read once more after it, immediately before the broadcast.
      const nonce = await readSafeNonce(session.reader!, reviewed.safe);
      if (nonce !== reviewed.nonce) {
        throw new LisaError('SAFE_NOT_READY', `Safe nonce moved to ${nonce} while signing — nothing was sent.`);
      }
      if (!unchanged()) {
        throw new LisaError('WALLET_DISCONNECTED', 'Program, account, or chain changed before broadcasting — nothing was sent.');
      }
      await broadcast(session.signer!, prepareSafeExecutionTransaction({
        safe: reviewed.safe, chainId: reviewed.chainId, transaction, signature,
      }), state, alive, update);
    }

    try {
      // A JsonRpcSigner caches the address it was built with, so asking it who is
      // connected says nothing about the wallet now. Ask the wallet instead (§14).
      const signerAddress = await session.signer.getAddress();
      if (!unchanged()) throw new LisaError('WALLET_DISCONNECTED', 'Session changed while checking — nothing was sent.');
      if (signerAddress.toLowerCase() !== expectedAccount.toLowerCase()) {
        throw new LisaError('WALLET_DISCONNECTED', 'Connected account changed before sending — nothing was sent.');
      }
      await walletUnchanged('before sending');

      if (wanted.kind === 'eoa') {
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
        await broadcast(session.signer, prepareExecuteLisaTransaction({ account: wanted.account, program: wanted.program, status }), state, alive, update);
      } else {
        await sendSafe(wanted);
      }
    } catch (cause) {
      settle(cause, state, alive, update);
    } finally {
      // Whatever the outcome, the broadcast is no longer unresolved — input
      // changes may resume clearing the phase from here on.
      sendInFlight.current = false;
    }
  }, [config, activeSafe, session.signer, session.reader, session.walletAccounts]);

  const cancelReview = useCallback(() => {
    intent.current = null;
    setReviewTarget(null);
    setDialogRequested(false);
    setPhase(IDLE);
  }, []);

  return {
    session, config, output, gate, phase,
    canExecute: canExecute(gate),
    alert: gateAlert(gate),
    reviewTarget,
    activeSafe, savedSafes, selectSafe, clearSafe, removeSafe,
    // A requested window with nothing left to watch is no window at all.
    dialogOpen: dialogRequested && phase.kind !== 'idle',
    review, send, cancelReview, dismiss, requestSwitch, switching, switchMessage,
  };
}
