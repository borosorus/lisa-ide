import { describe, expect, it } from 'vitest';
import { compileSource, inspectProgram } from './run';
import { createArtifact, parseArtifact } from './artifact';
import { evaluateSource, SourceError } from './evaluate';

const source = `const p = createProgram();
const balance = p.staticCall(SELF, encodeCall("balanceOf(address)", [SELF])).uint256();
p.if(balance.gt(1000n), () => {
  p.call(SELF, encodeCall("deposit(uint256)", [balance]));
});
return p;`;

describe('restricted LISA source', () => {
  it('compiles the starter program and exports an artifact', () => {
    const output = compileSource(source);
    expect(output.program).toMatch(/^0x[0-9a-f]+$/);
    expect(output.byteSize).toBe((output.program.length - 2) / 2);
    expect(output.instructionCount).toBe(output.disassembly.length);
    expect(output.disassembly.at(-1)).toMatch(/STOP$/);
    const artifact = createArtifact(output);
    expect(artifact).toEqual({
      format: 'lisa-program', version: 1, isa: 'lisa-v1',
      program: output.program, programHash: output.programHash,
      compiler: { name: 'lisa-tooling', version: '0.1.0' },
    });
    expect(parseArtifact(JSON.stringify(artifact))).toEqual(artifact);
  });

  it('hashes the compiled program bytes with Keccak-256', () => {
    const output = compileSource('const p = createProgram(); return p;');
    expect(output.program).toBe('0x00');
    expect(output.programHash).toBe('0xbc36789e7a1e281436464229828f817d6612f7b477d66591ff96a9e064bcc98a');
  });

  it('inspects already-compiled bytecode', () => {
    const output = inspectProgram('0x00');
    expect(output).toMatchObject({
      program: '0x00',
      byteSize: 1,
      instructionCount: 1,
      disassembly: ['0x0000  STOP'],
    });
  });

  it('rejects tampered and unsupported artifacts', () => {
    const artifact = createArtifact(inspectProgram('0x00'));
    expect(() => parseArtifact(JSON.stringify({ ...artifact, program: '0x01' }))).toThrow(/programHash does not match/);
    expect(() => parseArtifact(JSON.stringify({ ...artifact, version: 2 }))).toThrow(/Unsupported artifact version/);
    expect(() => parseArtifact(JSON.stringify({ ...artifact, isa: 'lisa-v2' }))).toThrow(/Unsupported LISA ISA/);
  });

  it('accepts value-like literal receivers, coercing exactly as builder arguments do', () => {
    const output = compileSource(
      'const p = createProgram(); p.call(SELF, encodeCall("f(uint256)", [(1n).add(2n)])); return p;',
    );
    expect(output.instructionCount).toBeGreaterThan(1);
    expect(() => evaluateSource(
      'const p = createProgram(); const b = p.staticCall(SELF, encodeCall("g(address)", ["0x2222222222222222222222222222222222222222"])).uint256(); const x = b.add("0x01"); return p;',
    )).not.toThrow();
  });

  it('rejects booleans used as numeric values with a clear message', () => {
    expect(() => evaluateSource('const p = createProgram(); p.if(true, () => {}); return p;'))
      .toThrowError(/A boolean is not a numeric value/);
    expect(() => evaluateSource('const p = createProgram(); const b = p.staticCall(SELF, encodeCall("balanceOf(address)", [SELF])).uint256(); b.add(true); return p;'))
      .toThrowError(/A boolean is not a numeric value/);
  });

  it.each([
    'const p = createProgram(); fetch("https://example.com"); return p;',
    'const p = createProgram(); p.constructor; return p;',
    'const p = createProgram(); p.compile(); return p;',
    'const p = createProgram(); while (true) {} return p;',
    'const p = createProgram(); return globalThis;',
  ])('rejects syntax and access outside the allowlist', text => {
    expect(() => evaluateSource(text)).toThrow(SourceError);
  });

  it('reports source positions for unknown names', () => {
    expect(() => evaluateSource('const p = createProgram();\np.call(UNKNOWN, rawCalldata("0x"));\nreturn p;'))
      .toThrowError(/Unknown name: UNKNOWN/);
    try {
      evaluateSource('const p = createProgram();\np.call(UNKNOWN, rawCalldata("0x"));\nreturn p;');
    } catch (error) {
      expect(error).toMatchObject({ line: 2 });
    }
  });
});
