import { gzipSync } from 'node:zlib';
import { readFileSync, statSync } from 'node:fs';

const FILE = 'dist/grovs.global.js';
// Raised from 20 KB after six review passes added correctness the SDK needs:
// per-project storage scoping, bounded queue and sanitizer, cross-tab reset,
// bounded auth retry, and a CSP- and Trusted-Types-safe messages UI. The gate
// exists to catch bloat, not to be shaved past with shorter warning strings —
// at 20 KB it had 237 B of headroom, so the next fix would have failed CI for
// a reason unrelated to size. 24 KB restores a working margin and still
// catches anything that grows the bundle by a fifth.
//
// Raised again, to 32 KB, for in-app messages: the engine, storage, sync and
// the renderer for nine templates are about 11 KB. They ship in the one
// bundle on purpose. Loading them on demand would spare sites that never use
// in-app messages about 7 KB, at the cost of a second build output and a
// loader that script-tag installs would need too.
//
// 36 KB, not 32: the old messages UI is still in the bundle beside its
// replacement and the two together reach 32.3 KB. Lower this to 32 KB in the
// change that removes src/messages.
const BUDGET_BYTES = 36 * 1024;

try {
  statSync(FILE);
} catch {
  console.error(`size-check: ${FILE} not found. Run "npm run build" first.`);
  process.exit(1);
}

const gzipped = gzipSync(readFileSync(FILE)).length;
const pct = Math.round((gzipped / BUDGET_BYTES) * 100);
console.log(`size-check: ${FILE} is ${gzipped} B gzipped (${pct}% of ${BUDGET_BYTES} B budget)`);

if (gzipped > BUDGET_BYTES) {
  console.error(`size-check: FAIL — over budget by ${gzipped - BUDGET_BYTES} B`);
  process.exit(1);
}
