import { fileURLToPath } from 'node:url';

const sdk = fileURLToPath(new URL('../../../dist/grovs.js', import.meta.url));

// The SDK's ESM build, as `import { Grovs } from 'grovs'` resolves it from npm.
export default {
  experimental: { externalDir: true },
  eslint: { ignoreDuringBuilds: true },
  webpack(config) {
    config.resolve.alias.grovs = sdk;
    return config;
  },
};
