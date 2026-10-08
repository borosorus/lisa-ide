import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // The compiler Worker is instantiated on the first Compile click, and the
  // dep scanner does not crawl `new Worker(new URL(...))` graphs. Without
  // this, its imports appear mid-session and Vite answers with a full page
  // reload — the first compile never reports back. See: "new dependencies
  // optimized ... reloading" in the dev log.
  optimizeDeps: { include: ['@bosorus/lisa-evm', 'acorn'] },
  test: { environment: 'jsdom', setupFiles: ['./src/test/setup.ts'] },
});
