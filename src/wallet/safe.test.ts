import { Wallet, ZeroAddress, getAddress } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import type { AccountReader, DeploymentConfig } from '../lisa-account/types';
import { LisaError } from '../lisa-account/types';
import {
  buildSafeTx, hashSafeTx, inspectSafeExecution, normalizeSafeSignature, parseSafeAddress,
  prepareSafeExecutionTransaction, readSafeNonce, readSafeTransactionHash, recoverSafeSigner,
  safeInterface, safeTypedData, type SafeTx,
} from './safe';
import { DOMAIN_SEPARATOR_TYPEHASH, SAFE_TX_TYPEHASH, referenceSafeTransactionHash } from '../test/safeReference';

/** A real key, so signatures can be produced and recovered without a network. */
const OWNER_WALLET = new Wallet(`0x${'11'.repeat(32)}`);
const OWNER = OWNER_WALLET.address;
const OTHER = new Wallet(`0x${'22'.repeat(32)}`).address;
const SAFE = '0x1234567890abcdef1234567890abcdef12345678';
const RUNTIME = '0x4444444444444444444444444444444444444444';
const IMPL = '0x3333333333333333333333333333333333333333';

const CONFIGURED: DeploymentConfig = { kind: 'configured', chainId: '1', runtime: RUNTIME, implementation: IMPL };
const TX: SafeTx = buildSafeTx({ runtime: RUNTIME, program: '0x60016002', nonce: 7n });

const selector = (name: string) => safeInterface.getFunction(name)!.selector;

interface SafeOptions {
  code?: string;
  /** A string, or a thrown error, to model a contract that is not a Safe. */
  version?: string | (() => never);
  owners?: string[];
  threshold?: bigint;
  nonce?: bigint;
  runtimeCode?: string;
}

function reader(options: SafeOptions = {}): AccountReader {
  const owners = options.owners ?? [OWNER];
  return {
    getCode: vi.fn(async (address: string) => address.toLowerCase() === RUNTIME.toLowerCase()
      ? (options.runtimeCode ?? '0x6080604052348015')
      : (options.code ?? '0x6080604052348015')),
    call: vi.fn(async ({ data }: { to: string; data: string }) => {
      const which = data.slice(0, 10);
      if (which === selector('VERSION')) {
        if (typeof options.version === 'function') options.version();
        return safeInterface.encodeFunctionResult('VERSION', [options.version ?? '1.4.1']);
      }
      if (which === selector('getOwners')) return safeInterface.encodeFunctionResult('getOwners', [owners]);
      if (which === selector('getThreshold')) return safeInterface.encodeFunctionResult('getThreshold', [options.threshold ?? 1n]);
      if (which === selector('nonce')) return safeInterface.encodeFunctionResult('nonce', [options.nonce ?? 0n]);
      throw new Error('unexpected call');
    }),
  };
}

