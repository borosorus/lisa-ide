import { describe, expect, it, vi } from 'vitest';
import { getAddress } from 'ethers';
import { loadSafeAddress, safeAddressKey, saveSafeAddress, type SafeAddressStorage } from './safeSettings';

const SAFE = '0x1234567890abcdef1234567890abcdef12345678';
const OTHER = '0x0987654321098765432109876543210987654321';

function memory(initial: Record<string, string> = {}): SafeAddressStorage & { entries: Map<string, string> } {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, value) },
    removeItem: key => { entries.delete(key) },
  };
}

describe('safeAddressKey', () => {
  it('keys one address per normalized chain', () => {
    expect(safeAddressKey('1')).toBe('lisa-ide.safe-address.v1.1');
    expect(safeAddressKey('0xaa36a7')).toBe('lisa-ide.safe-address.v1.11155111');
    expect(safeAddressKey('not-a-chain')).toBeNull();
  });
});

describe('safe settings', () => {
  it('remembers an address per chain, and keeps the chains apart', () => {
    const store = memory();
    saveSafeAddress('1', SAFE, store);
    saveSafeAddress('11155111', OTHER, store);
    expect(loadSafeAddress('1', store)).toBe(getAddress(SAFE));
    expect(loadSafeAddress('11155111', store)).toBe(getAddress(OTHER));
    expect(loadSafeAddress('137', store)).toBeNull();
  });

  it('checksums on read, so the value cannot drift between sessions', () => {
    const store = memory({ 'lisa-ide.safe-address.v1.1': SAFE.toLowerCase() });
    expect(loadSafeAddress('1', store)).toBe(getAddress(SAFE));
  });

  it('never hands back a stored value that no longer parses', () => {
    const store = memory({ 'lisa-ide.safe-address.v1.1': 'garbage' });
    expect(loadSafeAddress('1', store)).toBeNull();
    expect(loadSafeAddress(null, store)).toBeNull();
  });

  it('does not erase the remembered address while it is being edited', () => {
    const store = memory({ 'lisa-ide.safe-address.v1.1': getAddress(SAFE) });
    saveSafeAddress('1', SAFE.slice(0, 10), store);
    expect(loadSafeAddress('1', store)).toBe(getAddress(SAFE));
    saveSafeAddress('1', '', store);
    expect(loadSafeAddress('1', store)).toBeNull();
  });

  it('costs nothing when storage is unavailable or throws', () => {
    expect(loadSafeAddress('1', null)).toBeNull();
    expect(() => saveSafeAddress('1', SAFE, null)).not.toThrow();
    const hostile: SafeAddressStorage = {
      getItem: vi.fn(() => { throw new Error('storage disabled') }),
      setItem: vi.fn(() => { throw new Error('storage disabled') }),
      removeItem: vi.fn(() => { throw new Error('storage disabled') }),
    };
    expect(loadSafeAddress('1', hostile)).toBeNull();
    expect(() => saveSafeAddress('1', SAFE, hostile)).not.toThrow();
    expect(() => saveSafeAddress('1', '', hostile)).not.toThrow();
  });
});
