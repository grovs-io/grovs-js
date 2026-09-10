# Changelog

## Unreleased

### Fixed

- `setUserAttributes()` called before `configure()` finished cleared the
  server's existing user identifier. Identifier and attributes are now
  tracked separately, and whichever was not set locally is adopted.
- Queued events, the session and the launch counters are now stored per
  project (and per `testEnvironment`), so a second project configured on the
  same origin no longer sends the first one's queue. From state written under
  the old unscoped keys, only the launch counters are carried over (so a
  returning visitor is not reported as a reinstall); an unsent legacy queue
  has no known owner and is dropped rather than sent under the current project.
- `reset()` also clears durable state the current client never opened: a
  previous visit's identifier and queue while consent is pending, and legacy
  unscoped keys. It no longer skips that cleanup when storage writes are
  refused.
- The final batch of a session is now sent with `keepalive` from the
  `visibilitychange` handler instead of `pagehide`. Every engine fires
  `pagehide` first and the hide right after; Firefox discards requests
  issued from `pagehide`, so it lost the batch on every tab close, while
  Chromium and WebKit delivered it twice. Verified against a real HTTP
  server in all three engines: delivered once, through a real tab close.
  Events stay stored until acknowledged; a page gone before the answer sends
  them again from the next load, and the backend deduplicates on `event_id`.
  The exit flush skips events the ordinary drain already has in flight, and
  reports per-event rejections like the ordinary path does. `await flush()`
  now waits for keepalive requests.
- A reset in another tab now stops this tab sending as the erased visitor.
  It is honoured from construction to disposal (mid-authentication, disabled,
  or retrying), closes the message list including the one the deprecated v1
  surface owns, and does not wipe a visitor who authenticated after the reset
  when the event arrives late. `dispose()` invalidates queued identity and
  alias updates.
- Events queued while offline are flushed when the browser reports it is
  back online, instead of waiting for the next tick.
- The first batch of a visit now leaves as soon as `configure()` has
  authenticated and resolved attribution, carrying the launch events and
  anything an earlier visit never delivered. Every flush before attribution
  settled returned without sending and nothing re-triggered one, so the
  opening batch waited out a full interval and a short visit depended on the
  tab-close flush surviving termination.
- The batch interval is five seconds rather than thirty, matching where the
  comparable web SDKs sit. A web visit is often shorter than the old window.
  An idle page still sends nothing: a tick with an empty queue makes no
  request.
- A full queue against a failing backend no longer sends a request per
  tracked event; after a failed batch, size-triggered flushes wait for the
  next 30-second tick.
- Authentication that fails on a network error, timeout, 429 or 5xx is
  retried when the browser comes back online and on a 30-second timer, up to
  three times. `onError` fires for the first failure and the last retry.
- Property sanitization stops after 10,000 values, so a small object graph
  with shared references cannot hold the page's main thread.
- Tags are bounded (20 per event, 255 characters each) when queued, not only
  when sent, and string caps no longer split a surrogate pair.
- The messages UI works under a strict `style-src` policy and under Trusted
  Types; it defers rendering until `<body>` exists when `configure()` runs in
  `<head>`; and it stops trapping Tab if the host page detaches a modal. The
  `style-src` support adopts a constructed stylesheet, which needs Safari
  16.4+ or Firefox 101+; older engines fall back to a `<style>` element that
  a strict policy still blocks.
- The event queue is bounded to one million characters of serialized events
  as well as 1,000 entries, enforced when the snapshot is written; the oldest
  are evicted and reported through the debug log.
- A malformed `linksquared` cookie no longer throws during `configure()`.
- `setEnabled(false)` now also blocks `setScreenAliases()` and the messages
  UI, list and detail alike. An alias sync that fails, or is overtaken by a
  newer map, is retried on the next `configure()` or re-enable.
- Screen names are capped at 255 characters, so an oversized name can no
  longer push every later custom event over the 8 KB property limit.
- `generateLink()` resolves `null` and reports `linkGenerationFailed` when
  `data` cannot be serialized, instead of rejecting.
- CommonJS TypeScript consumers now get `grovs.d.cts` from the `require`
  condition, fixing TS1471 under Node16 module resolution.
- Malformed entries in a messages response are skipped instead of crashing
  the list; automatic-display failures report through `onError`.
