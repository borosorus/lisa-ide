import { describe, expect, it, vi } from 'vitest';
import { LisaError } from '../lisa-account/types';

import { messageFor, normalizeError } from './errors';

function withCode(message: string, code: string | number): Error {
  return Object.assign(new Error(message), { code });
}

describe('normalizeError', () => {
  it('passes a LisaError through unchanged', () => {
    const error = new LisaError('RUNTIME_MISMATCH', 'LisaAccount is bound to a different LISA runtime.');
    expect(normalizeError(error)).toMatchObject({ code: 'RUNTIME_MISMATCH', message: error.message });
  });

  it('recognises ethers action rejection', () => {
    expect(normalizeError(withCode('user rejected transaction', 'ACTION_REJECTED')).code).toBe('USER_REJECTED');
  });

  it('recognises EIP-1193 4001, including nested inside a cause', () => {
    expect(normalizeError(withCode('Provider rejected request', 4001)).code).toBe('USER_REJECTED');
    expect(normalizeError(new Error('send failed', { cause: withCode('rejected', 4001) })).code).toBe('USER_REJECTED');
    const eip = Object.assign(new Error('MetaMask error'), { info: { error: withCode('User denied transaction signature.', 4001) } });
    expect(normalizeError(eip).code).toBe('USER_REJECTED');
  });

  it('separates an unrecognized chain from a rejection', () => {
    expect(normalizeError(withCode('Unrecognized chain ID', 4902)).code).toBe('WRONG_CHAIN');
  });

  it('classifies reverts, transport failures and a missing signer', () => {
    expect(normalizeError(new Error('execution reverted')).code).toBe('TRANSACTION_REVERTED');
    expect(normalizeError(new Error('The operation failed because the transaction reverted')).code).toBe('TRANSACTION_REVERTED');
    expect(normalizeError(new TypeError('Failed to fetch')).code).toBe('RPC_UNAVAILABLE');
    expect(normalizeError(new Error('could not detect network')).code).toBe('RPC_UNAVAILABLE');
    expect(normalizeError(new Error('No signer available')).code).toBe('WALLET_DISCONNECTED');
  });

  it('keeps an unknown failure short but still debuggable (§12)', () => {
    const result = normalizeError(new Error('someProvider internal blob 0xdeadbeef at line 4'));
    expect(result.code).toBe('UNKNOWN');
    expect(result.message).toBe(messageFor('UNKNOWN'));
    expect(result.message).not.toContain('0xdeadbeef');
    expect(result.detail).toContain('0xdeadbeef');
    expect(result.cause).toBeInstanceOf(Error);
  });

  it('never leaves the message empty for a known code', () => {
    for (const code of ['USER_REJECTED', 'WRONG_CHAIN', 'RPC_UNAVAILABLE', 'TRANSACTION_REVERTED', 'INVALID_CONFIG'] as const) {
      expect(messageFor(code).length).toBeGreaterThan(0);
    }
  });
});
