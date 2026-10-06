import { describe, expect, it } from 'vitest';
import { parseDeploymentConfig, IMPLEMENTATION_ENV, RUNTIME_ENV } from './config';

const IMPL = '0x3333333333333333333333333333333333333333';
const RUNTIME = '0x4444444444444444444444444444444444444444';
const CHECKED_IMPL = '0x3333333333333333333333333333333333333333';

describe('parseDeploymentConfig', () => {
  it('treats a build with no variables as unconfigured, not broken', () => {
    expect(parseDeploymentConfig({})).toEqual({ kind: 'unconfigured' });
    expect(parseDeploymentConfig({ VITE_LISA_RUNTIME_ADDRESS: undefined, VITE_LISA_ACCOUNT_IMPLEMENTATION_ADDRESS: undefined }))
      .toEqual({ kind: 'unconfigured' });
  });

  it('treats blank or literal-undefined values as absent', () => {
    expect(parseDeploymentConfig({ VITE_LISA_RUNTIME_ADDRESS: '  ', VITE_LISA_ACCOUNT_IMPLEMENTATION_ADDRESS: '' }))
      .toEqual({ kind: 'unconfigured' });
    expect(parseDeploymentConfig({ VITE_LISA_RUNTIME_ADDRESS: 'undefined', VITE_LISA_ACCOUNT_IMPLEMENTATION_ADDRESS: 'undefined' }))
      .toEqual({ kind: 'unconfigured' });
  });

  it('names the variable when only half a deployment is configured', () => {
    expect(parseDeploymentConfig({ VITE_LISA_RUNTIME_ADDRESS: RUNTIME })).toEqual({ kind: 'invalid', reason: `${IMPLEMENTATION_ENV} is not set` });
    expect(parseDeploymentConfig({ VITE_LISA_ACCOUNT_IMPLEMENTATION_ADDRESS: IMPL })).toEqual({ kind: 'invalid', reason: `${RUNTIME_ENV} is not set` });
  });

  it('accepts valid addresses and normalizes them to checksum form', () => {
    // EIP-55: single-case forms carry no checksum, mixed case must validate.
    expect(parseDeploymentConfig({ VITE_LISA_RUNTIME_ADDRESS: RUNTIME, VITE_LISA_ACCOUNT_IMPLEMENTATION_ADDRESS: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }))
      .toEqual({ kind: 'configured', runtime: RUNTIME, implementation: '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa' });
    expect(parseDeploymentConfig({ VITE_LISA_RUNTIME_ADDRESS: RUNTIME, VITE_LISA_ACCOUNT_IMPLEMENTATION_ADDRESS: IMPL }).kind)
      .toBe('configured');
    expect((parseDeploymentConfig({ VITE_LISA_RUNTIME_ADDRESS: RUNTIME, VITE_LISA_ACCOUNT_IMPLEMENTATION_ADDRESS: IMPL }) as { implementation: string }).implementation)
      .toBe(CHECKED_IMPL);
  });

  it('rejects a mixed-case address whose checksum is wrong', () => {
    expect(parseDeploymentConfig({ VITE_LISA_RUNTIME_ADDRESS: RUNTIME, VITE_LISA_ACCOUNT_IMPLEMENTATION_ADDRESS: '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa' }))
      .toEqual({ kind: 'invalid', reason: `${IMPLEMENTATION_ENV} is not a 20-byte address` });
  });

  it('rejects malformed addresses instead of using them', () => {
    for (const bad of ['0x123', 'nope', '0xzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', '3333333333333333333333333333333333333333', '0x' + '3'.repeat(39)]) {
      const result = parseDeploymentConfig({ VITE_LISA_RUNTIME_ADDRESS: bad, VITE_LISA_ACCOUNT_IMPLEMENTATION_ADDRESS: IMPL });
      expect(result, bad).toEqual({ kind: 'invalid', reason: `${RUNTIME_ENV} is not a 20-byte address` });
    }
  });

  it('rejects the zero address, which could never execute', () => {
    expect(parseDeploymentConfig({
      VITE_LISA_RUNTIME_ADDRESS: '0x0000000000000000000000000000000000000000',
      VITE_LISA_ACCOUNT_IMPLEMENTATION_ADDRESS: IMPL,
    })).toEqual({ kind: 'invalid', reason: `${RUNTIME_ENV} is the zero address` });
  });
});
