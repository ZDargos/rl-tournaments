import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Relative base so the build works on any GitHub Pages path (user.github.io/<repo>/) with HashRouter.
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: { alias: { '@rl/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)) } },
  build: { outDir: 'dist', sourcemap: false, target: 'es2022' },
  server: { port: 5173, strictPort: true },
});
