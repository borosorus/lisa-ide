import { normalizeChainId } from '../lisa-account/chain';
import { parseSafeAddress, type SafeAddress } from './safe';

/**
 * The Safe address book: a list of `{ address, chainId }` entries plus the one
 * entry currently in use. Both live in localStorage — an address is long, a
 * chain is easy to forget, and neither should have to be retyped every reload.
 *
 * Storage is optional: private-mode browsers throw on access, and that must only
 * cost the remember feature, never the ability to execute.
 */

const SAVED_KEY = 'lisa-ide.saved-safes.v1';
const ACTIVE_KEY = 'lisa-ide.active-safe.v1';
/**
 * The first iteration of this feature stored one address per chain under its own
 * key. Those entries are folded into the book once and the keys removed (§13).
 */
const LEGACY_PREFIX = 'lisa-ide.safe-address.v1.';

export interface SafeAddressStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  /** Present on `localStorage`; only needed to find the legacy per-chain keys. */
  readonly length?: number;
  key?(index: number): string | null;
}

function storage(): SafeAddressStorage | null {
  try {
    const candidate = (globalThis as { localStorage?: SafeAddressStorage }).localStorage;
    return candidate ?? null;
  } catch {
    return null;
  }
}

/** Identifies one entry: the chain is part of it, so the same address twice is two entries. */
export function safeAddressKey(entry: SafeAddress): string {
  return `${entry.chainId}:${entry.address.toLowerCase()}`;
}

export function sameSafeAddress(a: SafeAddress, b: SafeAddress): boolean {
  return safeAddressKey(a) === safeAddressKey(b);
}

function normalizeEntry(value: unknown): SafeAddress | null {
  const node = value as { address?: unknown; chainId?: unknown } | null;
  if (node === null || typeof node !== 'object') return null;
  if (typeof node.address !== 'string') return null;
  const chainId = normalizeChainId(typeof node.chainId === 'string' ? node.chainId : String(node.chainId));
  // A stored entry that no longer parses is dropped, never used as input (§4).
  const address = parseSafeAddress(node.address);
  if (chainId === null || address === null) return null;
  return { address, chainId };
}

interface LegacyEntries {
  readonly entries: SafeAddress[];
  readonly keys: string[];
}

/**
 * Entries stored by the per-chain iteration of this feature. Reading them must
 * not delete them: they are only removed once the book that replaces them has
 * been written, or a failed write would forget the address for good.
 */
function readLegacyEntries(store: SafeAddressStorage): LegacyEntries {
  const keys: string[] = [];
  try {
    const length = store.length ?? 0;
    if (typeof store.key === 'function') {
      for (let index = 0; index < length; index += 1) {
        let key: string | null = null;
        try {
          key = store.key(index);
        } catch {
          break;
        }
        if (key !== null && key.startsWith(LEGACY_PREFIX)) keys.push(key);
      }
    }
  } catch {
    // A store that will not enumerate has nothing to fold in; that costs the
    // remember feature, never the ability to execute (§4).
    return { entries: [], keys: [] };
  }
  const entries: SafeAddress[] = [];
  for (const key of keys) {
    let stored: string | null = null;
    try {
      stored = store.getItem(key);
    } catch {
      continue;
    }
    const entry = normalizeEntry({ chainId: key.slice(LEGACY_PREFIX.length), address: stored ?? '' });
    if (entry !== null) entries.push(entry);
  }
  return { entries, keys };
}

/** The saved entries, deduplicated, in the order they were added. */
export function readSavedSafes(store: SafeAddressStorage | null = storage()): SafeAddress[] {
  if (store === null) return [];
  let stored: SafeAddress[] = [];
  try {
    const raw = store.getItem(SAVED_KEY);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) stored = parsed.map(normalizeEntry).filter((entry): entry is SafeAddress => entry !== null);
    }
  } catch {
    stored = [];
  }
  const legacy = readLegacyEntries(store);
  const entries: SafeAddress[] = [];
  for (const entry of [...stored, ...legacy.entries]) {
    if (!entries.some(candidate => sameSafeAddress(candidate, entry))) entries.push(entry);
  }
  // Fold once: the book takes over from the legacy keys, and they are dropped
  // only if it really took over. A store that refuses the write keeps them, so
  // the fold is retried on the next read instead of losing the address.
  if (legacy.entries.length > 0 && persist(entries, store)) {
    for (const key of legacy.keys) {
      try {
        store.removeItem(key);
      } catch {
        // A leftover key only costs a repeated fold, and the book dedupes.
      }
    }
  }
  return entries;
}

/** True when the entries reached storage; the caller decides what a failure costs. */
function persist(entries: readonly SafeAddress[], store: SafeAddressStorage): boolean {
  try {
    store.setItem(SAVED_KEY, JSON.stringify(entries));
    return true;
  } catch {
    return false;
  }
}

export function writeSavedSafes(entries: readonly SafeAddress[], store: SafeAddressStorage | null = storage()): void {
  if (store === null) return;
  // Remembering is a convenience; failing to is not an execution failure.
  persist(entries, store);
}

/** The entry the user last chose to execute through, or null for the connected account. */
export function readActiveSafe(store: SafeAddressStorage | null = storage()): SafeAddress | null {
  if (store === null) return null;
  try {
    const raw = store.getItem(ACTIVE_KEY);
    return raw === null ? null : normalizeEntry(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export function writeActiveSafe(entry: SafeAddress | null, store: SafeAddressStorage | null = storage()): void {
  if (store === null) return;
  try {
    if (entry === null) store.removeItem(ACTIVE_KEY);
    else store.setItem(ACTIVE_KEY, JSON.stringify(entry));
  } catch {
    // See writeSavedSafes.
  }
}

/** Add an entry, keeping the existing one when that Safe is already saved. */
export function addSafeAddress(entries: readonly SafeAddress[], entry: SafeAddress): SafeAddress[] {
  if (entries.some(candidate => sameSafeAddress(candidate, entry))) return [...entries];
  return [...entries, entry];
}

export function withoutSafeAddress(entries: readonly SafeAddress[], entry: SafeAddress): SafeAddress[] {
  return entries.filter(candidate => !sameSafeAddress(candidate, entry));
}
