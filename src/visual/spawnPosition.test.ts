import { describe, expect, it } from 'vitest';
import { nodeSize, spawnPosition, spawnPositionInBounds } from './spawnPosition';
import { occupiedRects } from './containment';
import { addNode } from './projectState';
import { emptyProject, type VisualProject } from './model';

const SIZE = { width: 250, height: 104 };

describe('spawnPosition', () => {
  it('centers the first node on the anchor when nothing is there', () => {
    expect(spawnPosition({ anchor: { x: 400, y: 300 }, size: SIZE, occupied: [] }))
      .toEqual({ x: 275, y: 248 });
  });

  it('is deterministic', () => {
    const occupied = [{ x: 275, y: 248, ...SIZE }];
    const a = spawnPosition({ anchor: { x: 400, y: 300 }, size: SIZE, occupied });
    const b = spawnPosition({ anchor: { x: 400, y: 300 }, size: SIZE, occupied });
    expect(a).toEqual(b);
  });

  it('never returns the same occupied spot twice in a row', () => {
    const placed: { x: number; y: number }[] = [];
    for (let i = 0; i < 8; i++) {
      const next = spawnPosition({
        anchor: { x: 400, y: 300 },
        size: SIZE,
        occupied: placed.map(p => ({ x: p.x, y: p.y, ...SIZE })),
      });
      expect(placed.some(p => p.x === next.x && p.y === next.y)).toBe(false);
      placed.push(next);
    }
  });

  it('separates successive nodes by at least the node size plus a gap', () => {
    const first = spawnPosition({ anchor: { x: 400, y: 300 }, size: SIZE, occupied: [] });
    const second = spawnPosition({ anchor: { x: 400, y: 300 }, size: SIZE, occupied: [{ x: first.x, y: first.y, ...SIZE }] });
    const dx = Math.abs(second.x - first.x);
    const dy = Math.abs(second.y - first.y);
    expect(dx >= SIZE.width || dy >= SIZE.height || (dx > 0 && dy > 0)).toBe(true);
  });

  it('prefers positions inside the visible bounds', () => {
    const occupied = [{ x: 275, y: 248, ...SIZE }];
    const bounds = { x: 0, y: 0, width: 1200, height: 800 };
    const next = spawnPosition({ anchor: { x: 400, y: 300 }, size: SIZE, occupied, bounds });
    expect(next.x).toBeGreaterThanOrEqual(0);
    expect(next.y).toBeGreaterThanOrEqual(0);
    expect(next.x + SIZE.width).toBeLessThanOrEqual(1200);
  });

  it('falls back to outside-the-viewport positions when every visible slot is taken', () => {
    const occupied = [];
    for (let x = -1000; x < 2200; x += 300) {
      for (let y = -1000; y < 1800; y += 150) occupied.push({ x, y, ...SIZE });
    }
    const next = spawnPosition({ anchor: { x: 400, y: 300 }, size: SIZE, occupied, bounds: { x: 0, y: 0, width: 800, height: 600 } });
    expect(occupied.some(r => r.x === next.x && r.y === next.y)).toBe(false);
  });

  it('derives occupancy from the project, not the screen', () => {
    let project = emptyProject();
    project = addNode(project, { id: 'lit1', kind: 'literal', literalType: 'uint', literal: '1' }, { x: 100, y: 100 });
    project = addNode(project, { id: 'ctx1', kind: 'context', name: 'SELF' }, { x: 700, y: 40 });
    const rects = occupiedRects(project);
    expect(rects).toHaveLength(2);
    expect(rects[0]).toMatchObject({ x: 100, y: 100 });
    const next = spawnPosition({ anchor: { x: 190, y: 132 }, size: { width: 180, height: 64 }, occupied: rects });
    expect(next).not.toEqual({ x: 100, y: 100 });
  });
});

describe('nodeSize estimation', () => {
  const ADDRESS = '0x1111111111111111111111111111111111111111';
  const wide: VisualProject = {
    ...emptyProject(),
    contracts: [{
      id: 'c1', name: 'Vault', address: ADDRESS,
      functions: [
        { signature: 'f()', name: 'f', inputs: [], outputs: [], mutability: 'view' },
        { signature: 'multi(address,uint256,bool)', name: 'multi', inputs: ['address', 'uint256', 'bool'], outputs: ['uint256', 'bool'], mutability: 'nonpayable' },
      ],
    }],
  };

  it('grows call cards with their ABI port count', () => {
    const small = nodeSize({ id: 'a', kind: 'call', contractId: 'c1', signature: 'f()' }, wide);
    const big = nodeSize({ id: 'b', kind: 'call', contractId: 'c1', signature: 'multi(address,uint256,bool)' }, wide);
    expect(big.width).toBe(small.width);
    expect(big.height).toBeGreaterThan(small.height);
    expect(big.height).toBe(84 + 5 * 29);
  });

  it('sizes an IF from its stored frame size', () => {
    const p = { ...emptyProject(), frameSizes: { if1: { width: 900, height: 640 } } };
    expect(nodeSize({ id: 'if1', kind: 'if' }, p)).toEqual({ width: 900, height: 640 });
    expect(nodeSize({ id: 'if9', kind: 'if' }, emptyProject())).toEqual({ width: 420, height: 260 });
  });

  it('is deterministic for identical projects', () => {
    const node = { id: 'b', kind: 'call', contractId: 'c1', signature: 'multi(address,uint256,bool)' } as const;
    expect(nodeSize(node, wide)).toEqual(nodeSize(node, wide));
  });
});

describe('spawnPositionInBounds', () => {
  const SIZE = { width: 180, height: 64 };
  const BOUNDS = { x: 0, y: 0, width: 400, height: 300 };

  it('centers the first slot and stays inside', () => {
    const at = spawnPositionInBounds({ anchor: { x: 200, y: 150 }, size: SIZE, occupied: [], bounds: BOUNDS });
    expect(at).not.toBeNull();
    expect(at!.x).toBeGreaterThanOrEqual(0);
    expect(at!.y).toBeGreaterThanOrEqual(0);
    expect(at!.x + SIZE.width).toBeLessThanOrEqual(400);
    expect(at!.y + SIZE.height).toBeLessThanOrEqual(300);
  });

  it('returns null instead of an out-of-bounds fallback', () => {
    const occupied = [];
    for (let x = -200; x < 600; x += 200) {
      for (let y = -200; y < 500; y += 90) occupied.push({ x, y, ...SIZE });
    }
    expect(spawnPositionInBounds({ anchor: { x: 200, y: 150 }, size: SIZE, occupied, bounds: BOUNDS })).toBeNull();
  });

  it('sizes the new cards by the rows they render', () => {
    expect(nodeSize({ id: 'b', kind: 'balance' }, emptyProject())).toEqual({ width: 200, height: 108 });
    expect(nodeSize({ id: 'g', kind: 'guard' }, emptyProject())).toEqual({ width: 180, height: 79 });
    expect(nodeSize({ id: 'h', kind: 'keccak', data: '0x00' }, emptyProject())).toEqual({ width: 180, height: 79 });
  });
});