- The messages modals move focus in on open, keep Tab inside the topmost
  modal (including on the way out of the message iframe), and restore focus
  on close.
- `setGlobalTags()` now applies to system events such as `time_spent`, as
  documented.
- `reset()` clears the current screen context.
- Alias precedence no longer depends on insertion order: the pattern with
  more literal text wins, and among equals `:param` beats `*`. A bare `*`
  catch-all therefore loses to every route pattern. A pattern with more than
  two `*` wildcards is now ignored with a warning: matching cost grows
  sharply past that, and five could freeze the page for a minute on a long
  URL. Use `:name` for the inner segments.
- Granting consent in one tab could delete another tab's whole queue. Events
  adopted from a sibling's stored queue and then dropped for the size cap were
  tombstoned, and a tombstone permanently suppresses an id on every later
  write — so the sibling's events were stripped from storage for good. Only
  events this tab actually delivered are tombstoned now.
- Purchases carry a transaction id. The backend deduplicates on it and mints
  a fresh one server-side when it is blank, so a retried purchase was billed
  twice. `logCustomPurchase()` takes an optional `transactionID` — pass your
  order id to make the call safe to repeat — and mints one per call otherwise.
  An invalid `startDate` now reports through `onError` instead of rejecting.
- A second `configure()` on the same page no longer emits a second `app_open`
  or advances the open counter twice. The launch events belong to the page
  load and to the project, which is what React strict mode double-invokes;
  a different project or environment configured on the same page still emits
  its own.
- `reset()` is terminal until you configure again: coming back online no
  longer restarts authentication behind it.
- Two copies of the SDK on one page (a CDN script tag beside an npm install)
  no longer leave SPA screen tracking permanently blind. The History patch
  marker was shared between copies but its ownership was not, so the second
  copy never saw a navigation and stayed blind once the first stopped.
  Ownership now lives in the same shared registry as the marker, the most
  recently started tracker owns the patch, and a displaced one goes quiet
  instead of uninstalling a patch someone else is using.
- A visitor identifier cookie that a v1 host-only cookie was shadowing is now
  repaired rather than silently left stale: the write is verified, and both
  scopes are cleared and rewritten when it fails.
- A stylesheet that fails to parse is no longer cached, which left every
  later message modal rendering unstyled.
- An unanswered keepalive request no longer turns every later `track()` into
  a request of its own. The batch threshold counts what is sendable, not what
  is queued, and the queue counts the events already on the wire.
- `Retry-After` is honoured throughout. A delay longer than a request will
  wait ends the retries rather than sleeping the cap and trying again, the
  scheduled 30-second drain waits the delay out, and a failed drain can no
  longer shorten a longer delay the server named. An explicit `flush()` is
  still a deliberate drain and sends. The cooldown clears on success.
- A request body that cannot be serialized fails immediately instead of
  burning three attempts and a second of backoff on a deterministic error.
- Session identity survives a store that starts refusing writes. It was
  minting a new id on every read, so consecutive events landed in different
  sessions and `time_spent` was attributed to none of them.
- The deep-link parameter is bounded and an empty one no longer erases a real
  capture, so a crafted link cannot exhaust the origin's storage quota during
  `configure()`.
- `displayAutomaticMessages()` shows at most five messages, instead of one
  modal, one remote iframe and one mark-as-read request per record returned.
- An unrecognised `debugLevel` falls back to `error` instead of silencing
  every line including errors.
- `generateLink()` and `linkDetails()` report through `onError` when a reset
  ends the request, like every other failure path in them, and the
  serialization guard now covers a non-enumerable `data` property.
- The transport no longer rejects when a caller's payload cannot be
  serialized; it answers with status 0 like every other failure, as its
  contract says.
- A rejected screen-alias sync no longer stops every later sync on that page.
- The reconnect flush survives an authentication retry: the `online` listener
  was added in one place and removed in two, so a recovered retry left it
  detached.
- `generateLink()` and `linkDetails()` resolve `null` when a `reset()` lands
  while the request is in flight, instead of returning the previous visitor's
  result.
- A host framework detaching the message list no longer closes the detail
  modals stacked above it, or pulls focus out of the page on the next keypress.
- A link out of a message opens a working page: the iframe sandbox now allows
  popups to escape it, so a login or checkout destination is no longer given
  an opaque origin where storage access throws.
