import { describe, expect, it } from 'vitest';
import { arrangeProject } from './arrange';
import { VISUAL_EXAMPLES } from './examples';

describe('visual examples', () => {
  it('ships every example in the same stable layout as Arrange', () => {
    for (const example of VISUAL_EXAMPLES) {
      const project = example.createProject();
      const arranged = arrangeProject(project);

      expect(arranged.error, example.id).toBeUndefined();
      expect(arranged.changed, example.id).toBe(false);
    }
  });
});
