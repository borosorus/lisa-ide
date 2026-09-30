import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompilerClient, CompilerError } from './client';
import type { CompileRequest, CompileResponse } from './types';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<CompileResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  terminated = false;
  request: CompileRequest | undefined;

  constructor() { FakeWorker.instances.push(this); }
  postMessage(request: CompileRequest) { this.request = request; }
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
    const id = worker.request!.id;
    expect(worker.request).toMatchObject({ kind: 'compile', source: 'return p;' });
    worker.reply({ id: id + 1, ok: false, error: 'stale' });
    expect(worker.terminated).toBe(false);
    const output = { program: '0x00', programHash: '0xhash', byteSize: 1, instructionCount: 1, disassembly: ['STOP'] };
    worker.reply({ id, ok: true, output });
    await expect(promise).resolves.toEqual(output);
    expect(worker.terminated).toBe(true);
  });

  it('uses the Worker for artifact inspection', async () => {
    const client = new CompilerClient();
    const promise = client.inspect('0x00');
    const worker = FakeWorker.instances[0];
    const id = worker.request!.id;
    expect(worker.request).toEqual({ id, kind: 'inspect', program: '0x00' });
    const output = { program: '0x00', programHash: '0xhash', byteSize: 1, instructionCount: 1, disassembly: ['STOP'] };
    worker.reply({ id, ok: true, output });
    await expect(promise).resolves.toEqual(output);
  });

  it('preserves structured source diagnostics', async () => {
    const client = new CompilerClient();
    const promise = client.compile('bad');
    const worker = FakeWorker.instances[0];
    worker.reply({ id: worker.request!.id, ok: false, error: 'Unknown name', line: 2, column: 7 });
    const assertion = expect(promise).rejects.toMatchObject({
      name: 'CompilerError',
      diagnostic: { message: 'Unknown name', line: 2, column: 7 },
    });
    await assertion;
    await promise.catch(error => expect(error).toBeInstanceOf(CompilerError));
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
