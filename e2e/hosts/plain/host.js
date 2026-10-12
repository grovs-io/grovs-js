// The plain host's integration: a script tag, then configure on load, as the README tells a site to.
(function () {
  var params = new URLSearchParams(location.search);
  var cfg = window.__HOST__ || { apiKey: params.get('apiKey'), baseURL: params.get('baseURL'), identifier: params.get('identifier') };
  var Grovs = window.Grovs;
  window.__hostGrovs = Grovs;
  window.__hostLog = [];
  function log(entry) { window.__hostLog.push(entry); }
  function text(id, value) { var el = document.getElementById(id); if (el) el.textContent = value; }
  Grovs.inApp.setCallbacks({
    beforeShow: function (id) { return !Array.isArray(cfg.allow) || cfg.allow.indexOf(id) !== -1; },
    onShown: function (id) { log({ cb: 'shown', id: id }); },
    onDismissed: function (id, reason) { log({ cb: 'dismissed', id: id, reason: reason }); },
    onClicked: function (id, button, payload) {
      log({ cb: 'clicked', id: id, button: button, payload: payload });
      if (payload) text('host-last-action', JSON.stringify(payload));
    },
    onAnswered: function (id, value, comment) {
      log({ cb: 'answered', id: id, value: value, comment: comment });
      text('host-last-answer', String(value) + '|' + (comment || ''));
    },
  });
  if (!cfg.apiKey) return;
  if (cfg.paused) Grovs.inApp.pause();
  if (cfg.debug) Grovs.inApp.setDebug(true);
  var debugLevel = cfg.debug ? 'info' : 'error';
  Grovs.configure({ apiKey: cfg.apiKey, baseURL: cfg.baseURL || undefined, autoTrackScreenViews: true, debugLevel: debugLevel }).then(function () {
    window.__hostConfigured = true;
  });
  Grovs.screenNameProvider = function (url) { return url.pathname === '/second' ? 'Second' : 'Host home'; };
  if (cfg.identifier) Grovs.setUserIdentifier(cfg.identifier);
  document.addEventListener('click', function (event) {
    if (event.target && event.target.id === 'host-trigger') Grovs.track('zz_qa_evt', {});
  });
})();
