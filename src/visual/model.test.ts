import { describe, expect, it } from 'vitest';
import { createId, emptyProject, type VisualProject } from './model';

describe('createId', () => {
  it('returns the first unused id with the prefix', () => {
    expect(createId([], 'n')).toBe('n1');
    expect(createId(['n1'], 'n')).toBe('n2');
    expect(createId(['n1', 'n2', 'n4'], 'n')).toBe('n3');
    expect(createId(['n2'], 'e')).toBe('e1');
  });
});

describe('emptyProject', () => {
  it('is serializable and empty', () => {
    const project: VisualProject = emptyProject();
    expect(JSON.parse(JSON.stringify(project))).toEqual({ contracts: [], nodes: [], edges: [], positions: {}, frameSizes: {} });
  });
});
