import { Grovs } from 'grovs';

/** Reads the test's settings, as a site reads its key from its own config. */
export function hostConfig() {
  const params = new URLSearchParams(window.location.search);
  return window.__HOST__ ?? { apiKey: params.get('apiKey'), baseURL: params.get('baseURL'), identifier: params.get('identifier') };
}

export function startGrovs(report) {
  const cfg = hostConfig();
  window.__hostGrovs = Grovs;
  window.__hostLog ??= [];
  const log = (entry) => window.__hostLog.push(entry);
  Grovs.inApp.setCallbacks({
    beforeShow: (id) => !Array.isArray(cfg.allow) || cfg.allow.includes(id),
    onShown: (id) => log({ cb: 'shown', id }),
    onDismissed: (id, reason) => log({ cb: 'dismissed', id, reason }),
    onClicked: (id, button, payload) => {
      log({ cb: 'clicked', id, button, payload });
      if (payload) report.action(JSON.stringify(payload));
    },
    onAnswered: (id, value, comment) => {
      log({ cb: 'answered', id, value, comment });
      report.answer(`${value}|${comment ?? ''}`);
    },
  });
  if (!cfg.apiKey) return;
  if (cfg.paused) Grovs.inApp.pause();
  if (cfg.debug) Grovs.inApp.setDebug(true);
  const debugLevel = cfg.debug ? 'info' : 'error';
  window.__hostConfigured = false;
  void Grovs.configure({ apiKey: cfg.apiKey, baseURL: cfg.baseURL || undefined, autoTrackScreenViews: true, debugLevel }).then(() => {
    window.__hostConfigured = true;
  });
  Grovs.screenNameProvider = (url) => (url.pathname === '/second' ? 'Second' : 'Host home');
  if (cfg.identifier) Grovs.setUserIdentifier(cfg.identifier);
}

export function trigger() {
  Grovs.track('zz_qa_evt', {});
}
