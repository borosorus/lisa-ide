import type { DeploymentConfig, LisaAccountStatus } from '../lisa-account/types';

/**
 * Pure derivation of every execution-surface state (AGENTS.md §7). The panel only
 * renders one of these, so "can I execute?" has exactly one answer in one place
 * rather than a pile of JSX conditionals.
 */

export type SessionSnapshot = {
  readonly status: 'disconnected' | 'loading' | 'ready' | 'error';
  readonly account: string | null;
  readonly chainId: string | null;
  readonly message?: string | null;
};

/** An inspection result is only usable while account *and* chain are unchanged (§14). */
export type Inspection = {
  readonly account: string;
  readonly chainId: string;
  readonly status: LisaAccountStatus;
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
  | { kind: 'ready'; account: string; runtime: string };

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

export function deriveGate(input: {
  session: SessionSnapshot;
  config: DeploymentConfig;
  inspection: Inspection | null;
  inspectionError: string | null;
  hasProgram: boolean;
}): ExecutionGate {
  const { session, config, hasProgram } = input;
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

export function canExecute(gate: ExecutionGate): boolean {
  return gate.kind === 'ready';
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
