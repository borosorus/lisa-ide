import { describe, expect, it } from 'vitest';
import { loadStoredProject, parseStoredProject, PROJECT_STORAGE_KEY, saveStoredProject, type StoredProject } from './storage';
import { SOURCE_STORAGE_KEY } from '../editor/sourceStorage';
import type { VisualProject } from './model';

const CONTRACT = {
  id: 'c1',
  name: 'USDC',
  address: '0x1111111111111111111111111111111111111111',
  functions: [{
    signature: 'balanceOf(address)', name: 'balanceOf',
    inputs: ['address'], outputs: ['uint256'], mutability: 'view' as const,
    inputNames: ['owner'], outputNames: ['balance'],
  }],
};

const PROJECT: StoredProject = {
  version: 1 as const,
  mode: 'visual' as const,
  codeSource: 'const p = createProgram();\nreturn p;',
  visual: {
    contracts: [CONTRACT],
    nodes: [
      { id: 'call1', kind: 'call', contractId: 'c1', signature: 'balanceOf(address)' },
      { id: 'lit1', kind: 'literal', literalType: 'address', literal: '0x1111111111111111111111111111111111111111' },
      { id: 'if1', kind: 'if' },
      { id: 'call2', kind: 'call', contractId: 'c1', signature: 'balanceOf(address)', parent: 'if1' },
    ],
    edges: [
      { id: 'e1', from: { node: 'lit1', port: 'out' }, to: { node: 'call1', port: 'arg:0' } },
      { id: 'e2', from: { node: 'call1', port: 'out:0' }, to: { node: 'call2', port: 'arg:0' } },
    ],
    positions: { call1: { x: 40, y: 80 } },
  },
};

class FakeStorage {
  private map = new Map<string, string>();
  getItem(key: string) { return this.map.has(key) ? this.map.get(key)! : null; }
  setItem(key: string, value: string) { this.map.set(key, value); }
}

describe('parseStoredProject', () => {
  it('round-trips a full visual project', () => {
    const parsed = parseStoredProject(JSON.stringify(PROJECT));
    expect(parsed.visual).toEqual(PROJECT.visual as VisualProject);
    expect(parsed.mode).toBe('visual');
  });

  it('drops invalid entries and keeps the rest of the project', () => {
    const withBadNode = parseStoredProject(JSON.stringify({
      ...PROJECT,
      visual: { ...PROJECT.visual, nodes: [{ id: 'x', kind: 'teleport' }, ...PROJECT.visual.nodes] },
    }));
    expect(withBadNode.visual.nodes.map(n => n.id)).toEqual(PROJECT.visual.nodes.map(n => n.id));
    // The dropped node's edges are gone too; the survivors are untouched.
    expect(withBadNode.visual.contracts).toEqual(PROJECT.visual.contracts);
    expect(withBadNode.codeSource).toBe(PROJECT.codeSource);

    const badContract = parseStoredProject(JSON.stringify({
      ...PROJECT, visual: { ...PROJECT.visual, contracts: [{ ...CONTRACT, address: 'nope' }] },
    }));
    expect(badContract.visual.contracts).toEqual([]);
    expect(badContract.visual.nodes).toHaveLength(PROJECT.visual.nodes.length);

    const badLiteral = parseStoredProject(JSON.stringify({
      ...PROJECT, visual: { ...PROJECT.visual, nodes: [{ id: 'lit9', kind: 'literal', literalType: 'address', literal: '0x123' }] },
    }));
    expect(badLiteral.visual.nodes).toEqual([]);
    // Edges whose endpoints were repaired away are dropped, not fatal.
    expect(badLiteral.visual.edges).toEqual([]);
  });

  it('skips invalid positions and dangling edges', () => {
    const withBadPositions = parseStoredProject(JSON.stringify({
      ...PROJECT, visual: { ...PROJECT.visual, positions: { call1: { x: 40, y: 80 }, ghost: { x: Number.NaN, y: 0 } } },
    }));
    expect(withBadPositions.visual.positions).toEqual({ call1: { x: 40, y: 80 } });

    const withDanglingEdge = parseStoredProject(JSON.stringify({
      ...PROJECT, visual: { ...PROJECT.visual, edges: [...PROJECT.visual.edges, { id: 'ez', from: { node: 'ghost', port: 'out' }, to: { node: 'call1', port: 'arg:0' } }] },
    }));
    expect(withDanglingEdge.visual.edges.map(e => e.id)).toEqual(['e1', 'e2']);
  });

  it('rejects malformed structural containers', () => {
    expect(() => parseStoredProject('nope')).toThrowError(/valid JSON/);
    expect(() => parseStoredProject('[1,2]')).toThrowError(/must be an object/);
    expect(() => parseStoredProject(JSON.stringify({ ...PROJECT, version: 2 }))).toThrowError(/version/);
    expect(() => parseStoredProject(JSON.stringify({ ...PROJECT, mode: 'draw' }))).toThrowError(/mode/);
    expect(() => parseStoredProject(JSON.stringify({ ...PROJECT, visual: {
      ...PROJECT.visual, nodes: { not: 'an array' },
    } }))).toThrowError(/nodes must be an array/);
    expect(() => parseStoredProject(JSON.stringify({ ...PROJECT, visual: {
      ...PROJECT.visual, positions: 'nope',
    } }))).toThrowError(/positions must be an object/);
  });
});

