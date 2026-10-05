import { describe, expect, it } from 'vitest';
import { canonicalInputType, isValidAddress, parseAbiJson } from './abi';
import { outputHeadOffsets } from './model';

const ERC20 = JSON.stringify([
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'o', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amt', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'sp', type: 'address' }, { name: 'amt', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'event', name: 'Transfer', inputs: [{ name: 'from', type: 'address', indexed: true }], anonymous: false },
]);

describe('parseAbiJson', () => {
  it('extracts canonical callable functions and skips non-functions', () => {
    const { functions, rejected } = parseAbiJson(ERC20);
    expect(rejected).toEqual([]);
    expect(functions.map(f => f.signature)).toEqual([
      'balanceOf(address)', 'transfer(address,uint256)', 'approve(address,uint256)',
    ]);
    expect(functions[0].mutability).toBe('view');
    expect(functions[1].mutability).toBe('nonpayable');
    expect(functions[0].outputs).toEqual(['uint256']);
  });

  it('rejects unsupported argument types with a reason', () => {
    const { functions, rejected } = parseAbiJson(JSON.stringify([
      { type: 'function', name: 'bad', inputs: [{ type: 'uint256[]' }], outputs: [] },
      { type: 'function', name: 'tuple', inputs: [{ type: 'tuple', components: [] }], outputs: [] },
      { type: 'function', name: 'string', inputs: [{ type: 'string' }], outputs: [] },
      { type: 'function', name: 'signed', inputs: [{ type: 'int256' }], outputs: [] },
      { type: 'function', name: 'dynamicBytes', inputs: [{ type: 'bytes' }], outputs: [] },
      { type: 'function', name: 'odd', inputs: [{ type: 'uint7' }], outputs: [] },
      { type: 'function', name: 'fixed', inputs: [{ type: 'bool' }, { type: 'bytes32' }, { type: 'uint8' }], outputs: [] },
      { type: 'function', name: 'fine', inputs: [{ type: 'bool' }, { type: 'uint8' }], outputs: [{ type: 'bytes32' }] },
    ]));
    expect(functions.map(f => f.signature)).toEqual(['fine(bool,uint8)']);
    expect(rejected.map(r => r.name)).toEqual([
      'bad(uint256[])', 'tuple(tuple)', 'string(string)', 'signed(int256)', 'dynamicBytes(bytes)', 'odd(uint7)', 'fixed(bool,bytes32,uint8)',
    ]);
    expect(rejected[0].reason).toContain('uint256[]');
  });

  it('rejects bytesN arguments because the graph cannot author constant bytes yet', () => {
    const { functions, rejected } = parseAbiJson(JSON.stringify([
      { type: 'function', name: 'consume', inputs: [{ type: 'bytes32' }], outputs: [] },
    ]));
    expect(functions).toEqual([]);
    expect(rejected[0].name).toBe('consume(bytes32)');
    expect(rejected[0].reason).toContain('bytesN arguments are not supported');
  });

  it('canonicalizes bare uint and deduplicates overloads', () => {
    const { functions } = parseAbiJson(JSON.stringify([
      { type: 'function', name: 'f', inputs: [{ type: 'uint' }], outputs: [] },
      { type: 'function', name: 'f', inputs: [{ type: 'uint256' }], outputs: [] },
      { type: 'function', name: 'g', inputs: [{ type: 'uint64' }], outputs: [] },
    ]));
    expect(functions.map(f => f.signature)).toEqual(['f(uint256)', 'g(uint64)']);
  });

  it('defaults missing stateMutability to nonpayable', () => {
    const { functions } = parseAbiJson(JSON.stringify([
      { type: 'function', name: 'x', inputs: [], outputs: [] },
    ]));
    expect(functions[0].signature).toBe('x()');
    expect(functions[0].mutability).toBe('nonpayable');
  });

  it('preserves parameter and output names when the ABI has them', () => {
    const { functions } = parseAbiJson(JSON.stringify([{
      type: 'function', name: 'balanceOf', stateMutability: 'view',
      inputs: [{ name: 'owner', type: 'address' }, { type: 'uint8' }],
      outputs: [{ name: 'balance', type: 'uint' }, { type: 'bool' }],
    }]));
    expect(functions[0].signature).toBe('balanceOf(address,uint8)');
    expect(functions[0].inputNames).toEqual(['owner', null]);
    expect(functions[0].outputNames).toEqual(['balance', null]);
    // Bare uint canonicalizes; raw spellings survive only for non-word types.
    expect(functions[0].outputs).toEqual(['uint256', 'bool']);
  });

  it('omits name arrays entirely when the ABI names nothing', () => {
    const { functions } = parseAbiJson(JSON.stringify([{
      type: 'function', name: 'ping', inputs: [], outputs: [{ type: 'string' }],
    }]));
    expect(functions[0]).not.toHaveProperty('inputNames');
    expect(functions[0]).not.toHaveProperty('outputNames');
    expect(functions[0].outputs).toEqual(['string']);
  });

  it('keeps dynamic output types as raw text for the canvas to mark', () => {
    const { functions } = parseAbiJson(JSON.stringify([{
      type: 'function', name: 'meta', inputs: [],
      outputs: [{ type: 'bytes' }, { type: 'uint256[]' }, { type: 'tuple', components: [] }],
    }]));
    expect(functions[0].outputs).toEqual(['bytes', 'uint256[]', 'tuple']);
  });

  it('throws clear errors for malformed ABIs', () => {
    expect(() => parseAbiJson('not json')).toThrowError(/valid JSON/);
    expect(() => parseAbiJson('{"name":"x"}')).toThrowError(/JSON array/);
    expect(() => parseAbiJson('[{"type":"event","name":"E"}]')).toThrowError(/no callable functions/);
  });
});

