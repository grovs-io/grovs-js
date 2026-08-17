import { spawn } from 'node:child_process';

/**
 * Re-runs the live suite on an interval.
 *
 * The point is drift, not regression: the unit and stub suites already cover
 * our own code, and they pass whatever the backend does, because stubs agree
 * with whatever the SDK sends. This is the only thing that notices a renamed
 * field, an endpoint that turned Enterprise-only, or a linked domain someone
 * removed from the console.
 */
const MINUTES = Number(process.env['GROVS_LIVE_INTERVAL_MINUTES'] ?? 15);

if (!process.env['GROVS_LIVE_API_KEY']) {
  console.error('live-watch: set GROVS_LIVE_API_KEY. See demo/README.md.');
  process.exit(1);
}

let consecutiveFailures = 0;

function run() {
  const startedAt = new Date().toISOString();
  const child = spawn('npx', ['playwright', 'test', '--project=live'], { stdio: 'inherit' });

  child.on('exit', (code) => {
    if (code === 0) {
      consecutiveFailures = 0;
      console.log(`\nlive-watch: pass at ${startedAt}. Next run in ${MINUTES} min.\n`);
    } else {
      consecutiveFailures += 1;
      console.error(
        `\nlive-watch: FAIL at ${startedAt} (${consecutiveFailures} in a row). ` +
          `Next run in ${MINUTES} min.\n`,
      );
    }
    setTimeout(run, MINUTES * 60_000);
  });
}

console.log(`live-watch: running the live suite every ${MINUTES} minutes. Ctrl-C to stop.`);
run();
