<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://s3.eu-north-1.amazonaws.com/grovs.io/full-white.svg">
    <img src="https://s3.eu-north-1.amazonaws.com/grovs.io/full-black.svg" width="120" alt="Grovs">
  </picture>
</p>
<p align="center">
  <a href="#"><img src="https://img.shields.io/badge/types-included-4F46E5?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript"/></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/grovs-io/grovs-js?style=flat-square&color=4F46E5" alt="MIT License"/></a>
  <a href="https://github.com/grovs-io/grovs-js/stargazers"><img src="https://img.shields.io/github/stars/grovs-io/grovs-js?style=flat-square&color=4F46E5" alt="GitHub stars"/></a>
</p>

## Overview

Grovs is a JavaScript SDK for deep linking, attribution and in-app messaging on
the web. It generates dynamic links, resolves deferred deep links, tracks
analytics events, and displays messages from the Grovs console.

Works in bundled browser apps, SSR frameworks (Next.js, Nuxt), Electron, and
from a plain `<script>` tag. Written in TypeScript, ships its own types, and
has no runtime dependencies.

## Installation

```bash
npm install grovs --save
```

```javascript
import Grovs from "grovs";
```

### Script tag

The IIFE build at `dist/grovs.global.js` exposes `window.Grovs`. Serve it from
your own origin alongside your other assets:

```html
<script src="/assets/grovs.global.js"></script>
<script>
  Grovs.configure({ apiKey: "your-api-key" });
</script>
```

Loading it from a public CDN works too, but pin an exact version and add a
Subresource Integrity hash — a `@2` range resolves to a different file on every
patch release, which defeats SRI and leaves you executing whatever the CDN
serves. The published release notes carry the `integrity` value for each
version.

### CommonJS

`import` is the primary path. From `require`, the facade is the default
export and the named exports sit alongside it:

```javascript
const { default: Grovs, GrovsError } = require("grovs");
await Grovs.configure({ apiKey: "your-api-key" });
```

### TypeScript

Types ship with the package; no `@types/grovs` is needed.

### Upgrading from v1

Your existing v1 code keeps working. Two accessors return corrected values —
see [MIGRATION.md](MIGRATION.md) before upgrading.

## Configuration

Call `configure()` once, as early as you can. It resolves `true` when the SDK
authenticated successfully.

```javascript
await Grovs.configure({
  apiKey: "your-api-key",
  testEnvironment: false,
  onDeeplink: (payload) => {
    // The app was opened from a Grovs link.
    console.log("deep link payload", payload);
  },
  onError: (code, message) => {
    console.error("grovs error", code, message);
  },
});
```

