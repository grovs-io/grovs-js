# Changelog

## 2.0.0-alpha.1

A TypeScript rewrite bringing the JS SDK to behavioural parity with the iOS
SDK. Existing v1 code keeps working — see [MIGRATION.md](MIGRATION.md).

### Fixed

- `userIdentifier()` and `userAttributes()` returned each other's values. If
  you compensated for this, remove the workaround.
- No event of any type was ever emitted: the event queue's `addEvent()` had no
  callers, so web reported zero installs, opens and engagement time.
- The stored deep link path was deleted as a side effect of reading it, while
  three call sites read it per page load — so all but the first saw nothing.
- `createLink` reported an error when unauthenticated and then issued the
  request anyway, so one call could produce both an error and a success.
- Queued events were removed by object identity, which does not survive the
  JSON round trip a page reload performs.
- The messages modal painted its backdrop red — a debug line left in place.
- Message titles were interpolated into `innerHTML`, so a title could inject
  markup into the host page.
- Automatic message display was implemented and commented out.
- The README advertised TypeScript types that did not exist.

### Added

- System events with the iOS trigger rules and cadence, batched to
  `/events/batch` with retry, a 1,000-event cap and a 7-day staleness cutoff.
- Sessions shared across tabs, rotating after 30 minutes of combined idle.
- `track`, `trackScreenView`, `setGlobalTags`, `setScreenAliases`, and
  automatic SPA screen tracking with `screenNameProvider`.
- `linkDetails`, and the remaining seven `generateLink` parameters.
- `logCustomPurchase` (Grovs Enterprise backends only).
- `requireConsent` / `grantConsent()` / `reset()`, and `flush()`.
- Errors surface through an `onError` callback instead of `console.log`.
- ESM, CJS, IIFE and `.d.ts` builds; the package now publishes only `dist/`.
- Server-side rendering no longer throws on import.

### Changed

- `PROJECT-KEY` replaces the `PROJECT_KEY` header. No action needed — nginx
  drops underscored headers by default, so this removes a latent 403.
- The messages modal renders in a shadow root and no longer loads a
  third-party font.
- The event queue persists on a debounce rather than re-serialising itself on
  every enqueue.
