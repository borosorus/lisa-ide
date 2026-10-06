import { describe, expect, it } from 'vitest';
import {
  canExecute, deriveGate, describeGate, inspectionIsCurrent, normalizeChainId,
  type Inspection, type SessionSnapshot,
} from './executionState';
import type { DeploymentConfig } from '../lisa-account/types';

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const CONFIG = {
  kind: 'configured' as const,
  implementation: '0x3333333333333333333333333333333333333333',
  runtime: '0x4444444444444444444444444444444444444444',
};

const READY: SessionSnapshot = { status: 'ready', account: ACCOUNT, chainId: '1', message: null };

function gate(status: Inspection['status'], overrides: {
  session?: Partial<SessionSnapshot>; config?: DeploymentConfig; hasProgram?: boolean; error?: string | null;
} = {}) {
  return deriveGate({
    session: { ...READY, ...overrides.session },
    config: overrides.config ?? CONFIG,
    inspection: { account: ACCOUNT, chainId: '1', status },
    inspectionError: overrides.error ?? null,
    hasProgram: overrides.hasProgram ?? true,
  });
}

describe('normalizeChainId', () => {
  it('accepts hex, decimal, bigint and numeric forms alike', () => {
    expect(normalizeChainId('0x1')).toBe('1');
    expect(normalizeChainId('0xAA36A7')).toBe('11155111');
    expect(normalizeChainId(1n)).toBe('1');
    expect(normalizeChainId(137)).toBe('137');
    expect(normalizeChainId('1')).toBe('1');
  });

  it('returns null rather than inventing a chain', () => {
    for (const value of [null, undefined, '', 'abc', '0xzz']) {
      expect(normalizeChainId(value as string | null)).toBeNull();
    }
  });
});

describe('inspectionIsCurrent', () => {
  const stored: Inspection = {
    account: ACCOUNT, chainId: '1', status: { kind: 'ready', implementation: CONFIG.implementation, runtime: CONFIG.runtime },
  };

  it('matches case-insensitively on account and exactly on chain', () => {
    expect(inspectionIsCurrent(stored, ACCOUNT.toUpperCase().replace('0X', '0x'), '1')).toBe(true);
    expect(inspectionIsCurrent(stored, ACCOUNT, '5')).toBe(false);
  });

  it('is never current without an account', () => {
    expect(inspectionIsCurrent(stored, null, '1')).toBe(false);
    expect(inspectionIsCurrent(null, ACCOUNT, '1')).toBe(false);
  });
});

describe('deriveGate', () => {
  it('is gated on the wallet first', () => {
    expect(deriveGate({ session: { status: 'disconnected', account: null, chainId: null }, config: CONFIG, inspection: null, inspectionError: null, hasProgram: true }))
      .toEqual({ kind: 'wallet-disconnected' });
    expect(deriveGate({ session: { status: 'loading', account: null, chainId: null }, config: CONFIG, inspection: null, inspectionError: null, hasProgram: true }))
      .toEqual({ kind: 'wallet-connecting' });
    expect(deriveGate({ session: { status: 'error', account: null, chainId: null, message: 'boom' }, config: CONFIG, inspection: null, inspectionError: null, hasProgram: true }))
      .toEqual({ kind: 'wallet-error', reason: 'boom' });
  });

  it('is gated on deployment configuration second (§3)', () => {
    expect(gate({ kind: 'ready', implementation: CONFIG.implementation, runtime: CONFIG.runtime }, { config: { kind: 'unconfigured' } }))
      .toEqual({ kind: 'unconfigured' });
    expect(gate({ kind: 'ready', implementation: CONFIG.implementation, runtime: CONFIG.runtime }, { config: { kind: 'invalid', reason: 'oops' } }))
      .toEqual({ kind: 'invalid-config', reason: 'oops' });
  });

  it('is inspecting until a matching inspection exists', () => {
    expect(deriveGate({ session: READY, config: CONFIG, inspection: null, inspectionError: null, hasProgram: true })).toEqual({ kind: 'inspecting' });
    expect(deriveGate({ session: READY, config: CONFIG, inspection: null, inspectionError: 'Network request failed.', hasProgram: true }))
      .toEqual({ kind: 'rpc-error', reason: 'Network request failed.' });
  });

  it('discards an inspection taken on another account or chain (§14, §16)', () => {
    const stored: Inspection = { account: ACCOUNT, chainId: '1', status: { kind: 'ready', implementation: CONFIG.implementation, runtime: CONFIG.runtime } };
    const other = '0x2222222222222222222222222222222222222222';
    expect(deriveGate({ session: { ...READY, account: other }, config: CONFIG, inspection: stored, inspectionError: null, hasProgram: true }))
      .toEqual({ kind: 'inspecting' });
    expect(deriveGate({ session: { ...READY, chainId: '11155111' }, config: CONFIG, inspection: stored, inspectionError: null, hasProgram: true }))
      .toEqual({ kind: 'inspecting' });
  });

  it('is ready only with an exactly matching LisaAccount and a compiled program', () => {
    const ready = { kind: 'ready', implementation: CONFIG.implementation, runtime: CONFIG.runtime } as const;
    expect(gate(ready)).toEqual({ kind: 'ready', account: ACCOUNT, runtime: CONFIG.runtime });
    expect(canExecute(gate(ready))).toBe(true);
    expect(gate(ready, { hasProgram: false })).toEqual({ kind: 'no-program' });
    expect(canExecute(gate(ready, { hasProgram: false }))).toBe(false);
  });

  it('fails closed for every other account state', () => {
    const cases: Array<[Inspection['status'], string]> = [
      [{ kind: 'unconfigured' }, 'unconfigured'],
      [{ kind: 'invalid-config', reason: 'bad' }, 'invalid-config'],
      [{ kind: 'undelegated' }, 'undelegated'],
      [{ kind: 'other-delegation', implementation: '0x5555555555555555555555555555555555555555' }, 'other-delegation'],
      [{ kind: 'invalid-delegation', reason: 'short' }, 'invalid-delegation'],
      [{ kind: 'invalid-lisa', implementation: CONFIG.implementation, reason: 'reverted' }, 'invalid-lisa'],
      [{ kind: 'runtime-mismatch', implementation: CONFIG.implementation, runtime: '0x5555555555555555555555555555555555555555', expected: CONFIG.runtime }, 'runtime-mismatch'],
    ];
    for (const [status, kind] of cases) {
      const result = gate(status);
      expect(result.kind, kind).toBe(kind);
      expect(canExecute(result), kind).toBe(false);
      expect(describeGate(result).length, kind).toBeGreaterThan(0);
    }
  });

  it('labels each state for the compact status row (§7)', () => {
    expect(describeGate({ kind: 'unconfigured' })).toBe('LISA deployment not configured');
    expect(describeGate({ kind: 'ready', account: ACCOUNT, runtime: CONFIG.runtime })).toBe('Ready');
    expect(describeGate({ kind: 'no-program' })).toContain('no compiled program');
  });
});