| Option | Default | Purpose |
|---|---|---|
| `apiKey` | required | From the console at [app.grovs.io](https://app.grovs.io) |
| `testEnvironment` | `false` | Routes to the test environment |
| `baseURL` | Grovs cloud | Custom API domain for self-hosted backends |
| `autoTrackScreenViews` | `true` | Fires screen views on SPA route changes |
| `cookieDomain` | host-only | Set to span subdomains, e.g. `.example.com` |
| `requireConsent` | `false` | Store and send nothing until `grantConsent()` |
| `appVersion` | SDK version | Your app's version, reported with the device fingerprint |
| `debugLevel` | `"error"` | `"info"`, `"warn"` or `"error"` |
| `messagesTheme` | built-in | Styling for the messages UI — see [Styling the messages UI](#styling-the-messages-ui) |
| `onDeeplink` | — | Called with the payload when opened from a link |
| `onError` | — | Called on every SDK failure |

> **Server-side rendering.** Importing the SDK during SSR is safe. Calling
> `configure()` on the server is a no-op that logs once and reports through
> `onError` — call it on the client instead.

### Linked domains

The SDK sends its origin (`https://app.example.com`) as an identifier, and the
backend compares it **exactly** against the linked domains configured for your
project. A mismatch fails with "This Web app is not configured". If that
happens, the error message contains the exact string the SDK sent — copy it
into the console.

## Deep links

Deep link handling needs no integration beyond `onDeeplink`. The SDK reads the
link parameter from the URL, resolves the payload, and calls you back.

```javascript
await Grovs.configure({
  apiKey: "your-api-key",
  onDeeplink: (payload) => router.push(payload.screen),
});

// Or read them later:
Grovs.lastReceivedPayload();
Grovs.allReceivedPayloadsSinceStartup();
```

The callback runs when a lookup returns a payload object; a missing payload
does not trigger it. With `requireConsent: true`, the lookup and callback wait
for `grantConsent()`, while the URL's link token is captured in memory first.

Refreshing with `?Grovs=...` (or the legacy `?linksquared=...`) still in the URL
resolves that link again and delivers its payload to the new page again. The
SDK consumes the stored token after a successful lookup but leaves the URL
unchanged. If your app handles a link only once, remove its query parameter
after handling it and guard any action that must not repeat. Without a URL
token, the backend can still return a payload through deferred matching.

## Generating links

```javascript
const url = await Grovs.generateLink({
  title: "Link title",
  subtitle: "Link subtitle",
  imageURL: "https://example.com/image.jpg",
  data: { screen: "product", id: 42 },
  tags: ["launch"],
  showPreviewiOS: false,
  showPreviewAndroid: true,
  copyToClipboardiOS: false,
  copyToClipboardAndroid: true,
  customRedirects: {
    ios: { link: "https://apps.apple.com/...", openAppIfInstalled: true },
    android: { link: "https://play.google.com/..." },
    desktop: { link: "https://example.com" },
  },
  trackingCampaign: "BlackFriday2025",
  trackingSource: "instagram",
  trackingMedium: "social",
});
```

Resolves `null` on failure; the reason arrives through `onError`.

`copyToClipboardiOS` / `copyToClipboardAndroid` ask the Grovs-hosted preview page
to copy the link to the clipboard, so a fresh mobile install can be matched back
to it by the native SDK. Omit them and the link inherits the project default —
passing `false` is an explicit override, not the same thing. They only take
effect where the preview page is shown for that platform (`showPreviewiOS` /
`showPreviewAndroid`), and there is no combined `copyToClipboard` shorthand;
the toggles are per-platform by design. The web SDK never reads the clipboard
itself: the copy happens on the preview page and the read-back happens in the
iOS and Android SDKs after install.

Details for a link the SDK generated:

```javascript
const details = await Grovs.linkDetails("abc123");
```

## Identifying users

```javascript
Grovs.setUserIdentifier("user-42");
Grovs.setUserAttributes({ plan: "pro", seats: 5 });

Grovs.userIdentifier;  // "user-42"
Grovs.userAttributes;  // { plan: "pro", seats: 5 }
```

Both are safe to call before `configure()` resolves. Whichever you set locally
wins; the other is adopted from the server if it has one.

`Grovs.isAuthenticated()` reports whether the SDK has authenticated. It is
`false` before `configure()` resolves, after `reset()`, and while a transient
failure is being retried.

## Tracking events

```javascript
Grovs.track("purchase", { item: "sku-42", price: 19.99 }, ["checkout"]);
Grovs.trackScreenView("Checkout", { section: "payment" });
```

Custom events carry the most recently viewed screen as `screen_name`, so they
can be segmented by screen. Screen names are capped at 255 characters.

**Event names** must be non-empty and must not be a reserved system name
(`install`, `reinstall`, `app_open`, `view`, `open`, `time_spent`,
`reactivation`, `user_referred`). Use `trackScreenView()` for screen views.

**Property values** may be strings, numbers, booleans, `null`, or nested
arrays and objects of those. `Date`, `URL` and `BigInt` are coerced to
strings. Values that cannot be represented in JSON — `NaN`, `Infinity`,
functions, symbols, circular references — are dropped for that key only; the
rest are still sent. If the encoded properties exceed 8 KB (measured as UTF-8
bytes, as the backend measures them) they are all dropped and the event is
still recorded. Tags are capped at 20 per event, each 255 characters.

### Screen tracking

With `autoTrackScreenViews` enabled (the default), SPA route changes fire
screen views automatically — `pushState`, `replaceState`, `popstate` and
`hashchange` are all observed. The screen name resolves in priority order:
`screenNameProvider`, then the alias map, then `document.title`, then the
pathname.

Name resolution is deferred one animation frame, so `document.title` is the
page the user is on rather than the one they left. If your framework commits
its render later than that, name the screen explicitly:

```javascript
Grovs.screenNameProvider = (url) => {
  if (url.pathname.startsWith("/legal")) return "suppress";
  if (url.pathname.startsWith("/product/")) return "Product";
  return "automatic";
};
```

URLs are high-cardinality, so collapse them with alias patterns — otherwise a
catalogue of any size produces one dashboard row per id:

```javascript
Grovs.setScreenAliases({
  "/product/:id": "Product",
  "/docs/*": "Documentation",
  "/checkout": "Checkout",
});
```

When several patterns match, the more specific one wins regardless of order:
more literal text first, then `:param` over `*`. A bare `*` is a catch-all
that every other pattern beats.

Global tags attach to every event until cleared:

```javascript
Grovs.setGlobalTags(["beta"]);
Grovs.setGlobalTags(null);
```

### Flushing

Events batch automatically and flush on tab close. To drain the queue before a
hard navigation:

```javascript
await Grovs.flush();
```

## Messages

```javascript
await Grovs.showMessagesList();
const unread = await Grovs.numberOfUnreadMessages();
const messages = await Grovs.getMessages(1);
await Grovs.markMessageAsRead(messages[0].id);
```

Messages flagged for automatic display in the console open on their own; call
`Grovs.displayAutomaticMessages()` to trigger the check yourself. The messages
UI renders inside a shadow root, so it neither inherits your CSS nor leaks its
own.

### Styling the messages UI

The built-in list and detail views take a theme, from JavaScript or from CSS:

```ts
Grovs.configure({
  apiKey: '…',
  messagesTheme: {
    mode: 'auto',            // 'light' | 'dark' | 'auto'
    position: 'center',      // or 'right' for a side sheet
    title: 'Inbox',          // list header text (localization hook)
    accentColor: '#e91e63',
    borderRadius: '12px',
  },
});
```

```css
/* or from CSS alone — this wins over the config object.
   Target both hosts: the list modal and the per-message detail modals. */
#Grovs-modal, .grovs-page-modal { --grovs-accent: #e91e63; --grovs-radius: 12px; }
```

Page CSS beats the config object, which beats the built-in defaults — set a
`--grovs-*` property on the host elements in your stylesheet to override
everything.

| Theme token | CSS property | Light default | Dark default |
| --- | --- | --- | --- |
| `accentColor` | `--grovs-accent` | `#2563eb` | `#60a5fa` |
| `backgroundColor` | `--grovs-bg` | `#ffffff` | `#1c1f24` |
| `textColor` | `--grovs-text` | `#1a1d21` | `#e7e9ec` |
| `mutedTextColor` | `--grovs-muted` | `#6b7280` | `#9aa2ad` |
| `borderRadius` | `--grovs-radius` | `12px` | `12px` |
| `fontFamily` | `--grovs-font` | system-ui stack | system-ui stack |
| `backdropColor` | `--grovs-backdrop` | `rgba(0,0,0,.45)` | `rgba(0,0,0,.6)` |
| `zIndex` | `--grovs-z` | `1000` | `1000` |

`mode: 'auto'` follows `prefers-color-scheme`. Invalid values never break the
modal: values that are not valid CSS (or that contain CSS delimiters) are
rejected at `configure()` time with a warning and the defaults hold, and an
invalid `mode`/`position` falls back with a warning.

## Purchases

```javascript
await Grovs.logCustomPurchase({
  type: "buy",              // "buy" | "cancel" | "refund" | "refund_reversed"
  priceInCents: 1999,
  currency: "USD",
  productID: "com.acme.coins.100",
  startDate: new Date(),    // optional
  transactionID: "order-8842",  // optional, but pass yours — see below
});
```

The backend deduplicates purchases on the transaction id, so passing your own
order or payment id makes the call safe to repeat: a retry after a timeout,
or a double-submitted checkout, is counted once. Omit it and the SDK mints one
per call, which covers its own network retries but cannot recognise the same
purchase sent from a later page load.

> Purchase events require a Grovs Enterprise backend (`GROVS_EE=true`). On a
> standard deployment the endpoint does not exist and this reports
> `eventDispatchFailed` naming the requirement rather than retrying.

## Consent

Tracking is on by default. To gate it behind a cookie banner:

```javascript
await Grovs.configure({ apiKey: "your-api-key", requireConsent: true });

// Nothing has been stored on the device or sent. Events tracked meanwhile are
// held in memory and delivered once consent arrives.
await Grovs.grantConsent();

// Clear identifiers, session and queued events:
Grovs.reset();
```

`reset()` returns the SDK to its pre-consent state and **stops tracking**. It
does not re-authenticate on its own, which is the point: with
`requireConsent: true` the visitor has withdrawn permission. To start again,
call `configure()` (then `grantConsent()` if you require consent).

### Delivery

Events are queued, persisted to `localStorage`, and sent in batches of 50.
The first batch goes as soon as `configure()` has authenticated and resolved
attribution, and it carries anything an earlier visit left undelivered, so a
short visit does not depend on the tab-close flush. After that they batch
every five seconds, immediately at 50 events, and again when the page is
hidden.

Failed requests are attempted up to three times, with exponential backoff and
full jitter. A `Retry-After` longer than a request will wait ends the retries
and holds the scheduled batches for the interval the server named; an
explicit `flush()` still sends.

`flush()` joins a delivery already in progress rather than starting a second
one. If that delivery is a scheduled batch and the backend throttles it,
`flush()` resolves with events still queued — it waits for the send in
flight, not for the queue to empty. Call it again, or let the next scheduled
batch carry them once the server's interval has passed. Events the backend rejects as permanently
invalid are dropped rather than retried. The queue holds 1,000 events, or one
million characters, and discards anything older than seven days.

## What the SDK collects

`configure()` authenticates and, in the same request, reports a device
fingerprint used to match deferred deep links: user agent, screen size,
timezone, language, and the WebGL vendor and renderer strings. It also reads
and writes a visitor identifier in a cookie and in `localStorage`. Tracked
events carry the event name, your properties and tags, a session id, and the
attribution path the visit arrived on.

With the default `requireConsent: false` this happens as soon as you call
`configure()`. If you need it gated behind a banner, use
[Consent](#consent) — with `requireConsent: true` nothing is written to the
device and no request leaves until `grantConsent()`.

## Errors

Every failure reaches `onError` with one of four codes, matching the iOS SDK:

| Code | Meaning |
|---|---|
| `1` `authenticationFailed` | Bad API key, unconfigured domain, or auth failure |
| `2` `networkRequestFailed` | A request failed, or the SDK was called during SSR |
| `3` `eventDispatchFailed` | Events were rejected; they stay queued unless permanently invalid |
| `4` `linkGenerationFailed` | Link generation failed |

```javascript
import Grovs, { GrovsError } from "grovs";

await Grovs.configure({
  apiKey: "your-api-key",
  onError: (code, message) => {
    if (code === GrovsError.authenticationFailed) reportToSentry(message);
  },
});
```

## Disabling the SDK

```javascript
Grovs.setEnabled(false);
Grovs.setDebugLevel("info");
```

## Known limitations

- **Safari identity.** The visitor identifier is written to both a cookie and
  localStorage, because Safari's ITP clamps script-written cookies to 7 days
  regardless of the expiry requested. That covers visitors returning within the
  window, but ITP can still evict script-writable storage for genuinely dormant
  ones — so Safari install counts carry a small known over-count.
- **Delivery is at-least-once.** The final batch is sent with `keepalive`
  when the page is hidden and stays stored until acknowledged, so a page that
  goes away before the answer sends it again from the next load. No batch is
  dropped before an acknowledgement. Events can still be discarded for the
  documented reasons below: seven days old, evicted by the queue caps, or
  never written because the browser refused storage.
  A re-send is byte-identical and carries the same `event_id`, so a backend
  that deduplicates on it counts the event once. **Grovs cloud does.** If you
  point `baseURL` at your own backend, deduplicating on `event_id` is your
  responsibility; without it, retries are counted twice.
- **One known exception to "byte-identical", across tabs.** An event is
  attributed by the page that created it, and only that page. A second tab
  sharing the queue can send a copy of that event before its own page has
  settled its attribution, and the two copies then differ in the campaign
  they carry. Grovs cloud's `event_id` covers the resolved campaign, so those
  two are not recognised as the same event and one visit can be counted twice
  under two campaigns. It needs a second tab, opened on a campaign link, while
  the first tab's attribution is still resolving. Closing it properly needs
  per-tab queue ownership, which is not in this release.
- **`configure()` resolves `false` on a transient failure** (no connection,
  timeout, 429, 5xx) while the SDK retries in the background, on `online` and
  at 30-second intervals, up to three times. Events tracked meanwhile queue.
- **Multiple tabs share one queue** without atomic ownership. A tab opened
  mid-visit may send events the first tab also sends. Those copies are
  identical and `event_id` dedup collapses them, except in the attribution
  case above. Because the shared write is read-merge-write and `localStorage`
  has no compare-and-swap, two tabs writing in the same instant can still
  lose an event that neither has delivered.
- **Stored state is per project.** The queue, session and counters are keyed
  by project (and separately for `testEnvironment`), so switching projects on
  one origin does not carry events across. The visitor identifier is shared.
- **Purchases require Enterprise**, as above.
- **In-app purchase logging** has no web equivalent; there is no StoreKit.
  `logCustomPurchase` covers every web payment flow.

## Development

```bash
npm test              # typecheck, lint, unit tests, coverage gate
npm run verify        # the above plus build, size budget, export shapes, E2E
npm run demo          # QA harness at http://localhost:5174/demo/
npm run test:live     # every flow against a real backend (needs a key)
npm run test:safari   # native installed Safari on macOS, local test server
```

The demo runs stubbed by default — no backend needed — and can be switched to
a real one. `npm run test:live` drives it through every flow against a live
project: create a link, arrive through it, resolve the payload, deliver events
and confirm the backend accepted them, messages, identity, purchases. See
[demo/README.md](demo/README.md).

The browser suite includes complete consent/message journeys, payload delivery
on refresh, responses arriving after reset, automatic messages, and sandboxed
message links opening a usable checkout window. These use controlled HTTP
responses; `e2e/delivery.spec.ts` separately checks real HTTP receipt. They run
in Chromium, WebKit and Firefox with no retries.
They start a fresh server on port 4175, separate from the demo on port 5174,
so a running dev server cannot serve a stale SDK bundle. Live tests require
`http://localhost:4175` in the project's linked domains and CORS configuration.
For concurrent local runs, set `GROVS_E2E_PORT` to a free port and give
Playwright separate output/report directories (`--output` and
`PLAYWRIGHT_HTML_OUTPUT_DIR`). Live projects must allow the overridden origin.

On a browser-test failure, `test-results/` contains a screenshot and trace;
`playwright-report/` contains the HTML report. Open it with
`npx playwright show-report`. CI uploads these folders on failure.
An explicit `npm run test:live` builds the SDK and fails if
`GROVS_LIVE_API_KEY` is missing; the normal verification suite needs no key.

`npm run test:safari` uses macOS's bundled `safaridriver` to run the built SDK
in the installed Safari. Enable **Safari → Settings → Developer → Allow remote
automation** first. It opens an isolated automation window; keep that window
in front during the tab-close test. It needs no project key and sends all SDK
traffic to a local HTTP server. Failed setup fails the command rather than
silently skipping tests.

The native Safari suite checks consent, request headers and browser details,
deep-link callbacks across refresh and delayed consent,
automatic batching, identity recovery after cookie deletion, full storage
loss, refused storage writes, retries, unchanged replay after reload, and
server receipt after a real tab close. Storage deletion/refusal is injected:
this tests recovery from eviction, not Safari's multi-day ITP eviction policy.
The IP assertion checks the local connection address; production proxy IP
forwarding must be verified against the deployed backend separately.

## Further assistance

Documentation: <https://docs.grovs.io/s/docs>.
Support: [support@grovs.io](mailto:support@grovs.io).

<br />
Copyright Grovs.
