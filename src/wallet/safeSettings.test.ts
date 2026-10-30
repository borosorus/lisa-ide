import { describe, expect, it, vi } from 'vitest';
import { getAddress } from 'ethers';
import {
  addSafeAddress, readActiveSafe, readSavedSafes, safeAddressKey, sameSafeAddress,
  withoutSafeAddress, writeActiveSafe, writeSavedSafes, type SafeAddressStorage,
} from './safeSettings';

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
  it('keeps the same address apart on different chains', () => {
    const one = { address: getAddress(SAFE), chainId: '1' };
    const other = { address: getAddress(SAFE), chainId: '11155111' };
    expect(safeAddressKey(one)).toBe(`1:${SAFE.toLowerCase()}`);
    expect(safeAddressKey(other)).toBe(`11155111:${SAFE.toLowerCase()}`);
    expect(sameSafeAddress(one, other)).toBe(false);
    expect(sameSafeAddress(one, { address: SAFE.toLowerCase(), chainId: '1' })).toBe(true);
  });
});

describe('the saved address book', () => {
  it('remembers entries in the order they were added, across chains', () => {
    const store = memory();
    writeSavedSafes([{ address: getAddress(SAFE), chainId: '1' }], store);
    writeSavedSafes([
      { address: getAddress(SAFE), chainId: '1' },
      { address: getAddress(OTHER), chainId: '11155111' },
    ], store);
    expect(readSavedSafes(store)).toEqual([
      { address: getAddress(SAFE), chainId: '1' },
      { address: getAddress(OTHER), chainId: '11155111' },
    ]);
  });

  it('checksums on read, so a stored value cannot drift between sessions', () => {
    const store = memory({ 'lisa-ide.saved-safes.v1': JSON.stringify([{ address: SAFE.toLowerCase(), chainId: '1' }]) });
    expect(readSavedSafes(store)).toEqual([{ address: getAddress(SAFE), chainId: '1' }]);
  });

  it('drops entries that no longer parse instead of handing them back as input', () => {
    const store = memory({
      'lisa-ide.saved-safes.v1': JSON.stringify([
        { address: 'garbage', chainId: '1' },
        { address: SAFE, chainId: 'not-a-chain' },
        { address: 42, chainId: '1' },
        null,
        { address: OTHER, chainId: 1 },
      ]),
    });
    expect(readSavedSafes(store)).toEqual([{ address: getAddress(OTHER), chainId: '1' }]);
  });

  it('folds the per-chain keys of the first iteration into the book once', () => {
    const store = memory({
      'lisa-ide.safe-address.v1.1': SAFE,
      'lisa-ide.safe-address.v1.11155111': OTHER,
      'lisa-ide.saved-safes.v1': JSON.stringify([{ address: getAddress(SAFE), chainId: '1' }]),
    });
    const withKey = { ...store, length: store.entries.size, key: (index: number) => [...store.entries.keys()][index] ?? null };
    expect(readSavedSafes(withKey)).toEqual([
      { address: getAddress(SAFE), chainId: '1' },
      { address: getAddress(OTHER), chainId: '11155111' },
    ]);
    // The legacy keys are gone, so the fold happens once and the address book is
    // the only source afterwards — and it holds what they said.
    expect(store.entries.has('lisa-ide.safe-address.v1.1')).toBe(false);
    expect(store.entries.has('lisa-ide.safe-address.v1.11155111')).toBe(false);
    expect(readSavedSafes(store)).toEqual([
      { address: getAddress(SAFE), chainId: '1' },
      { address: getAddress(OTHER), chainId: '11155111' },
    ]);
  });

  it('survives a store that throws while enumerating or reading legacy keys', () => {
    const saved = JSON.stringify([{ address: SAFE, chainId: '1' }]);
    const base = { getItem: (key: string) => (key === 'lisa-ide.saved-safes.v1' ? saved : null), setItem: () => {}, removeItem: () => {} };
    // A throwing `length` getter used to escape from the controller's initializer.
    const noLength: SafeAddressStorage = { ...base, get length(): number { throw new Error('enumeration disabled') } };
    const noKeys: SafeAddressStorage = { ...base, length: 2, key: () => { throw new Error('nope') } };
    const noReads: SafeAddressStorage = {
      ...base,
      length: 1,
      key: () => 'lisa-ide.safe-address.v1.1',
      getItem: (key: string) => {
        if (key === 'lisa-ide.saved-safes.v1') return saved;
        throw new Error('nope');
      },
    };
    for (const store of [noLength, noKeys, noReads]) {
      expect(readSavedSafes(store)).toEqual([{ address: getAddress(SAFE), chainId: '1' }]);
    }
  });

  it('keeps a legacy address recoverable when the fold cannot be written', () => {
    const entries = new Map([['lisa-ide.safe-address.v1.1', SAFE]]);
    const store: SafeAddressStorage = {
      getItem: key => entries.get(key) ?? null,
      // A full quota is a write failure, not a reason to forget the address.
      setItem: () => { throw new Error('quota exceeded') },
      removeItem: key => { entries.delete(key) },
      get length() { return entries.size },
      key: index => [...entries.keys()][index] ?? null,
    };
    expect(readSavedSafes(store)).toEqual([{ address: getAddress(SAFE), chainId: '1' }]);
    expect(entries.has('lisa-ide.safe-address.v1.1')).toBe(true);
    // The retry reads the same address rather than an empty book.
    expect(readSavedSafes(store)).toEqual([{ address: getAddress(SAFE), chainId: '1' }]);
  });

  it('never throws when storage is unavailable or hostile', () => {
    expect(readSavedSafes(null)).toEqual([]);
    expect(readActiveSafe(null)).toBeNull();
    expect(() => writeSavedSafes([], null)).not.toThrow();
    expect(() => writeActiveSafe(null, null)).not.toThrow();
    const hostile: SafeAddressStorage = {
      getItem: vi.fn(() => { throw new Error('storage disabled') }),
      setItem: vi.fn(() => { throw new Error('storage disabled') }),
      removeItem: vi.fn(() => { throw new Error('storage disabled') }),
    };
    expect(readSavedSafes(hostile)).toEqual([]);
    expect(readActiveSafe(hostile)).toBeNull();
    expect(() => writeSavedSafes([{ address: getAddress(SAFE), chainId: '1' }], hostile)).not.toThrow();
    expect(() => writeActiveSafe({ address: getAddress(SAFE), chainId: '1' }, hostile)).not.toThrow();
    expect(() => writeActiveSafe(null, hostile)).not.toThrow();
  });
});

