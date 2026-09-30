import { decode, disassemble } from '@bosorus/lisa-evm';
import { hashProgram } from './artifact';
import { evaluateSource } from './evaluate';
import type { CompileOutput } from './types';

export function compileSource(source: string): CompileOutput {
  const compiled = evaluateSource(source).compile();
  const decoded = decode(compiled.bytes);
  return {
    program: compiled.hex,
    programHash: hashProgram(compiled.bytes),
    byteSize: compiled.bytes.length,
    instructionCount: decoded.length,
    disassembly: disassemble(compiled.bytes).map((line, index) =>
      `0x${decoded[index].offset.toString(16).padStart(4, '0')}  ${line}`),
  };
}
