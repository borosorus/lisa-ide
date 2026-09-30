import { decode, disassemble } from '@bosorus/lisa-evm';
import { hashProgram } from './artifact';
import { evaluateSource } from './evaluate';
import { bytesFromHex, hexFromBytes } from './hex';
import type { CompileOutput } from './types';

function inspectBytes(bytes: Uint8Array): CompileOutput {
  const decoded = decode(bytes);
  return {
    program: hexFromBytes(bytes),
    programHash: hashProgram(bytes),
    byteSize: bytes.length,
    instructionCount: decoded.length,
    disassembly: disassemble(bytes).map((line, index) =>
      `0x${decoded[index].offset.toString(16).padStart(4, '0')}  ${line}`),
  };
}

export function compileSource(source: string): CompileOutput {
  return inspectBytes(evaluateSource(source).compile().bytes);
}

export function inspectProgram(program: string): CompileOutput {
  return inspectBytes(bytesFromHex(program));
}
