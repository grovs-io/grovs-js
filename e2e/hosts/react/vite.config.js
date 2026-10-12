import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The SDK's ESM build, as `import { Grovs } from 'grovs'` resolves it from npm.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { grovs: fileURLToPath(new URL('../../../dist/grovs.js', import.meta.url)) } },
  server: { fs: { allow: ['../../..'] } },
});
