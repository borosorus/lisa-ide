import type { CompileDiagnostic, CompileOutput, CompileRequest, CompileResponse } from './types';

type RequestInput =
  | { readonly kind: 'compile'; readonly source: string }
  | { readonly kind: 'inspect'; readonly program: string };

export class CompilerError extends Error {
  constructor(readonly diagnostic: CompileDiagnostic) {
    super(diagnostic.message);
    this.name = 'CompilerError';
  }
}

export class CompilerClient {
  private worker: Worker | undefined;
  private nextId = 0;
  private pending: {
    id: number;
    resolve: (value: CompileOutput) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | undefined;

  compile(source: string): Promise<CompileOutput> {
    return this.request({ kind: 'compile', source });
  }

  inspect(program: string): Promise<CompileOutput> {
    return this.request({ kind: 'inspect', program });
  }

  private request(input: RequestInput): Promise<CompileOutput> {
    this.cancel();
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.id === id) {
          this.pending = undefined;
          worker.terminate();
          this.worker = undefined;
          reject(new Error('Compilation timed out after 5 seconds'));
        }
      }, 5000);
      this.pending = { id, resolve, reject, timer };
      worker.onmessage = (event: MessageEvent<CompileResponse>) => {
        if (event.data.id !== id || this.pending?.id !== id) return;
        clearTimeout(timer);
        this.pending = undefined;
        worker.terminate();
        this.worker = undefined;
        if (event.data.ok) {
          resolve(event.data.output);
        } else {
          reject(new CompilerError({
            message: event.data.error,
            ...(event.data.line ? { line: event.data.line } : {}),
            ...(event.data.column ? { column: event.data.column } : {}),
          }));
        }
      };
      worker.onerror = () => {
        if (this.pending?.id !== id) return;
        clearTimeout(timer);
        this.pending = undefined;
        worker.terminate();
        this.worker = undefined;
        reject(new Error('Compiler Worker failed'));
      };
      const request: CompileRequest = input.kind === 'compile'
        ? { id, kind: 'compile', source: input.source }
        : { id, kind: 'inspect', program: input.program };
      worker.postMessage(request);
    });
  }

  cancel(): void {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error('Compilation cancelled'));
      this.pending = undefined;
    }
    this.worker?.terminate();
    this.worker = undefined;
  }
}
