import { gzipSync } from 'node:zlib';
import { readFileSync, statSync } from 'node:fs';

const FILE = 'dist/grovs.global.js';
// Raised from 20 KB after six review passes added correctness the SDK needs:
// per-project storage scoping, bounded queue and sanitizer, cross-tab reset,
// bounded auth retry, and a CSP- and Trusted-Types-safe messages UI. The gate
// exists to catch bloat, not to be shaved past with shorter warning strings —
// at 20 KB it had 237 B of headroom, so the next fix would have failed CI for
// a reason unrelated to size.
// Raised to 27 KB for the smart banner, leaving about 1.8 KB of headroom (25.2 KB used).
const BUDGET_BYTES = 27 * 1024;

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
