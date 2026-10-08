import { keccak_256 } from '@noble/hashes/sha3.js';
import type { CompileOutput } from './types';
import { bytesFromHex } from './hex';

export const LISA_ARTIFACT_FORMAT = 'lisa-program' as const;
export const LISA_ARTIFACT_VERSION = 1 as const;
export const LISA_ISA = 'lisa-v1' as const;
export const LISA_TOOLCHAIN_NAME = 'lisa-tooling' as const;
export const LISA_TOOLCHAIN_VERSION = '0.3.0';

export interface ProgramArtifact {
  readonly format: typeof LISA_ARTIFACT_FORMAT;
  readonly version: typeof LISA_ARTIFACT_VERSION;
  readonly isa: typeof LISA_ISA;
  readonly program: string;
  readonly programHash: string;
  readonly compiler: {
    readonly name: string;
    readonly version: string;
  };
  readonly metadata?: {
    readonly name?: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hashProgram(bytes: Uint8Array): string {
  return `0x${Array.from(keccak_256(bytes), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function createArtifact(output: CompileOutput, name?: string): ProgramArtifact {
  return {
    format: LISA_ARTIFACT_FORMAT,
    version: LISA_ARTIFACT_VERSION,
    isa: LISA_ISA,
    program: output.program,
    programHash: output.programHash,
    compiler: { name: LISA_TOOLCHAIN_NAME, version: LISA_TOOLCHAIN_VERSION },
    ...(name ? { metadata: { name } } : {}),
  };
}

export function parseArtifact(serialized: string): ProgramArtifact {
  let candidate: unknown;
  try {
    candidate = JSON.parse(serialized);
  } catch {
    throw new Error('Artifact is not valid JSON');
  }
  if (!isRecord(candidate)) throw new Error('Artifact must be a JSON object');
  if (candidate.format !== LISA_ARTIFACT_FORMAT) throw new Error('Unsupported artifact format');
  if (candidate.version !== LISA_ARTIFACT_VERSION) throw new Error(`Unsupported artifact version: ${String(candidate.version)}`);
  if (candidate.isa !== LISA_ISA) throw new Error(`Unsupported LISA ISA: ${String(candidate.isa)}`);
  if (typeof candidate.program !== 'string') throw new Error('Artifact program must be hex data');
  if (typeof candidate.programHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(candidate.programHash)) {
    throw new Error('Artifact programHash must be a 32-byte hex value');
  }
  if (!isRecord(candidate.compiler)
      || typeof candidate.compiler.name !== 'string'
      || candidate.compiler.name.length === 0
      || typeof candidate.compiler.version !== 'string'
      || candidate.compiler.version.length === 0) {
    throw new Error('Artifact compiler metadata is invalid');
  }
  if (candidate.metadata !== undefined && (!isRecord(candidate.metadata)
      || (candidate.metadata.name !== undefined && typeof candidate.metadata.name !== 'string'))) {
    throw new Error('Artifact metadata is invalid');
  }

  const bytes = bytesFromHex(candidate.program);
  const programHash = hashProgram(bytes);
  if (candidate.programHash.toLowerCase() !== programHash) {
    throw new Error('Artifact programHash does not match the program bytes');
  }

  return {
    format: LISA_ARTIFACT_FORMAT,
    version: LISA_ARTIFACT_VERSION,
    isa: LISA_ISA,
    program: candidate.program.toLowerCase(),
    programHash,
    compiler: { name: candidate.compiler.name, version: candidate.compiler.version },
    ...(candidate.metadata && typeof candidate.metadata.name === 'string'
      ? { metadata: { name: candidate.metadata.name } }
      : {}),
  };
}