- An event is attributed only by the page that created it. A sibling tab
  shares the storage and the session, so it could adopt an unsettled event
  from the queue and stamp its own campaign on it; both tabs then sent the
  same `event_id` with different bodies, and the backend's hash covers the
  resolved link, so they landed as two events under two campaigns.
- A drain in progress stops when a `reset()` withdraws permission to send,
  instead of continuing into the next visitor's queue and sending their
  events before their attribution had resolved.
- An authentication retry waits out a `Retry-After` the server named rather
  than trying again after thirty seconds, and coming back online no longer
  cancels that wait. A dead connection is still retried immediately on
  reconnect; only a delay the server asked for holds.
- `reset()` clears every project's queue on the origin, not just the
  configured one. The visitor identifier is shared across projects, so a
  queue left behind was re-sent under whatever identity the next
  `configure()` minted.
- The set tracking events awaiting attribution is bounded like the queue it
  follows, instead of growing for as long as consent stays pending.
- Disabling one copy of the SDK never uninstalls another copy's History
  patch, or the wrappers other libraries have chained on top of it. The
  installed patch and the functions it displaced are held together in shared
  state, and only that exact pair is ever put back.
- Two copies of the SDK on one page no longer lose SPA tracking after a
  disable and re-enable cycle. A tracker trusted its own record of having
  installed the History patch, so once the other copy restored the originals
  it held ownership of a patch that was no longer there and reported nothing
  for the rest of the page's life. It now reconciles against the real state,
  telling a patch another library wrapped from one that has been removed.
- A delay named by the server stops a drain that is already running, checked
  before every batch rather than only when one is scheduled. A queue larger
  than one batch kept sending through a `Retry-After` that answered a
  concurrent keepalive request. An explicit `flush()` still drains through,
  which is what "drain the queue now" means; the SDK's own schedule yields.
- A delay named by the server is tracked separately from the SDK's own
  failure backoff. An ordinary batch and a keepalive batch are in flight
  together whenever a page is hidden mid-drain, and either answer could
  arrive first — so a success was retiring a `Retry-After` that a different
  request had just been given.
- A reset notification from another tab is ignored when it names an identity
  this client no longer holds. A background tab could be handed one minutes
  late and stop tracking a visitor who had already replaced the erased one.
- A session held in memory because storage refused writes is only written
  back over the value it replaced. A sibling that started a session in the
  meantime keeps it, and this tab joins that one.
- A session rotated while storage refused writes is written back once the
  store recovers, so a sibling tab does not read the id this tab replaced.
- A screen view deferred to an animation frame is dropped if another copy of
  the SDK takes the History patch over before that frame runs.
- A session rotated while storage refuses writes stays rotated. The stale
  stored id was read back in preference to the new one, so the rotation
  repeated on every read.
- Back and fragment navigation are reported once when two copies of the SDK
  are loaded. Ownership governed the patched History methods, but each copy
  kept its own `popstate` and `hashchange` listeners.
- An event's attribution is frozen once it could have been transmitted. A
  campaign opened later in the same session no longer back-fills its path
  onto events an earlier page load had already sent, which would have made
  the replay a different event to the backend and counted it twice under the
  new campaign. Events minted after attribution settles are marked at both
  mint sites, so this holds for custom events and `time_spent` too, and the
  exit flush settles and persists whatever it sends before the request
  leaves — a visitor can close the tab while the attribution lookup is still
  open.

### Added

- `generateLink()` accepts `copyToClipboardiOS` and `copyToClipboardAndroid`,
  which ask the Grovs preview page to copy the link so a fresh mobile install
  can be matched back to it. Omitting an option leaves the link on the project
  default; `false` is an explicit override. The web SDK never reads the
  clipboard itself — that happens in the iOS and Android SDKs after install.

## 2.0.0

### Added

- The messages UI is redesigned (themed card, unread badge, skeleton loading,
  empty state, keyboard and Escape support) and configurable via the new
  `messagesTheme` option on `configure()` or `--grovs-*` CSS custom
  properties. See "Styling the messages UI" in the README.

### Fixed

- Purchases and custom link redirects were sent under field names the backend
  does not read, so both were silently dropped.
- Message bodies rendered blank: the backend sends `access_url` without a
  scheme and the URL guard rejected it.
- Deep link attribution now also accepts the legacy `linksquared` query
  parameter and case-mangled parameter names.
- Messages pagination stalled when the first page did not overflow the list.

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
