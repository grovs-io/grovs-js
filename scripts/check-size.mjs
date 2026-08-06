import { gzipSync } from 'node:zlib';
import { readFileSync, statSync } from 'node:fs';

const FILE = 'dist/grovs.global.js';
const BUDGET_BYTES = 20 * 1024;

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