describe('the Safe transaction digest', () => {
  it('matches the type hashes the Safe contract declares', () => {
    // Taken verbatim from GnosisSafe.sol 1.3.0 and Safe.sol 1.4.1.
    expect(DOMAIN_SEPARATOR_TYPEHASH).toBe('0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218');
    expect(SAFE_TX_TYPEHASH).toBe('0xbb8310d486368db6bd6f849402fdd73ad53d316b5a4b2644ad6efe0f941286d8');
  });

  it('reproduces the abi.encode/abi.encodePacked construction of getTransactionHash', () => {
    for (const chainId of ['1', '11155111']) {
      expect(hashSafeTx(chainId, SAFE, TX)).toBe(referenceSafeTransactionHash(chainId, SAFE, TX));
    }
  });

  it('binds the chain and the Safe into the domain', () => {
    const elsewhere = hashSafeTx('11155111', SAFE, TX);
    expect(elsewhere).not.toBe(hashSafeTx('1', SAFE, TX));
    expect(hashSafeTx('1', OTHER, TX)).not.toBe(hashSafeTx('1', SAFE, TX));
  });

  it('signs the fields in the SafeTx order the contract uses', () => {
    const typed = safeTypedData('1', SAFE, TX);
    expect(typed.domain).toEqual({ chainId: 1n, verifyingContract: getAddress(SAFE) });
    expect(typed.types.SafeTx.map(field => `${field.type} ${field.name}`)).toEqual([
      'address to', 'uint256 value', 'bytes data', 'uint8 operation', 'uint256 safeTxGas',
      'uint256 baseGas', 'uint256 gasPrice', 'address gasToken', 'address refundReceiver', 'uint256 nonce',
    ]);
    // ethers adds EIP712Domain itself; the Safe hashes the same type string.
    expect(typed.types.EIP712Domain).toBeUndefined();
  });

  it('produces a 32-byte digest', () => {
    expect(hashSafeTx('1', SAFE, TX)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('buildSafeTx', () => {
  it('delegatecalls the runtime with the program as data and no value', () => {
    expect(TX).toEqual({
      to: RUNTIME,
      value: 0n,
      data: '0x60016002',
      operation: 1,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: ZeroAddress,
      refundReceiver: ZeroAddress,
      nonce: 7n,
    });
  });

  it('canonicalises the program bytes so they are hashed and sent identically', () => {
    const upper = buildSafeTx({ runtime: RUNTIME, program: '0xAB', nonce: 0n });
    expect(upper.data).toBe('0xab');
    expect(hashSafeTx('1', SAFE, upper)).toBe(hashSafeTx('1', SAFE, { ...upper, data: '0xab' }));
  });

  it('refuses a runtime that is not an address', () => {
    expect(() => buildSafeTx({ runtime: '0xnope', program: '0x01', nonce: 0n })).toThrow(LisaError);
  });
});

describe('prepareSafeExecutionTransaction', () => {
  const signature = `0x${'ab'.repeat(64)}1b`;

  it('sends execTransaction to the Safe itself and keeps the program untouched', () => {
    const transaction = prepareSafeExecutionTransaction({ safe: SAFE, chainId: '1', transaction: TX, signature });
    // The request is pinned to the reviewed chain; the signature only verifies there.
    expect(transaction).toMatchObject({ to: getAddress(SAFE), value: 0n, chainId: 1n });
    const [to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, signatures] =
      safeInterface.decodeFunctionData('execTransaction', transaction.data);
    expect(to).toBe(RUNTIME);
    expect(value).toBe(0n);
    expect(data).toBe(TX.data);
    expect(operation).toBe(1n);
    expect([safeTxGas, baseGas, gasPrice]).toEqual([0n, 0n, 0n]);
    expect([gasToken, refundReceiver]).toEqual([ZeroAddress, ZeroAddress]);
    expect(signatures).toBe(signature);
  });
});

describe('readSafeTransactionHash', () => {
  it('returns what the Safe computed, lowercased', () => {
    const expected = referenceSafeTransactionHash('1', SAFE, TX);
    const mock: AccountReader = {
      getCode: async () => '0x60',
      call: async ({ data }) => {
        expect(data.slice(0, 10)).toBe(selector('getTransactionHash'));
        const [to, value, bytes, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, nonce] =
          safeInterface.decodeFunctionData('getTransactionHash', data);
        return safeInterface.encodeFunctionResult('getTransactionHash', [
          referenceSafeTransactionHash('1', SAFE, {
            to: to as string, value: value as bigint, data: bytes as string, operation: operation as 1,
            safeTxGas: safeTxGas as bigint, baseGas: baseGas as bigint, gasPrice: gasPrice as bigint,
            gasToken: gasToken as string, refundReceiver: refundReceiver as string, nonce: nonce as bigint,
          }),
        ]);
      },
    };
    return expect(readSafeTransactionHash(mock, SAFE, TX)).resolves.toBe(expected);
  });

  it('reads the Safe nonce as a bigint', async () => {
    await expect(readSafeNonce(reader({ nonce: 3n }), SAFE)).resolves.toBe(3n);
  });
});

describe('normalizeSafeSignature', () => {
  it('accepts a canonical 27/28 signature and lowercases it', async () => {
    const raw = await OWNER_WALLET.signTypedData(safeTypedData('1', SAFE, TX).domain, safeTypedData('1', SAFE, TX).types, TX);
    expect(normalizeSafeSignature(raw.toUpperCase().replace('0X', '0x'))).toBe(raw.toLowerCase());
  });

  it('rejects the approved-hash marker and anything that is not a signature', () => {
    const body = `${'0x'}${'ab'.repeat(64)}`;
    for (const v of ['00', '01', '1d', '1e', 'ff']) {
      expect(() => normalizeSafeSignature(`${body}${v}`)).toThrow(/only accepts 27 or 28/);
    }
    // EIP-2098 compact signatures have no v byte and a Safe cannot parse them.
    expect(() => normalizeSafeSignature(`${body.slice(0, 130)}`)).toThrow(/65 bytes/);
    expect(() => normalizeSafeSignature('0x')).toThrow(/65 bytes/);
  });
});

describe('recoverSafeSigner', () => {
  it('recovers the owner that signed the reviewed transaction', async () => {
    const typed = safeTypedData('1', SAFE, TX);
    const signature = await OWNER_WALLET.signTypedData(typed.domain, typed.types, TX);
    expect(recoverSafeSigner('1', SAFE, TX, signature)).toBe(OWNER);
  });

  it('does not recover the reviewed owner when another nonce was signed', async () => {
    const other = buildSafeTx({ runtime: RUNTIME, program: '0x60016002', nonce: 8n });
    const typed = safeTypedData('1', SAFE, other);
    const signature = await OWNER_WALLET.signTypedData(typed.domain, typed.types, other);
    expect(recoverSafeSigner('1', SAFE, TX, signature)).not.toBe(OWNER);
  });

  it('returns null for a signature that is not an ECDSA signature at all', () => {
    expect(recoverSafeSigner('1', SAFE, TX, `0x${'00'.repeat(65)}`)).toBeNull();
  });
});

describe('parseSafeAddress', () => {
  it('returns the checksummed address, or null for anything unusable', () => {
    expect(parseSafeAddress(SAFE)).toBe(getAddress(SAFE));
    expect(parseSafeAddress(`  ${SAFE}  `)).toBe(getAddress(SAFE));
    // A bare 40-hex address is accepted and checksummed, as ethers does.
    expect(parseSafeAddress(SAFE.slice(2))).toBe(getAddress(SAFE));
    for (const value of ['', '   ', '0x1234', 'not-an-address', SAFE.slice(0, -1)]) {
      expect(parseSafeAddress(value)).toBeNull();
    }
  });
});

describe('inspectSafeExecution', () => {
  const inspect = (options: SafeOptions = {}, config: DeploymentConfig = CONFIGURED, owner = OWNER) =>
    inspectSafeExecution(reader(options), SAFE, owner, config);

  it('is ready only for a deployed, single-owner Safe on the configured runtime', async () => {
    await expect(inspect({ nonce: 4n })).resolves.toEqual({
      kind: 'ready', safe: getAddress(SAFE), owner: OWNER, runtime: RUNTIME, version: '1.4.1', nonce: 4n,
    });
  });

  it('accepts 1.3.0 and the L2 variants whose hashing is identical', async () => {
    for (const version of ['1.3.0', '1.3.0+L2', '1.4.1', '1.4.1+L2']) {
      await expect(inspect({ version })).resolves.toMatchObject({ kind: 'ready', version });
    }
  });

  it('refuses versions whose domain or hashing differs', async () => {
    for (const version of ['1.1.1', '1.2.0', '1.0.0', '2.0.0', '']) {
      await expect(inspect({ version })).resolves.toMatchObject({ kind: 'unsupported-version', version });
    }
  });

  it('fails closed before reading a Safe that has no code', async () => {
    const r = reader({ code: '0x' });
    await expect(inspectSafeExecution(r, SAFE, OWNER, CONFIGURED)).resolves.toEqual({ kind: 'safe-no-code', safe: getAddress(SAFE) });
    expect(r.call).not.toHaveBeenCalled();
  });

  it('reports a contract that does not answer as a Safe', async () => {
    const status = await inspect({ version: () => { throw new Error('execution reverted') } });
    expect(status).toMatchObject({ kind: 'not-a-safe', safe: getAddress(SAFE) });
    expect(status.kind === 'not-a-safe' && status.reason).toMatch(/execution reverted/);
  });

  it('reports an account that is not an owner, and one Safe that needs more signatures', async () => {
    await expect(inspect({ owners: [OTHER] })).resolves.toMatchObject({ kind: 'not-owner', owner: OWNER });
    await expect(inspect({ threshold: 2n })).resolves.toMatchObject({ kind: 'threshold', threshold: 2 });
  });

  it('checks the configured runtime for code, not the Safe', async () => {
    await expect(inspect({ runtimeCode: '0x' })).resolves.toEqual({ kind: 'runtime-no-code', runtime: RUNTIME });
  });

  it('carries deployment problems instead of inventing a Safe state', async () => {
    await expect(inspect({}, { kind: 'unconfigured' })).resolves.toEqual({ kind: 'unconfigured' });
    await expect(inspect({}, { kind: 'invalid', reason: 'boom' })).resolves.toEqual({ kind: 'invalid-config', reason: 'boom' });
    await expect(inspectSafeExecution(reader(), '0xnope', OWNER, CONFIGURED)).resolves.toMatchObject({ kind: 'invalid-config' });
  });

  it('never treats a read failure as ready', async () => {
    const r: AccountReader = { getCode: async () => '0x60', call: async () => { throw new Error('rpc down') } };
    await expect(inspectSafeExecution(r, SAFE, OWNER, CONFIGURED)).resolves.toMatchObject({ kind: 'not-a-safe' });
  });
});
