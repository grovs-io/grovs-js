import tseslint from 'typescript-eslint';

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      // Spec A1: browser globals are reachable only through
      // core/environment.ts, resolved at call time rather than import time.
      // Without this rule the SSR target breaks the first time someone adds a
      // convenient reference.
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'Access browser globals through core/environment.ts (spec A1).' },
        { name: 'document', message: 'Access browser globals through core/environment.ts (spec A1).' },
        { name: 'localStorage', message: 'Access browser globals through core/environment.ts (spec A1).' },
        { name: 'navigator', message: 'Access browser globals through core/environment.ts (spec A1).' },
      ],
    },
  },
  {
    files: ['src/core/environment.ts'],
    rules: { 'no-restricted-globals': 'off' },
  },
  { ignores: ['dist/**', 'node_modules/**', 'public/**', 'demo/**', 'playwright-report/**'] },
);