describe('legacy decoder folding', () => {
  const TWO_OUT = {
    id: 'c1',
    name: 'Vault',
    address: '0x1111111111111111111111111111111111111111',
    functions: [{
      signature: 'snapshot(address)', name: 'snapshot',
      inputs: ['address'], outputs: ['uint256', 'bytes32'], mutability: 'view' as const,
    }],
  };

  function legacy(extraNodes: unknown[], extraEdges: unknown[]): StoredProject {
    return parseStoredProject(JSON.stringify({
      version: 1, mode: 'visual', codeSource: null,
      visual: {
        contracts: [TWO_OUT],
        nodes: [
          { id: 'call1', kind: 'call', contractId: 'c1', signature: 'snapshot(address)' },
          ...extraNodes,
        ],
        edges: extraEdges,
        positions: {},
      },
    }));
  }

  it('rewires decoder consumer edges onto the matching output index', () => {
    const parsed = legacy(
      [
        { id: 'dep1', kind: 'call', contractId: 'c1', signature: 'snapshot(address)' },
        { id: 'dep2', kind: 'call', contractId: 'c1', signature: 'snapshot(address)' },
        { id: 'ret1', kind: 'return', decoder: 'uint256' },
        { id: 'ret2', kind: 'return', decoder: 'word', offset: 32 },
      ],
      [
        { id: 'ei', from: { node: 'call1', port: 'result' }, to: { node: 'ret1', port: 'result' } },
        { id: 'eo1', from: { node: 'ret1', port: 'out' }, to: { node: 'dep1', port: 'arg:0' } },
        { id: 'ei2', from: { node: 'call1', port: 'result' }, to: { node: 'ret2', port: 'result' } },
        { id: 'eo2', from: { node: 'ret2', port: 'out' }, to: { node: 'dep2', port: 'arg:0' } },
      ],
    );
    expect(parsed.visual.nodes.map(n => n.id)).toEqual(['call1', 'dep1', 'dep2']);
    expect(parsed.visual.edges).toEqual([
      { id: 'eo1', from: { node: 'call1', port: 'out:0' }, to: { node: 'dep1', port: 'arg:0' } },
      { id: 'eo2', from: { node: 'call1', port: 'out:1' }, to: { node: 'dep2', port: 'arg:0' } },
    ]);
  });

  it('maps two word-zero decoders to the same output and keeps edge ids', () => {
    const parsed = legacy(
      [
        { id: 'dep1', kind: 'call', contractId: 'c1', signature: 'snapshot(address)' },
        { id: 'dep2', kind: 'call', contractId: 'c1', signature: 'snapshot(address)' },
        { id: 'retA', kind: 'return', decoder: 'uint256' },
        { id: 'retB', kind: 'return', decoder: 'bytes32' },
      ],
      [
        { id: 'ei1', from: { node: 'call1', port: 'result' }, to: { node: 'retA', port: 'result' } },
        { id: 'eoA', from: { node: 'retA', port: 'out' }, to: { node: 'dep1', port: 'arg:0' } },
        { id: 'ei2', from: { node: 'call1', port: 'result' }, to: { node: 'retB', port: 'result' } },
        { id: 'eoB', from: { node: 'retB', port: 'out' }, to: { node: 'dep2', port: 'arg:0' } },
      ],
    );
    // uint256() and bytes32() both read word 0 -> both fold onto out:0.
    expect(parsed.visual.edges.every(e => e.from.port === 'out:0')).toBe(true);
    expect(parsed.visual.edges).toHaveLength(2);
  });

  it('drops decoders whose word position no longer exists', () => {
    const parsed = legacy(
      [
        { id: 'dep1', kind: 'call', contractId: 'c1', signature: 'snapshot(address)' },
        { id: 'retX', kind: 'return', decoder: 'word', offset: 64 },
      ],
      [
        { id: 'ei', from: { node: 'call1', port: 'result' }, to: { node: 'retX', port: 'result' } },
        { id: 'eo', from: { node: 'retX', port: 'out' }, to: { node: 'dep1', port: 'arg:0' } },
      ],
    );
    expect(parsed.visual.nodes.map(n => n.id)).toEqual(['call1', 'dep1']);
    expect(parsed.visual.edges).toEqual([]);
  });

  it('folding is idempotent (saving a folded project changes nothing)', () => {
    const withDecoders = legacy(
      [{ id: 'dep1', kind: 'call', contractId: 'c1', signature: 'snapshot(address)' }, { id: 'ret1', kind: 'return', decoder: 'uint256' }],
      [
        { id: 'ei', from: { node: 'call1', port: 'result' }, to: { node: 'ret1', port: 'result' } },
        { id: 'eo', from: { node: 'ret1', port: 'out' }, to: { node: 'dep1', port: 'arg:0' } },
      ],
    );
    const again = parseStoredProject(JSON.stringify(withDecoders));
    expect(again).toEqual(withDecoders);
  });
});

describe('loadStoredProject', () => {
  it('returns null with no saved state', () => {
    expect(loadStoredProject(new FakeStorage())).toBeNull();
  });

  it('saves and loads back', () => {
    const storage = new FakeStorage();
    saveStoredProject(PROJECT, storage);
    expect(loadStoredProject(storage)).toEqual(PROJECT);
  });

  it('migrates a legacy code-only draft', () => {
    const storage = new FakeStorage();
    storage.setItem(SOURCE_STORAGE_KEY, 'const p = createProgram();\nreturn p;');
    const loaded = loadStoredProject(storage);
    expect(loaded).toEqual({ version: 1, mode: 'code', codeSource: 'const p = createProgram();\nreturn p;', visual: { contracts: [], nodes: [], edges: [], positions: {} } });
  });

  it('recovers to null on corrupt saved state', () => {
    const storage = new FakeStorage();
    storage.setItem(PROJECT_STORAGE_KEY, '{trunc');
    expect(loadStoredProject(storage)).toBeNull();
  });

  it('never throws on storage access failures', () => {
    const storage = { getItem() { throw new Error('blocked'); } };
    expect(loadStoredProject(storage)).toBeNull();
    saveStoredProject(PROJECT, { setItem() { throw new Error('blocked'); } });
  });
});
