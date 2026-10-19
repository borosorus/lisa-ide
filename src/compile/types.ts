export interface CompileDiagnostic {
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
}

export interface CompileOutput {
  readonly program: string;
  readonly programHash: string;
  readonly byteSize: number;
  readonly instructionCount: number;
  readonly disassembly: readonly string[];
  /** Advisory source diagnostics; absent for imported bytecode. */
  readonly warnings?: readonly CompileDiagnostic[];
}

export type CompileRequest =
  | { readonly id: number; readonly kind: 'compile'; readonly source: string }
  | { readonly id: number; readonly kind: 'inspect'; readonly program: string };

export type CompileResponse =
  | { readonly id: number; readonly ok: true; readonly output: CompileOutput }
  | {
      readonly id: number;
      readonly ok: false;
      readonly error: string;
      readonly line?: number;
      readonly column?: number;
    };
