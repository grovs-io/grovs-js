# Migrating to Grovs JS SDK v2

v2 is a TypeScript rewrite. **Your existing v1 code keeps working** — the
constructor and every callback method are preserved as a deprecated shim.

## Read this first: two accessors now return different values

v1 assigned the authenticate response backwards
(`src/grovs_manager.js:66-67`), putting the user identifier into the
attributes slot and the attributes into the identifier slot. v2 fixes it.

| Call | v1 returned | v2 returns |
|---|---|---|
| `userIdentifier()` | the user **attributes** | the user identifier |
| `userAttributes()` | the user **identifier** | the user attributes |

If you noticed this and compensated — reading `userAttributes()` when you
wanted the identifier — **remove that workaround**. Your code will still
compile and run after upgrading; it will simply return the wrong value.

This is the only v1 behavior deliberately not preserved.

## Upgrading

```bash
npm install grovs@^2.0.0
```

### Your v1 code, unchanged

```javascript
import Grovs from 'grovs';

const sdk = new Grovs(apiKey, false, (data) => console.log(data));
await sdk.start();
```

Constructing the default export returns the deprecated v1 surface, so
existing npm and CDN (`new Grovs.default(...)`) integrations keep working
without edits. The same class is also reachable explicitly as `Grovs.V1`.

The constructor and the static `Grovs.configure()` API are eras, not
alternatives: each builds its own client, so using both on one page runs
sessions, launch events and timers twice. Pick one — the SDK warns if it
sees both.

Each deprecated method logs one warning naming its replacement. The shim is
removed in 3.0.

### The v2 API

```javascript
import Grovs from 'grovs';

await Grovs.configure({
  apiKey: 'your-key',
  testEnvironment: false,
  onDeeplink: (payload) => console.log('deep link', payload),
  onError: (code, message) => console.error('grovs error', code, message),
});

const link = await Grovs.generateLink({
  title: 'Sample',
  subtitle: 'Subtitle',
  imageURL: 'https://example.com/image.jpg',
  data: { foo: 'bar' },
});
```

## Method mapping

| v1 | v2 |
|---|---|
| `new Grovs(key, testEnv, cb)` + `.start()` | `Grovs.configure({ apiKey, testEnvironment, onDeeplink })` |
| `createLink(t, s, i, d, ok, err)` | `generateLink({ title, subtitle, imageURL, data })` → Promise |
| `setUserIdentifier`, `setUserAttributes` | same signature, **corrected values** |
| `userIdentifier()`, `userAttributes()` | same signature, **corrected values** |
| `authenticated()` | `isAuthenticated()` |
| `getAllReceivedData()` | `allReceivedPayloadsSinceStartup()` |
| `showMessagesList()` | unchanged |
| `getMessages(page, ok, err)` | `getMessages(page)` → Promise |
| `getNumberOfUnreadMessages(ok, err)` | `numberOfUnreadMessages()` → Promise |
| `markMessageAsRead(msg, ok, err)` | `markMessageAsRead(id)` → Promise |

## What else changed in 2.0.0

- **Errors reach your code.** Pass `onError` to `configure()`. Every failure in
  v1 was a bare `console.log`, so a broken install was undetectable.
- **TypeScript types ship with the package.** The README badge claimed this
  before; now it is true.
- **The package publishes only `dist/`.** v1 shipped `src/`, `public/`, and
  `webpack.config.js` to every consumer.
- **A `<script>` tag build exists** at `dist/grovs.global.js`, exposing
  `window.Grovs`.
- **`PROJECT-KEY` replaces `PROJECT_KEY`** on the wire. No action needed; nginx
  drops underscored headers under its default configuration, so this removes a
  latent 403.
- **Importing during server rendering no longer throws.** Call `configure()` on
  the client; a server-side call logs once and reports through `onError`.
- **Optional `cookieDomain`.** v1 wrote a host-only cookie. Set `cookieDomain`
  if you need identity to span subdomains.
- **The messages modal no longer paints its backdrop red**, and message titles
  are rendered as text rather than interpolated into HTML.

## New in v2

Everything below is additive; none of it requires changing existing code.

```javascript
// Analytics
Grovs.track('purchase', { sku: 'x-1', price: 19.99 }, ['checkout']);
Grovs.trackScreenView('Checkout', { section: 'payment' });
Grovs.setGlobalTags(['beta']);
Grovs.setScreenAliases({ '/product/:id': 'Product' });

// Screen tracking is automatic for SPA route changes. To override:
Grovs.screenNameProvider = (url) =>
  url.pathname.startsWith('/legal') ? 'suppress' : 'automatic';

// Links
await Grovs.linkDetails('abc123');

// Commerce (Grovs Enterprise backends only)
await Grovs.logCustomPurchase({
  type: 'buy', priceInCents: 1999, currency: 'USD', productID: 'sku-1',
});

// Consent
await Grovs.configure({ apiKey, requireConsent: true });
await Grovs.grantConsent();  // after your banner is accepted
Grovs.reset();               // clears identifiers, session and queue

await Grovs.flush();         // drain before a hard navigation
```

### Events now actually fire

v1 shipped an event queue whose `addEvent()` had no callers, so web reported
zero installs, opens and engagement time. v2 emits the full set:
`install`/`reinstall`, `app_open`, `time_spent`, `reactivation`, plus your
custom events.

**Expect a step change in your dashboards on the day you upgrade.** The
series was flat zero before; it will not be afterwards. That is the defect
being fixed, but it looks like an anomaly if nobody was told.

### Two limitations worth knowing

- **Safari identity.** The visitor identifier is written to both a cookie and
  localStorage, because Safari's ITP clamps script-written cookies to 7 days
  regardless of the expiry requested. That covers visitors who return within
  the window; ITP can still evict script-writable storage for genuinely
  dormant ones, so Safari install counts carry a small known over-count.
- **Purchases need Enterprise.** `logCustomPurchase` calls an endpoint that
  only exists when the backend runs with `GROVS_EE=true`. On a standard
  deployment it reports `eventDispatchFailed` naming the requirement rather
  than retrying.
