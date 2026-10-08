/**
 * Wallet-independent LisaAccount protocol types.
 *
 * Nothing here may import React, MUI, Web3-Onboard, or any UI code: this module
 * is meant to be extractable as a standalone package later.
 */

/** One explicit deployment on one explicit chain; multi-chain registries are a non-goal. */
export type DeploymentConfig =
  | { readonly kind: 'configured'; readonly chainId: string; readonly runtime: string; readonly implementation: string }
  | { readonly kind: 'unconfigured' }
  | { readonly kind: 'invalid'; readonly reason: string };

/** Result of reading one account's code as an EIP-7702 delegation designator. */
export type DelegationCode =
  /** `0x` / empty — a plain EOA with no delegation set. */
  | { readonly kind: 'none' }
  | { readonly kind: 'delegated'; readonly implementation: string }
  /** Non-empty code that is not a well-formed designator: fail closed. */
  | { readonly kind: 'invalid'; readonly reason: string };

/**
 * Classification of the connected account. Only `ready` may execute a program;
 * every other kind must disable execution and explain itself.
 */
export type LisaAccountStatus =
  | { readonly kind: 'unconfigured' }
  | { readonly kind: 'invalid-config'; readonly reason: string }
  | { readonly kind: 'undelegated' }
  | { readonly kind: 'other-delegation'; readonly implementation: string }
  | { readonly kind: 'invalid-delegation'; readonly reason: string }
  | { readonly kind: 'invalid-lisa'; readonly implementation: string; readonly reason: string }
  | { readonly kind: 'runtime-mismatch'; readonly implementation: string; readonly runtime: string; readonly expected: string }
  /** The account names the configured runtime, but that address has no code (§3). */
  | { readonly kind: 'runtime-no-code'; readonly implementation: string; readonly runtime: string }
  | { readonly kind: 'ready'; readonly implementation: string; readonly runtime: string };

/**
 * The smallest RPC surface inspection needs. A `BrowserProvider` satisfies it
 * structurally, and tests can pass a plain object literal — no provider mocking.
 */
export interface AccountReader {
  getCode(address: string): Promise<string>;
  call(transaction: { to: string; data: string }): Promise<string>;
}

/** Normalized categories for everything crossing the wallet/LISA boundary (§12). */
export type LisaErrorCode =
  | 'WALLET_DISCONNECTED'
  | 'USER_REJECTED'
  | 'WRONG_CHAIN'
  | 'INVALID_CONFIG'
  | 'UNSUPPORTED_DELEGATION'
  | 'UNKNOWN_DELEGATION'
  | 'RUNTIME_MISMATCH'
  | 'TRANSACTION_REVERTED'
  | 'RPC_UNAVAILABLE'
  | 'UNKNOWN';

export class LisaError extends Error {
  constructor(readonly code: LisaErrorCode, message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'LisaError';
  }
}
