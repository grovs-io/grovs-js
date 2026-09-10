# Grovs SDK demo & QA harness

Every SDK method behind a button, with the outgoing request log beside it.
The Playwright suites drive this same page.

```bash
npm run demo    # http://localhost:5174/demo/
```

## Two modes

**Stubbed (default).** No backend. Every call is answered locally, so you can
inspect exactly what the SDK builds — headers, payload shapes, batching, the
byte-bounded exit flush — without credentials or network.

**Live.** Tick *"Talk to a real backend"*, enter a real project key, reload,
then press `configure()`. Requests go out for real and responses are logged
alongside them.

Two things must be true or `authenticate` answers 422:

1. The project must list `http://localhost:5174` in its **linked domains**,
   exactly that string. The backend compares it with no normalisation, so
   `localhost:5174` and `https://localhost:5174` are different values. If it
   fails, the log prints the exact string the SDK sent — copy that in.
2. The backend must allow the origin via **CORS**. Mobile SDKs never hit this,
   so it is easy to miss the first time a browser talks to a self-hosted
   deployment.

Set *baseURL* to point at a self-hosted backend; leave it blank for the Grovs
cloud. Settings persist across reloads, which matters because deferred
attribution is only observable across one.

## Automated flows against a real backend

Automated tests own a separate server on `http://localhost:4175`; add that
exact origin to the project's linked domains and CORS configuration too.
The interactive demo remains on port 5174. The test runner refuses to reuse
an existing server so a stale SDK build cannot affect the result.

`e2e/live.spec.ts` drives this page through every flow with no stubs:
authenticate, create a link, read its details, arrive through the link and
resolve the payload, deliver an event batch and assert the backend accepted
it, set identity and attributes, sync screen aliases, list messages, read the
unread count, log a purchase, observe the `time_spent` request on an actual tab close, and confirm a
returning visitor is recognised rather than counted as a new install.

```bash
GROVS_LIVE_API_KEY=your-key npm run test:live

# self-hosted, or production instead of the test environment
GROVS_LIVE_API_KEY=your-key \
GROVS_LIVE_BASE_URL=https://sdk.your-domain.com \
GROVS_LIVE_TEST_ENV=false \
  npm run test:live
```

Without `GROVS_LIVE_API_KEY`, an explicit live run fails with setup instructions.
`npm run verify` runs only the local projects and does not need credentials.
The key only ever comes from the environment.

### Running it continuously

```bash
npm run test:live:watch    # every 15 minutes until you stop it
```

That is the useful shape for catching backend drift: a renamed field, an
endpoint that becomes Enterprise-only, a linked domain someone removed. The
stub suite cannot see any of that, because stubs agree with whatever the SDK
sends. On a scheduler, point cron or a CI job at `npm run test:live` instead.