describe('the active Safe', () => {
  it('round-trips one entry and clears to null', () => {
    const store = memory();
    expect(readActiveSafe(store)).toBeNull();
    writeActiveSafe({ address: getAddress(SAFE), chainId: '1' }, store);
    expect(readActiveSafe(store)).toEqual({ address: getAddress(SAFE), chainId: '1' });
    writeActiveSafe(null, store);
    expect(readActiveSafe(store)).toBeNull();
  });

  it('treats an unreadable active entry as absent', () => {
    const store = memory({ 'lisa-ide.active-safe.v1': '{"address":"garbage","chainId":"1"}' });
    expect(readActiveSafe(store)).toBeNull();
  });
});

describe('book edits', () => {
  const safe = { address: getAddress(SAFE), chainId: '1' };

  it('adds an entry once and keeps the existing one', () => {
    expect(addSafeAddress([], safe)).toEqual([safe]);
    expect(addSafeAddress([safe], { address: SAFE.toLowerCase(), chainId: '1' })).toEqual([safe]);
    expect(addSafeAddress([safe], { address: safe.address, chainId: '11155111' })).toHaveLength(2);
  });

  it('removes by identity, leaving other chains alone', () => {
    const other = { address: safe.address, chainId: '11155111' };
    expect(withoutSafeAddress([safe, other], { address: SAFE.toLowerCase(), chainId: '1' })).toEqual([other]);
  });
});
