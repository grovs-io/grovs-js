import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { grovs: 'src/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    treeshake: true,
    target: 'es2020',
  },
  {
    // tsup appends ".global" for the iife format, so this emits
    // dist/grovs.global.js. Naming the entry "grovs.global" would double it.
    entry: { grovs: 'src/index.ts' },
    format: ['iife'],
    globalName: 'Grovs',
    minify: true,
    sourcemap: true,
    target: 'es2020',
    // tsup's IIFE wraps the module namespace, so a bare <script> would leave
    // window.Grovs.default rather than window.Grovs and Grovs.configure would
    // be undefined. See plan Task 1 / spec T8.
    //
    // Merge rather than replace: taking `default` alone dropped every named
    // export, so a script-tag user could not reach GrovsError and had to
    // hardcode the numeric codes the README tells them not to.
    footer: { js: 'Grovs=Object.assign(Grovs.default||{},Grovs);' },
  },
]);
