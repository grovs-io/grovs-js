import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { Script } from 'node:vm';

/**
 * Asserts the public shape of all three build outputs.
 *
 * The IIFE build once silently dropped every named export — `GrovsError` was
 * unreachable from a script tag while the README told those users to compare
 * against it. Nothing caught that, because the unit suite tests source and
 * the E2E asserted the broken shape as expected. This checks the artifacts.
 */
const require = createRequire(import.meta.url);
const failures = [];

// major.minor, matching iOS. Derived so a bump cannot forget src/version.ts.
const { version } = require('../package.json');
const SDK_VERSION = version.split('.').slice(0, 2).join('.');

function check(label, condition, detail) {
  if (!condition) failures.push(`${label}: ${detail}`);
}

// --- CJS: standard interop shape, facade under .default ---
const cjs = require('../dist/grovs.cjs');
check('cjs', typeof cjs.default?.configure === 'function', 'default.configure missing');
check('cjs', typeof cjs.default === 'function', 'default not constructable (v1 `new Grovs(...)`)');
check('cjs', cjs.GrovsError?.authenticationFailed === 1, 'GrovsError missing');
check('cjs', cjs.SDK_VERSION === SDK_VERSION, `SDK_VERSION is not ${SDK_VERSION}`);
check('cjs', typeof cjs.GrovsV1 === 'function', 'GrovsV1 missing');

// --- ESM ---
const esm = await import('../dist/grovs.js');
check('esm', typeof esm.default?.configure === 'function', 'default.configure missing');
check('esm', typeof esm.default === 'function', 'default not constructable (v1 `new Grovs(...)`)');
check('esm', esm.GrovsError?.authenticationFailed === 1, 'GrovsError missing');
check('esm', esm.SDK_VERSION === SDK_VERSION, `SDK_VERSION is not ${SDK_VERSION}`);

// --- Declarations: each condition names the declaration file matching its
// module format. Pointing both at .d.ts made a Node16 CommonJS consumer fail
// with TS1471 while the runtime checks above passed.
const { exports: exportsMap } = require('../package.json');
const importTypes = exportsMap['.']?.import?.types;
const requireTypes = exportsMap['.']?.require?.types;
check('types', importTypes === './dist/grovs.d.ts', `import.types is ${importTypes}`);
check('types', requireTypes === './dist/grovs.d.cts', `require.types is ${requireTypes}`);
check('types', existsSync('dist/grovs.d.cts'), 'dist/grovs.d.cts missing');

// --- IIFE: one global carrying the facade *and* the named exports ---
const sandbox = {};
new Script(readFileSync('dist/grovs.global.js', 'utf8')).runInNewContext(sandbox);
const g = sandbox.Grovs;
check('iife', typeof g?.configure === 'function', 'window.Grovs.configure missing');
check('iife', typeof g === 'function', 'window.Grovs not constructable (v1 `new Grovs(...)`)');
check('iife', typeof g?.default === 'function', 'window.Grovs.default not constructable (v1 CDN shape)');
check('iife', typeof g?.V1 === 'function', 'window.Grovs.V1 missing');
check('iife', g?.GrovsError?.authenticationFailed === 1, 'window.Grovs.GrovsError missing');
check('iife', g?.SDK_VERSION === SDK_VERSION, `window.Grovs.SDK_VERSION is not ${SDK_VERSION}`);

if (failures.length > 0) {
  console.error('check-exports: FAIL');
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log('check-exports: cjs, esm and iife all expose the documented shape');
