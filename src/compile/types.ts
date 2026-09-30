export interface CompileRequest {
  readonly id: number;
  readonly source: string;
}

export interface CompileOutput {
  readonly program: string;
  readonly programHash: string;
  readonly byteSize: number;
  readonly instructionCount: number;
  readonly disassembly: readonly string[];
}

export type CompileResponse =
  | { readonly id: number; readonly ok: true; readonly output: CompileOutput }
  | { readonly id: number; readonly ok: false; readonly error: string; readonly line?: number; readonly column?: number };
