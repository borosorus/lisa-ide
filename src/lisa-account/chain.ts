/**
 * Chain-id normalization, shared by deployment-config parsing and the wallet
 * layer. It lives here rather than in `src/wallet/` so the pure LISA helpers stay
 * self-contained and extractable (AGENTS.md §6), and so one rule covers every
 * representation a chain id arrives in.
 *
 * Syntax only: `0` normalizes to `'0'`. Whether a chain id is *usable* is a
 * decision for whoever asks (deployment config rejects 0, and so does switching).
 */

/** Hex (`0x1`), decimal (`1`), numeric and bigint all normalize to decimal text. */
export function normalizeChainId(value: string | number | bigint | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toLowerCase();
  const hex = /^0x([0-9a-f]+)$/.exec(text);
  if (hex) return BigInt(`0x${hex[1]}`).toString();
  return /^\d+$/.test(text) ? BigInt(text).toString() : null;
}

/** The `wallet_switchEthereumChain` payload form (EIP-3326 requires hex). */
export function hexChainId(decimalChainId: string): string {
  return `0x${BigInt(decimalChainId).toString(16)}`;
}
