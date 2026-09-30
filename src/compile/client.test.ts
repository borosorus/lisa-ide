import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompilerClient } from './client';
import type { CompileResponse } from './types';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<CompileResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  terminated = false;
  request: unknown;

  constructor() { FakeWorker.instances.push(this); }
  postMessage(request: unknown) { this.request = request; }
  terminate() { this.terminated = true; }
  reply(response: CompileResponse) { this.onmessage?.({ data: response } as MessageEvent<CompileResponse>); }
}

describe('CompilerClient', () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal('Worker', FakeWorker);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('accepts only the matching response and terminates the Worker', async () => {
    const client = new CompilerClient();
    const promise = client.compile('return p;');
    const worker = FakeWorker.instances[0];
    const id = (worker.request as { id: number }).id;
    worker.reply({ id: id + 1, ok: false, error: 'stale' });
    expect(worker.terminated).toBe(false);
    const output = { program: '0x00', programHash: '0xhash', byteSize: 1, instructionCount: 1, disassembly: ['STOP'] };
    worker.reply({ id, ok: true, output });
    await expect(promise).resolves.toEqual(output);
    expect(worker.terminated).toBe(true);
  });

  it('cancels old requests when another compile begins', async () => {
    const client = new CompilerClient();
    const first = client.compile('first');
    const oldWorker = FakeWorker.instances[0];
    const second = client.compile('second');
    await expect(first).rejects.toThrow('Compilation cancelled');
    expect(oldWorker.terminated).toBe(true);
    client.cancel();
    await expect(second).rejects.toThrow('Compilation cancelled');
  });

  it('terminates a Worker that exceeds the time limit', async () => {
    vi.useFakeTimers();
    const client = new CompilerClient();
    const promise = client.compile('source');
    const worker = FakeWorker.instances[0];
    const assertion = expect(promise).rejects.toThrow('Compilation timed out after 5 seconds');
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(worker.terminated).toBe(true);
  });

  it('reports Worker failures', async () => {
    const client = new CompilerClient();
    const promise = client.compile('source');
    const worker = FakeWorker.instances[0];
    worker.onerror?.();
    await expect(promise).rejects.toThrow('Compiler Worker failed');
    expect(worker.terminated).toBe(true);
  });
});
