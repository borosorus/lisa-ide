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
      { id: 'ret1', kind: 'return', decoder: 'uint256' },
      { id: 'if1', kind: 'if' },
      { id: 'call2', kind: 'call', contractId: 'c1', signature: 'balanceOf(address)', parent: 'if1' },
    ],
    edges: [
      { id: 'e1', from: { node: 'lit1', port: 'out' }, to: { node: 'call1', port: 'arg:0' } },
      { id: 'e2', from: { node: 'call1', port: 'result' }, to: { node: 'ret1', port: 'result' } },
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
