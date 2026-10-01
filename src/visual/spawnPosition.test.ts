import { describe, expect, it } from 'vitest';
import { occupiedRects, spawnPosition } from './spawnPosition';
import { addNode } from './projectState';
import { emptyProject } from './model';

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
    const rects = occupiedRects(project.nodes, project.positions);
    expect(rects).toHaveLength(2);
    expect(rects[0]).toMatchObject({ x: 100, y: 100 });
    const next = spawnPosition({ anchor: { x: 190, y: 132 }, size: { width: 180, height: 64 }, occupied: rects });
    expect(next).not.toEqual({ x: 100, y: 100 });
  });
});
