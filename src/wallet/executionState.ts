import type { DeploymentConfig, LisaAccountStatus } from '../lisa-account/types';
import { parseSafeAddress, type SafeExecutionStatus } from './safe';

/**
 * Pure derivation of every execution-surface state. The panel only
 * renders one of these, so "can I execute?" has exactly one answer in one place
 * rather than a pile of JSX conditionals.
 */

export type SessionSnapshot = {
  readonly status: 'disconnected' | 'loading' | 'ready' | 'error';
  readonly account: string | null;
  readonly chainId: string | null;
  readonly message?: string | null;
};

/**
 * Where a program runs: through the connected account's own EIP-7702 delegation,
 * or through a single-owner Safe that delegatecalls the runtime for it.
 */
export type ExecutionMode = 'eoa' | 'safe';

/** An inspection result is only usable while account *and* chain are unchanged (§14). */
export type Inspection = {
  readonly account: string;
  readonly chainId: string;
  readonly status: LisaAccountStatus;
};

/** A Safe inspection belongs to one Safe, one owner, and one chain (§14). */
export type SafeInspection = {
  readonly safe: string;
  readonly owner: string;
  readonly chainId: string;
  readonly status: SafeExecutionStatus;
};

export type ExecutionGate =
  | { kind: 'wallet-disconnected' }
  | { kind: 'wallet-connecting' }
  | { kind: 'wallet-error'; reason: string }
  | { kind: 'unconfigured' }
  | { kind: 'invalid-config'; reason: string }
  | { kind: 'wrong-chain'; expected: string; actual: string }
  | { kind: 'inspecting' }
  | { kind: 'undelegated' }
  | { kind: 'other-delegation'; implementation: string }
  | { kind: 'invalid-delegation'; reason: string }
  | { kind: 'invalid-lisa'; implementation: string; reason: string }
  | { kind: 'runtime-mismatch'; implementation: string; runtime: string; expected: string }
  | { kind: 'runtime-no-code'; runtime: string }
  | { kind: 'rpc-error'; reason: string }
  | { kind: 'no-program' }
  | { kind: 'ready'; account: string; runtime: string }
  // Safe mode: the address is entered by hand, so "nothing typed yet" and
  // "not an address" are separate, actionable states (§2).
  | { kind: 'safe-address-missing' }
  | { kind: 'safe-address-invalid' }
  | { kind: 'safe-no-code'; safe: string }
  | { kind: 'safe-not-a-safe'; safe: string; reason: string }
  | { kind: 'safe-unsupported-version'; safe: string; version: string }
  | { kind: 'safe-not-owner'; safe: string; owner: string }
  | { kind: 'safe-threshold'; safe: string; threshold: number }
  | { kind: 'ready-safe'; safe: string; owner: string; runtime: string; version: string; nonce: bigint };

export type TransactionPhase =
  | { kind: 'idle' }
  | { kind: 'review' }
  | { kind: 'awaiting-confirmation' }
  | { kind: 'submitted'; txHash: string }
  | { kind: 'confirmed'; txHash: string; blockNumber: number }
  | { kind: 'reverted'; txHash: string }
  | { kind: 'failed'; txHash: string | null; message: string };

export const IDLE: TransactionPhase = { kind: 'idle' };

/** Re-exported so the wallet and the deployment config apply one rule (§1). */
export { normalizeChainId } from '../lisa-account/chain';

export function inspectionIsCurrent(
  inspection: Inspection | null,
  account: string | null,
  chainId: string | null,
): inspection is Inspection {
  if (inspection === null || account === null) return false;
  return inspection.account.toLowerCase() === account.toLowerCase() && inspection.chainId === chainId;
}

export function safeInspectionIsCurrent(
  inspection: SafeInspection | null,
  safe: string,
  owner: string,
  chainId: string | null,
): inspection is SafeInspection {
  if (inspection === null) return false;
  return inspection.safe.toLowerCase() === safe.toLowerCase()
    && inspection.owner.toLowerCase() === owner.toLowerCase()
    && inspection.chainId === chainId;
}

/** Everything the gate derives from; one shape, so both targets are asked the same question. */
export interface GateInput {
  readonly session: SessionSnapshot;
  readonly config: DeploymentConfig;
  readonly inspection: Inspection | null;
  readonly inspectionError: string | null;
  readonly hasProgram: boolean;
  readonly mode?: ExecutionMode;
  /** The Safe address as typed, not as parsed: an invalid entry is its own state. */
  readonly safeAddress?: string;
  readonly safeInspection?: SafeInspection | null;
  readonly safeInspectionError?: string | null;
}

export function deriveGate(input: GateInput): ExecutionGate {
  const { session, config } = input;
  if (session.status === 'disconnected') return { kind: 'wallet-disconnected' };
  if (session.status === 'loading') return { kind: 'wallet-connecting' };
  if (session.status === 'error') return { kind: 'wallet-error', reason: session.message ?? 'Wallet connection failed.' };
  if (config.kind === 'unconfigured') return { kind: 'unconfigured' };
  if (config.kind === 'invalid') return { kind: 'invalid-config', reason: config.reason };
  // Nothing on another chain belongs to this deployment, so nothing here may be
  // read as if it did: same address, different account (§2).
  if (session.chainId !== null && session.chainId !== config.chainId) {
    return { kind: 'wrong-chain', expected: config.chainId, actual: session.chainId };
  }
  return (input.mode ?? 'eoa') === 'safe' ? safeGate(input) : eoaGate(input);
}

