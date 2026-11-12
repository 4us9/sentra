/* Sentra operator console.
 *
 * Security note: every string that comes back from the API (recipient, purpose,
 * reason details, mandate description) was supplied by an agent that may be
 * hostile. Nothing from the API is ever parsed as HTML: this file builds DOM
 * nodes and sets textContent only. There is no innerHTML anywhere in it, and the
 * page ships with a CSP that forbids inline script.
 */
(function () {
  'use strict';

  var POLL_MS = 1500;
  var TOKEN_PREFIX = 'sentra.agentToken.';
  var ADMIN_KEY = 'sentra.adminToken';
  var BAD_RESULTS = { FAIL: 1, FLAG: 1, high: 1, med: 1, error: 1 };
  var LAYERS = [
    ['schema', 'Schema'], ['rule', 'Rules'], ['anomaly', 'Anomaly'],
    ['intent', 'Intent'], ['human', 'Human'], ['processor', 'Processor'],
  ];
  var CORE_LAYERS = { schema: 1, rule: 1, anomaly: 1, intent: 1 };
  var CORE_ORDER = ['schema', 'rule', 'anomaly', 'intent'];
  var MODE_TEXT = {
    sandbox: 'Allowed payments are created in the processor sandbox and read back to verify amount and currency. No real money moves.',
    test: 'Allowed payments are created with test-mode keys and read back to verify amount and currency. No real money moves.',
    simulated: 'Simulated: the server has no credentials for this processor, so allowed payments are not sent to it. Payment ids start with SIM-.',
    external: 'Authorise only: Sentra decides and records, and the caller executes the payment itself. Sentra does not see or verify the execution. Authorisation ids start with AUTH-.',
  };
  var MODE_WORD = { external: 'authorise only' };
  // Scenarios whose point is "every number passes, only the intent layer sees it".
  var INTENT_STORY = { giftcard: 1, offscope: 1 };

  var S = {
    mandates: [], decisions: [], audit: null, config: null, metrics: null,
    scenarios: [], poisoned: '',
    policies: [], policyDefault: null, policiesLoaded: false,
    issuePolicy: null,      // policy name chosen in the issue control
    issueProcessor: null,   // processor name chosen in the issue control
    procFilter: '',
    selectedMandateId: null,
    selectedDecisionId: null,
    pendingSelectId: null,
    verdictFilter: '',
    results: {},      // scenario id -> { items: [...], error }
    running: {},      // scenario id -> bool
    busy: {},         // operator action key -> bool
    loaded: false,
  };
  var sigs = {};
  var gridApi = null;
  var cardRefs = {};

  // ---------------------------------------------------------------- helpers
  function $(id) { return document.getElementById(id); }

  // el('div', {class:'x', text:'y', title:'z', attrs:{...}, on:{click:fn}}, child, child...)
  function el(tag, props) {
    var node = document.createElement(tag);
    var p = props || {};
    if (p.class) node.className = p.class;
    if (p.text !== undefined && p.text !== null) node.textContent = String(p.text);
    if (p.title) node.title = String(p.title);
    if (p.attrs) Object.keys(p.attrs).forEach(function (k) { node.setAttribute(k, String(p.attrs[k])); });
    if (p.on) Object.keys(p.on).forEach(function (k) { node.addEventListener(k, p.on[k]); });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

  // Anything from the API -> a bounded display string. Never trusted, only displayed.
  function str(v, max) {
    var s;
    if (v === null || v === undefined) s = '';
    else if (typeof v === 'string') s = v;
    else { try { s = JSON.stringify(v); } catch (e) { s = String(v); } if (s === undefined) s = String(v); }
    var lim = max || 600;
    return s.length > lim ? s.slice(0, lim) + '...' : s;
  }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function money(v, currency) {
    if (!isNum(v)) return str(v, 60) || '(none)';
    var cur = typeof currency === 'string' && /^[A-Z]{3}$/.test(currency) ? currency : 'USD';
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: 2 }).format(v);
    } catch (e) { return '$' + v.toFixed(2); }
  }
  function clock(iso) {
    var d = new Date(iso);
    return isNaN(d.getTime()) ? str(iso, 30) : d.toLocaleTimeString('en-GB', { hour12: false });
  }
  function shortHash(h) {
    var s = str(h, 200);
    return s.length > 30 ? s.slice(0, 18) + '...' + s.slice(-8) : (s || '-');
  }
  function nonAscii(s) {
    var out = [];
    var text = String(s);
    for (var i = 0; i < text.length && out.length < 8; i++) {
      var c = text.charCodeAt(i);
      if (c > 126 || c < 32) out.push('U+' + ('0000' + c.toString(16).toUpperCase()).slice(-4) + ' at position ' + (i + 1));
    }
    return out;
  }
  function changed(key, value) {
    var s = JSON.stringify(value);
    if (sigs[key] === s) return false;
    sigs[key] = s;
    return true;
  }
  function pill(verdict, asButton) {
    var v = str(verdict, 12) || 'NONE';
    var known = { ALLOW: 1, BLOCK: 1, REVIEW: 1, ERROR: 1, INFO: 1, MIXED: 1 };
    var node = el(asButton ? 'button' : 'span', { class: 'pill ' + (known[v] ? v : 'NONE'), text: v });
    if (asButton) node.type = 'button';
    return node;
  }
  function tag(text, cls, title) {
    return el('span', { class: 'mtag' + (cls ? ' ' + cls : ''), text: str(text, 24), title: title || '' });
  }
  // Processor names and labels arrive from the API; they are only ever displayed as text.
  function processors() {
    var ps = S.config && Array.isArray(S.config.processors) ? S.config.processors : [];
    return ps.filter(function (p) { return p && typeof p.name === 'string'; });
  }
  function procInfo(name) {
    var ps = processors();
    for (var i = 0; i < ps.length; i++) if (ps[i].name === name) return ps[i];
    return null;
  }
  function procLabel(name) {
    var p = procInfo(name);
    return p ? str(p.label || p.name, 40) : (str(name, 40) || 'unknown');
  }
  function procMode(name) { var p = procInfo(name); return p ? str(p.mode, 20) : ''; }
  // "External (authorise only)" -> "External": the hint is shown separately as the mode.
  function procShort(name) { return procLabel(name).replace(/\s*\(.*\)\s*$/, '') || procLabel(name); }
  function modeWord(mode) { var m = str(mode, 20); return MODE_WORD[m] || m; }
  function modeClass(mode) { return mode === 'sandbox' || mode === 'test' ? 'ok' : mode === 'simulated' ? 'warn' : ''; }
  function modeTag(mode) {
    var m = str(mode, 20);
    return m ? tag(modeWord(m), 'mode ' + modeClass(m), MODE_TEXT[m] || '') : null;
  }
  function retryText(body) {
    var n = body && isNum(body.retryAfterSec) ? Math.max(1, Math.ceil(body.retryAfterSec)) : null;
    return n ? 'Retry in ' + n + (n === 1 ? ' second.' : ' seconds.') : 'Retry in a moment.';
  }
  var toastTimer = null;
  function toast(msg, ok) {
    var t = $('toast');
    t.textContent = String(msg);
    t.className = 'toast' + (ok ? ' ok' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, ok ? 3200 : 6000);
  }

  // sessionStorage (agent tokens live only in this tab)
  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function ssDel(k) { try { sessionStorage.removeItem(k); } catch (e) { /* ignore */ } }
  function tokenFor(mandateId) { return mandateId ? ssGet(TOKEN_PREFIX + mandateId) : null; }
  function dropAllTokens() {
    try {
      var keys = [];
      for (var i = 0; i < sessionStorage.length; i++) {
        var k = sessionStorage.key(i);
        if (k && k.indexOf(TOKEN_PREFIX) === 0) keys.push(k);
      }
      keys.forEach(ssDel);
    } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------- API
  function rawPost(path, body, headers) {
    var h = { 'content-type': 'application/json' };
    Object.keys(headers || {}).forEach(function (k) { h[k] = headers[k]; });
    return fetch(path, { method: 'POST', headers: h, body: JSON.stringify(body === undefined ? {} : body), cache: 'no-store' })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, body: j }; });
      });
  }
  // Operator endpoints. If the server requires an operator token, ask once and retry.
  async function opPost(path, body) {
    var send = function () {
      var t = ssGet(ADMIN_KEY);
      return rawPost(path, body, t ? { 'x-sentra-admin': t } : {});
    };
    var r = await send();
    if (r.status === 401) {
      var t = window.prompt('This Sentra instance requires the operator token (SENTRA_ADMIN_TOKEN):');
      if (!t) throw new Error('operator token required');
      ssSet(ADMIN_KEY, t.trim());
      try { r = await send(); } catch (e) { ssDel(ADMIN_KEY); throw new Error('operator token rejected'); }
      if (r.status === 401) { ssDel(ADMIN_KEY); throw new Error('operator token rejected'); }
    }
    if (r.status === 429) throw new Error('operator rate limit reached. ' + retryText(r.body));
    if (r.status < 200 || r.status >= 300) throw new Error(str(r.body && r.body.error, 200) || ('HTTP ' + r.status));
    return r.body;
  }
  // The agent surface: exactly what an agent would send.
  function guard(token, payment) {
    return rawPost('/guard', payment, { authorization: 'Bearer ' + token });
  }

  var polling = false;
  async function refresh() {
    if (polling) return;
    polling = true;
    try {
      var r = await fetch('/api/state', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var j = await r.json();
      S.mandates = Array.isArray(j.mandates) ? j.mandates : [];
      S.decisions = Array.isArray(j.decisions) ? j.decisions : [];
      S.audit = j.audit || null;
      S.config = j.config || {};
      S.metrics = j.metrics || null;
      S.loaded = true;
      if (!S.policiesLoaded) loadPolicies();
      $('chip-conn').hidden = true;
      $('foot-state').textContent = 'Updated ' + clock(new Date().toISOString());
      renderAll();
    } catch (e) {
      var c = $('chip-conn');
      c.hidden = false; c.className = 'chip bad';
      clear(c).appendChild(el('b', { text: 'Connection lost' }));
    } finally { polling = false; }
  }
  async function loadScenarios() {
    try {
      var r = await fetch('/api/scenarios', { cache: 'no-store' });
      var j = await r.json();
      S.scenarios = Array.isArray(j.scenarios) ? j.scenarios : [];
      S.poisoned = str(j.poisonedListing, 2000);
    } catch (e) { S.scenarios = []; }
    renderCards();
    renderLabState();
  }

  var policiesBusy = false;
  async function loadPolicies() {
    if (policiesBusy) return;
    policiesBusy = true;
    try {
      var r = await fetch('/api/policies', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var j = await r.json();
      S.policies = (Array.isArray(j.policies) ? j.policies : []).filter(function (p) { return p && typeof p.name === 'string'; });
      S.policyDefault = typeof j.default === 'string' ? j.default : null;
      S.policiesLoaded = true;
    } catch (e) { S.policies = []; }
    policiesBusy = false;
    renderIssue();
  }

  // ---------------------------------------------------------------- derived
  function currentMandate() {
    var ms = S.mandates;
    if (!ms.length) return null;
    var found = null;
    for (var i = 0; i < ms.length; i++) if (ms[i].id === S.selectedMandateId) found = ms[i];
    if (found) return found;
    var latest = ms[0];
    ms.forEach(function (m) { if (String(m.createdAt) > String(latest.createdAt)) latest = m; });
    S.selectedMandateId = latest.id;
    return latest;
  }
  // The server names the check that stopped a payment in decidedBy {layer, check}.
  // Entries without it (or written before it existed) fall back to the first failing reason.
  function decidingReason(d) {
    var rs = Array.isArray(d.reasons) ? d.reasons : [];
    var by = d.decidedBy, i;
    if (by && typeof by === 'object') {
      for (i = 0; i < rs.length; i++) if (rs[i] && rs[i].layer === by.layer && rs[i].check === by.check) return rs[i];
      return { layer: by.layer, check: by.check, detail: '', result: '' };
    }
    if (d.verdict === 'ALLOW') return null;
    for (i = 0; i < rs.length; i++) if (rs[i] && BAD_RESULTS[rs[i].result]) return rs[i];
    return null;
  }
  // Intent details end with the source in brackets: "... [llm]", "[signature]", "[fallback]".
  function splitSource(detail) {
    var t = str(detail, 600);
    var m = /^([\s\S]*?)\s*\[([a-z_]{2,16})\]$/.exec(t);
    return m ? { text: m[1], source: m[2] } : { text: t, source: '' };
  }
  function decidingText(d) {
    var r = decidingReason(d);
    if (r) return str(r.check, 80) + (r.detail ? ': ' + str(r.detail, 400) : '');
    var first = Array.isArray(d.reasons) ? d.reasons[0] : null;
    if (d.kind === 'event') return first ? str(first.detail, 400) : 'operator event';
    if (d.kind === 'review_resolution' && first) return str(first.check, 80) + ': ' + str(first.detail, 400);
    return 'all checks passed';
  }
  function resolverOf(id) {
    for (var i = 0; i < S.decisions.length; i++) if (S.decisions[i].resolves === id) return S.decisions[i];
    return null;
  }
  function decisionById(id) {
    for (var i = 0; i < S.decisions.length; i++) if (S.decisions[i].id === id) return S.decisions[i];
    return null;
  }
  function layerName(k) {
    for (var i = 0; i < LAYERS.length; i++) if (LAYERS[i][0] === k) return LAYERS[i][1];
    return str(k, 30) || 'Other';
  }
  function pendingReviews() {
    var resolved = {};
    S.decisions.forEach(function (d) { if (d.resolves) resolved[d.resolves] = 1; });
    return S.decisions.filter(function (d) { return d.verdict === 'REVIEW' && !resolved[d.id]; });
  }

  // ---------------------------------------------------------------- header + flow
  function setChip(id, cls, label, strong, title) {
    var c = $(id);
    c.className = 'chip ' + cls;
    c.title = title || '';
    clear(c);
    if (label) c.appendChild(document.createTextNode(label + ' '));
    c.appendChild(el('b', { text: strong }));
  }
  function renderChips() {
    var cfg = S.config || {}, a = S.audit || {};
    if (!changed('chips', [cfg, a.ok, a.length, a.brokenAt])) return;
    var host = clear($('chips-proc')), rails = clear($('flow-rails'));
    var ps = processors();
    ps.forEach(function (p) {
      var mode = str(p.mode, 20);
      var chip = el('span', { class: 'chip ' + modeClass(mode), title: MODE_TEXT[mode] || '' },
        procShort(p.name) + ' ', el('b', { text: modeWord(mode).toUpperCase() }));
      host.appendChild(chip);
      rails.appendChild(el('span', { class: 'rail ' + modeClass(mode), title: MODE_TEXT[mode] || '' },
        el('span', { class: 'rail-n', text: procShort(p.name) }), el('span', { class: 'rail-m', text: modeWord(mode) })));
    });
    if (!ps.length) rails.textContent = 'PayPal · Stripe';
    if (cfg.intent === 'llm') {
      setChip('chip-intent', 'ok', 'Intent', 'Claude', 'The intent layer asks Claude whether the stated purpose fits the mandate, on top of injection signatures. The model only classifies; fixed policy decides.');
      if (cfg.intentModel) $('chip-intent').appendChild(el('span', { class: 'chip-x mono', text: ' · ' + str(cfg.intentModel, 48) }));
    } else setChip('chip-intent', '', 'Intent', 'fallback', 'No LLM key configured. The intent layer runs deterministic injection signatures and a mandate-vocabulary check.');
    var n = isNum(a.length) ? a.length : S.decisions.length;
    if (a.ok === false) {
      setChip('chip-audit', 'bad', '', 'LEDGER TAMPERED at #' + str(a.brokenAt, 12), 'The hash chain does not verify from this entry onward. An entry was edited, removed or reordered after it was written.');
    } else {
      setChip('chip-audit', 'ok', '', 'Ledger intact', 'Every entry carries the hash of the one before it. The whole chain was re-verified on this poll.');
      $('chip-audit').appendChild(document.createTextNode(' · ' + n + (n === 1 ? ' entry' : ' entries')));
    }
    renderIssue();
    renderProcFilter();
  }
  function ms(v) {
    if (!isNum(v)) return '-';
    return String(v < 10 ? Math.round(v * 10) / 10 : Math.round(v));
  }
  // Every number here is computed by the server (state.metrics). Nothing is re-derived from the ledger.
  function renderStats() {
    var m = S.metrics || {};
    if (!changed('stats', [m, processors()])) return;
    var bv = m.byVerdict || {};
    var n = function (v) { return isNum(v) ? v : 0; };
    $('st-allow').textContent = n(bv.ALLOW);
    $('st-block').textContent = n(bv.BLOCK);
    $('st-review').textContent = n(bv.REVIEW);
    var pend = n(m.reviewsPending);
    $('st-pending').textContent = pend ? pend + ' pending' : '';
    var errs = n(bv.ERROR);
    $('st-allow').title = errs ? errs + ' more passed the firewall but failed at the processor (ERROR, nothing debited).' : '';
    var rate = n(m.blockRate) * 100;
    $('st-rate').textContent = (rate % 1 ? rate.toFixed(1) : String(rate)) + '%';
    $('st-rate').title = n(bv.BLOCK) + ' of ' + n(m.decisions) + ' decisions were BLOCK.';
    $('st-blocked-value').textContent = money(n(m.blockedValue), 'USD');
    $('st-blocked-value').title = 'Sum of the amounts of blocked payment attempts (well-formed, positive amounts only).';

    var spend = m.spendByProcessor && typeof m.spendByProcessor === 'object' ? m.spendByProcessor : {};
    var host = clear($('st-spend')), names = processors().map(function (p) { return p.name; });
    Object.keys(spend).forEach(function (k) { if (names.indexOf(k) === -1) names.push(k); });
    names.slice(0, 6).forEach(function (k) {
      var v = n(spend[k]);
      host.appendChild(el('span', { class: 'spend' + (v ? '' : ' zero') },
        el('span', { class: 'spend-n', text: procShort(k) }), el('span', { class: 'spend-v', text: money(v, 'USD') })));
    });
    host.title = 'Value of ALLOW decisions per processor. Total ' + money(n(m.spendTotal), 'USD')
      + (n(m.reservedInFlight) ? ', plus ' + money(m.reservedInFlight, 'USD') + ' reserved in flight.' : '.');

    var lat = m.latencyMs || {};
    var ldd = clear($('st-latency'));
    if (n(lat.samples)) {
      ldd.appendChild(document.createTextNode(ms(lat.p50) + ' / ' + ms(lat.p95)));
      ldd.appendChild(el('small', { text: ' ms' }));
    } else ldd.textContent = '-';
    ldd.title = 'Time from request to verdict across ' + n(lat.samples) + ' payment decisions, including the processor call on ALLOW. Max ' + ms(lat.max) + ' ms.';

    // Stopped by layer: one stacked bar, built from plain divs.
    var by = m.stoppedByLayer && typeof m.stoppedByLayer === 'object' ? m.stoppedByLayer : {};
    var other = 0, total = 0;
    Object.keys(by).forEach(function (k) { var v = n(by[k]); total += v; if (!CORE_LAYERS[k]) other += v; });
    var segs = CORE_ORDER.map(function (k) { return [k, layerName(k), n(by[k])]; });
    if (other) segs.push(['other', 'Human / processor', other]);
    var bar = clear($('sbar')), legend = clear($('slegend'));
    bar.classList.toggle('is-empty', !total);
    segs.forEach(function (sg) {
      if (sg[2]) {
        var piece = el('span', { class: 'sseg l-' + sg[0], title: sg[1] + ': ' + sg[2] + ' stopped' });
        piece.style.flexGrow = String(sg[2]);
        bar.appendChild(piece);
      }
      legend.appendChild(el('span', { class: 'sleg' + (sg[2] ? '' : ' zero') },
        el('i', { class: 'l-' + sg[0] }), el('span', { text: sg[1] }), el('b', { text: sg[2] })));
    });
    $('sb-total').textContent = total ? total + ' stopped' : 'nothing stopped yet';
    CORE_ORDER.forEach(function (k) {
      var node = $('lc-' + k), c = n(by[k]);
      node.textContent = c + ' stopped';
      node.parentNode.classList.toggle('hit', c > 0);
    });
  }

  // ---------------------------------------------------------------- issue-mandate control
  function policyByName(name) {
    for (var i = 0; i < S.policies.length; i++) if (S.policies[i].name === name) return S.policies[i];
    return null;
  }
  function scopeWord(v) { return v === 'block' ? 'blocked' : 'held for review'; }
  function renderIssue() {
    var ps = processors();
    if (!S.issueProcessor || !procInfo(S.issueProcessor)) {
      var def = ps.filter(function (p) { return p.default; })[0] || ps[0];
      S.issueProcessor = def ? def.name : null;
    }
    if (!S.issuePolicy || !policyByName(S.issuePolicy)) {
      S.issuePolicy = policyByName(S.policyDefault) ? S.policyDefault : (S.policies[0] ? S.policies[0].name : null);
    }
    if (!changed('issue', [S.policies, S.policyDefault, S.issuePolicy, S.issueProcessor, ps, S.busy.issue])) return;

    var sel = clear($('policy-select'));
    if (!S.policies.length) {
      var o0 = el('option', { text: S.policiesLoaded ? 'Server default' : 'Loading policies...' }); o0.value = '';
      sel.appendChild(o0);
    }
    S.policies.forEach(function (p) {
      var o = el('option', { text: str(p.name, 64) + (p.name === S.policyDefault ? '  (default)' : '') });
      o.value = p.name;
      if (p.name === S.issuePolicy) o.selected = true;
      sel.appendChild(o);
    });
    sel.disabled = !S.policies.length;

    var sum = clear($('policy-summary'));
    var pol = policyByName(S.issuePolicy);
    if (pol) {
      var rc = Array.isArray(pol.allowedRecipients) ? pol.allowedRecipients.length : 0;
      var bits = [
        [money(pol.budgetTotal, pol.currency), 'budget'],
        [money(pol.perTxCap, pol.currency), 'per payment'],
        [String(rc), rc === 1 ? 'recipient' : 'recipients'],
        ['out of scope', scopeWord(pol.outOfScope)],
      ];
      bits.forEach(function (b, i) {
        if (i) sum.appendChild(el('span', { class: 'sep', text: '·' }));
        sum.appendChild(i === 3
          ? el('span', {}, b[0] + ' ', el('b', { class: pol.outOfScope === 'block' ? 'v-block' : 'v-review', text: b[1] }))
          : el('span', {}, el('b', { text: b[0] }), ' ' + b[1]));
      });
      sum.title = str(pol.description, 400);
    } else sum.textContent = S.policiesLoaded ? 'No policy files found. The server default mandate will be issued.' : '';

    var tg = clear($('proc-toggle'));
    ps.forEach(function (p) {
      var mode = str(p.mode, 20), on = p.name === S.issueProcessor;
      var b = el('button', { class: 'seg-b rail-b' + (on ? ' is-on' : '') + (mode === 'external' ? ' is-secondary' : ''),
        title: MODE_TEXT[mode] || '', attrs: { role: 'radio', 'aria-checked': on ? 'true' : 'false', 'data-p': p.name } },
        el('span', { class: 'rail-b-n', text: procShort(p.name) }),
        el('span', { class: 'rail-b-m ' + modeClass(mode), text: modeWord(mode) }));
      b.type = 'button';
      tg.appendChild(b);
    });
    var btn = $('btn-new-mandate');
    btn.disabled = !!S.busy.issue || !S.loaded;
    btn.textContent = S.busy.issue ? 'Issuing...' : S.issueProcessor ? 'Issue mandate on ' + procShort(S.issueProcessor) : 'Issue mandate';
  }

  // ---------------------------------------------------------------- mandate panel
  function remaining(iso) {
    var t = new Date(iso).getTime();
    if (isNaN(t)) return { text: 'unknown', expired: false };
    var ms = t - Date.now();
    if (ms <= 0) return { text: 'expired', expired: true };
    var mins = Math.floor(ms / 60000), h = Math.floor(mins / 60), d = Math.floor(h / 24);
    if (d >= 2) return { text: 'in ' + d + ' days', expired: false };
    if (h >= 1) return { text: 'in ' + h + 'h ' + (mins % 60) + 'm', expired: false };
    return { text: 'in ' + Math.max(mins, 1) + ' min', expired: false };
  }
  function kvRow(dl, k, v) {
    dl.appendChild(el('dt', { text: k }));
    var dd = el('dd');
    if (typeof v === 'string') dd.textContent = v; else dd.appendChild(v);
    dl.appendChild(dd);
  }
  function tagList(items, soft) {
    var wrap = el('div', { class: 'tags' });
    (Array.isArray(items) ? items : []).slice(0, 40).forEach(function (x) {
      wrap.appendChild(el('span', { class: 'tag' + (soft ? ' soft' : ''), text: str(x, 140) }));
    });
    return wrap;
  }
  function renderMandateSelect() {
    var sel = $('mandate-select');
    var ms = S.mandates;
    var cur = currentMandate();
    if (!changed('msel', [ms.map(function (m) { return [m.id, m.processor, m.policy, m.status, !!tokenFor(m.id)]; }), cur && cur.id, processors()])) return;
    sel.hidden = ms.length < 2;
    clear(sel);
    ms.slice().sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); }).forEach(function (m) {
      var label = procShort(m.processor) + ' · ' + (str(m.policy, 40) || 'custom') + ' · ' + str(m.id, 24)
        + (m.status === 'frozen' ? ' (frozen)' : '') + (tokenFor(m.id) ? '' : ' (no agent token)');
      var o = el('option', { text: label });
      o.value = m.id;
      if (cur && m.id === cur.id) o.selected = true;
      sel.appendChild(o);
    });
  }
  function renderMandate() {
    var m = currentMandate();
    var body = $('mandate-body');
    var rem = m ? remaining(m.expiresAt) : null;
    if (!changed('mandate', [m, rem && rem.text, m && !!tokenFor(m.id), S.busy.freeze, S.loaded, processors()])) return;
    clear(body);
    if (!m) {
      body.appendChild(el('p', { class: 'empty', text: S.loaded
        ? 'No mandate yet. A mandate is the authority a human delegates to an agent: budget, per-payment cap, allowed recipients, velocity and expiry. Choose a policy and a processor below, then issue one.'
        : 'Loading...' }));
      return;
    }
    var frozen = m.status === 'frozen';
    var statusCls = m.sealValid === false ? 'broken' : frozen ? 'frozen' : rem.expired ? 'expired' : 'active';
    var statusTxt = m.sealValid === false ? 'SEAL BROKEN' : frozen ? 'FROZEN' : rem.expired ? 'EXPIRED' : 'ACTIVE';

    var meta = el('div', { class: 'm-meta' },
      el('span', { class: 'm-status ' + statusCls, text: statusTxt }),
      el('span', { class: 'm-rail', title: 'The rail that executes an ALLOW. It is sealed into the mandate, so the agent cannot reroute its own payments.' },
        el('span', { text: procShort(m.processor) }), modeTag(procMode(m.processor))));
    if (!frozen) {
      var kill = el('button', { class: 'btn btn-danger btn-sm', text: 'Kill switch', title: 'Freeze this mandate now. Every payment from the agent is blocked until you reinstate it.',
        on: { click: function () { setFrozen(m.id, true); } } });
      kill.type = 'button'; kill.disabled = !!S.busy.freeze; kill.style.marginLeft = 'auto';
      meta.appendChild(kill);
    }
    body.appendChild(meta);

    if (m.sealValid === false) {
      body.appendChild(el('div', { class: 'frozen-banner' },
        el('strong', { text: 'Mandate seal does not verify' }),
        el('p', { text: 'The stored mandate was modified after it was issued. Every payment under it is blocked.' })));
    }
    if (frozen) {
      var re = el('button', { class: 'btn btn-primary', text: 'Reinstate agent', on: { click: function () { setFrozen(m.id, false); } } });
      re.type = 'button'; re.disabled = !!S.busy.freeze; re.style.justifySelf = 'start';
      body.appendChild(el('div', { class: 'frozen-banner', attrs: { role: 'alert' } },
        el('strong', { text: 'Agent frozen' }),
        el('p', { text: str(m.frozenReason, 300) || 'frozen' }),
        el('p', { class: 'sub', text: 'All payments under this mandate are refused until a human reinstates it.' }),
        re));
    }

    body.appendChild(el('p', { class: 'm-desc', text: str(m.description, 400) }));

    var spent = isNum(m.spent) ? m.spent : 0, total = isNum(m.budgetTotal) && m.budgetTotal > 0 ? m.budgetTotal : 0;
    var held = isNum(m.reserved) && m.reserved > 0 ? m.reserved : 0;
    var pct = total ? Math.max(0, Math.min(100, (spent / total) * 100)) : 0;
    var hpct = total ? Math.max(0, Math.min(100 - pct, (held / total) * 100)) : 0;
    var used = pct + hpct;
    var fill = el('span', { class: 'bar-spent' }); fill.style.width = pct.toFixed(1) + '%';
    var bar = el('div', { class: 'bar' + (used >= 100 ? ' full' : used >= 80 ? ' hot' : ''), attrs: { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(used), 'aria-label': 'Budget used, including reservations' } }, fill);
    if (held) {
      var hfill = el('span', { class: 'bar-held', title: money(held, m.currency) + ' reserved by payments that passed the firewall and are executing now' });
      hfill.style.width = Math.max(hpct, 1.5).toFixed(1) + '%';
      bar.appendChild(hfill);
    }
    var left = Math.max(0, Math.round((total - spent - held) * 100) / 100);
    body.appendChild(el('div', { class: 'budget' },
      el('div', { class: 'budget-top' },
        el('span', {}, el('span', { class: 'big', text: money(spent, m.currency) }), el('span', { class: 'of', text: '  spent of ' + money(m.budgetTotal, m.currency) })),
        el('span', { class: 'of', text: money(left, m.currency) + ' left' })),
      bar,
      held ? el('div', { class: 'budget-held' }, el('i'), el('span', { text: money(held, m.currency) + ' reserved in flight' })) : null));

    var dl = el('dl', { class: 'kv' });
    kvRow(dl, 'Processor', el('span', { class: 'kv-rail' }, el('span', { text: procShort(m.processor) }), modeTag(procMode(m.processor))));
    kvRow(dl, 'Policy', m.policy ? el('span', { class: 'mono', text: str(m.policy, 64) }) : el('span', { class: 'sub', text: 'none (custom mandate)' }));
    kvRow(dl, 'Mandate id', el('span', { class: 'mono', text: str(m.id, 40) }));
    kvRow(dl, 'Issued for', str(m.user, 80));
    kvRow(dl, 'Per-payment cap', money(m.perTxCap, m.currency));
    kvRow(dl, 'Recipients', tagList(m.allowedRecipients));
    var vl = m.velocityLimit || {}, br = m.breaker || {};
    kvRow(dl, 'Velocity limit', str(vl.count, 10) + ' payments per ' + str(vl.windowSec, 10) + 's');
    kvRow(dl, 'Circuit breaker', str(br.blocks, 10) + ' blocks in ' + str(br.windowSec, 10) + 's freezes the agent');
    kvRow(dl, 'Out of scope', el('span', {}, 'an ordinary purchase outside the purpose is ',
      el('b', { class: m.outOfScope === 'block' ? 'v-block' : 'v-review', text: scopeWord(m.outOfScope) })));
    if (Array.isArray(m.scope) && m.scope.length) kvRow(dl, 'Scope', tagList(m.scope, true));
    var exp = new Date(m.expiresAt);
    kvRow(dl, 'Expires', rem.text + (isNaN(exp.getTime()) ? '' : ' (' + exp.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) + ')'));
    kvRow(dl, 'Agent token', tokenFor(m.id) ? 'held in this tab; the lab acts as the agent' : 'not held by this tab');
    body.appendChild(dl);
  }

  // ---------------------------------------------------------------- attack lab
  function renderCards() {
    var wrap = clear($('cards'));
    cardRefs = {};
    if (!S.scenarios.length) { wrap.appendChild(el('p', { class: 'empty', text: 'No scenarios available.' })); return; }
    S.scenarios.forEach(function (sc) {
      var id = str(sc.id, 60);
      var attack = sc.category !== 'legit';
      var steps = Array.isArray(sc.steps) ? sc.steps : [];
      var count = steps.length === 1 ? '1 payment' : steps.length + (sc.concurrent ? ' at once' : ' payments');
      var btn = el('button', { class: 'btn btn-sm', text: 'Run', on: { click: function () { runScenario(sc); } } });
      btn.type = 'button';
      var out = el('div', { class: 'card-out', attrs: { 'aria-live': 'polite' } });
      var card = el('article', { class: 'card ' + (attack ? 'attack' : 'legit') },
        el('div', { class: 'card-k' }, el('span', { text: attack ? 'Attack' : 'Legitimate' }), el('span', { class: 'n', text: count })),
        el('h4', { text: str(sc.title, 120) }),
        el('p', { text: str(sc.blurb, 400) }),
        id === 'hijack' && S.poisoned ? el('pre', { text: S.poisoned.trim(), title: 'The poisoned listing the agent read. Shown as inert text.' }) : null,
        out,
        el('div', { class: 'card-f' },
          el('span', { class: 'expect' }, 'Expect', pill(sc.expect)),
          btn));
      wrap.appendChild(card);
      cardRefs[id] = { btn: btn, out: out };
      renderCardOut(id);
    });
    // Recipient suggestions for the craft form come from static scenario data.
    var dlst = clear($('recipient-list')), seen = {};
    S.scenarios.forEach(function (sc) {
      (sc.steps || []).forEach(function (st) {
        var r = str(st.recipient, 128);
        if (r && !seen[r]) { seen[r] = 1; var o = el('option'); o.value = r; dlst.appendChild(o); }
      });
    });
  }
  function resultPill(item) {
    if (item.error) return el('span', { class: 'card-note err', text: item.error });
    var p = pill(item.verdict, true);
    p.title = '#' + str(item.seq, 10) + '  ' + item.why + '  (click to open the trace)';
    p.addEventListener('click', function () { selectDecision(item.id); });
    return p;
  }
  function summarise(items) {
    var c = {}, frozen = false, order = ['ALLOW', 'BLOCK', 'REVIEW', 'ERROR'];
    items.forEach(function (i) { if (i.verdict) c[i.verdict] = (c[i.verdict] || 0) + 1; if (i.frozen) frozen = true; });
    var parts = order.filter(function (k) { return c[k]; }).map(function (k) { return c[k] + ' ' + k; });
    return parts.join(' · ') + (frozen ? ' · circuit breaker froze the agent' : '');
  }
  // "Only the intent layer caught this": the reason sentence, inline, with its source.
  function intentCallout(it) {
    var src = it.intent.source;
    var head = src === 'llm' ? 'Only the AI layer caught this' : 'Caught by the intent layer';
    var srcTitle = src === 'llm' ? 'Claude classified the purpose against the mandate; fixed policy turned that into the verdict.'
      : src === 'signature' ? 'A deterministic signature matched known hijack or cash-out language. No model can talk it back down.'
      : src === 'fallback' ? 'No model configured: the purpose was compared with the mandate scope vocabulary.' : '';
    return el('div', { class: 'intent-note ' + (it.verdict === 'REVIEW' ? 'is-review' : 'is-block') },
      el('div', { class: 'intent-h' }, el('span', { text: head }), src ? tag(src, 'src', srcTitle) : null),
      el('p', { text: it.intent.text || 'intent check' }));
  }
  function renderCardOut(id) {
    var ref = cardRefs[id]; if (!ref) return;
    var res = S.results[id];
    clear(ref.out);
    ref.btn.textContent = S.running[id] ? 'Running' : res ? 'Run again' : 'Run';
    if (!res) return;
    var shown = res.items.filter(function (it) { return !it.rate; });
    shown.forEach(function (it) { ref.out.appendChild(resultPill(it)); });
    var story = INTENT_STORY[id] && shown.length === 1 && shown[0].intent ? shown[0] : null;
    if (story) ref.out.appendChild(intentCallout(story));
    else if (shown.length > 1 && !S.running[id]) ref.out.appendChild(el('span', { class: 'card-note', text: summarise(shown) }));
    else if (shown.length === 1 && !shown[0].error) ref.out.appendChild(el('span', { class: 'card-note', text: shown[0].why }));
    if (res.note) ref.out.appendChild(el('span', { class: 'card-note warn', text: res.note }));
    if (res.error) ref.out.appendChild(el('span', { class: 'card-note err', text: res.error }));
  }
  function rateNote(items) {
    var hit = items.filter(function (i) { return i.rate; });
    if (!hit.length) return null;
    var done = items.length - hit.length;
    return 'Rate limit reached for this agent token' + (items.length > 1 ? ' (' + done + ' of ' + items.length + ' sent)' : '') + '. ' + hit[0].retry;
  }
  function toItem(r) {
    if (r.status === 401) return { error: 'Agent token rejected (401). Issue a new mandate.', fatal: true };
    var d = r.body || {};
    // /guard is rate limited per agent token. That is the firewall working, not a failure.
    if (r.status === 429) return { rate: true, fatal: true, retry: retryText(d) };
    if (r.status !== 200 || !d.id) return { error: str(d.error, 200) || ('HTTP ' + r.status) };
    var dr = decidingReason(d);
    var intent = null;
    if (dr && dr.layer === 'intent' && d.verdict !== 'ALLOW') intent = splitSource(dr.detail);
    return {
      id: d.id, seq: d.seq, verdict: str(d.verdict, 12), why: decidingText(d), intent: intent,
      frozen: Array.isArray(d.effects) && d.effects.indexOf('mandate_frozen') !== -1,
    };
  }
  function renderLabState() {
    var m = currentMandate();
    var tok = m ? tokenFor(m.id) : null;
    var hint = $('lab-hint');
    var anyRunning = Object.keys(S.running).some(function (k) { return S.running[k]; });
    if (!changed('lab', [m && m.id, !!tok, S.running, S.loaded, S.scenarios.length])) return;
    var off = !tok;
    $('h-lab').parentNode.parentNode.classList.toggle('is-off', off);
    hint.hidden = !off || !S.loaded;
    if (off) {
      hint.textContent = !m
        ? 'The lab is disabled: there is no mandate. Issue one from the Mandate panel to receive its agent token.'
        : 'The lab is disabled: this tab does not hold the agent token for ' + str(m.id, 40) + '. Tokens are shown once, when the mandate is created, and kept only in this tab. Issue a fresh mandate to continue.';
    }
    Object.keys(cardRefs).forEach(function (id) { cardRefs[id].btn.disabled = off || anyRunning; });
    $('craft-send').disabled = off || !!S.running.__craft;
    ['craft-amount', 'craft-recipient', 'craft-purpose'].forEach(function (i) { $(i).disabled = off; });
  }
  async function runScenario(sc) {
    var m = currentMandate(), tok = m && tokenFor(m.id), id = str(sc.id, 60);
    if (!tok || S.running[id]) return;
    var steps = (Array.isArray(sc.steps) ? sc.steps : []).map(function (s) {
      return { amount: s.amount, recipient: s.recipient, purpose: s.purpose };
    });
    S.running[id] = true;
    S.results[id] = { items: [], error: null, note: null };
    renderCardOut(id); renderLabState();
    try {
      if (sc.concurrent) {
        // Fired in the same tick: this is the race the per-mandate lock has to win.
        var rs = await Promise.all(steps.map(function (s) { return guard(tok, s); }));
        S.results[id].items = rs.map(toItem);
      } else {
        for (var i = 0; i < steps.length; i++) {
          var it = toItem(await guard(tok, steps[i]));
          S.results[id].items.push(it);
          renderCardOut(id);
          if (it.fatal) break;
        }
      }
    } catch (e) {
      S.results[id].error = 'Request failed: ' + str(e && e.message, 160);
    } finally {
      S.running[id] = false;
      S.results[id].note = rateNote(S.results[id].items);
      if (S.results[id].note) toast(S.results[id].note);
      renderCardOut(id);
      await refresh();
      renderLabState();
    }
  }
  async function sendCrafted(ev) {
    ev.preventDefault();
    var m = currentMandate(), tok = m && tokenFor(m.id);
    if (!tok || S.running.__craft) return;
    var rawAmt = $('craft-amount').value.trim();
    // Plain decimals go as numbers; anything else is sent verbatim so the schema layer has to deal with it.
    var amount = /^-?\d+(\.\d+)?$/.test(rawAmt) ? Number(rawAmt) : rawAmt;
    var payment = { amount: amount, recipient: $('craft-recipient').value, purpose: $('craft-purpose').value };
    var out = clear($('craft-out'));
    S.running.__craft = true; renderLabState();
    try {
      var it = toItem(await guard(tok, payment));
      if (it.rate) out.appendChild(el('span', { class: 'card-note warn', text: rateNote([it]) }));
      else if (it.error) out.appendChild(el('span', { class: 'card-note err', text: it.error }));
      else {
        out.appendChild(resultPill(it));
        out.appendChild(el('span', { class: 'mono', text: '#' + str(it.seq, 10) }));
        var w = it.intent ? it.intent.text : it.why;
        out.appendChild(el('span', { class: 'why', text: (it.intent ? 'intent: ' : '') + w + (it.frozen ? '  (circuit breaker froze the agent)' : '') }));
        if (it.intent && it.intent.source) out.appendChild(tag(it.intent.source, 'src'));
      }
    } catch (e) {
      out.appendChild(el('span', { class: 'card-note err', text: 'Request failed: ' + str(e && e.message, 160) }));
    } finally {
      S.running.__craft = false;
      await refresh();
      renderLabState();
    }
  }

  // ---------------------------------------------------------------- operator actions
  async function newMandate() {
    if (S.busy.issue) return;
    S.busy.issue = true; renderIssue();
    try {
      var body = {};
      if (S.issuePolicy) body.policy = S.issuePolicy;
      if (S.issueProcessor) body.processor = S.issueProcessor;
      var r = await opPost('/api/mandates', body);
      if (r && r.mandate && r.mandate.id && typeof r.agentToken === 'string') {
        ssSet(TOKEN_PREFIX + r.mandate.id, r.agentToken);   // shown once by the server; kept in this tab only
        S.selectedMandateId = r.mandate.id;
        toast('Mandate ' + str(r.mandate.id, 40) + ' issued on ' + procShort(r.mandate.processor)
          + (r.mandate.policy ? ' from policy ' + str(r.mandate.policy, 64) : '') + '. Its agent token is held in this tab.', true);
      }
    } catch (e) { toast('Could not issue mandate: ' + str(e.message, 200)); }
    S.busy.issue = false;
    await refresh();
    renderIssue();
  }
  async function resetDemo() {
    if (!window.confirm('Reset the demo? This wipes every mandate and the whole decision ledger.')) return;
    try {
      await opPost('/api/demo/reset', {});
      dropAllTokens();
      S.results = {}; S.selectedMandateId = null; S.selectedDecisionId = null;
      clear($('craft-out'));
      Object.keys(cardRefs).forEach(renderCardOut);
      if (gridApi) gridApi.deselectAll();
      toast('Demo reset.', true);
    } catch (e) { toast('Reset failed: ' + str(e.message, 200)); }
    await refresh();
    renderDetail(true);
  }
  async function setFrozen(id, freeze) {
    if (S.busy.freeze) return;
    S.busy.freeze = true; renderMandate();
    try { await opPost('/api/mandates/' + encodeURIComponent(id) + '/' + (freeze ? 'freeze' : 'reinstate'), {}); }
    catch (e) { toast((freeze ? 'Freeze' : 'Reinstate') + ' failed: ' + str(e.message, 200)); }
    S.busy.freeze = false;
    await refresh();
  }
  async function resolveReview(id, action) {
    var key = 'rev:' + id;
    if (S.busy[key]) return;
    S.busy[key] = true; renderReviews();
    try {
      var d = await opPost('/api/reviews/' + encodeURIComponent(id) + '/' + action, {});
      if (d && d.id) {
        if (action === 'deny') toast('Denied. Recorded as #' + str(d.seq, 10) + '; the processor was never called.', true);
        else if (d.verdict === 'ALLOW' && d.processor === 'external') toast('Approved and authorised as #' + str(d.seq, 10) + (d.paymentId ? ', ' + str(d.paymentId, 60) : '') + '. The caller executes it; Sentra does not verify that.', true);
        else if (d.verdict === 'ALLOW') toast('Approved and executed as #' + str(d.seq, 10) + (d.paymentId ? ', ' + procShort(d.processor) + ' payment ' + str(d.paymentId, 60) : '') + '.', true);
        else toast('Approved, but not executed (#' + str(d.seq, 10) + '): ' + decidingText(d));
        S.pendingSelectId = d.id;
      }
    } catch (e) { toast('Review ' + action + ' failed: ' + str(e.message, 200)); }
    delete S.busy[key];
    await refresh();
  }

  // ---------------------------------------------------------------- review queue
  function renderReviews() {
    var pend = pendingReviews();
    if (!changed('reviews', [pend.map(function (d) { return d.id; }), S.busy, processors()])) return;
    var sec = $('review');
    sec.hidden = pend.length === 0;
    var list = clear($('review-list'));
    $('review-sub').textContent = pend.length + (pend.length === 1 ? ' payment is' : ' payments are') + ' held. Nothing reaches a processor until a human approves; approval re-checks the mandate as it stands now.';
    pend.forEach(function (d) {
      var rq = d.request || {};
      var busy = !!S.busy['rev:' + d.id];
      var ok = el('button', { class: 'btn btn-allow btn-sm', text: 'Approve', on: { click: function () { resolveReview(d.id, 'approve'); } } });
      var no = el('button', { class: 'btn btn-danger btn-sm', text: 'Deny', on: { click: function () { resolveReview(d.id, 'deny'); } } });
      ok.type = no.type = 'button'; ok.disabled = no.disabled = busy;
      var why = decidingText(d);
      var seq = el('button', { class: 'd-close seq', text: '#' + str(d.seq, 10), title: 'Open the trace', on: { click: function () { selectDecision(d.id); } } });
      seq.type = 'button';
      list.appendChild(el('div', { class: 'review-item' },
        seq,
        el('span', { class: 'amt', text: money(rq.amount, rq.currency) }),
        el('span', { class: 'via', text: 'via ' + procShort(d.processor), title: 'Processor of the mandate this payment was made under' }),
        el('span', { class: 'mono', text: str(rq.recipient, 128), title: str(rq.recipient, 128) }),
        el('span', { class: 'pur', text: str(rq.purpose, 500), title: str(rq.purpose, 500) }),
        el('span', { class: 'why', text: why, title: why }),
        el('span', { class: 'acts' }, ok, no)));
    });
  }

  // ---------------------------------------------------------------- ledger (AG Grid)
  // Cell renderers return DOM nodes built with textContent. No HTML strings.
  function txtCell(text, cls) {
    var t = String(text);
    return el('span', { class: 'cell-txt' + (cls ? ' ' + cls : ''), text: t, title: t });
  }
  function initGrid() {
    var host = $('grid');
    if (!window.agGrid || typeof window.agGrid.createGrid !== 'function') {
      host.appendChild(el('p', { class: 'empty', text: 'AG Grid could not be loaded from cdn.jsdelivr.net, so the ledger table is unavailable. The rest of the console still works.' }));
      host.firstChild.style.padding = '16px';
      return;
    }
    var ag = window.agGrid;
    var theme;
    try {
      theme = ag.themeQuartz.withPart(ag.colorSchemeDark).withParams({
        backgroundColor: '#0f1319', foregroundColor: '#e4e8ee',
        headerBackgroundColor: '#0b0e13', headerTextColor: '#76808f',
        borderColor: '#1e2530', rowHoverColor: '#141a23', selectedRowBackgroundColor: '#1a2431',
        oddRowBackgroundColor: '#0f1319', accentColor: '#9db8ff',
        fontFamily: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Helvetica Neue', 'Arial', 'sans-serif'],
        fontSize: 12.5, headerFontSize: 10.5, headerFontWeight: 650,
        spacing: 6, rowHeight: 32, headerHeight: 32, cellHorizontalPadding: 12,
        wrapperBorder: false, wrapperBorderRadius: 0, columnBorder: false,
        browserColorScheme: 'dark',
      });
    } catch (e) { theme = undefined; }

    var columnDefs = [
      { colId: 'seq', headerName: '#', field: 'seq', width: 64, sort: 'desc', filter: 'agNumberColumnFilter', cellClass: 'cell-mono cell-muted' },
      { colId: 'time', headerName: 'Time', width: 86, filter: false,
        valueGetter: function (p) { return p.data ? str(p.data.createdAt, 40) : ''; },
        valueFormatter: function (p) { return p.value ? clock(p.value) : ''; },
        cellClass: 'cell-mono' },
      { colId: 'verdict', headerName: 'Verdict', field: 'verdict', width: 96,
        cellRenderer: function (p) { return pill(p.value); } },
      { colId: 'amount', headerName: 'Amount', width: 100, type: 'rightAligned', filter: 'agNumberColumnFilter',
        valueGetter: function (p) { var a = p.data && p.data.request ? p.data.request.amount : null; return isNum(a) ? a : null; },
        cellRenderer: function (p) {
          var d = p.data || {}, rq = d.request || {};
          if (d.kind === 'event') return txtCell('-', 'cell-muted');
          if (isNum(rq.amount)) return txtCell(money(rq.amount, rq.currency), rq.amount < 0 ? 'cell-bad' : '');
          return txtCell(str(rq.amount, 40) || '(none)', 'cell-bad cell-mono');   // malformed amount, shown verbatim as text
        } },
      { colId: 'recipient', headerName: 'Recipient', flex: 1.1, minWidth: 130,
        valueGetter: function (p) { return p.data && p.data.request ? str(p.data.request.recipient, 128) : ''; },
        cellRenderer: function (p) {
          var v = p.value || '';
          if (!v) return txtCell('-', 'cell-muted');
          var odd = nonAscii(v);
          if (!odd.length) return txtCell(v, 'cell-mono');
          // The warning goes first so it stays visible when the column is narrow.
          return el('span', { class: 'cell-flex' },
            el('span', { class: 'flag-uni', text: 'NON-ASCII', title: 'Look-alike risk. Unexpected characters: ' + odd.join(', ') }),
            txtCell(v, 'cell-mono'));
        } },
      { colId: 'purpose', headerName: 'Purpose', flex: 1.5, minWidth: 130,
        valueGetter: function (p) { return p.data && p.data.request ? str(p.data.request.purpose, 500) : ''; },
        cellRenderer: function (p) { return p.value ? txtCell(p.value) : txtCell('-', 'cell-muted'); } },
      { colId: 'deciding', headerName: 'Deciding check', flex: 2.2, minWidth: 210,
        valueGetter: function (p) { return p.data ? decidingText(p.data) : ''; },
        cellRenderer: function (p) {
          var d = p.data || {}, v = d.verdict;
          var stopped = v === 'BLOCK' || v === 'ERROR' || v === 'REVIEW';
          var r = stopped && d.kind !== 'event' ? decidingReason(d) : null;
          if (!r) return txtCell(p.value, stopped ? '' : 'cell-muted');
          return el('span', { class: 'cell-flex', title: p.value },
            el('span', { class: 'cell-layer l-' + (CORE_LAYERS[r.layer] ? r.layer : 'other'), text: layerName(r.layer) }),
            txtCell(p.value));
        } },
      { colId: 'risk', headerName: 'Risk', width: 92, filter: 'agNumberColumnFilter',
        valueGetter: function (p) { return p.data && isNum(p.data.riskScore) ? p.data.riskScore : null; },
        cellRenderer: function (p) {
          if (!isNum(p.value) || (p.data && p.data.kind === 'event')) return txtCell('-', 'cell-muted');
          var r = Math.max(0, Math.min(1, p.value));
          var bar = el('b'); bar.style.width = Math.round(r * 100) + '%';
          return el('span', { class: 'risk ' + (r >= 0.7 ? 'high' : r >= 0.35 ? 'med' : 'low'), title: 'Risk score ' + r.toFixed(2) + ' (0 to 1)' },
            el('i', {}, bar), el('span', { text: r.toFixed(2) }));
        } },
      { colId: 'processor', headerName: 'Processor', width: 104,
        valueGetter: function (p) { return p.data && p.data.processor ? procShort(p.data.processor) : ''; },
        cellRenderer: function (p) { return p.value ? txtCell(p.value) : txtCell('-', 'cell-muted'); } },
      { colId: 'payment', headerName: 'Payment id', width: 196,
        valueGetter: function (p) { return p.data ? str(p.data.paymentId, 80) : ''; },
        cellRenderer: function (p) {
          var d = p.data || {};
          if (d.kind === 'event') return txtCell('-', 'cell-muted');
          if (!p.value) return txtCell('not called', 'cell-muted');
          var mode = d.payment ? str(d.payment.mode, 20) : '';
          return el('span', { class: 'cell-flex' }, txtCell(p.value, 'cell-mono'),
            mode ? el('span', { class: 'cell-mode ' + modeClass(mode), text: modeWord(mode), title: MODE_TEXT[mode] || '' }) : null);
        } },
      { colId: 'paymentMode', headerName: 'Payment mode', hide: true,
        valueGetter: function (p) { return p.data && p.data.payment ? str(p.data.payment.mode, 20) : ''; } },
      { colId: 'latency', headerName: 'ms', width: 64, type: 'rightAligned', filter: 'agNumberColumnFilter',
        valueGetter: function (p) { return p.data && isNum(p.data.latencyMs) ? p.data.latencyMs : null; },
        cellClass: 'cell-mono cell-muted' },
      { colId: 'mandate', headerName: 'Mandate', width: 150, hide: true,
        valueGetter: function (p) { return p.data ? str(p.data.mandateId, 60) : ''; },
        cellRenderer: function (p) { return txtCell(p.value, 'cell-mono cell-muted'); } },
      { colId: 'decidedLayer', headerName: 'Decided by layer', hide: true,
        valueGetter: function (p) { return p.data && p.data.decidedBy ? str(p.data.decidedBy.layer, 30) : ''; } },
      { colId: 'id', headerName: 'Decision id', hide: true, valueGetter: function (p) { return p.data ? str(p.data.id, 80) : ''; } },
      { colId: 'prevHash', headerName: 'Prev hash', hide: true, valueGetter: function (p) { return p.data ? str(p.data.prevHash, 200) : ''; } },
      { colId: 'hash', headerName: 'Hash', hide: true, valueGetter: function (p) { return p.data ? str(p.data.hash, 200) : ''; } },
    ];

    gridApi = ag.createGrid(host, {
      theme: theme,
      columnDefs: columnDefs,
      defaultColDef: { sortable: true, resizable: true, filter: 'agTextColumnFilter', suppressHeaderMenuButton: false },
      rowData: [],
      getRowId: function (p) { return String(p.data.id); },      // rows update in place on each poll
      rowSelection: { mode: 'singleRow', checkboxes: false, enableClickSelection: true },
      rowClassRules: { 'row-event': function (p) { return !!p.data && p.data.kind === 'event'; } },
      isExternalFilterPresent: function () { return !!S.verdictFilter || !!S.procFilter; },
      doesExternalFilterPass: function (node) {
        var d = node.data;
        if (!d) return false;
        if (S.verdictFilter && d.verdict !== S.verdictFilter) return false;
        if (S.procFilter && d.processor !== S.procFilter) return false;
        return true;
      },
      suppressCellFocus: true,
      animateRows: false,
      enableCellTextSelection: true,
      overlayNoRowsTemplate: 'No decisions yet. Issue a mandate and run a scenario from the Attack Lab.',
      onModelUpdated: function () { updateLedgerCount(); },
      onSelectionChanged: function () {
        var rows = gridApi ? gridApi.getSelectedRows() : [];
        S.selectedDecisionId = rows.length ? rows[0].id : null;
        renderDetail(true);
      },
    });
  }
  function renderGrid() {
    if (!gridApi) return;
    var ds = S.decisions, last = ds.length ? ds[ds.length - 1] : null;
    if (changed('grid', [ds.length, last && last.hash, ds.length ? ds[0].id : null])) {
      gridApi.setGridOption('rowData', ds);
      updateLedgerCount();
      if (S.selectedDecisionId && !decisionById(S.selectedDecisionId)) { S.selectedDecisionId = null; renderDetail(true); }
    }
    if (S.pendingSelectId && decisionById(S.pendingSelectId)) {
      var id = S.pendingSelectId; S.pendingSelectId = null;
      selectDecision(id, true);
    }
  }
  function setVerdictFilter(v) {
    S.verdictFilter = v;
    var bs = $('verdict-filter').querySelectorAll('.seg-b');
    for (var i = 0; i < bs.length; i++) {
      var on = bs[i].getAttribute('data-v') === v;
      bs[i].classList.toggle('is-on', on);
      bs[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    if (gridApi) gridApi.onFilterChanged();
  }
  function setProcFilter(v) {
    S.procFilter = v;
    renderProcFilter();
    if (gridApi) gridApi.onFilterChanged();
  }
  // One button per processor the server reports, plus All.
  function renderProcFilter() {
    var ps = processors();
    if (S.procFilter && !procInfo(S.procFilter)) S.procFilter = '';
    if (!changed('pfilter', [ps, S.procFilter])) return;
    var host = clear($('proc-filter'));
    host.hidden = ps.length < 2;
    [{ name: '', label: 'All rails' }].concat(ps).forEach(function (p) {
      var on = p.name === S.procFilter;
      var b = el('button', { class: 'seg-b' + (on ? ' is-on' : ''), text: p.name ? procShort(p.name) : p.label,
        attrs: { 'data-p': p.name, 'aria-pressed': on ? 'true' : 'false' } });
      b.type = 'button';
      host.appendChild(b);
    });
  }
  function updateLedgerCount() {
    if (!gridApi) return;
    var shown = gridApi.getDisplayedRowCount(), all = S.decisions.length;
    $('ledger-sub').textContent = (shown === all ? all + (all === 1 ? ' entry' : ' entries') : shown + ' of ' + all + ' entries')
      + '. Append-only and hash-chained. Click a row for its full check trace.';
  }
  function selectDecision(id, quiet) {
    if (!id) return;
    if (!gridApi) { S.selectedDecisionId = id; renderDetail(true); return; }
    var d = decisionById(id);
    if (!d) { S.pendingSelectId = id; return; }
    if (S.verdictFilter && d.verdict !== S.verdictFilter) setVerdictFilter('');
    if (S.procFilter && d.processor !== S.procFilter) setProcFilter('');
    var node = gridApi.getRowNode(String(id));
    if (!node) { S.pendingSelectId = id; return; }
    if (!node.displayed) { $('quick').value = ''; gridApi.setGridOption('quickFilterText', ''); gridApi.setFilterModel(null); }
    node.setSelected(true, true);
    gridApi.ensureNodeVisible(node, 'middle');
    if (!quiet) $('detail').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  // CSV cells that start with a formula character are prefixed so a spreadsheet
  // never evaluates attacker-supplied text (CSV injection).
  function csvSafe(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return String(v);
    var s = String(v);
    return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  }
  function exportCsv() {
    if (!gridApi) return;
    gridApi.exportDataAsCsv({
      fileName: 'sentra-ledger-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.csv',
      allColumns: true,
      processCellCallback: function (p) {
        var id = p.column.getColId(), d = p.node && p.node.data;
        if (id === 'amount' && d && d.request) return csvSafe(d.request.amount);
        return csvSafe(p.value);
      },
    });
  }

  // ---------------------------------------------------------------- detail panel
  function resultMark(result) {
    var r = str(result, 12);
    var kind = (r === 'pass' || r === 'ok' || r === 'low') ? 'good'
      : (r === 'FAIL' || r === 'high' || r === 'error') ? 'bad'
      : (r === 'FLAG' || r === 'med') ? 'warn' : 'neutral';
    var label = r === 'error' ? 'ERR' : r || '?';
    return { kind: kind, node: el('span', { class: 'res ' + kind, text: label }) };
  }
  function hashRow(dl, k, v) {
    dl.appendChild(el('dt', { text: k }));
    dl.appendChild(el('dd', { text: shortHash(v), title: str(v, 200) }));
  }
  function renderDetail(force) {
    var host = $('detail');
    var d = S.selectedDecisionId ? decisionById(S.selectedDecisionId) : null;
    var res = d ? resolverOf(d.id) : null;
    if (!changed('detail', [d && d.id, res && res.id]) && !force) return;
    clear(host);
    host.parentNode.classList.toggle('has-detail', !!d);
    if (!d) {
      host.appendChild(el('div', { class: 'detail-empty' },
        el('strong', { text: 'No entry selected' }),
        el('span', { text: 'Select a row to see which checks ran, what each one found, and the hashes that chain the entry to the ledger.' })));
      return;
    }
    var rq = d.request || {};
    var close = el('button', { class: 'd-close', text: 'Close', on: { click: function () { if (gridApi) gridApi.deselectAll(); else { S.selectedDecisionId = null; renderDetail(true); } } } });
    close.type = 'button';
    var kindLabel = d.kind === 'review_resolution' ? 'review resolution' : d.kind === 'event' ? 'operator event' : 'payment';
    host.appendChild(el('div', { class: 'd-head' },
      pill(d.verdict), el('span', { class: 'seq', text: '#' + str(d.seq, 10) + '  ' + kindLabel }),
      el('span', { class: 'when', text: clock(d.createdAt), title: str(d.createdAt, 40) }), close));

    if (d.kind !== 'event') {
      var amt = el('div', { class: 'd-amt', text: money(rq.amount, rq.currency) });
      amt.appendChild(el('small', { text: isNum(rq.amount) ? str(rq.currency, 8) : 'malformed amount, shown as received' }));
      host.appendChild(amt);
      var rcp = str(rq.recipient, 128);
      host.appendChild(el('div', { class: 'd-to' }, 'to ', el('span', { class: 'mono', text: rcp || '(no recipient)' })));
      var odd = nonAscii(rcp);
      if (odd.length) host.appendChild(el('div', { class: 'd-note bad', text: 'Recipient contains characters outside printable ASCII (' + odd.join(', ') + '). It may look identical to a trusted id and still be a different account.' }));
      host.appendChild(el('div', { class: 'd-purpose', text: str(rq.purpose, 500) || '(no purpose given)' }));
    }

    if (d.verdict === 'REVIEW') {
      if (res) {
        var b = el('button', { text: '#' + str(res.seq, 10), on: { click: function () { selectDecision(res.id, true); } } }); b.type = 'button';
        host.appendChild(el('div', { class: 'd-note' }, 'Resolved by a human in entry ', b, ': ' + str(res.verdict, 12) + '.'));
      } else host.appendChild(el('div', { class: 'd-note warn', text: 'Held. Waiting for a human in the review queue; the processor has not been called.' }));
    }
    if (d.resolves) {
      var orig = decisionById(d.resolves);
      var ob = el('button', { text: orig ? '#' + str(orig.seq, 10) : str(d.resolves, 60), on: { click: function () { selectDecision(d.resolves, true); } } }); ob.type = 'button';
      host.appendChild(el('div', { class: 'd-note' }, 'Resolves held payment ', ob, '. The original entry is never edited.'));
    }
    if (Array.isArray(d.effects) && d.effects.indexOf('mandate_frozen') !== -1 && d.kind === 'payment') {
      host.appendChild(el('div', { class: 'd-note bad', text: 'This block tripped the circuit breaker: the mandate was frozen.' }));
    }

    // ---- what decided it
    var by = d.kind !== 'event' && d.verdict !== 'ALLOW' ? decidingReason(d) : null;
    if (by) {
      var parts = splitSource(by.detail);
      host.appendChild(el('div', { class: 'd-by' },
        el('div', { class: 'd-by-h' }, el('span', { text: 'Decided by' }),
          el('span', { class: 'cell-layer l-' + (CORE_LAYERS[by.layer] ? by.layer : 'other'), text: layerName(by.layer) }),
          el('span', { class: 'mono', text: str(by.check, 80) }),
          by.layer === 'intent' && parts.source ? tag(parts.source, 'src') : null),
        parts.text ? el('p', { text: parts.text }) : null));
    } else if (d.kind !== 'event' && d.verdict === 'ALLOW') {
      host.appendChild(el('div', { class: 'd-by is-pass' },
        el('div', { class: 'd-by-h' }, el('span', { text: 'Decided by' }), el('span', { class: 'mono', text: 'no check stopped it' }))));
    }

    // ---- check trace, grouped by layer
    var reasons = Array.isArray(d.reasons) ? d.reasons : [];
    var groups = {}, extra = [];
    reasons.forEach(function (r) {
      if (!r) return;
      var k = str(r.layer, 30) || 'other';
      if (!groups[k]) { groups[k] = []; if (!LAYERS.some(function (l) { return l[0] === k; })) extra.push([k, k]); }
      groups[k].push(r);
    });
    var sec = el('div', { class: 'd-sec' });
    var hd = el('h3', {}, el('span', { text: 'Check trace' }), el('span', { text: reasons.length + (reasons.length === 1 ? ' check' : ' checks') }));
    sec.appendChild(hd);
    LAYERS.concat(extra).forEach(function (l) {
      var rs = groups[l[0]];
      if (!rs && !(CORE_LAYERS[l[0]] && d.kind === 'payment')) return;
      var g = el('div', { class: 'trace-layer' }, el('h4', { text: l[1] }));
      if (!rs) { g.appendChild(el('p', { class: 'empty', text: 'No checks recorded for this layer.' })); g.lastChild.style.padding = '0'; }
      else {
        var ul = el('ul', { class: 'trace' });
        rs.forEach(function (r) {
          var m = resultMark(r.result);
          var isDecider = !!by && r.layer === by.layer && r.check === by.check;
          ul.appendChild(el('li', { class: (m.kind === 'bad' ? 'is-bad' : m.kind === 'warn' ? 'is-warn' : '') + (isDecider ? ' is-decider' : '') }, m.node,
            el('span', {}, el('span', { class: 'chk', text: str(r.check, 80) }), el('span', { class: 'det', text: str(r.detail, 600) }))));
        });
        g.appendChild(ul);
      }
      sec.appendChild(g);
    });
    host.appendChild(sec);

    // ---- payment: what the processor (if any) did
    if (d.kind !== 'event') {
      var pay = d.payment && typeof d.payment === 'object' ? d.payment : null;
      var ps = el('div', { class: 'd-sec' }, el('h3', {}, el('span', { text: 'Payment' }), el('span', { text: procShort(d.processor) })));
      if (pay || d.paymentId) {
        pay = pay || {};
        var pmode = str(pay.mode, 20);
        var external = pmode === 'external' || d.processor === 'external';
        var dl = el('dl', { class: 'dkv' });
        var row = function (k, v, cls) {
          dl.appendChild(el('dt', { text: k }));
          if (typeof v === 'string') dl.appendChild(el('dd', { class: cls || '', text: v, title: v })); else dl.appendChild(el('dd', { class: 'dd-node' }, v));
        };
        row('Processor', procLabel(pay.processor || d.processor));
        row(external ? 'Auth id' : 'Payment id', str(pay.id || d.paymentId, 80));
        row('Status', str(pay.status, 40) || '-');
        row('Mode', pmode ? modeTag(pmode) : '-');
        row('Verified', external || pay.verified !== true
          ? (external ? 'not verified by Sentra' : pay.verified === false ? 'no' : '-')
          : (pmode === 'simulated' ? 'yes (simulated result)' : 'yes, amount and currency read back'),
          external || pay.verified === false ? 'dd-warn' : '');
        ps.appendChild(dl);
        if (external) ps.appendChild(el('p', { class: 'empty', text: 'Authorise only. Sentra approved and recorded this payment; the caller executes it on its own rail. No processor confirmed it to Sentra.' }));
      } else {
        ps.appendChild(el('p', { class: 'empty', text:
          d.verdict === 'BLOCK' ? 'Not called. A blocked payment never reaches the processor.'
          : d.verdict === 'REVIEW' ? 'Not called. Held until a human approves.'
          : d.verdict === 'ERROR' ? 'The processor call failed. No payment, and the budget was not debited.'
          : 'No payment recorded.' }));
        ps.lastChild.style.padding = '0';
      }
      host.appendChild(ps);
    }

    // ---- chain
    var cs = el('div', { class: 'd-sec' }, el('h3', {}, el('span', { text: 'Tamper-evident chain' })));
    var cdl = el('dl', { class: 'dkv' });
    hashRow(cdl, 'Prev hash', d.prevHash);
    hashRow(cdl, 'Entry hash', d.hash);
    var meta = function (k, v) { cdl.appendChild(el('dt', { text: k })); cdl.appendChild(el('dd', { text: v, title: v })); };
    meta('Entry id', str(d.id, 80));
    meta('Mandate', str(d.mandateId, 60));
    if (d.processor) meta('Processor', procLabel(d.processor));
    if (d.intentSource) meta('Intent by', str(d.intentSource, 40));
    if (isNum(d.latencyMs)) meta('Latency', d.latencyMs + ' ms');
    cs.appendChild(cdl);
    cs.appendChild(el('p', { class: 'empty', text: 'The entry hash covers this entry and the previous hash, so editing any earlier entry breaks every hash after it.' }));
    host.appendChild(cs);
    host.scrollTop = 0;
  }

  // ---------------------------------------------------------------- wiring
  function renderAll() {
    renderChips();
    renderStats();
    renderMandateSelect();
    renderMandate();
    renderLabState();
    renderReviews();
    renderGrid();
    renderDetail(false);
  }
  function init() {
    initGrid();
    renderDetail(true);
    $('btn-new-mandate').addEventListener('click', newMandate);
    $('btn-reset').addEventListener('click', resetDemo);
    $('craft').addEventListener('submit', sendCrafted);
    $('btn-csv').addEventListener('click', exportCsv);
    $('quick').addEventListener('input', function (e) { if (gridApi) gridApi.setGridOption('quickFilterText', e.target.value); });
    $('proc-filter').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.seg-b') : null;
      if (b) setProcFilter(b.getAttribute('data-p') || '');
    });
    $('policy-select').addEventListener('change', function (e) { S.issuePolicy = e.target.value || null; renderIssue(); });
    $('proc-toggle').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.seg-b') : null;
      if (b) { S.issueProcessor = b.getAttribute('data-p'); renderIssue(); }
    });
    renderIssue();
    $('verdict-filter').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.seg-b') : null;
      if (b) setVerdictFilter(b.getAttribute('data-v') || '');
    });
    $('mandate-select').addEventListener('change', function (e) {
      S.selectedMandateId = e.target.value;
      renderMandateSelect(); renderMandate(); renderLabState();
    });
    loadScenarios();
    refresh();
    setInterval(refresh, POLL_MS);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
