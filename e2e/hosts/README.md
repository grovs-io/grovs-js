# In-app host-app matrix (web)

Four host apps, each loading the SDK the way a customer would, run one Playwright suite in Chromium, WebKit and Firefox against the **local** backend (plan: `backend-development-internal/docs/plans/2026-10-07-in-app-host-app-tests-plan.md`, Tasks 7–8).

| Host | Port | SDK via | Routing |
| --- | --- | --- | --- |
| `plain/` | 4801 | `<script src="/dist/grovs.global.js">` (IIFE) | full page loads |
| `react/` | 4802 | `import { Grovs } from 'grovs'` → `dist/grovs.js` (Vite alias), React 19 + react-router, prod build | client-side |
| `next/` | 4803 | same import (webpack alias), Next 15 app router, `next build && next start` | client-side |
| `vue/` | 4804 | same import (Vite alias), Vue 3 + vue-router, prod build | client-side |

Every host reads `window.__HOST__` (or `?apiKey=&baseURL=&identifier=`), sets `inApp.setCallbacks`, configures, sets the identifier and a `screenNameProvider` ("Host home" / "Second"). It has `#host-trigger` (tracks `zz_qa_evt`), `#host-field`, a link to `/second` and back, `#host-last-action` (key-value payload) and `#host-last-answer`; React, Next and Vue also have `#host-remount`, which remounts the provider component that calls `configure()`.

## Running

```
scripts/run_host_tests.sh preflight     # stack check, token mint + revoke, helper start
scripts/run_host_tests.sh smoke         # A1 alert, A2 modal, B6, C11 close/key_value, C12 close/tap outside
scripts/run_host_tests.sh full          # everything (about 30 min for 4 hosts x 3 browsers)
scripts/run_host_tests.sh rich          # the rich-content suite (see "Rich content" below)
HOST_APPS=react,vue HOST_BROWSERS=webkit scripts/run_host_tests.sh full -g "C14"
```

The runner checks Rails (`/in_app/preview`), Sidekiq and ClickHouse (through the helper), mints a one-hour Doorkeeper token and reads project 2796's SDK key with `rails runner`, builds the SDK, runs `npm ci` per host, starts the helper, runs `playwright test -c e2e/hosts/hosts.config.ts`, and on exit hard-deletes, by the exact ids the run recorded (`test-results/hosts-state/<run>/campaigns.txt`, `segments.txt`), anything a test left behind, prints how many of them still exist (expected `0 0`), stops the helper and revokes the token. Results JSON and the helper log land in `test-results/hosts-state/<run id>/`.

Playwright: one project per host x browser, each with a setup project (one visitor and one segment for the whole run) and a teardown (deletes the segment); a project runs its tests one at a time (`workers: 1` per project, 3 overall).

### How the suite reaches the local backend