function eoaGate(input: GateInput): ExecutionGate {
  const { session, hasProgram } = input;
  if (session.chainId === null || session.account === null) return { kind: 'inspecting' };
  // A stored inspection belongs to the account and chain it was taken on.
  const current = inspectionIsCurrent(input.inspection, session.account, session.chainId) ? input.inspection : null;
  if (current === null) {
    return input.inspectionError !== null
      ? { kind: 'rpc-error', reason: input.inspectionError }
      : { kind: 'inspecting' };
  }
  // Fail closed on anything but an exactly-matching LisaAccount (§4).
  switch (current.status.kind) {
    case 'ready': break;
    case 'unconfigured': return { kind: 'unconfigured' };
    case 'invalid-config': return { kind: 'invalid-config', reason: current.status.reason };
    case 'runtime-no-code': return { kind: 'runtime-no-code', runtime: current.status.runtime };
    case 'runtime-mismatch': {
      const mismatch = current.status;
      return { kind: 'runtime-mismatch', implementation: mismatch.implementation, runtime: mismatch.runtime, expected: mismatch.expected };
    }
    case 'invalid-lisa': {
      const invalid = current.status;
      return { kind: 'invalid-lisa', implementation: invalid.implementation, reason: invalid.reason };
    }
    default: return current.status;
  }
  if (!hasProgram) return { kind: 'no-program' };
  return { kind: 'ready', account: current.account, runtime: current.status.runtime };
}

/**
 * Safe mode: the owner signs, the Safe executes. The threshold, the owner list
 * and the nonce all come from the Safe itself, so "ready" here is a statement
 * about a specific Safe at a specific nonce (§14).
 */
function safeGate(input: GateInput): ExecutionGate {
  const { session, hasProgram } = input;
  if (session.chainId === null || session.account === null) return { kind: 'inspecting' };
  const typed = (input.safeAddress ?? '').trim();
  if (typed === '') return { kind: 'safe-address-missing' };
  const safe = parseSafeAddress(typed);
  if (safe === null) return { kind: 'safe-address-invalid' };

  const current = safeInspectionIsCurrent(input.safeInspection ?? null, safe, session.account, session.chainId)
    ? input.safeInspection!
    : null;
  if (current === null) {
    const error = input.safeInspectionError ?? null;
    return error !== null ? { kind: 'rpc-error', reason: error } : { kind: 'inspecting' };
  }
  const status = current.status;
  switch (status.kind) {
    case 'ready': break;
    case 'unconfigured': return { kind: 'unconfigured' };
    case 'invalid-config': return { kind: 'invalid-config', reason: status.reason };
    case 'runtime-no-code': return { kind: 'runtime-no-code', runtime: status.runtime };
    case 'safe-no-code': return { kind: 'safe-no-code', safe: status.safe };
    case 'not-a-safe': return { kind: 'safe-not-a-safe', safe: status.safe, reason: status.reason };
    case 'unsupported-version': return { kind: 'safe-unsupported-version', safe: status.safe, version: status.version };
    case 'not-owner': return { kind: 'safe-not-owner', safe: status.safe, owner: status.owner };
    case 'threshold': return { kind: 'safe-threshold', safe: status.safe, threshold: status.threshold };
  }
  if (!hasProgram) return { kind: 'no-program' };
  return {
    kind: 'ready-safe', safe: status.safe, owner: status.owner,
    runtime: status.runtime, version: status.version, nonce: status.nonce,
  };
}

export function canExecute(gate: ExecutionGate): boolean {
  return gate.kind === 'ready' || gate.kind === 'ready-safe';
}

/** One-line label for the compact LISA status row (§7). */
export function describeGate(gate: ExecutionGate): string {
  switch (gate.kind) {
    case 'wallet-disconnected': return 'Wallet not connected';
    case 'wallet-connecting': return 'Connecting…';
    case 'wallet-error': return 'Wallet error';
    case 'unconfigured': return 'LISA deployment not configured';
    case 'invalid-config': return 'Invalid deployment configuration';
    case 'wrong-chain': return 'Connected to the wrong network';
    case 'inspecting': return 'Inspecting account…';
    case 'undelegated': return 'Account has no LISA delegation';
    case 'other-delegation': return 'Delegated to another implementation';
    case 'invalid-delegation': return 'Malformed delegation';
    case 'invalid-lisa': return 'LisaAccount is not usable';
    case 'runtime-no-code': return 'Configured runtime has no code';
    case 'runtime-mismatch': return 'LisaAccount runtime mismatch';
    case 'rpc-error': return 'Account inspection failed';
    // Not "no compiled program": an imported artifact is compiled, it just is not
    // ours to run (§4). The alert gives the reason; the chip stays true either way.
    case 'no-program': return 'No executable program';
    case 'ready': return 'Ready';
    case 'safe-address-missing': return 'Add a Safe address';
    case 'safe-address-invalid': return 'Safe address is not valid';
    case 'safe-no-code': return 'Safe address has no code';
    case 'safe-not-a-safe': return 'Address is not a Safe';
    case 'safe-unsupported-version': return 'Unsupported Safe version';
    case 'safe-not-owner': return 'Not an owner of this Safe';
    case 'safe-threshold': return 'Safe needs a single owner';
    case 'ready-safe': return 'Ready (Safe)';
  }
}

export function describePhase(phase: TransactionPhase): string {
  switch (phase.kind) {
    case 'idle': return '';
    case 'review': return 'Review transaction';
    case 'awaiting-confirmation': return 'Awaiting wallet confirmation';
    case 'submitted': return 'Submitted';
    case 'confirmed': return 'Confirmed';
    case 'reverted': return 'Reverted';
    // The message belongs to the failure alert, so the chip stays short.
    case 'failed': return 'Failed';
  }
}
