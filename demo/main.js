import Grovs from '../src/index.ts';

// The live suite (and console poking) reaches the SDK through the page.
window.Grovs = Grovs;

const logEl = document.getElementById('log');
const stAuth = document.getElementById('st-auth');
const stId = document.getElementById('st-id');
const stCount = document.getElementById('st-count');

let requestCount = 0;
/** Mirrors the console's "display automatically" setting, off by default. */
let autoDisplayEnabled = false;

const SETTINGS_KEY = 'grovs_demo_settings';

/**
 * Demo settings, kept out of the SDK's own storage keys and persisted so a
 * reload keeps them — which matters, because deferred deep link attribution
 * is only observable across a reload.
 */
function loadSettings() {
  try {
    return { live: false, baseURL: '', apiKey: 'demo-key', ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
  } catch {
    return { live: false, baseURL: '', apiKey: 'demo-key' };
  }
}

function saveSettings(next) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...loadSettings(), ...next }));
}

const settings = loadSettings();

function log(label, detail) {
  const time = new Date().toISOString().slice(11, 23);
  const body = detail === undefined ? '' : ` ${JSON.stringify(detail)}`;
  logEl.textContent += `${time}  ${label}${body}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function refreshState() {
  stAuth.textContent = String(Grovs.isAuthenticated());
  stId.textContent = String(Grovs.userIdentifier);
  stCount.textContent = String(requestCount);
}

/**
 * Wraps fetch so the panel shows what actually went over the wire.
 *
 * Two modes. Stubbed (the default) answers every call locally: no backend
 * needed, and the point is to exercise request *construction* and see it.
 * Live passes the request through to a real backend and logs the response —
 * which is the only way to catch an integration problem a stub cannot have,
 * like a linked domain that does not match or a CORS rule that is missing.
 *
 * Both modes record to window.__grovsRequests, so the Playwright suites read
 * the same log either way.
 */
const realFetch = window.fetch.bind(window);
window.fetch = async (url, init = {}) => {
  const path = String(url).replace(/^.*\/api\/v1\/sdk/, '');
  requestCount += 1;

  let parsed;
  try {
    parsed = init.body ? JSON.parse(init.body) : undefined;
  } catch {
    parsed = init.body;
  }

  log(`→ ${init.method ?? 'GET'} ${path}`, parsed);
  window.__grovsRequests = window.__grovsRequests ?? [];
  const record = { path, method: init.method, body: parsed, keepalive: !!init.keepalive };
  window.__grovsRequests.push(record);
  refreshState();

  if (settings.live) {
    const response = await realFetch(url, init);
    const text = await response.clone().text();
    record.status = response.status;
    try {
      record.response = text ? JSON.parse(text) : null;
    } catch {
      record.response = text;
    }
    log(`← ${response.status} ${path}`, record.response);
    return response;
  }

  const canned = stubFor(path);
  record.status = canned.status;
  record.response = canned.body;
  return new Response(JSON.stringify(canned.body), {
    status: canned.status,
    headers: { 'Content-Type': 'application/json' },
  });
};

function stubFor(path) {
  switch (path) {
    case '/authenticate':
      return {
        status: 200,
        body: {
          linksquared: 'demo-visitor-1',
          uri_scheme: 'demo',
          sdk_identifier: 'user-42',
          sdk_attributes: { plan: 'pro' },
          push_token: null,
        },
      };
    case '/data_for_device':
    case '/data_for_device_and_path':
      return { status: 200, body: { data: { screen: 'demo', from: 'stub' } } };
    case '/create_link':
      return { status: 200, body: { link: 'https://sqd.link/demo-abc' } };
    case '/link_details':
      return { status: 200, body: { path: 'demo-abc', title: 'Demo link' } };
    case '/events/batch':
      return { status: 200, body: { accepted: 99, rejected: 0, errors: [] } };
    case '/visitor_attributes':
      return { status: 200, body: { visitor: {} } };
    case '/screen_aliases':
      return { status: 200, body: { saved: 2 } };
    case '/notifications_for_device':
      return {
        status: 200,
        body: {
          notifications: [
            { id: 1, title: 'Welcome', subtitle: 'Thanks for trying Grovs', read: false, access_url: 'https://example.com/message' },
            { id: 2, title: 'Release notes', subtitle: 'v2 is out', read: true, access_url: 'https://example.com/message' },
          ],
        },
      };
    // Automatic display is off in the console by default, and the SDK checks
    // on every configure(). Answering with messages unconditionally would open
    // a full-screen modal on every page load — which is what the real setting
    // does, and why it is opt-in. The button below turns it on.
    case '/notifications_to_display_automatically':
      return {
        status: 200,
        body: {
          notifications: autoDisplayEnabled
            ? [{ id: 3, title: 'Automatic', subtitle: 'Opened without being asked', read: false, access_url: 'https://example.com/message' }]
            : [],
        },
      };
    case '/number_of_unread_notifications':
      return { status: 200, body: { number_of_unread_notifications: 1 } };
    case '/mark_notification_as_read':
      return { status: 200, body: {} };
    // Not mounted unless GROVS_EE=true — the demo reproduces that, so the
    // Enterprise error path is visible here rather than only in production.
    case '/add_payment_event':
      return { status: 404, body: { error: 'Not Found' } };
    default:
      return { status: 200, body: {} };
  }
}

const on = (id, fn) => document.getElementById(id).addEventListener('click', fn);

on('btn-configure', async () => {
  const baseURL = document.getElementById('baseURL').value.trim();
  const config = {
    apiKey: document.getElementById('apiKey').value,
    testEnvironment: document.getElementById('testEnvironment').checked,
    debugLevel: 'info',
    requireConsent: document.getElementById('requireConsent').checked,
    onDeeplink: (payload) => log('⚑ onDeeplink', payload),
    onError: (code, message) => log(`✖ onError(${code})`, message),
  };
  if (baseURL) config.baseURL = baseURL;

  saveSettings({ apiKey: config.apiKey, baseURL });
  const ok = await Grovs.configure(config);
  log('configure() →', ok);
  refreshState();
});

on('btn-grantConsent', async () => log('grantConsent() →', await Grovs.grantConsent()));
on('btn-reset', () => {
  Grovs.reset();
  log('reset()');
  refreshState();
});

on('btn-setIdentifier', () => {
  Grovs.setUserIdentifier(document.getElementById('identifier').value);
  log('setUserIdentifier()');
  refreshState();
});
on('btn-setAttributes', () => {
  Grovs.setUserAttributes({ plan: 'pro', seats: 5 });
  log('setUserAttributes()');
});
on('btn-readIdentity', () =>
  log('accessors →', { identifier: Grovs.userIdentifier, attributes: Grovs.userAttributes }),
);

on('btn-track', () => {
  Grovs.track('purchase', { sku: 'demo-1', price: 19.99 }, ['checkout']);
  log('track()');
});
on('btn-trackFat', () => {
  Grovs.track('fat_event', { blob: 'x'.repeat(9000) });
  log('track() with 9 KB of properties — expect the sanitizer to drop them');
});
on('btn-screen', () => {
  Grovs.trackScreenView('Manual Screen', { section: 'demo' });
  log('trackScreenView()');
});
on('btn-tags', () => {
  Grovs.setGlobalTags(['beta', 'demo']);
  log('setGlobalTags()');
});
on('btn-aliases', () => {
  Grovs.setScreenAliases({ '/product/:id': 'Product', '/checkout': 'Checkout' });
  log('setScreenAliases()');
});
on('btn-flush', async () => {
  await Grovs.flush();
  log('flush()');
});

on('btn-nav-home', () => history.pushState({}, '', '/'));
on('btn-nav-checkout', () => history.pushState({}, '', '/checkout'));
on('btn-nav-product', () => history.pushState({}, '', '/product/42'));
on('btn-back', () => history.back());

on('btn-generateLink', async () =>
  log('generateLink() →', await Grovs.generateLink({ title: 'Demo', data: { k: 'v' } })),
);
on('btn-generateLinkFull', async () =>
  log(
    'generateLink() all params →',
    await Grovs.generateLink({
      title: 'Demo',
      subtitle: 'Every parameter',
      imageURL: 'https://example.com/i.png',
      data: { k: 'v' },
      tags: ['launch'],
      customRedirects: { ios: { link: 'https://ios', openAppIfInstalled: true } },
      showPreviewiOS: false,
      showPreviewAndroid: true,
      trackingCampaign: 'BlackFriday2025',
      trackingSource: 'instagram',
      trackingMedium: 'social',
    }),
  ),
);
on('btn-linkDetails', async () => log('linkDetails() →', await Grovs.linkDetails('demo-abc')));
on('btn-payloads', () =>
  log('payloads →', {
    last: Grovs.lastReceivedPayload(),
    all: Grovs.allReceivedPayloadsSinceStartup(),
  }),
);

on('btn-showMessages', async () => {
  await Grovs.showMessagesList();
  log('showMessagesList()');
});
on('btn-unread', async () => log('numberOfUnreadMessages() →', await Grovs.numberOfUnreadMessages()));
on('btn-auto', async () => {
  autoDisplayEnabled = true;
  await Grovs.displayAutomaticMessages();
  log('displayAutomaticMessages() — console setting simulated as on');
});
on('btn-purchase', async () =>
  log(
    'logCustomPurchase() →',
    await Grovs.logCustomPurchase({
      type: 'buy',
      priceInCents: 1999,
      currency: 'USD',
      productID: 'com.acme.coins.100',
    }),
  ),
);

on('btn-enable', () => {
  Grovs.setEnabled(true);
  log('setEnabled(true)');
});
on('btn-disable', () => {
  Grovs.setEnabled(false);
  log('setEnabled(false)');
});
on('btn-clearLog', () => {
  logEl.textContent = '';
  window.__grovsRequests = [];
  requestCount = 0;
  refreshState();
});

// --- Backend mode wiring ---

const liveModeEl = document.getElementById('liveMode');
const baseURLEl = document.getElementById('baseURL');
const apiKeyEl = document.getElementById('apiKey');
const hintEl = document.getElementById('liveHint');

liveModeEl.checked = settings.live;
baseURLEl.value = settings.baseURL;
apiKeyEl.value = settings.apiKey;

function refreshHint() {
  hintEl.innerHTML = liveModeEl.checked
    ? 'Live. Requests reach the backend, and responses are logged. Two things must be true or ' +
      'authenticate answers 422: the project needs <code>' +
      window.location.origin +
      '</code> in its linked domains, and the backend must allow this origin via CORS.'
    : 'Stubbed. No backend needed — every call is answered locally so you can inspect what the ' +
      'SDK builds. Tick the box to send it for real.';
}

liveModeEl.addEventListener('change', () => {
  saveSettings({ live: liveModeEl.checked });
  refreshHint();
  log(
    liveModeEl.checked
      ? 'Live mode on — reload, then configure() to authenticate for real.'
      : 'Stub mode on — reload to clear any live state.',
  );
});
baseURLEl.addEventListener('change', () => saveSettings({ baseURL: baseURLEl.value.trim() }));
apiKeyEl.addEventListener('change', () => saveSettings({ apiKey: apiKeyEl.value }));

refreshHint();
log(`Ready (${settings.live ? 'live' : 'stubbed'}). Press configure() to start.`);
refreshState();
