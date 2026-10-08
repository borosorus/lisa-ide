import { describe, expect, it } from 'vitest';
import { compileSource, inspectProgram } from './run';
import { createArtifact, parseArtifact } from './artifact';
import { evaluateSource, SourceError } from './evaluate';
import { SOURCE_EXAMPLES } from '../editor/examples';

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
      compiler: { name: 'lisa-tooling', version: '0.3.0' },
    });
    expect(parseArtifact(JSON.stringify(artifact))).toEqual(artifact);
  });

  it('hashes the compiled program bytes with Keccak-256', () => {
    const output = compileSource('const p = createProgram(); return p;');
    expect(output.program).toBe('0x00');
    expect(output.programHash).toBe('0xbc36789e7a1e281436464229828f817d6612f7b477d66591ff96a9e064bcc98a');
  });

  it('compiles every example the editor offers', () => {
    for (const example of SOURCE_EXAMPLES) {
      expect(() => compileSource(example.source), example.id).not.toThrow();
    }
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

describe('p.if with ELSE (0.2.0)', () => {
  const cond = 'CALLER.eq(0n)';
  it('accepts the three-argument form and compiles', () => {
    const src = `const p = createProgram();
p.if(${cond}, () => { p.staticCall(SELF, encodeCall("a()")); }, () => { p.staticCall(SELF, encodeCall("b()")); });
return p;`;
    const result = compileSource(src);
    expect(result.program).toMatch(/^0x[0-9a-f]+$/);
    expect(result.program.length).toBeGreaterThan(4);
  });

  it('still accepts the two-argument form', () => {
    const src = `const p = createProgram();
p.if(${cond}, () => { p.staticCall(SELF, encodeCall("a()")); });
return p;`;
    expect(compileSource(src).program).toMatch(/^0x[0-9a-f]+$/);
  });

  it('rejects one-argument and four-argument calls', () => {
    expect(() => evaluateSource(`const p = createProgram();\np.if(${cond});\nreturn p;`)).toThrow(SourceError);
    const four = `const p = createProgram();
p.if(${cond}, () => {}, () => {}, () => {});
return p;`;
    expect(() => evaluateSource(four)).toThrow(/one or two callbacks/);
  });

  it('rejects a non-arrow third callback', () => {
    const src = `const p = createProgram();
p.if(${cond}, () => {}, "nope");
return p;`;
    expect(() => evaluateSource(src)).toThrow(/arrow callbacks/);
  });

  it('keeps callback restrictions for the else body too', () => {
    const src = `const p = createProgram();
p.if(${cond}, () => {}, async () => {});
return p;`;
    expect(() => evaluateSource(src)).toThrow(SourceError);
  });
});

/** Mnemonics only: offsets and operands would make these assertions about encoding. */
const mnemonics = (output: { disassembly: readonly string[] }) => output.disassembly.map(line => line.split('  ')[1] ?? '');

describe('balance, revertUnless and keccak (0.3.0)', () => {
  it('reads a balance as an expression without reserving a slot', () => {
    const output = compileSource('const p = createProgram(); p.revertUnless(p.balance(CALLER).gt(10n)); return p;');
    const ops = mnemonics(output);
    expect(ops).toContain('CALLER');
    expect(ops).toContain('BALANCE');
    expect(ops).toContain('REVERT');
    expect(ops).not.toContain('RDLOAD');
    expect(output.byteSize).toBeLessThan(16);
  });

  it('re-reads the balance wherever the value is consumed', () => {
    const bound = compileSource('const p = createProgram(); const b = p.balance(CALLER); p.if(b.gt(1n), () => {}); p.if(b.lt(2n), () => {}); return p;');
    const inlined = compileSource('const p = createProgram(); p.if(p.balance(CALLER).gt(1n), () => {}); p.if(p.balance(CALLER).lt(2n), () => {}); return p;');
    expect(mnemonics(bound).filter(op => op === 'BALANCE')).toHaveLength(2);
    expect(inlined.program).toBe(bound.program);
  });

  it('guards with revertUnless and keeps the guard inside a branch', () => {
    const plain = mnemonics(compileSource('const p = createProgram(); p.revertUnless(p.balance(SELF).gt(0n)); return p;'));
    expect(plain.filter(op => op === 'REVERT')).toHaveLength(1);
    const branch = compileSource('const p = createProgram(); p.if(GAS.gt(1n), () => { p.revertUnless(p.balance(SELF).gt(0n)); p.call(SELF, encodeCall("f()")); }); return p;');
    const ops = mnemonics(branch);
    expect(ops.filter(op => op === 'REVERT')).toHaveLength(2);
    expect(ops.indexOf('REVERT')).toBeGreaterThan(ops.indexOf('GAS'));
  });

  it('rejects a balance read whose value goes nowhere', () => {
    expect(() => evaluateSource('const p = createProgram(); p.balance(CALLER); return p;'))
      .toThrowError(/p\.balance produces a value/);
    // The comparison swallows the read, so the line looks like a check.
    expect(() => evaluateSource('const p = createProgram(); p.balance(SELF).gt(0n); return p;'))
      .toThrowError(/p\.balance produces a value/);
    expect(() => evaluateSource('const p = createProgram(); const b = p.balance(SELF); return p;'))
      .toThrowError(/p\.balance produces a value/);
  });

  it('accepts a balance read bound to a value that reaches a call', () => {
    const bound = 'const p = createProgram(); const c = p.balance(SELF).gt(1n); p.if(c, () => {}); return p;';
    expect(() => evaluateSource(bound)).not.toThrow();
    expect(() => evaluateSource('const p = createProgram(); p.call(SELF, encodeCall("f(uint256)", [p.balance(SELF).add(1n)])); return p;'))
      .not.toThrow();
    expect(() => evaluateSource('const p = createProgram(); p.if(GAS.gt(1n), () => { p.revertUnless(p.balance(SELF).gt(1n)); }); return p;'))
      .not.toThrow();
    expect(() => evaluateSource('const p = createProgram(); p.call(SELF, encodeCall("stake()"), p.balance(CALLER)); return p;'))
      .not.toThrow();
  });

  it('hashes constant data once and reuses the digest', () => {
    const output = compileSource(`const p = createProgram();
const digest = p.keccak("0xdeadbeef");
p.call(SELF, encodeCall("a(uint256)", [digest]));
p.call(SELF, encodeCall("b(uint256)", [digest]));
return p;`);
    const ops = mnemonics(output);
    expect(ops.filter(op => op === 'KECCAK256')).toHaveLength(1);
    expect(ops).toContain('BLOB 4 byte(s)');
  });

  it('hashes empty data', () => {
    const ops = mnemonics(compileSource('const p = createProgram(); p.call(SELF, encodeCall("f(uint256)", [p.keccak("0x")])); return p;'));
    expect(ops).toContain('BLOB 0 byte(s)');
    expect(ops).toContain('KECCAK256');
  });

  it.each([
    ['p.keccak("hello")', /hex string/],
    ['p.keccak("0xabc")', /hex string/],
    ['p.keccak("deadbeef")', /hex string/],
    ['p.keccak(5)', /hex string/],
    ['p.keccak()', /exactly one argument/],
    ['p.balance()', /exactly one argument/],
    ['p.balance(SELF, SELF)', /exactly one argument/],
    ['p.revertUnless()', /exactly one argument/],
    ['p.balance(true)', /not an address/],
    ['p.revertUnless(true)', /not a condition/],
    ['p.call(SELF, encodeCall("f(uint256)", [p.revertUnless(GAS.gt(1n))]))', /p\.revertUnless is a statement/],
  ])('rejects %s with a source-level message', (call, message) => {
    expect(() => evaluateSource(`const p = createProgram(); ${call}; return p;`)).toThrowError(message);
  });

  it('points at the offending keccak argument', () => {
    try {
      evaluateSource('const p = createProgram();\np.call(SELF, encodeCall("f(bytes32)", [p.keccak("nope")]));\nreturn p;');
      throw new Error('expected keccak to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(SourceError);
      expect(error).toMatchObject({ line: 2 });
    }
  });
});
