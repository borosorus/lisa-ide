import { LisaError, type LisaErrorCode } from '../lisa-account/types';

/**
 * Error normalization at the wallet/LISA boundary (AGENTS.md §12). The UI renders
 * `message` only — raw provider error objects never reach it — while `cause` and
 * `detail` keep whatever the provider gave for debugging.
 */

export interface NormalizedError {
  readonly code: LisaErrorCode;
  readonly message: string;
  readonly detail: string;
  readonly cause?: unknown;
}

const MESSAGES: Readonly<Record<LisaErrorCode, string>> = {
  WALLET_DISCONNECTED: 'Wallet is not connected.',
  USER_REJECTED: 'Request rejected in the wallet.',
  WRONG_CHAIN: 'Connected to the wrong network.',
  INVALID_CONFIG: 'LISA deployment configuration is invalid.',
  UNSUPPORTED_DELEGATION: 'Wallet cannot install the configured delegation.',
  UNKNOWN_DELEGATION: 'Account is delegated to an unknown implementation.',
  RUNTIME_MISMATCH: 'LisaAccount is bound to a different LISA runtime.',
  TRANSACTION_REVERTED: 'Transaction reverted.',
  RPC_UNAVAILABLE: 'Network request failed.',
  UNKNOWN: 'Request failed.',
};

export function messageFor(code: LisaErrorCode): string {
  return MESSAGES[code];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}

/** Walks `cause`/`error`/`info` chains looking for a provider code or text. */
function collect(cause: unknown, seen: Set<unknown>, codes: number[], texts: string[]): void {
  if (seen.size > 8 || seen.has(cause) || cause === null || cause === undefined) return;
  seen.add(cause);
  if (typeof cause === 'string') {
    texts.push(cause);
    return;
  }
  const node = record(cause);
  if (!node) return;
  texts.push(String(node.message ?? ''), String(node.shortMessage ?? ''), String(node.reason ?? ''));
  const code = node.code;
  if (typeof code === 'number') codes.push(code);
  else if (typeof code === 'string') texts.push(code);
  const info = record(node.info);
  if (info) {
    const nested = record(info.error) ?? info;
    const nestedCode = nested.code;
    if (typeof nestedCode === 'number') codes.push(nestedCode);
    texts.push(String(nested.message ?? ''));
  }
  collect(node.cause, seen, codes, texts);
  collect(node.error, seen, codes, texts);
}

/** EIP-1193 user rejection is 4001; 4902 is "chain not added". */
export function normalizeError(cause: unknown): NormalizedError {
  if (cause instanceof LisaError) {
    return { code: cause.code, message: cause.message, detail: cause.message, cause };
  }
  const codes: number[] = [];
  const texts: string[] = [];
  collect(cause, new Set(), codes, texts);
  const text = texts.filter(t => t.length > 0 && t !== 'undefined').join(' ').toLowerCase();
  const detail = cause instanceof Error ? cause.message : String(cause);

  const classify = (): LisaErrorCode => {
    if (codes.includes(4001) || /action_rejected|user ?rejected|rejected the transaction|denied|permission denied/.test(text)) {
      return 'USER_REJECTED';
    }
    if (codes.includes(4902) || /unrecognized chain|wrong (network|chain)|chain mismatch/.test(text)) return 'WRONG_CHAIN';
    if (/revert/.test(text)) return 'TRANSACTION_REVERTED';
    if (/could not detect network|failed to fetch|network error|missing response|timeout|timed out|econn|enotfound/.test(text)) {
      return 'RPC_UNAVAILABLE';
    }
    if (/not connected|no signer|no provider|provider is not connected/.test(text)) return 'WALLET_DISCONNECTED';
    return 'UNKNOWN';
  };
  const code = classify();
  return { code, message: MESSAGES[code], detail, ...(cause === undefined ? {} : { cause }) };
}
