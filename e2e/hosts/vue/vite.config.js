import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// The SDK's ESM build, as `import { Grovs } from 'grovs'` resolves it from npm.
export default defineConfig({
  plugins: [vue()],
  resolve: { alias: { grovs: fileURLToPath(new URL('../../../dist/grovs.js', import.meta.url)) } },
  server: { fs: { allow: ['../../..'] } },
});
