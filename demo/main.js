import Grovs from '../src/index.ts';

const logEl = document.getElementById('log');
const stAuth = document.getElementById('st-auth');
const stId = document.getElementById('st-id');
const stCount = document.getElementById('st-count');

let requestCount = 0;
/** Mirrors the console's "display automatically" setting, off by default. */
let autoDisplayEnabled = false;

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
 * The demo has no real backend, so every call is answered locally: the point
 * is to exercise the SDK's request construction and see it, not to reach a
 * server. Playwright asserts against this same log.
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
  window.__grovsRequests.push({ path, method: init.method, body: parsed, keepalive: !!init.keepalive });
  refreshState();

  const canned = stubFor(path);
  if (canned === null) return realFetch(url, init);
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
            { id: 1, title: 'Welcome', subtitle: 'Thanks for trying Grovs', read: false, access_url: 'about:blank' },
            { id: 2, title: 'Release notes', subtitle: 'v2 is out', read: true, access_url: 'about:blank' },
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
            ? [{ id: 3, title: 'Automatic', subtitle: 'Opened without being asked', read: false, access_url: 'about:blank' }]
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
  const ok = await Grovs.configure({
    apiKey: document.getElementById('apiKey').value,
    testEnvironment: true,
    debugLevel: 'info',
    requireConsent: document.getElementById('requireConsent').checked,
    onDeeplink: (payload) => log('⚑ onDeeplink', payload),
    onError: (code, message) => log(`✖ onError(${code})`, message),
  });
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

log('Ready. Press configure() to start.');
refreshState();
