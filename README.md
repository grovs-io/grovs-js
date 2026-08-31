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
| `debugLevel` | `"error"` | `"info"`, `"warn"` or `"error"` |
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

Resolves `null` on failure; the reason arrives through `onError`. Details for a
link the SDK generated:

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

## Tracking events

```javascript
Grovs.track("purchase", { item: "sku-42", price: 19.99 }, ["checkout"]);
Grovs.trackScreenView("Checkout", { section: "payment" });
```

Custom events carry the most recently viewed screen as `screen_name`, so they
can be segmented by screen.

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
});
```

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

### Delivery

Events are queued, persisted to `localStorage`, and sent in batches of 50 —
five seconds after startup, then every 30 seconds, and on tab close. Failed
requests are attempted up to three times total, with exponential backoff and
full jitter between attempts; events
the backend rejects as permanently invalid are dropped rather than retried.
The queue holds 1,000 events and discards anything older than seven days.

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
- **Purchases require Enterprise**, as above.
- **In-app purchase logging** has no web equivalent; there is no StoreKit.
  `logCustomPurchase` covers every web payment flow.

## Development

```bash
npm test              # typecheck, lint, unit tests, coverage gate
npm run verify        # the above plus build, size budget, export shapes, E2E
npm run demo          # QA harness at http://localhost:5174/demo/
npm run test:live     # every flow against a real backend (needs a key)
```

The demo runs stubbed by default — no backend needed — and can be switched to
a real one. `npm run test:live` drives it through every flow against a live
project: create a link, arrive through it, resolve the payload, deliver events
and confirm the backend accepted them, messages, identity, purchases. See
[demo/README.md](demo/README.md).

## Further assistance

Documentation: <https://docs.grovs.io/s/docs>.
Support: [support@grovs.io](mailto:support@grovs.io).

<br />
Copyright Grovs.
