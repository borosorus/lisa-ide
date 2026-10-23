import { describe, expect, it } from 'vitest';
import { Interface } from 'ethers';
import { encodeExecuteLisa, prepareExecuteLisaTransaction } from './execute';
import { LisaError } from './types';

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const CHAIN_ID = '1';
const STATUS = { kind: 'ready', implementation: '0x3333333333333333333333333333333333333333', runtime: '0x4444444444444444444444444444444444444444' } as const;

// Independent ABI, so a typo in the app's own ABI string cannot agree with itself.
const REFERENCE = new Interface(['function executeLisa(bytes memory program) payable']);

describe('encodeExecuteLisa', () => {
  it('produces executeLisa(bytes) calldata for a one-byte program', () => {
    // keccak256("executeLisa(bytes)")[0:4] = 0x79bb0b6f
    expect(encodeExecuteLisa('0x00')).toBe([
      '0x79bb0b6f',
      '0000000000000000000000000000000000000000000000000000000000000020',
      '0000000000000000000000000000000000000000000000000000000000000001',
      '0000000000000000000000000000000000000000000000000000000000000000',
    ].join(''));
  });

  it('agrees with a reference encoder and leaves the bytes untouched', () => {
    for (const program of ['0x6001', '0x0102030405', `0x${'ab'.repeat(97)}`, `0x${'ff'.repeat(400)}`]) {
      const encoded = encodeExecuteLisa(program);
      expect(encoded).toBe(REFERENCE.encodeFunctionData('executeLisa', [program]));
      const [bytes] = REFERENCE.decodeFunctionData('executeLisa', encoded);
      expect(bytes).toBe(program);
    }
  });

  it('refuses data that is not even-length hex', () => {
    for (const program of ['0x', '0x1', 'nope', '']) {
      expect(() => encodeExecuteLisa(program), program).toThrow(/hex/i);
    }
  });
});

describe('prepareExecuteLisaTransaction', () => {
  it('sends to the connected account itself with zero value', () => {
    const tx = prepareExecuteLisaTransaction({ account: ACCOUNT, program: '0x6001', status: STATUS, chainId: CHAIN_ID });
    expect(tx.to).toBe(ACCOUNT);
    expect(tx.value).toBe(0n);
    expect(tx.data).toBe(encodeExecuteLisa('0x6001'));
    expect(tx.chainId).toBe(1n);
  });

  it('passes an explicit native value through when the caller supplies one', () => {
    expect(prepareExecuteLisaTransaction({ account: ACCOUNT, program: '0x00', status: STATUS, chainId: CHAIN_ID, value: 7n }).value).toBe(7n);
  });

  it('rejects a negative value', () => {
    expect(() => prepareExecuteLisaTransaction({ account: ACCOUNT, program: '0x00', status: STATUS, chainId: CHAIN_ID, value: -1n }))
      .toThrow(LisaError);
  });

  it('rejects an account that is not an address', () => {
    expect(() => prepareExecuteLisaTransaction({ account: '0x12', program: '0x00', status: STATUS, chainId: CHAIN_ID }))
      .toThrow(/address/i);
  });

  it('never retargets to the runtime itself (§14)', () => {
    const tx = prepareExecuteLisaTransaction({ account: ACCOUNT, program: '0x00', status: STATUS, chainId: CHAIN_ID });
    expect(tx.to.toLowerCase()).not.toBe(STATUS.runtime);
    expect(tx.to.toLowerCase()).toBe(ACCOUNT);
  });
});
