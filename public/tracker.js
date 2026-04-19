/**
 * ASBL Web Tracker v1.0
 * Drop this script on any ASBL website page.
 * Automatically captures UTMs, time spent, page views, referrer.
 * Injects tracking data into form submissions to Vercel CRM API.
 * Zero changes required to existing form code.
 */
(function (w, d) {
  'use strict';

  var STORAGE_KEY   = 'asbl_track';
  var INGEST_DOMAIN = 'asbl-crm-api.vercel.app/api/ingest';

  // ── Helpers ──────────────────────────────────────────────
  function load() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch (e) { return {}; }
  }
  function save(data) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) {}
  }

  // ── 1. UTM Capture ────────────────────────────────────────
  // Captured on first visit with UTM params, persists until new UTMs arrive
  function captureUTMs() {
    var p = new URLSearchParams(w.location.search);
    var keys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
    var hasNew = keys.some(function (k) { return p.get(k); });
    if (!hasNew) return;

    var data = load();
    keys.forEach(function (k) {
      if (p.get(k)) data[k] = p.get(k);
    });
    save(data);
  }

  // ── 2. Page & Referrer Tracking ───────────────────────────
  function trackPage() {
    var data = load();
    var page = w.location.href;

    if (!data.first_page_visited) data.first_page_visited = page;
    data.last_page_visited  = page;
    data.total_page_views   = (data.total_page_views || 0) + 1;
    if (!data.referrer_url && d.referrer) data.referrer_url = d.referrer;

    save(data);
  }

  // ── 3. Time Spent Tracking ────────────────────────────────
  var _pageStart = Date.now();

  function flushTime() {
    var mins = (Date.now() - _pageStart) / 60000;
    var data = load();
    data.time_spent_minutes = Math.round(((data.time_spent_minutes || 0) + mins) * 100) / 100;
    save(data);
    _pageStart = Date.now();
  }

  setInterval(flushTime, 15000);
  w.addEventListener('visibilitychange', function () {
    if (d.hidden) flushTime();
    else _pageStart = Date.now();
  });
  w.addEventListener('beforeunload', flushTime);

  // ── 4. Get all tracking data ──────────────────────────────
  function getTracking() {
    flushTime();
    return load();
  }

  // ── 5. Merge tracking into request body ───────────────────
  function mergeTracking(body) {
    try {
      var parsed = (typeof body === 'string') ? JSON.parse(body) : (body || {});
      var tracking = getTracking();
      // Tracking fills blanks — existing form values always take priority
      var merged = Object.assign({}, tracking, parsed);
      return JSON.stringify(merged);
    } catch (e) {
      return body;
    }
  }

  // ── 6. Patch fetch ────────────────────────────────────────
  var _fetch = w.fetch;
  w.fetch = function (url, opts) {
    if (typeof url === 'string' && url.indexOf(INGEST_DOMAIN) !== -1) {
      opts = opts ? Object.assign({}, opts) : {};
      opts.body = mergeTracking(opts.body);
      opts.headers = Object.assign({}, opts.headers, { 'Content-Type': 'application/json' });
    }
    return _fetch.apply(this, arguments);
  };

  // ── 7. Patch XMLHttpRequest ───────────────────────────────
  var _XHR = w.XMLHttpRequest.prototype;
  var _xhrOpen = _XHR.open;
  var _xhrSend = _XHR.send;

  _XHR.open = function (method, url) {
    this._asblUrl = url;
    return _xhrOpen.apply(this, arguments);
  };
  _XHR.send = function (body) {
    if (this._asblUrl && this._asblUrl.indexOf(INGEST_DOMAIN) !== -1) {
      body = mergeTracking(body);
    }
    return _xhrSend.call(this, body);
  };

  // ── 8. Patch HTML form submit (fallback) ──────────────────
  d.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form || form.tagName !== 'FORM') return;
    var action = form.action || '';
    if (action.indexOf(INGEST_DOMAIN) === -1) return;

    var tracking = getTracking();
    Object.keys(tracking).forEach(function (key) {
      if (!form.querySelector('[name="' + key + '"]')) {
        var inp = d.createElement('input');
        inp.type = 'hidden';
        inp.name = key;
        inp.value = String(tracking[key] || '');
        form.appendChild(inp);
      }
    });
  }, true);

  // ── Init ──────────────────────────────────────────────────
  captureUTMs();
  trackPage();

  // SPA support — re-track on popstate / pushState
  var _pushState = history.pushState;
  history.pushState = function () {
    _pushState.apply(this, arguments);
    flushTime();
    _pageStart = Date.now();
    trackPage();
  };
  w.addEventListener('popstate', function () {
    flushTime();
    _pageStart = Date.now();
    trackPage();
  });

}(window, document));