describe('outputHeadOffsets', () => {
  it('places each static output at its head word', () => {
    expect(outputHeadOffsets(['uint256', 'bool', 'address', 'bytes4'])).toEqual([0, 32, 64, 96]);
  });

  it('gives dynamic predecessors one head slot', () => {
    // string occupies one head word (an offset); the uint after it lives at word 1.
    expect(outputHeadOffsets(['string', 'uint256'])).toEqual([0, 32]);
    expect(outputHeadOffsets(['bytes', 'bool', 'uint256[]'])).toEqual([0, 32, 64]);
  });

  it('counts static arrays as multiple head words', () => {
    expect(outputHeadOffsets(['uint256[3]', 'uint256'])).toEqual([0, 96]);
  });

  it('gives a fixed array of dynamic elements one head word', () => {
    // string[2] is itself dynamic: it is referenced by a single head pointer.
    expect(outputHeadOffsets(['string[2]', 'uint256'])).toEqual([0, 32]);
    expect(outputHeadOffsets(['string[2][3]', 'bool'])).toEqual([0, 32]);
    expect(outputHeadOffsets(['uint256[2][2]', 'address'])).toEqual([0, 128]);
  });

  it('nulls out outputs after a head width that cannot be established', () => {
    expect(outputHeadOffsets(['tuple', 'uint256'])).toEqual([null, null]);
    expect(outputHeadOffsets(['uint256', 'tuple', 'bool'])).toEqual([0, null, null]);
  });
});

describe('canonicalInputType', () => {
  it('accepts the static ABI subset', () => {
    expect(canonicalInputType('address')).toBe('address');
    expect(canonicalInputType('bool')).toBe('bool');
    expect(canonicalInputType('uint8')).toBe('uint8');
    expect(canonicalInputType('uint248')).toBe('uint248');
    expect(canonicalInputType('bytes1')).toBe('bytes1');
    expect(canonicalInputType('bytes32')).toBe('bytes32');
  });
  it('rejects everything else', () => {
    for (const bad of ['int256', 'string', 'tuple', 'uint256[3]', 'uint257', 'uint0', 'bytes33', 'bytes0', 'fixed128x18', 'function', 42]) {
      expect(canonicalInputType(bad as never)).toBeNull();
    }
  });
});

describe('isValidAddress', () => {
  it('requires 20-byte hex', () => {
    expect(isValidAddress('0x1111111111111111111111111111111111111111')).toBe(true);
    expect(isValidAddress('0x123')).toBe(false);
    expect(isValidAddress('1111111111111111111111111111111111111111')).toBe(false);
    expect(isValidAddress(undefined)).toBe(false);
  });
});
