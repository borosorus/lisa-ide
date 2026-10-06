import { Interface } from 'ethers';

/**
 * The whole LisaAccount ABI boundary the IDE needs (AGENTS.md §5). The runtime's
 * own instruction set is deliberately absent — the program bytes are opaque.
 */
export const LISA_ACCOUNT_ABI = [
  'function executeLisa(bytes program) payable',
  'function lisaRuntime() view returns (address)',
] as const;

export const lisaAccountInterface = new Interface(LISA_ACCOUNT_ABI);
