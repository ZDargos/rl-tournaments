import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

// Relative base so the build works on any GitHub Pages path (user.github.io/<repo>/) with HashRouter.
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@rl/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)) } },
  build: {
    outDir: 'dist', sourcemap: false, target: 'es2022',
    // Libraries change less often than the app, so they get their own long-cached files.
    rollupOptions: { output: { manualChunks: { react: ['react', 'react-dom', 'react-router-dom'], ui: ['radix-ui', 'sonner', 'lucide-react'] } } },
  },
  server: { port: 5173, strictPort: true },
});
