import { describe, expect, it, vi } from 'vitest';
import { inspectLisaAccount, isLisaAccountReady, parseDelegationCode } from './inspect';
import { lisaAccountInterface } from './abi';
import type { AccountReader, DeploymentConfig } from './types';

const IMPL = '0x3333333333333333333333333333333333333333';
const RUNTIME = '0x4444444444444444444444444444444444444444';
const OTHER = '0x5555555555555555555555555555555555555555';
const ACCOUNT = '0x1111111111111111111111111111111111111111';

const CONFIG: DeploymentConfig = { kind: 'configured', implementation: IMPL, runtime: RUNTIME };

function delegatingTo(address: string): string {
  return `0xef0100${address.slice(2)}`;
}

function runtimeWord(address: string): string {
  return lisaAccountInterface.encodeFunctionResult('lisaRuntime', [address]);
}

function reader(code: string | null | ((address: string) => Promise<string>), call?: () => Promise<string>): AccountReader {
  return {
    getCode: typeof code === 'function' ? vi.fn(code) : vi.fn().mockResolvedValue(code ?? '0x'),
    call: vi.fn(call ?? (async () => runtimeWord(RUNTIME))),
  };
}

describe('parseDelegationCode', () => {
  it('reads an absent account as undelegated', () => {
    for (const code of ['0x', '', null, undefined, '  ']) {
      expect(parseDelegationCode(code as string | null | undefined)).toEqual({ kind: 'none' });
    }
  });

  it('parses a well-formed EIP-7702 designator', () => {
    expect(parseDelegationCode(delegatingTo(IMPL))).toEqual({ kind: 'delegated', implementation: IMPL });
  });

  it('accepts a designator written in upper case hex', () => {
    expect(parseDelegationCode(delegatingTo(IMPL).toUpperCase())).toEqual({ kind: 'delegated', implementation: IMPL });
  });

  it('rejects a designator that is not exactly 23 bytes', () => {
    expect(parseDelegationCode('0xef01001234')).toMatchObject({ kind: 'invalid' });
    expect(parseDelegationCode(`${delegatingTo(IMPL)}deadbeef`)).toMatchObject({ kind: 'invalid' });
    expect(parseDelegationCode('0xef0100')).toMatchObject({ kind: 'invalid' });
  });

  it('rejects other non-empty code rather than guessing', () => {
    expect(parseDelegationCode('0x6080604052')).toMatchObject({ kind: 'invalid' });
    expect(parseDelegationCode('0xef010133333333333333333333333333333333333333')).toMatchObject({ kind: 'invalid' });
    expect(parseDelegationCode('not hex')).toMatchObject({ kind: 'invalid' });
  });
});

describe('inspectLisaAccount', () => {
  it('never reads the chain without a configuration', async () => {
    const r = reader('0x');
    await expect(inspectLisaAccount(r, ACCOUNT, { kind: 'unconfigured' })).resolves.toEqual({ kind: 'unconfigured' });
    await expect(inspectLisaAccount(r, ACCOUNT, { kind: 'invalid', reason: 'bad' })).resolves.toEqual({ kind: 'invalid-config', reason: 'bad' });
    expect(r.getCode).not.toHaveBeenCalled();
  });

  it('classifies an undelegated EOA without probing a runtime', async () => {
    const r = reader('0x');
    await expect(inspectLisaAccount(r, ACCOUNT, CONFIG)).resolves.toEqual({ kind: 'undelegated' });
    expect(r.call).not.toHaveBeenCalled();
  });

  it('is ready only when both the implementation and the runtime match', async () => {
    const status = await inspectLisaAccount(reader(delegatingTo(IMPL)), ACCOUNT, CONFIG);
    expect(status).toEqual({ kind: 'ready', implementation: IMPL, runtime: RUNTIME });
    expect(isLisaAccountReady(status)).toBe(true);
  });

  it('reads the runtime from the connected account, not the implementation', async () => {
    const r = reader(delegatingTo(IMPL));
    await inspectLisaAccount(r, ACCOUNT, CONFIG);
    expect(r.call).toHaveBeenCalledWith({ to: ACCOUNT, data: expect.stringMatching(/^0x[0-9a-f]{8}$/) });
    expect(r.call).toHaveBeenCalledWith(expect.objectContaining({ to: ACCOUNT }));
  });

  it('reports a foreign delegation and never calls into it', async () => {
    const r = reader(delegatingTo(OTHER));
    await expect(inspectLisaAccount(r, ACCOUNT, CONFIG)).resolves.toEqual({ kind: 'other-delegation', implementation: OTHER });
    expect(r.call).not.toHaveBeenCalled();
  });

  it('fails closed when the bound runtime differs (§4)', async () => {
    const status = await inspectLisaAccount(reader(delegatingTo(IMPL), async () => runtimeWord(OTHER)), ACCOUNT, CONFIG);
    expect(status).toEqual({ kind: 'runtime-mismatch', implementation: IMPL, runtime: OTHER, expected: RUNTIME });
    expect(isLisaAccountReady(status)).toBe(false);
  });

  it('treats a failing or junk runtime probe as invalid, never ready', async () => {
    const failing = await inspectLisaAccount(reader(delegatingTo(IMPL), async () => {
      throw new Error('execution reverted');
    }), ACCOUNT, CONFIG);
    expect(failing.kind).toBe('invalid-lisa');
    const junk = await inspectLisaAccount(reader(delegatingTo(IMPL), async () => '0x1234'), ACCOUNT, CONFIG);
    expect(junk.kind).toBe('invalid-lisa');
  });

  it('surfaces a malformed delegation instead of executing through it', async () => {
    await expect(inspectLisaAccount(reader('0xef0100aabb'), ACCOUNT, CONFIG))
      .resolves.toMatchObject({ kind: 'invalid-delegation' });
  });

  it('propagates a transport failure so the UI can report it (§12)', async () => {
    const r: AccountReader = { getCode: vi.fn().mockRejectedValue(new Error('failed to fetch')), call: vi.fn() };
    await expect(inspectLisaAccount(r, ACCOUNT, CONFIG)).rejects.toThrow('failed to fetch');
  });
});