- **Audience.** Each host x browser has its own identifier `zz-qa-host-<run>-<host>-<browser>` and its own segment (`identifier in_list`, list = that identifier only). Campaigns are named `zz-qa host <run> <host> <case>`, priority 10.
- **`support/backend_helper.rb`** (a `rails runner` process on 127.0.0.1:4809) does what the dashboard API cannot, and only for this run's names/identifiers:
  - `populate`: a segment campaign launches into `preparing` and queues `InAppMembershipPopulateJob` (queue `egress_exports`, not worked locally); the helper runs it inline for that one campaign, retries at once when ClickHouse is busy, and drops the queued copies.
  - `profile`: runs `SyncVisitorProfileJob` (queue `default`) inline for this run's visitor, so its identifier is in ClickHouse before the segment is read.
  - `purge`: hard-deletes this run's campaigns and segments by exact id (the API deletes drafts only and archives segments). Per campaign: its uploaded images and media (purged at once, not `purge_later`), its `in_app_views` rows (FK cascade), the populate retry jobs it queued; once no campaign uses its segment key, that key's `segment_memberships` and the queued `InAppMembershipCleanupJob`. Per segment: its size snapshots, its scheduled `PurgeSegmentIdentifierGenerationsJob` and its `segment_identifier_entries` rows in ClickHouse. It refuses anything not named `zz-qa host <this run> `. Each test ends its campaigns through the API and then purges them; the teardown purges the segment.
  - `visitors`: reads the visitor's id, its project control-group bucket (a held visitor is replaced) and whether its profile reached ClickHouse.
  - **Batch tick**: the dev Sidekiq works `batch_events`, but nothing enqueues `BatchEventProcessorJob` (that is the scheduler's job, which is not running; `events:pending` had stalled since 07:21 UTC). The helper enqueues one `BatchEventProcessorJob` whenever that queue is empty and no such job is running, i.e. it stands in for the scheduler's one-a-minute entry. This processes every pending event on the box, not only ours. Set `HOST_BATCH_TICK=0` to turn it off (report checks then fail).
- **Origin.** Project 2796 links only `http://localhost:4173` as a web domain; the hosts run on 4801–4804. Rather than change project settings, the browser context sends `IDENTIFIER: http://localhost:4173` as an extra HTTP header.
- **Session.** Tests reuse the setup's storage, and the init script refreshes `grovs_session_activity` so later tests stay in the same visit (no app_open). `freshSession` drops the session to make a load a new visit.
- **Other live campaigns.** The project has live "all users" campaigns on app_open. Hosts veto anything but the test's own campaigns in `beforeShow`, so demo campaigns never gain views from the suite.
- **Reports.** `GET .../report` is cached for 60 s per date range, so every poll asks for a different `from`.
- **Waits.** Sync waits are on the `/in_app/sync` response that lists the campaign; report polls flush the page first. The only fixed-duration checks are "stays at N" windows (2–5 s) for negative assertions.

## Results

Full run `1791363729` (2026-10-07), 4 hosts x 3 browsers, 46 tests per project. The "open on load (app_open, no recent gesture)" case was then made gesture-free (shows 6 s after load) and rerun on all 12 projects in run `1791365613`: 12/12 passed. Counts below include that rerun. Smoke runs `1791363376` and `1791366612` (with the hard-delete cleanup): 96/96 tests passed each (plus 24 setup/teardown).

| Project | Pass | Fail | Skip | Failing cases |
| --- | --- | --- | --- | --- |
| plain-chromium | 42 | 1 | 3 | C13 open on load after a click (F1) |
| plain-firefox | 42 | 1 | 3 | F1 |
| plain-webkit | 40 | 3 | 3 | F1, C11 open_url (F2), C13 open on tap (F2) |
| react-chromium | 44 | 1 | 1 | F1 |
| react-firefox | 44 | 1 | 1 | F1 |
| react-webkit | 43 | 2 | 1 | F1, C13 open on tap (F2; open_url passed this run) |
| next-chromium | 44 | 1 | 1 | F1 |
| next-firefox | 44 | 1 | 1 | F1 |
| next-webkit | 42 | 3 | 1 | F1, F2 x2 |
| vue-chromium | 44 | 1 | 1 | F1 |
| vue-firefox | 44 | 1 | 1 | F1 |
| vue-webkit | 42 | 3 | 1 | F1, F2 x2 |

Skips: `C12 banner swipe` everywhere (the web renderer has no swipe gesture); on `plain`, the two B10 cases (no client-side routing, no component tree to remount).

Observation (not a failure): in React, Next and Vue, remounting the provider that calls `configure()` closes the message on screen (the old client is disposed) without reporting a dismissal; no duplicate and no second view.

Coverage: A1 (9 native templates; image templates upload a PNG through the API), A2 (4 layouts), A3, A4, A5; B6 (over the second route, with a field focused: focus returns), B10; C11 (close, open_url, key_value; push/rating/store are skipped on the web as `unsupported`), C12, C13, C14, C15; D16, D17 (session, day, lifetime, delay), D18; E via the report after each interaction. B7–B9 and F are iOS-only.

## FINDINGS (SDK bugs; SDK code not changed)

**F1. `grovs.open()` from an html message's own script is honoured, not refused, when the message followed a click on the host.** All three engines, all four hosts.
Repro: html campaign (modal, event trigger) whose page runs `setTimeout(function(){ grovs.open('https://example.com/x') }, 300)`; trigger it from a button click on the host. The host navigates to the link. The same page shown with no gesture in the last ~5 s (app_open, delayed 6 s) is refused (`In-app page open ignored without a tap`).
Cause: `bridge.js` decides "tap" from `navigator.userActivation.isActive` inside the srcdoc frame, and the frame shares the host's transient activation for ~5 s after the click that triggered the message (Chromium shows `isActive === true` in the frame before anything in it was touched). Event triggers are usually clicks, so open-on-load is effectively allowed for most messages. A fix would require a trusted `pointerdown`/`keydown` inside the frame (or activation gained after the frame loaded) before `open` counts as a tap.
Test: `C13 html bridge: open on load is refused (message from a click trigger)`.

**F2. WebKit: the view and click of a message whose link navigates the tab are lost.** Chromium sends nothing at unload but keeps the events and sends them on the next visit; Firefox sends them at unload. In WebKit nothing is sent at unload and nothing on the next visit either, so the report keeps 0 views and 0 clicks (3 of 4 hosts for `open_url`, 4 of 4 for html `grovs.open` on a tap).
Repro: interstitial with an `open_url` button to another origin; click it; come back to the host; the report never counts the view or the click. Probably the keepalive flush on `visibilitychange` is dropped by WebKit while the SDK treats the keepalive batch as delivered. Seen in Playwright's WebKit build; worth confirming in Safari.
Tests: `C11 open_url action`, `C13 html bridge: open works from a tap` (the tests come back to the host before reading the report, so a late delivery counts).

**F3. WebKit: every event still queued when the tab navigates away is lost, not only the navigating message's.** (Broader form of F2.) A message's view, click and dismissal from an earlier showing, and custom events tracked from an html page (`grovs.track`, `data-grovs-action="track"`), are dropped if they have not been flushed before a link navigates the tab. Chromium and Firefox deliver all of them.
Repro (R7, any host, WebKit): interstitial with buttons `close` and `open_url` (another origin). Trigger, tap `close` (message closes), trigger again within a few seconds, tap the link, come back to the host. The report stays at 0 views, 0 clicks, 0 dismissals: the first showing's view and click, closed seconds earlier, are gone with the second's. In R6 (five showings of one page, the last three ending in a link) WebKit reported 3–5 views of 5, 2–3 clicks of 5 and 1–2 dismissals of 2, and once the page's `zz_qa_rich_2_*` track event never reached the backend.
Tests: `R6 every kind of button in a long page` (full, modal) and `R7 native interstitial` on WebKit; 11 of 12 such WebKit tests failed in run `1791392559`, the same tests pass on Chromium and Firefox.

## Rich content (`scripts/run_host_tests.sh rich`)

`rich-content.spec.ts` (cases in `support/rich.ts`, pages in `fixtures/gallery/` and `fixtures/rich/`). Not part of `smoke` or `full`. Chromium runs every case; WebKit and Firefox skip the ones tagged `@matrix` (`grepInvert` in `hosts.config.ts`), keeping the gallery in modal and full, the long page in every layout, video, R6 in modal and full and R7 interstitial. 51 + 6 tests per Chromium project, 27 per WebKit/Firefox project, about 28 min for the 12 projects.

| Case | What it proves |
| --- | --- |
| R1 gallery | The 8 dashboard gallery designs (`fixtures/gallery/*.html`, copied from `grovs-web-app/ee/lib/inAppHtmlGallery`, `SAMPLE_VIDEO_URL` replaced by the S3 clip as `index.ts` does; win-back's `{{ user.first_name \| default }}` filled) in all 4 layouts, shown twice: light at 1280x720, dark at 390x844. Each time: the design's headline is visible, card and frame lie wholly in the viewport, the page's `prefers-color-scheme` and body background match the scheme, Close is in view and closes. Report: views 2, dismissals 2, clicks 0; `onShown` twice; never two messages on the page. |
| R2 long page | A 12-section page (~3 screens on a phone) in each layout: header in view and not pre-scrolled; the wheel over the message scrolls the page inside it (the host page stays put) to the last button (`data-grovs-action="track"`), whose event reaches `/events/batch`; then back up to the header; still open; report views 1, clicks 1, dismissals 1. |
| R3 video | Muted autoplay inline with controls and loop (the page writes `data-state="playing"` and counts loops); a 403 video still shows the rest and closes; a 3840 px poster loads and the message stays on screen. |
| R4 limits | Every text template with a 256-char title, 1024-char message, two 64-char buttons and custom colours (card and title colours checked), at desktop and phone size: card inside, both buttons wholly in view and working (close; key_value reaches the host). Image templates with https portrait and landscape pictures: landscape at desktop, portrait at phone size, loaded, on screen, closable. |
| R5 custom UI | Web font from fonts.gstatic.com, CSS animations, fixed header and footer bars, a text input (typed text reaches the page, `grovs.track` counts the click), Close still takes the tap under the fixed header, the host's own field works afterwards. |
| R6 every button | One long page with a button of every kind spread through it, per layout, five showings: `grovs.track` with properties (exactly one event in the analytics API, properties `{n:1, where:"top", ok:true, campaign_id}`), `grovs.setAttribute` (stored on the visitor), `grovs.requestPushPermission()` (answered `unsupported`), an in-page `#` link (scrolls, stays open), the end of the page wholly visible, `data-grovs-action="close"`, `data-grovs-action="track"` (exactly one event), `grovs.close()`, `grovs.open(url)`, `data-grovs-action="open"` + `data-grovs-url`, a plain `<a href>`: each opens its own address. Report: views 5, clicks 5 (one per showing), dismissals 2, all clicks without a button id. |
| R7 native buttons | interstitial, footer, alert: `close` and `open_url` (opens the URL), `key_value` with five keys (unicode, `=`/`&`, JSON text) arriving intact in the host callback, per-button clicks in the report (`close`, `url`, `kv`, `done`: 1 each); `request_push_permission` + `request_app_rating`, and `open_store`, are skipped as `unsupported` on the web. |

Harness notes: the host context's `IDENTIFIER` header (see "Origin") makes Chromium preflight cross-origin font fetches, which fonts.gstatic.com refuses, so R5 strips it for that host; the card's 160 ms entrance slide is waited out before boxes are measured; the project setup polls (60 s) for the visitor's identifier and tries another visitor if it never shows (the helper can be busy for many seconds during a full run). `live-backend.ts` gained `events`, `eventProperties`, `visitorAttributes` and per-button clicks in `report`.

Results, run `1791392559` (2026-10-07, all 12 projects): 465 passed, 11 failed, all WebKit: R6 full and modal on every host and R7 interstitial on plain, next and vue, every one F3 (below). Earlier runs `1791387426` and `1791388889` (before R6/R7 and the setup fix) passed every R1–R5 case on every project that ran; their failures were the setup race, since fixed, and a React/Next/Vue callback read before the host re-rendered (harness, fixed).

## Data left behind and side effects

A run leaves no campaigns, segments, memberships, views, uploads or queued jobs of its own. Verified on smoke run `1791366612` (84 campaigns, 12 segments): 0 remain by id or by name, 0 queued jobs reference them, 0 ClickHouse list entries. What stays:

- The visitors `zz-qa-host-<run>-*` (one per host x browser, with `zz_qa_attr` set by the bridge test), their events in ClickHouse, and the `SyncVisitorProfileJob`s the SDK's identify calls queue on `default`.
- Audit events for each create/launch/end. They form a hash chain (`prev_hash`/`hash_value`), so deleting rows would break it; left alone.
- Batch events the helper's tick processed for everyone on the box.

Earlier runs of this suite (`dev0`, `dev1`, `1791363376`, `1791363729`, `1791365613`, `1791366045`) were cleaned the same way on 2026-10-07: 984 + 84 campaigns, 79 + 12 segments, 1,263 + 1,075 queued jobs, 233 memberships, 839 view rows, 97 uploads. Records of other runs on the box (the iOS suite's) were not touched.

## Files

- `hosts.config.ts`: projects, web servers; `HOST_SUITE=smoke|full|rich`, `HOST_APPS`, `HOST_BROWSERS`, `HOST_WORKERS`.
- `live-backend.ts`: the dashboard API (`createCampaign`, `launch`, `end`, `delete`, `report`, `waitForReport`, segments, media) plus helper calls.
- `support/fixtures.ts` (the `host` fixture), `support/cases.ts` (every case, shared by the specs and smoke), `support/definitions.ts`, `support/backend_helper.rb`.
- `project.setup.ts` / `project.teardown.ts`, `*.spec.ts`, `fixtures/` (PNG, VP9 and H.264 MP4 clips).
- `rich-content.spec.ts`, `support/rich.ts`, `fixtures/gallery/*.html` (the 8 dashboard designs), `fixtures/rich/*.html` (long, video, video-broken, poster, custom, actions; the iOS suite embeds the same pages in `grovs-ios/Tests/HostApps/UITests/RichPages.swift`).
- Root changes: `eslint.config.js` ignores `e2e/hosts/{plain,react,next,vue}/**` (the apps and their build output); `playwright.config.ts` makes the chromium/webkit/firefox projects ignore `hosts/`. The repo's `tsconfig.json` already includes `e2e/`; the host apps are JS, so `tsc` does not pick them up.
- `e2e/hosts/.gitignore` ignores host `node_modules`, `dist` and `.next`. The global excludes file ignores `.gitignore` files, so it needs `git add -f`.
