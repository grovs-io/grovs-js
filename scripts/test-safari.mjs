// Native macOS Safari, using its bundled WebDriver. No Selenium dependency.
// All SDK traffic goes to an isolated local server; no live project is used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, beforeEach, test } from 'node:test';

const received = [];
const servers = [];
const sockets = new Set();
let failBatches = 0;
let failBatchEvent = null;
let holdBatchEvent = null;
let linkPayload = null;
let visitorNumber = 0;
let pageURL;
let apiURL;
let driverURL;
let driver;
let driverError;
let driverOutput = '';
let session;

async function listen(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function until(check, message, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  do {
    if (await check()) return;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(message);
}

async function command(method, path, body) {
  const response = await fetch(`${driverURL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(25_000),
  });
  const { value } = await response.json();
  if (!response.ok || value?.error) throw new Error(value?.message ?? `WebDriver HTTP ${response.status}`);
  return value;
}

const wd = (method, path, body) => command(method, `/session/${session}${path}`, body);

async function run(fn, ...args) {
  const result = await wd('POST', '/execute/async', {
    script: `const args = Array.from(arguments); const done = args.pop();
      Promise.resolve().then(() => (${fn.toString()})(...args)).then(
        value => done({ok: true, value: value === undefined ? null : value}),
        error => done({ok: false, message: String(error)}));`,
    args,
  });
  assert.equal(result.ok, true, result.message);
  return result.value;
}

async function configure(options = {}) {
  return run((baseURL, options) => window.Grovs.configure({
    apiKey: 'native-safari-test', baseURL, autoTrackScreenViews: false, ...options,
  }), apiURL, options);
}

const flush = () => run(() => window.Grovs.flush());
const track = (name) => run((name) => window.Grovs.track(name), name);
const events = (acceptedOnly = true) => received
  .filter((r) => r.path === '/events/batch' && (!acceptedOnly || r.status === 200))
  .flatMap((r) => r.body.events);
const named = (name, acceptedOnly = true) => events(acceptedOnly)
  .filter((e) => (e.event_name ?? e.event) === name);
const lastAuth = () => received.filter((r) => r.path === '/authenticate').at(-1);

before(async () => {
  assert.equal(process.platform, 'darwin', 'Native Safari tests require macOS. Use npm run test:e2e:browsers elsewhere.');
  const bundle = await readFile(new URL('../dist/grovs.global.js', import.meta.url));
  apiURL = await listen((req, res) => {
    // Cross-origin, so Safari must really send the CORS preflight and SDK headers.
    const headers = {
      'Access-Control-Allow-Origin': pageURL,
      'Access-Control-Allow-Headers': 'Content-Type, PLATFORM, SDK-VERSION, PROJECT-KEY, IDENTIFIER, LINKSQUARED',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, headers).end();
      return;
    }
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body;
      try { body = raw ? JSON.parse(raw) : {}; } catch { res.writeHead(400, headers).end('{}'); return; }
      const path = req.url.replace('/api/v1/sdk', '');
      let status = 200;
      let answer = {};
      if (path === '/authenticate') {
        answer = { linksquared: req.headers.linksquared || `safari-visitor-${++visitorNumber}` };
      } else if (path === '/data_for_device_and_path') {
        answer = { data: linkPayload };
      } else if (path === '/data_for_device') {
        answer = { data: null };
      } else if (path === '/notifications_to_display_automatically') {
        answer = { notifications: [] };
      } else if (path === '/events/batch') {
        // Select the event, not whichever request wins the race with a tick
        // or the immediate launch batch. Arm these before tracking it.
        if (holdBatchEvent && body.events.some((e) => e.event_name === holdBatchEvent)) {
          holdBatchEvent = null;
          status = 0;
        } else if (failBatches > 0 && body.events.some((e) => e.event_name === failBatchEvent)) {
          failBatches -= 1;
          status = 503;
        }
        answer = status === 200 ? { accepted: body.events.length, rejected: 0, errors: [] } : {};
      }
      received.push({ path, body, headers: req.headers, remoteAddress: req.socket.remoteAddress, status, answer });
      if (status !== 0) res.writeHead(status, headers).end(JSON.stringify(answer));
    });
  });
  pageURL = await listen((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.url === '/grovs.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(bundle);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(
        '<!doctype html><title>Grovs native Safari test</title><h1>Grovs Safari test</h1><script src="/grovs.js"></script>',
      );
    }
  });

  // Reserve an available port, then hand it to the driver we own.
  const reservation = http.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  driverURL = `http://127.0.0.1:${port}`;
  driver = spawn('/usr/bin/safaridriver', ['-p', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  driver.on('error', (error) => { driverError = error; });
  driver.stdout.on('data', (data) => { driverOutput += data; });
  driver.stderr.on('data', (data) => { driverOutput += data; });
  await until(async () => {
    if (driverError) throw driverError;
    if (driver.exitCode !== null) throw new Error(`safaridriver exited: ${driverOutput}`);
    try { await command('GET', '/status'); return true; } catch { return false; }
  }, 'safaridriver did not start');
  let created;
  try {
    created = await command('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'safari' } } });
  } catch (error) {
    throw new Error(`${error.message}\nEnable Safari → Settings → Developer → Allow remote automation, then rerun npm run test:safari.`);
  }
  session = created.sessionId;
  console.log(`Native Safari ${created.capabilities.browserVersion} on ${created.capabilities.platformName}`);
  await wd('POST', '/timeouts', { script: 20_000, pageLoad: 20_000 });
});

after(async () => {
  try {
    if (session) await command('DELETE', `/session/${session}`);
  } finally {
    if (driver && driver.exitCode === null) driver.kill();
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  }
});

beforeEach(async () => {
  await wd('POST', '/url', { url: pageURL });
  await run(() => {
    localStorage.clear();
    for (const cookie of document.cookie.split(';')) {
      document.cookie = `${cookie.split('=')[0].trim()}=; Max-Age=0; Path=/`;
    }
  });
  received.length = 0;
  failBatches = 0;
  failBatchEvent = null;
  holdBatchEvent = null;
  linkPayload = null;
});

test('consent prevents storage and HTTP; granting sends events queued in memory', async () => {
  assert.equal(await configure({ requireConsent: true }), false);
  await track('before_consent');
  await flush();
  await delay(300);
  assert.deepEqual(await run(() => ({ cookie: document.cookie, keys: Object.keys(localStorage) })), { cookie: '', keys: [] });
  assert.equal(received.length, 0);
  assert.equal(await run(() => window.Grovs.grantConsent()), true);
  await flush();
  // Initialization also dispatches an automatic-message lookup. Observe it
  // before reset so its late arrival is not mistaken for a new request.
  await until(() => received.some((r) => r.path === '/notifications_to_display_automatically'), 'initial message lookup did not arrive');
  assert.equal(named('before_consent').length, 1);
  await run(() => window.Grovs.reset());
  const count = received.length;
  await run(() => window.dispatchEvent(new Event('online')));
  await delay(300);
  assert.equal(received.length, count, 'reset must not reauthenticate on reconnect');
  assert.deepEqual(await run(() => ({ cookie: document.cookie, keys: Object.keys(localStorage) })), { cookie: '', keys: [] });
});

test('real HTTP carries project, origin, visitor and browser details; server sees a peer IP', async () => {
  assert.equal(await configure(), true);
  await flush();
  const auth = lastAuth();
  assert.equal(auth.headers['project-key'], 'native-safari-test');
  assert.equal(auth.headers.platform, 'web');
  assert.equal(auth.headers.origin, pageURL);
  assert.equal(auth.headers.identifier, pageURL);
  assert.ok(isIP(auth.remoteAddress), 'the server must see the connection address');
  assert.match(auth.body.user_agent, /Safari\//);
  assert.ok(auth.body.timezone);
  assert.ok(auth.body.language);
  assert.ok(auth.body.screen_width > 0 && auth.body.screen_height > 0);
  assert.equal(auth.body.ip, undefined, 'the SDK must not invent an IP in its payload');
  assert.equal(auth.headers['x-forwarded-for'], undefined);
  const batch = received.find((r) => r.path === '/events/batch');
  assert.equal(batch.headers.linksquared, auth.answer.linksquared);
  assert.equal(batch.headers['sdk-version'], auth.headers['sdk-version']);
});

async function configureWithCallback(requireConsent = false) {
  return run((baseURL, requireConsent) => {
    window.__payloads = [];
    return window.Grovs.configure({
      apiKey: 'native-safari-test', baseURL, requireConsent, autoTrackScreenViews: false,
      onDeeplink: (payload) => window.__payloads.push(payload),
    });
  }, apiURL, requireConsent);
}

test('a link delivers its payload again after refresh while its ID remains in the URL', async () => {
  linkPayload = { screen: 'product', productId: '42' };
  await wd('POST', '/url', { url: `${pageURL}/?Grovs=safari-link` });
  assert.equal(await configureWithCallback(), true);
  assert.deepEqual(await run(() => window.__payloads), [linkPayload]);
  assert.deepEqual(await run(() => window.Grovs.lastReceivedPayload()), linkPayload);
  await flush();
  const visitor = lastAuth().answer.linksquared;

  await wd('POST', '/refresh', {});
  assert.equal(await configureWithCallback(), true);
  assert.equal(lastAuth().headers.linksquared, visitor);
  assert.deepEqual(await run(() => window.__payloads), [linkPayload], 'new page must receive its own callback');
  assert.deepEqual(await run(() => window.Grovs.allReceivedPayloadsSinceStartup()), [linkPayload]);
  const lookups = received.filter((r) => r.path === '/data_for_device_and_path');
  assert.equal(lookups.length, 2);
  assert.ok(lookups.every((r) => r.body.path === 'safari-link'));

  // The stored path was consumed; removing the URL token prevents its replay.
  // The fixture returns no deferred/device payload on this direct visit.
  await run(() => history.replaceState(null, '', '/'));
  await wd('POST', '/refresh', {});
  assert.equal(await configureWithCallback(), true);
  assert.deepEqual(await run(() => window.__payloads), []);
  assert.equal(received.filter((r) => r.path === '/data_for_device_and_path').length, 2);
  assert.ok(received.some((r) => r.path === '/data_for_device'));
});

test('consent delays the payload callback and preserves a link the router removes', async () => {
  linkPayload = { screen: 'checkout', campaign: 'safari-consent' };
  await wd('POST', '/url', { url: `${pageURL}/?Grovs=consent-link` });
  assert.equal(await configureWithCallback(true), false);
  assert.equal(received.length, 0);
  assert.deepEqual(await run(() => window.__payloads), []);
  assert.equal(await run(() => localStorage.length), 0);
  await run(() => history.replaceState(null, '', '/checkout'));

  assert.equal(await run(() => window.Grovs.grantConsent()), true);
  assert.deepEqual(await run(() => window.__payloads), [linkPayload]);
  const lookups = received.filter((r) => r.path === '/data_for_device_and_path');
  assert.equal(lookups.length, 1);
  assert.equal(lookups[0].body.path, 'consent-link');
  assert.equal(await run(() => window.Grovs.grantConsent()), true);
  assert.deepEqual(await run(() => window.__payloads), [linkPayload], 'granting twice must not redeliver the callback');
});

test('launch events arrive when attribution settles, before the five-second timer', async () => {
  assert.equal(await configure(), true);
  await until(() => named('app_open').length === 1, 'launch batch waited instead of sending after attribution', 2_000);
  const launch = received.find((r) => r.path === '/events/batch' && r.body.events.some((e) => e.event === 'app_open'));
  assert.deepEqual(launch.body.events.map((e) => e.event), ['install', 'app_open']);
});

test('two successive five-second ticks deliver newly queued events', { timeout: 20_000 }, async () => {
  assert.equal(await configure(), true);
  await until(() => named('app_open').length === 1, 'initial batch did not reach server', 2_000);
  // A second cycle distinguishes the recurring interval from the one-off
  // five-second launch timer. Allow scheduling slack, but never 30 seconds.
  for (const name of ['on_interval_one', 'on_interval_two']) {
    // Wait for the previous, already-observed request's acknowledgement.
    // Otherwise its drain can correctly pick up the next event immediately.
    // No explicit flush happens after the event under test is generated.
    await flush();
    await track(name);
    assert.equal(named(name).length, 0, 'ordinary events should batch rather than send immediately');
    await until(() => named(name).length === 1, `${name} missed the five-second cadence`, 6_500);
  }
});

test('an empty queue makes no batch requests across a five-second tick', async () => {
  assert.equal(await configure(), true);
  await flush();
  const before = received.filter((r) => r.path === '/events/batch').length;
  await delay(6_000);
  assert.equal(received.filter((r) => r.path === '/events/batch').length, before);
});

test('50 queued events trigger a batch before the first timer', async () => {
  assert.equal(await configure(), true);
  await flush(); // Finish the separate launch batch before the burst.
  await run(() => {
    for (let i = 0; i < 50; i += 1) window.Grovs.track(`size_${i}`);
  });
  await until(() => events().some((e) => e.event_name?.startsWith('size_')), 'size-triggered batch did not arrive', 3_000);
  const batch = received.find((r) => r.path === '/events/batch' && r.body.events.some((e) => e.event_name === 'size_0'));
  assert.equal(batch.body.events.length, 50);
  assert.deepEqual(batch.body.events.map((e) => e.event_name), Array.from({ length: 50 }, (_, i) => `size_${i}`));
});

test('cookie eviction recovers identity from localStorage; full eviction starts fresh', async () => {
  assert.equal(await configure(), true);
  await flush();
  const original = lastAuth().answer.linksquared;
  await run(() => { document.cookie = 'linksquared=; Max-Age=0; Path=/'; });
  await wd('POST', '/refresh', {});
  assert.equal(await configure(), true);
  await flush();
  assert.equal(lastAuth().headers.linksquared, original);
  assert.ok((await run(() => document.cookie)).includes(original));
  await run(() => {
    window.Grovs.setEnabled(false);
    localStorage.clear();
    document.cookie = 'linksquared=; Max-Age=0; Path=/';
  });
  const start = received.length;
  await wd('POST', '/refresh', {});
  assert.equal(await configure(), true);
  await flush();
  assert.equal(lastAuth().headers.linksquared, undefined);
  assert.notEqual(lastAuth().answer.linksquared, original);
  assert.ok(received.slice(start).some((r) => r.body.events?.some((e) => e.event === 'install')));
});

test('refused storage writes still allow in-memory tracking with a stable session', async () => {
  await run(() => {
    Storage.prototype.setItem = () => { throw new DOMException('Test storage refusal', 'QuotaExceededError'); };
  });
  assert.equal(await configure(), true);
  await track('memory_one');
  await track('memory_two');
  await flush();
  assert.equal(named('memory_one').length, 1);
  assert.equal(named('memory_two').length, 1);
  assert.ok(named('memory_one')[0].session_id);
  assert.equal(named('memory_one')[0].session_id, named('memory_two')[0].session_id);
});

test('503 retries recover and only acknowledged events are removed', async () => {
  assert.equal(await configure(), true);
  failBatches = 2;
  failBatchEvent = 'retry_safari';
  await track('retry_safari');
  await flush();
  assert.equal(named('retry_safari', false).length, 3);
  assert.equal(named('retry_safari').length, 1);
  const attempts = named('retry_safari', false);
  assert.deepEqual(attempts[0], attempts[1]);
  assert.deepEqual(attempts[1], attempts[2]);
});

test('a received but unacknowledged event replays unchanged after an actual reload', async () => {
  assert.equal(await configure(), true);
  holdBatchEvent = 'unacknowledged_safari';
  await track('unacknowledged_safari');
  await run(() => { void window.Grovs.flush(); });
  await until(() => named('unacknowledged_safari', false).length > 0, 'original request never arrived');
  const original = named('unacknowledged_safari', false)[0];
  assert.equal(named('unacknowledged_safari').length, 0, 'the original delivery must remain unacknowledged');
  await until(() => run(() => Object.entries(localStorage)
    .some(([key, value]) => key.startsWith('grovs_events') && value.includes('unacknowledged_safari'))), 'event never persisted');
  await wd('POST', '/refresh', {});
  assert.equal(await configure(), true);
  await flush();
  assert.equal(named('unacknowledged_safari').length, 1);
  assert.deepEqual(named('unacknowledged_safari')[0], original);
});

test('closing a real Safari tab delivers its final event and engagement to the server', async () => {
  // Keep a second automation tab open so closing the test tab does not end WebDriver.
  const original = await wd('GET', '/window');
  const spare = await wd('POST', '/window/new', { type: 'tab' });
  await wd('POST', '/window', { handle: original });
  assert.equal(await configure(), true);
  await flush();
  await run(() => {
    window.__safariHidden = false;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) window.__safariHidden = true;
    });
  });
  await delay(1500);
  assert.equal(await run(() => document.visibilityState), 'visible');
  assert.equal(await run(() => window.__safariHidden), false, 'test tab lost foreground during engagement measurement');
  await track('close_safari');
  await wd('DELETE', '/window');
  await wd('POST', '/window', { handle: spare.handle });
  await until(() => named('close_safari').length > 0, 'final event was not received after tab close');
  await delay(500);
  assert.equal(named('close_safari').length, 1);
  assert.equal(named('time_spent').length, 1);
  assert.ok(named('time_spent')[0].engagement_time >= 1);
});
