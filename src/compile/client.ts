import type { CompileDiagnostic, CompileOutput, CompileRequest, CompileResponse } from './types';

type RequestInput =
  | { readonly kind: 'compile'; readonly source: string }
  | { readonly kind: 'inspect'; readonly program: string };

interface Pending {
  resolve: (value: CompileOutput) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class CompilerError extends Error {
  constructor(readonly diagnostic: CompileDiagnostic) {
    super(diagnostic.message);
    this.name = 'CompilerError';
  }
}

/**
 * Talks to the compiler Worker. The Worker is built once and stays warm:
 * construction costs a module-graph load every time, and compiling is the
 * app's most repeated action. Responses are matched by id, so a cancelled
 * request's late answer is ignored rather than awaited, and nothing waits
 * on a Worker that died or stalled.
 */
export class CompilerClient {
  private worker: Worker | undefined;
  private nextId = 0;
  private pending = new Map<number, Pending>();

  compile(source: string): Promise<CompileOutput> {
    return this.request({ kind: 'compile', source });
  }

  inspect(program: string): Promise<CompileOutput> {
    return this.request({ kind: 'inspect', program });
  }

  private request(input: RequestInput): Promise<CompileOutput> {
    // A new request replaces whatever was in flight; only one result is ever shown.
    this.cancel();
    const worker = this.ensureWorker();
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        // A Worker that stalls once cannot be trusted with the next request.
        this.retireWorker();
        reject(new Error('Compilation timed out after 5 seconds'));
      }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      const request: CompileRequest = input.kind === 'compile'
        ? { id, kind: 'compile', source: input.source }
        : { id, kind: 'inspect', program: input.program };
      worker.postMessage(request);
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<CompileResponse>) => {
      const entry = this.pending.get(event.data.id);
      if (!entry) return; // stale or cancelled — this id is no longer ours
      this.pending.delete(event.data.id);
      clearTimeout(entry.timer);
      if (event.data.ok) {
        entry.resolve(event.data.output);
      } else {
        entry.reject(new CompilerError({
          message: event.data.error,
          ...(event.data.line ? { line: event.data.line } : {}),
          ...(event.data.column ? { column: event.data.column } : {}),
        }));
      }
    };
    worker.onerror = () => {
      // A dying Worker takes everything in flight with it; it comes back for
      // the next request.
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('Compiler Worker failed'));
      }
      this.pending.clear();
      this.retireWorker();
    };
    this.worker = worker;
    return worker;
  }

  private retireWorker(): void {
    this.worker?.terminate();
    this.worker = undefined;
  }

  /** Abandons in-flight requests; the Worker itself stays warm. */
  cancel(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Compilation cancelled'));
    }
    this.pending.clear();
  }

  /** The owner is gone for good; release the kept Worker with it. */
  dispose(): void {
    this.cancel();
    this.retireWorker();
  }
}
