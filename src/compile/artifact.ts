import { keccak_256 } from '@noble/hashes/sha3.js';
import type { CompileOutput } from './types';

export interface ProgramArtifact {
  readonly format: 'lisa-program';
  readonly version: 1;
  readonly isa: 'lisa-v1';
  readonly program: string;
  readonly programHash: string;
  readonly compiler: { readonly name: 'lisa-tooling'; readonly version: '0.1.0' };
}

export function hashProgram(bytes: Uint8Array): string {
  return `0x${Array.from(keccak_256(bytes), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function createArtifact(output: CompileOutput): ProgramArtifact {
  return {
    format: 'lisa-program',
    version: 1,
    isa: 'lisa-v1',
    program: output.program,
    programHash: output.programHash,
    compiler: { name: 'lisa-tooling', version: '0.1.0' },
  };
}
