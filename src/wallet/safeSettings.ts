import { normalizeChainId } from '../lisa-account/chain';
import { parseSafeAddress } from './safe';

/**
 * One Safe address per chain, remembered locally because a Safe exists on one
 * network at a time and a long address is not something to paste every reload.
 *
 * Storage is optional: private-mode browsers throw on access, and that must only
 * cost the remember feature, never the ability to execute.
 */

const KEY_PREFIX = 'lisa-ide.safe-address.v1.';

export interface SafeAddressStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function storage(): SafeAddressStorage | null {
  try {
    const candidate = (globalThis as { localStorage?: SafeAddressStorage }).localStorage;
    return candidate ?? null;
  } catch {
    return null;
  }
}

export function safeAddressKey(chainId: string): string | null {
  const normalized = normalizeChainId(chainId);
  return normalized === null ? null : `${KEY_PREFIX}${normalized}`;
}

/** The remembered address for this chain, or null when there is none to trust. */
export function loadSafeAddress(
  chainId: string | null,
  store: SafeAddressStorage | null = storage(),
): string | null {
  if (chainId === null || store === null) return null;
  const key = safeAddressKey(chainId);
  if (key === null) return null;
  try {
    const stored = store.getItem(key);
    // A stored value that no longer parses is treated as absent, not as input.
    return stored === null ? null : parseSafeAddress(stored);
  } catch {
    return null;
  }
}

/**
 * Remember a valid address; clearing the field forgets it. A half-typed address
 * is not persisted and does not erase what is already stored — otherwise editing
 * one character would forget the address being edited.
 */
export function saveSafeAddress(
  chainId: string | null,
  value: string,
  store: SafeAddressStorage | null = storage(),
): void {
  if (chainId === null || store === null) return;
  const key = safeAddressKey(chainId);
  if (key === null) return;
  try {
    const address = parseSafeAddress(value);
    if (address !== null) store.setItem(key, address);
    else if (value.trim() === '') store.removeItem(key);
  } catch {
    // Remembering is a convenience; failing to is not an execution failure.
  }
}
