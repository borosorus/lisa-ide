import { describe, expect, it, vi } from 'vitest';
import { LisaError } from '../lisa-account/types';
import { DISCONNECTED_SESSION, requestChainSwitch } from './session';

describe('requestChainSwitch', () => {
  it('fails loudly with no wallet rather than resolving as if it switched (§5)', async () => {
    // The old shape was `await provider?.send(...)`: with no provider that awaited
    // `undefined`, resolved, and reported a chain that never changed.
    await expect(requestChainSwitch(null, '1')).rejects.toMatchObject({
      code: 'WALLET_DISCONNECTED',
      name: 'LisaError',
    });
    await expect(DISCONNECTED_SESSION.switchChain('1')).rejects.toBeInstanceOf(LisaError);
  });

  it('refuses a chain id it cannot express before bothering the wallet', async () => {
    const send = vi.fn(async () => ({}));
    for (const bad of ['sepolia', '', '0', '0x0']) {
      await expect(requestChainSwitch(send, bad)).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('asks the wallet in the hex form EIP-3326 requires', async () => {
    const send = vi.fn(async () => ({}));
    await requestChainSwitch(send, '11155111');
    expect(send).toHaveBeenCalledWith('wallet_switchEthereumChain', [{ chainId: '0xaa36a7' }]);
    await requestChainSwitch(send, '0x1');
    expect(send).toHaveBeenLastCalledWith('wallet_switchEthereumChain', [{ chainId: '0x1' }]);
  });

  it('propagates a wallet refusal instead of swallowing it', async () => {
    const send = vi.fn(async () => {
      throw Object.assign(new Error('User rejected'), { code: 4001 });
    });
    await expect(requestChainSwitch(send, '1')).rejects.toMatchObject({ code: 4001 });
  });
});
