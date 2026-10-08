import { describe, expect, it } from 'vitest';
import { parseDeploymentConfig, CHAIN_ID_ENV, IMPLEMENTATION_ENV, RUNTIME_ENV } from './config';

const CHAIN = '11155111';
const IMPL = '0x3333333333333333333333333333333333333333';
const RUNTIME = '0x4444444444444444444444444444444444444444';
const CHECKED_IMPL = '0x3333333333333333333333333333333333333333';

/** Every case starts from a complete deployment and breaks one variable. */
const vars = (over: Record<string, string | undefined> = {}) => ({
  VITE_LISA_CHAIN_ID: CHAIN,
  VITE_LISA_RUNTIME_ADDRESS: RUNTIME,
  VITE_LISA_ACCOUNT_IMPLEMENTATION_ADDRESS: IMPL,
  ...over,
});

describe('parseDeploymentConfig', () => {
  it('treats a build with no variables as unconfigured, not broken', () => {
    expect(parseDeploymentConfig({})).toEqual({ kind: 'unconfigured' });
    expect(parseDeploymentConfig({
      VITE_LISA_CHAIN_ID: undefined,
      VITE_LISA_RUNTIME_ADDRESS: undefined,
      VITE_LISA_ACCOUNT_IMPLEMENTATION_ADDRESS: undefined,
    })).toEqual({ kind: 'unconfigured' });
  });

  it('treats blank or literal-undefined values as absent', () => {
    expect(parseDeploymentConfig(vars({
      VITE_LISA_CHAIN_ID: '  ',
      VITE_LISA_RUNTIME_ADDRESS: '',
      VITE_LISA_ACCOUNT_IMPLEMENTATION_ADDRESS: 'undefined',
    }))).toEqual({ kind: 'unconfigured' });
  });

  it('binds a complete deployment to one normalized chain id', () => {
    expect(parseDeploymentConfig(vars())).toEqual({ kind: 'configured', chainId: CHAIN, runtime: RUNTIME, implementation: IMPL });
  });

  it('names the variable when less than a whole deployment is configured', () => {
    expect(parseDeploymentConfig({ VITE_LISA_CHAIN_ID: CHAIN })).toEqual({ kind: 'invalid', reason: `${RUNTIME_ENV} is not set` });
    expect(parseDeploymentConfig({ VITE_LISA_RUNTIME_ADDRESS: RUNTIME })).toEqual({ kind: 'invalid', reason: `${CHAIN_ID_ENV} is not set` });
    expect(parseDeploymentConfig({ VITE_LISA_CHAIN_ID: CHAIN, VITE_LISA_RUNTIME_ADDRESS: RUNTIME }))
      .toEqual({ kind: 'invalid', reason: `${IMPLEMENTATION_ENV} is not set` });
    expect(parseDeploymentConfig({ VITE_LISA_CHAIN_ID: CHAIN, VITE_LISA_ACCOUNT_IMPLEMENTATION_ADDRESS: IMPL }))
      .toEqual({ kind: 'invalid', reason: `${RUNTIME_ENV} is not set` });
  });

  it('normalizes hex and decimal chain ids to decimal', () => {
    expect(parseDeploymentConfig(vars({ VITE_LISA_CHAIN_ID: '0xaa36a7' })))
      .toEqual({ kind: 'configured', chainId: CHAIN, runtime: RUNTIME, implementation: IMPL });
    expect(parseDeploymentConfig(vars({ VITE_LISA_CHAIN_ID: '0x1' })))
      .toEqual({ kind: 'configured', chainId: '1', runtime: RUNTIME, implementation: IMPL });
    expect(parseDeploymentConfig(vars({ VITE_LISA_CHAIN_ID: ' 1 ' })))
      .toEqual({ kind: 'configured', chainId: '1', runtime: RUNTIME, implementation: IMPL });
  });

  it('rejects a chain id that is not a number, or is zero', () => {
    for (const bad of ['sepolia', '0x', '1.5', '-1', '0x0', '0']) {
      expect(parseDeploymentConfig(vars({ VITE_LISA_CHAIN_ID: bad })), bad).toEqual({
        kind: 'invalid', reason: `${CHAIN_ID_ENV} is not a chain id: ${bad}`,
      });
    }
  });

  it('accepts valid addresses and normalizes them to checksum form', () => {
    // EIP-55: single-case forms carry no checksum, mixed case must validate.
    expect(parseDeploymentConfig({ VITE_LISA_CHAIN_ID: CHAIN, VITE_LISA_RUNTIME_ADDRESS: RUNTIME, VITE_LISA_ACCOUNT_IMPLEMENTATION_ADDRESS: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }))
      .toEqual({ kind: 'configured', chainId: CHAIN, runtime: RUNTIME, implementation: '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa' });
    expect(parseDeploymentConfig(vars()).kind).toBe('configured');
    expect((parseDeploymentConfig(vars()) as { implementation: string }).implementation).toBe(CHECKED_IMPL);
  });

  it('rejects a mixed-case address whose checksum is wrong', () => {
    expect(parseDeploymentConfig(vars({ VITE_LISA_ACCOUNT_IMPLEMENTATION_ADDRESS: '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa' })))
      .toEqual({ kind: 'invalid', reason: `${IMPLEMENTATION_ENV} is not a 20-byte address` });
  });

  it('rejects malformed addresses instead of using them', () => {
    for (const bad of ['0x123', 'nope', '0xzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', '3333333333333333333333333333333333333333', '0x' + '3'.repeat(39)]) {
      const result = parseDeploymentConfig({ VITE_LISA_CHAIN_ID: CHAIN, VITE_LISA_RUNTIME_ADDRESS: bad, VITE_LISA_ACCOUNT_IMPLEMENTATION_ADDRESS: IMPL });
      expect(result, bad).toEqual({ kind: 'invalid', reason: `${RUNTIME_ENV} is not a 20-byte address` });
    }
  });

  it('rejects the zero address, which could never execute', () => {
    expect(parseDeploymentConfig({
      VITE_LISA_CHAIN_ID: CHAIN,
      VITE_LISA_RUNTIME_ADDRESS: '0x0000000000000000000000000000000000000000',
      VITE_LISA_ACCOUNT_IMPLEMENTATION_ADDRESS: IMPL,
    })).toEqual({ kind: 'invalid', reason: `${RUNTIME_ENV} is the zero address` });
  });
});
