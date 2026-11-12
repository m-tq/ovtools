/**
 * Validator Management System - browser runtime (deploy / migrate / manage a node)
 * =========================================
 * Talks to the ovtools API:
 *   GET  /api/config            hosts, phase catalogue, artifacts
 *   GET  /api/state             current phase / progress / exit code
 *   GET  /api/nodes?old&new     live chain + membership of both nodes
 *   GET  /api/log/stream        SSE tail of the running phase (plus history)
 *   POST /api/run  /api/cancel
 *
 * Design notes
 *  - one action: POST /api/run {phase:'auto'} runs the whole pipeline
 *    (preconditions -> migration -> dashboard deploy). There is no per-step
 *    runner in the UI - the backend owns the order, the page only mirrors it.
 *  - all values are written with textContent (node output never becomes markup)
 *  - the console is an operator tool: the pipeline goes through a typed
 *    confirmation, and the UI never guesses - it mirrors the backend state
 *  - a dropped SSE connection is expected on long phases; the stream resumes
 *    from the last sequence number without duplicating rows
 */
(function () {
  'use strict';

  var POLL_STATE_MS = 2000;
  var POLL_NODES_MS = 10000;
  var MAX_ROWS = 1500;
  var PROGRAMS = ['deploy', 'migrate', 'manage'];

  var state = {
    cfg: null,
    program: 'migrate',          // 'migrate' | 'deploy' | 'manage' (three programs)
    runner: null,
    seq: 0,
    rows: 0,
    // deploy / migrate / manage never share data: the log, the node cards and the
    // error counters of one tab must not show up in another (2026-11-03 report:
    // the migrate log showed the deploy run and the host chips)
    logs: { deploy: [], migrate: [], manage: [] },
    errors: { deploy: 0, migrate: 0, manage: 0 },
    nodesByProgram: { deploy: null, migrate: null, manage: null },
    logLevel: 'all',
    logQuery: '',
    logPaused: false,
    hostFilter: 'all',
    hosts: [],
    es: null,
    confirm: null,
    check: null,
    checkLoaded: false,
    nodes: { src: null, dst: null },
    lastStatePoll: 0,
    // `startedAt` of the run THIS page has seen running. /api/state also returns
    // the run the console still remembers from an earlier session, and that one
    // must never drive the UI (see finishedNodeRun).
    runWatch: null,
    // id of the activation the console already told us about (the modal opens once
    // per activation, even though /api/state keeps returning it)
    seenActivation: null,
    // ...and the id of the exit report already shown (pending -> done is a new id)
    seenExit: null
  };

  /* - DOM helpers - */
  /* Two dashboards, one code path. The migrate dashboard keeps the original ids;
     the deploy dashboard uses the same names with a `d-` prefix. `$(id)` resolves
     the element of the *active* program, so every shared helper (setText, val,
     badge, progress, check rendering) works for both without branching. */
  var ID_MAP = {
    'inp-old': 'd-inp-ip', 'inp-new': 'd-inp-ip',
    'inp-old-pass': 'd-inp-pass', 'inp-new-pass': 'd-inp-pass',
    'inp-old-auth': 'd-inp-auth', 'inp-new-auth': 'd-inp-auth',
    'inp-old-key': 'd-inp-key', 'inp-new-key': 'd-inp-key',
    'inp-role': 'd-role',
    'btn-check': 'd-btn-check',
    'check-result': 'd-check-result', 'check-list': 'd-check-list',
    'check-badge': 'd-check-badge', 'check-badge-text': 'd-check-badge-text',
    'check-dot': 'd-check-dot', 'check-summary': 'd-check-summary',
    'check-age': 'd-check-age', 'check-actions': 'd-check-actions',
    'progress-wrap': 'd-progress-wrap', 'phase-gauge': 'd-gauge',
    'phase-label': 'd-phase-label', 'phase-pct': 'd-phase-pct',
    'phase-rate': 'd-phase-rate', 'phase-status': 'd-phase-status',
    'phase-idle': 'd-phase-idle', 'phase-exit': 'd-phase-exit',
    'btn-run-all': 'd-btn-start', 'btn-status': 'd-btn-status',
    'dash-result': 'd-dash-result'
  };

  /* The manage dashboard is a single-host panel too, so it reuses the same ids
     with an `m-` prefix. `amount` is the only manage-specific field. */
  var MANAGE_MAP = {
    "input-target": "m-inp-ip",
    "auth-target": "m-inp-pass",
    "inp-new": "m-inp-ip", "inp-new-pass": "m-inp-pass",
    "inp-new-auth": "m-inp-auth", "inp-new-key": "m-inp-key",
    "inp-bond-amount": "m-inp-bond-amount",
    "action-note": "m-action-note",
    "btn-check": "m-btn-check",
    "check-result": "m-check-result", "check-list": "m-check-list",
    "check-badge": "m-check-badge", "check-badge-text": "m-check-badge-text",
    "check-summary": "m-check-summary", "check-age": "m-check-age",
    "check-actions": "m-check-actions",
    "progress-wrap": "m-progress-wrap", "phase-gauge": "m-gauge",
    "phase-label": "m-phase-label", "phase-pct": "m-phase-pct",
    "phase-rate": "m-phase-rate", "phase-status": "m-phase-status",
    "phase-idle": "m-phase-idle", "phase-exit": "m-phase-exit",
    "dash-result": "m-dash-result"
  };

  function $(id) {
    var mapped = (state.program === 'deploy' && ID_MAP[id]) ? ID_MAP[id] : null;
    if (!mapped) {
      mapped = (state.program === 'manage' && MANAGE_MAP[id]) ? MANAGE_MAP[id] : null;
    }
    return document.getElementById(mapped || id);
  }

  function panelId(id) { return document.getElementById(id); }

  var PROGRAM_KEY = 'octra-console-program';   // the dashboard the operator used last

  function setText(id, value) {
    var node = $(id);
    if (!node) return;
    var next = (value === undefined || value === null || value === '') ? '-' : String(value);
    if (node.textContent !== next) node.textContent = next;
  }

  function val(id) {
    var node = $(id);
    return node ? String(node.value || '').trim() : '';
  }

  function badge(id, variant, text) {
    var node = $(id);
    if (!node) return;
    node.classList.remove('v2-badge--ok', 'v2-badge--warn', 'v2-badge--err', 'v2-badge--brand');
    if (variant) node.classList.add(variant);
    var label = node.querySelector('span:last-child');
    if (label && text !== undefined) label.textContent = text;
  }

  function fmtElapsed(sec) {
    if (!sec && sec !== 0) return '-';
    var m = Math.floor(sec / 60), s = sec % 60;
    return m > 0 ? m + 'm ' + s + 's' : s + 's';
  }

  /* the operator asked for minutes, not 2,402s: `35s`, `12m`, `1h 30m` */
  function fmtMinutes(sec) {
    var value = Number(sec);
    if (!isFinite(value) || value < 0) return '-';
    if (value < 90) return Math.round(value) + 's';
    var m = Math.round(value / 60);
    if (m < 60) return m + 'm';
    return Math.floor(m / 60) + 'h ' + ('0' + (m % 60)).slice(-2) + 'm';
  }

  function fmtInt(v) {
    if (v === null || v === undefined || v === '') return '-';
    var n = Number(v);
    return isFinite(n) ? n.toLocaleString('en-US') : String(v);
  }

  /* ledger amount: the node speaks raw units with 6 decimals (1 OCT = 1e6),
     exactly like dashboard/server.py: TOKEN_DECIMALS = 6 */
  function fmtToken(v) {
    if (v === null || v === undefined || v === '') return '-';
    var n = Number(v);
    if (!isFinite(n)) return String(v);
    return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 6 });
  }

  function getJSON(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error(body && body.error ? body.error : 'HTTP ' + r.status);
        return body;
      });
    });
  }

  function postJSON(url, payload) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {})
    }).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error(body && body.error ? body.error : 'HTTP ' + r.status);
        return body;
      });
    });
  }

  function tip(anchor, text, kind) {
    if (window.SynteqV2 && SynteqV2.tip) SynteqV2.tip(anchor, text, { kind: kind || 'ok' });
  }

  /* - config & phase catalogue - */
  /* "same credential as source" only exists on Migrate (that checkbox lives in
     the migrate panel and is checked by default). Deploy and Manage have ONE host
     of their own, so the flag must never mirror an empty source credential into
     their password field - that is what made Check report "no password typed
     for <ip>" while the field was filled (2026-11-03). */
  function samePass() {
    if (state.program !== 'migrate') { return false; }
    var box = $('chk-same-pass');
    return !!(box && box.checked);
  }


  function syncPasswordFields() {
    if (state.program !== 'migrate') {
      // a single credential per dashboard: nothing to mirror, never disabled
      var select = $('inp-new-auth');
      var own = $('inp-new-pass');
      if (own) { own.disabled = false; own.placeholder = 'root password'; }
      // the eye belongs to this dashboard (data-eye on its auth select), so the
      // hidden migrate one is never touched
      var eyeId = select && select.getAttribute ? select.getAttribute('data-eye') : null;
      var ownEye = eyeId ? document.getElementById(eyeId) : null;
      if (ownEye) { ownEye.disabled = false; }
      return;
    }
    var target = $('inp-new-pass');
    if (!target) return;
    var same = samePass();
    target.disabled = same;
    if (same) target.value = '';
    target.placeholder = same ? 'same as source' : 'root password';
    // the eye button follows the field: disabled (and re-masked) when the target
    // mirrors the source password
    var eye = $('btn-new-pass-eye');
    if (eye) {
      eye.disabled = same;
      if (same) setPassVisible(target, eye, false);
    }
  }

  /* - auth method per host: password | ssh key (OpenSSH) ------------------- */
  /* Only two methods exist any more (Pageant is gone). Everything an auth row
     needs is on the <select> itself (data-keybox / data-keytext / data-pass /
     data-eye / data-mirror-source), so the handler works from the element that
     changed - not from the panel that happened to be open when the page booted. */
  function syncAuthRow(select) {
    if (!select || !select.getAttribute) return;
    var keyId = select.getAttribute('data-key');
    var boxId = select.getAttribute('data-keybox');
    var textId = select.getAttribute('data-keytext');
    var passId = select.getAttribute('data-passfield');
    var eyeId = select.getAttribute('data-eye');
    var mirrorId = select.getAttribute('data-mirror-source');

    var keyBox = boxId ? document.getElementById(boxId) : null;
    var keyInput = keyId ? document.getElementById(keyId) : null;
    var keyText = textId ? document.getElementById(textId) : null;
    var passInput = passId ? document.getElementById(passId) : null;
    var eye = eyeId ? document.getElementById(eyeId) : null;

    // "same credential as source" mirrors the method and the key path
    var mirrored = false;
    var src = null;
    if (mirrorId && samePass()) {
      src = document.getElementById(mirrorId);
      if (src) {
        select.value = src.value === 'key' ? 'key' : 'password';
        mirrored = true;
      }
    }
    select.disabled = mirrored;
    var method = select.value === 'key' ? 'key' : 'password';

    if (keyBox) keyBox.hidden = method !== 'key';
    if (keyInput) {
      if (mirrored) {
        var srcKey = src ? document.getElementById(src.getAttribute('data-key')) : null;
        keyInput.value = srcKey ? String(srcKey.value || '') : '';
      }
      keyInput.disabled = mirrored;
    }
    if (keyText) {
      keyText.disabled = mirrored;
      if (mirrored) keyText.value = '';
    }
    if (passInput) {
      passInput.disabled = mirrored || method !== 'password';
      passInput.placeholder = mirrored ? 'same as source'
        : (method === 'password' ? 'root password' : 'ssh key auth - no password');
    }
    if (eye) {
      eye.disabled = !!(passInput && passInput.disabled);
      if (eye.disabled) setPassVisible(passInput, eye, false);
    }
  }

  function syncAuthFields(side) {
    var select = $('inp-' + side + '-auth');
    if (select) syncAuthRow(select);
  }

  function syncAllAuthFields() {
    for (var i = 0; i < AUTH_SELECTS.length; i++) {
      var select = document.getElementById(AUTH_SELECTS[i]);
      if (select) syncAuthRow(select);
    }
  }

  /* the four auth method selectors (one per host row, one per program panel) */
  var AUTH_SELECTS = ['d-inp-auth', 'inp-old-auth', 'inp-new-auth', 'm-inp-auth'];

  /* select id -> is it an auth method selector? */
  function isAuthSelect(id) {
    return /^(d|m)-inp-auth$/.test(id) || /^inp-(old|new)-auth$/.test(id);
  }

  function syncAllAuthFields() {
    syncAuthFields('old');
    syncAuthFields('new');
  }

  /* - password show/hide ------------------------------------------- */
  function setPassVisible(input, button, visible) {
    if (!input) return;
    input.type = visible ? 'text' : 'password';
    if (!button) return;
    var label = button.getAttribute('data-pass-label') || 'password';
    button.setAttribute('aria-pressed', String(visible));
    button.setAttribute('aria-label', (visible ? 'Hide ' : 'Show ') + label);
    button.title = visible ? 'Hide ' + label : 'Show ' + label;
  }

  function wirePassToggles() {
    var buttons = document.querySelectorAll('[data-pass]');
    for (var i = 0; i < buttons.length; i++) {
      (function (button) {
        // the auth <select> used to carry data-pass and showed a "password
        // visible" tip when the dropdown was clicked: never treat a SELECT as an
        // eye button (the selects use data-passfield now)
        if (button.tagName === 'SELECT') return;
        button.addEventListener('click', function () {
          var input = $(button.getAttribute('data-pass'));
          if (!input) return;
          // state comes from aria-pressed, not from input.type: a browser can
          // switch the type itself (autofill) and the button must still work
          var visible = button.getAttribute('aria-pressed') !== 'true';
          setPassVisible(input, button, visible);
          tip(button, visible ? 'Password visible' : 'Password hidden', visible ? 'warn' : 'ok');
        });
      })(buttons[i]);
    }
  }

  /* The tools that operate ONE host (no source/target pair): Deploy and Manage.
     Their log chips and node labels must never say "SRC". */
  function oneHostProgram(program) {
    var p = program || state.program;
    return p === 'deploy' || p === 'manage';
  }

  /* Manage has no source side at all: the pair keeps a single address (the server
     keys the check on it). Deploy reuses its own field for both, which the server
     ignores. */
  function noSourceProgram(program) {
    var p = program || state.program;
    return p === 'manage';
  }

  function pair() {
    var oldPassword = val('inp-old-pass');
    var oldAuth = authOf('inp-old-auth', 'inp-old-key');
    var newAuth = authOf('inp-new-auth', 'inp-new-key');
    // "same credential as source" mirrors the method *and* the key path
    var same = samePass();
    if (same) {
      newAuth = { method: oldAuth.method, key: oldAuth.key || '' };
    }
    var oneHost = noSourceProgram();
    return {
      program: state.program,
      // manage/upgrade operate ONE host: there is no source, so the pair keeps a
      // single address (the server keys its check on that)
      oldIp: oneHost ? '' : val('inp-old'),
      newIp: val('inp-new'),
      oldPassword: oneHost ? '' : oldPassword,
      newPassword: same ? oldPassword : val('inp-new-pass'),
      oldAuth: oneHost ? 'password' : oldAuth.method,
      newAuth: newAuth.method,
      oldKey: oneHost ? '' : oldAuth.key,
      newKey: newAuth.key,
      sameAuth: same
    };
  }

  function authOf(selectId, keyId) {
    var select = $(selectId);
    var method = select ? String(select.value || 'password') : 'password';
    var key = method === 'key' ? val(keyId) : '';
    if (method === 'key' && !key) { method = 'password'; }   // no key typed yet
    return { method: method, key: key };
  }

  /* Remember the last host pair (never the passwords) so a reload keeps the
     node panel useful instead of showing dashes. */
  var HOSTS_KEY = 'octra-mc-hosts';

  function rememberHosts() {
    if (state.program !== 'migrate') { return; }   // deploy/manage: single host of their own
    try {
      localStorage.setItem(HOSTS_KEY, JSON.stringify({
        oldIp: val('inp-old'),
        newIp: val('inp-new')
      }));
    } catch (err) { /* private mode */ }
  }

  function restoreHosts() {
    if (state.program !== 'migrate') { return; }
    try {
      var raw = localStorage.getItem(HOSTS_KEY);
      if (!raw) return;
      var saved = JSON.parse(raw);
      var oldInput = $('inp-old');
      var newInput = $('inp-new');
      if (saved && saved.oldIp && oldInput) oldInput.value = saved.oldIp;
      if (saved && saved.newIp && newInput) newInput.value = saved.newIp;
    } catch (err) { /* ignore malformed state */ }
  }

  /* -- gating ------------------------------------------------------- */
  function busy() {
    return !!(state.runner && state.runner.running);
  }

  function setNodeTitle(node, why) {
    if (!node.hasAttribute('data-base-title')) {
      node.setAttribute('data-base-title', node.getAttribute('title') || '');
    }
    if (why) {
      node.title = why;
      return;
    }
    var base = node.getAttribute('data-base-title');
    if (base) node.title = base;
    else node.removeAttribute('title');
  }

  function setDisabled(id, disabled, why) {
    var node = $(id);
    if (!node) return;
    node.disabled = !!disabled;
    setNodeTitle(node, disabled && why ? why : '');
  }

  function applyGating() {
    var running = busy();
    setDisabled('btn-run-all', running, 'A phase is already running');
    setDisabled('btn-check', running, 'A phase is already running');
    setDisabled('btn-status', running, 'A phase is already running');
    setDisabled('btn-swap', running, 'A phase is already running');
    setDisabled('btn-run-rollback', running || !checkOk(),
      running ? 'A phase is already running' : 'Press Check first - rollback is destructive');
    // the manage dashboard has no single "run" button: gate its actions
    if (state.program === 'manage') {
      var ready = checkOkFor('manage');          // bond/exit: the ACTIVE validator
      var readyUp = checkOkFor('upgrade');       // update/manual: an updatable node
      ['m-btn-bond', 'm-btn-exit'].forEach(function (id) {
        var node = panelId(id);
        if (!node) return;
        node.disabled = running || !ready;
        setNodeTitle(node, running ? 'A phase is already running'
          : (!ready ? 'Press Check first - the node must be the active validator' : ''));
      });
      // Update node and Manual update rebuild and restart the node: they need the
      // update half of the Check (checkout, tools, disk, identity).
      ['m-btn-upgrade', 'm-btn-manual'].forEach(function (id) {
        var node = panelId(id);
        if (!node) return;
        node.disabled = running || !readyUp;
        setNodeTitle(node, running ? 'A phase is already running'
          : (!readyUp ? 'Press Check first - the node must be reachable and updatable' : ''));
      });
      // prune / monitor / status do not restart the node: they only need an idle console
      // Diagnose is read-only (evidence only) and Fix stuck node is the repair path
      // for a node that is NOT healthy - both must work when Check fails, which is
      // why they are not gated on a passing sweep.
      ['m-btn-storage', 'm-btn-dashboard', 'm-btn-status', 'm-btn-diagnose', 'm-btn-recover'].forEach(function (id) {
        var node = panelId(id);
        if (!node) return;
        node.disabled = running;
        setNodeTitle(node, running ? 'A phase is already running' : '');
      });
    }
  }

  /* -- precondition check ---------------------------------------- */
  /* The key must be EXACTLY what the server caches (server.py: "deploy|ip",
     "manage|ip", "old|new" for migrate). It used to be "program|old|new" for
     every program, so checkOk() never matched and the gated actions (manage
     bond/exit, migrate rollback) could never be enabled. */
  function checkKey() {
    var p = pair();
    if (state.program === 'migrate') { return p.oldIp + '|' + p.newIp; }
    return state.program + '|' + p.newIp;
  }

  function invalidateCheck() {
    var res = $('check-result');
    if (res) res.hidden = true;
    state.check = null;
    state.checkLoaded = false;
    applyGating();
  }

  function checkOk() {
    var c = state.check;
    if (!c || !c.result || !c.result.ready) return false;
    return c.key === checkKey();
  }

  /* The Manage tab gates its actions apart: bond/exit need an ACTIVE validator,
     the update actions only need a node that can be updated (its checkout, its
     tools, the disk). The server sends both flags with the check; an older server
     without them falls back to the overall verdict. */
  function checkOkFor(kind) {
    if (!checkOk()) return false;
    var r = state.check.result;
    if (kind === 'upgrade') return r.readyUpgrade !== false;
    return r.readyManage !== false;
  }

  function renderCheck(check) {
    var res = $('check-result');
    if (!res) return;
    if (!check || !check.result) { res.hidden = true; return; }
    var r = check.result;
    // a check belongs to the dashboard that ran it
    if ((r.program || 'migrate') !== state.program) { res.hidden = true; return; }
    res.hidden = false;

    setText('check-badge-text', r.ready
      ? (state.program === 'deploy' ? 'ready to deploy'
        : (state.program === 'manage' ? 'ready to manage' : 'ready to migrate'))
      : 'not ready');
    badge('check-badge', r.ready ? 'v2-badge--ok' : 'v2-badge--err');
    setText('check-summary', r.counts.ok + ' ok - ' + r.counts.warn + ' warn - ' + r.counts.fail +
      ' fail - ' + r.durationMs + ' ms');
    // one program, one set of hosts: the deploy/manage programs check a single
    // VPS, so "src -> dst" (which then reads 1.2.3.4 -> 1.2.3.4) is migrate only
    var route = 'target ' + r.targetIp;
    if (state.program === 'manage') { route = 'node ' + r.targetIp; }
    if (state.program === 'migrate' && r.sourceIp && r.sourceIp !== r.targetIp) {
      route = r.sourceIp + ' -> ' + r.targetIp;
    }
    setText('check-age', route);

    var list = $('check-list');
    if (!list) return;
    list.textContent = '';
    r.items.forEach(function (item) {
      var row = document.createElement('div');
      row.className = 'mc-check__row mc-check__row--' + item.status;

      var st = document.createElement('span');
      st.className = 'mc-check__status';
      st.textContent = String(item.status || '').toUpperCase();

      var label = document.createElement('span');
      label.className = 'mc-check__label';
      label.textContent = item.label;

      var detail = document.createElement('span');
      detail.className = 'mc-check__detail v2-mono';
      detail.textContent = item.detail || '';
      if (item.detail) detail.title = item.detail;

      row.appendChild(st);
      row.appendChild(label);
      row.appendChild(detail);
      list.appendChild(row);
    });

    // host-key mismatch (e.g. after a VPS re-install) needs an explicit action
    var actions = $('check-actions');
    if (actions) {
      actions.textContent = '';
      var pending = r.needsTrust || [];
      actions.hidden = pending.length === 0;
      pending.forEach(function (ip) {
        var hint = document.createElement('span');
        hint.className = 'mc-check__hint';
        hint.textContent = ip + ' presents a new host key (typical after a re-install) - the console ' +
          'could not auto-trust it, so confirm it here.';

        var btn = document.createElement('button');
        btn.className = 'v2-btn v2-btn--primary';
        btn.type = 'button';
        btn.textContent = 'Trust host key for ' + ip;
        btn.addEventListener('click', function () {
          openConfirm({
            id: 'trust',
            label: 'Trust host key for ' + ip,
            desc: 'PuTTY has a different key cached for ' + ip + '. Accepting replaces the cached key ' +
                  'with the fingerprint this server presents right now. Only continue if you ' +
                  're-installed that VPS yourself.',
            confirm: 'TRUST'
          }, { action: 'trust', ip: ip });
        });

        actions.appendChild(hint);
        actions.appendChild(btn);
      });
    }
  }

  function runCheck(anchor) {
    var p = pair();
    if (state.program === 'manage') {
      if (!p.newIp) { tip(anchor, 'Fill the node host first', 'err'); return; }
    } else if (!p.oldIp || !p.newIp) {
      tip(anchor, 'Fill source and target first', 'err');
      return;
    }
    var btn = anchor || $('btn-check');
    if (btn) btn.disabled = true;
    var res = $('check-result');
    if (res) res.hidden = false;
    setText('check-badge-text', 'checking...');
    badge('check-badge', 'v2-badge--warn');
    setText('check-summary', (state.program === 'deploy'
      ? 'probing the target over SSH and the node API'
      : 'probing both hosts over SSH and the node API'));
    setText('check-age', state.program === 'deploy'
      ? 'target ' + p.newIp
      : p.oldIp + ' -> ' + p.newIp);

    postJSON('/api/check', p).then(function (body) {
      state.check = body.check;
      state.checkLoaded = true;
      renderCheck(body.check);
      applyGating();
      tip(btn, body.check.result.ready ? 'All checks passed' : 'Check found blockers',
        body.check.result.ready ? 'ok' : 'err');
    }).catch(function (err) {
      state.check = null;
      applyGating();
      setText('check-badge-text', 'check failed');
      badge('check-badge', 'v2-badge--err');
      setText('check-summary', err.message);
      tip(btn, err.message, 'err');
    }).then(function () {
      if (btn) btn.disabled = false;
    });
  }


  /* - runner state - */
  /* Bottom-right of the navigation: the console state in ONE word (the phase
     detail stays in the topbar badge). Same split as the monitor's dock badge. */
  function setDockStatus(word, variant) {
    setText('dock-status-text', word);
    badge('dock-status', variant);
    var host = $('dock-status');
    if (host) host.title = 'Console state: ' + word;
    var dot = $('dock-dot');
    if (dot) {
      dot.classList.remove('v2-dot--ok', 'v2-dot--warn', 'v2-dot--err', 'v2-dot--idle');
      dot.classList.add(variant === 'v2-badge--ok' ? 'v2-dot--ok'
        : variant === 'v2-badge--warn' ? 'v2-dot--warn'
          : variant === 'v2-badge--err' ? 'v2-dot--err' : 'v2-dot--idle');
    }
  }

  function renderRoute() {
    var node = $('hero-route-text');
    if (!node) return;
    var runner = state.runner || {};
    if (state.program !== 'migrate') {
      // deploy, manage and upgrade watch ONE host: it is always the target, so the
      // log chips and the route must never label it "SRC"
      var only = (runner.program === state.program && runner.newIp) ? runner.newIp : val('inp-new');
      node.textContent = only || '-';
      if (only) noteHost(only);
      return;
    }
    var from = runner.oldIp || val('inp-old');
    var to = runner.newIp || val('inp-new');
    node.textContent = (from && to) ? (from + ' -> ' + to) : '-';
    if (from) noteHost(from);
    if (to) noteHost(to);
  }

  function renderRunner(s) {
    state.runner = s;
    if (s.domain) {
      state.settings = state.settings || {};
      state.settings.dashboardDomain = s.domain;
      syncMonitorDomainField(false);
    }
    var running = !!s.running;
    // which run this page is following (a finished run from an earlier session
    // arrives through /api/state too, and must not drive the UI), then what the
    // Project-settings row offers
    noteRunWatch(s);
    syncDashboardGate();
    // Follow a phase that is RUNNING right now (the dashboard of the program that
    // is actually working). A finished run of another program must NOT drag the
    // operator back to that tab - that is how the deploy log/host chips used to
    // appear under Migrate (2026-11-03).
    if (running && s.program && s.program !== state.program) {
      state.program = s.program;
      renderProgram();
    }
    var mine = !s.program || s.program === state.program;
    // a pipeline pause always ends with one question: the enrollment top-up
    if (!running && s.awaiting && mine) { showAwaitPrompt(s.awaiting); }
    // the console watched the chain admit this validator: tell the operator once,
    // whatever the run is doing (it can arrive hours after the run ended)
    if (mine && s.activation) { showActivation(s.activation); }
    // ...and the same for an exit: the moment the stake is back, and the schedule
    // (unlock epoch + how far away) as soon as the chain recorded the exit
    if (mine && s.exitInfo) { showExit(s.exitInfo); }

    var finished = mine && s.exitCode !== null && s.exitCode !== undefined;
    // the console can be watching the set fold for a finished run: say so instead
    // of "idle" (the log keeps its own progress lines)
    var watching = !running && s.watching && s.watching.ip;
    var leaving = !running && s.exitWatching && s.exitWatching.ip;
    var dockWord = running ? 'Running'
      : (leaving ? 'Waiting'
        : (watching ? 'Watching'
          : (finished ? (s.exitCode === 0 ? 'Done' : 'Failed') : 'Idle')));
    var dockTone = running || leaving || watching ? 'v2-badge--warn'
      : (finished ? (s.exitCode === 0 ? 'v2-badge--ok' : 'v2-badge--err') : '');
    setDockStatus(dockWord, dockTone);
    setText('topbar-status-text', running ? s.phase + ' running'
      : (finished ? (s.exitCode === 0 ? 'completed' : 'failed') : 'idle'));
    badge('topbar-status', running ? 'v2-badge--warn'
      : (finished ? (s.exitCode === 0 ? 'v2-badge--ok' : 'v2-badge--err') : ''));

    setText('hero-state-text', running ? 'running ' + (s.step || s.phase)
      : (leaving ? 'waiting for the stake to unlock (' + s.exitWatching.ip + ')'
        : (watching ? 'watching for the set fold (' + s.watching.ip + ')'
          : (finished ? (s.exitCode === 0 ? 'last phase ok' : 'last phase failed') : 'idle'))));
    badge('hero-state-badge', running || watching || leaving ? 'v2-badge--warn'
      : (finished ? (s.exitCode === 0 ? 'v2-badge--ok' : 'v2-badge--err') : ''));
    renderRoute();
    setText('hero-elapsed', mine && s.startedAt ? fmtElapsed(s.elapsedSec) : '-');

    $('btn-stop').disabled = !running;
    applyGating();
    if (!mine) {
      // another program's run: keep its progress out of this panel
      var idleWrap = $('progress-wrap');
      if (idleWrap && !running) { idleWrap.hidden = true; }
      return;
    }
    renderDashboard(s);

    var wrap = $('progress-wrap');
    if (wrap) wrap.hidden = !(running || s.progress || s.status);
    var pct = s.progress && typeof s.progress.pct === 'number' ? s.progress.pct : 0;
    setText('phase-pct', pct);
    // bytes - rate - eta: the sync reports done/total, so the console can say how
    // many minutes are left instead of only a percentage
    var rateText = '-';
    if (s.progress) {
      rateText = s.progress.bytes + ' - ' + s.progress.rate;
      if (s.progress.eta) { rateText += ' - ' + s.progress.eta; }
    }
    setText('phase-rate', rateText);
    setText('phase-label', s.label ? ('[' + s.label.ip + '] ' + s.label.label) : (s.phase || 'idle'));
    setText('phase-status', s.status ? ('status = ' + s.status.state + (s.status.detail ? ' ' + s.status.detail : '')) : '-');
    setText('phase-idle', running && typeof s.idleSec === 'number' && s.idleSec >= 30
      ? 'quiet for ' + fmtMinutes(s.idleSec)
      : '');
    setText('phase-exit', s.exitCode === null || s.exitCode === undefined ? '' : 'exit ' + s.exitCode);
    var gauge = $('phase-gauge');
    if (gauge) gauge.setAttribute('aria-valuenow', String(pct));
    var fill = document.querySelector('#phase-gauge .v2-gauge__fill');
    if (fill && window.SynteqV2 && SynteqV2.renderGauge) SynteqV2.renderGauge(fill, pct, { kind: 'brand' });
  }

  /* - dashboard result (deployed in its own run, after the pause) - */
  function renderDashboard(s) {
    var box = $('dash-result');
    if (!box) return;
    if (s.program && s.program !== state.program) { box.hidden = true; return; }
    if (s.running) return;                                    // nothing final to show
    if (s.phase !== 'auto' && s.phase !== 'dashboard') return;
    if (s.exitCode === null || s.exitCode === undefined) return;
    box.hidden = false;
    box.textContent = '';
    if (s.exitCode !== 0) {
      box.className = 'mc-result mc-result--err';
      box.textContent = 'Pipeline stopped with exit ' + s.exitCode +
        ' - the monitoring dashboard was NOT deployed. Fix the error, then start again.';
      return;
    }
    var host = s.domain || s.newIp;
    box.className = 'mc-result mc-result--ok';
    box.textContent = s.phase === 'dashboard'
      ? 'Monitoring dashboard live on https://' + host + '/ - node ' + s.newIp
      : 'Validator live on ' + s.newIp + ' - monitoring dashboard: https://' + host + '/';
  }

  function pollState() {
    return getJSON('/api/state').then(function (body) {
      state.lastStatePoll = Date.now();
      setText('live-age', 'live');
      renderRunner(body.state);
      // adopt a check the server already has (page reload, second tab, or the
      // precondition step of the running pipeline) - but only when it belongs to
      // the program on screen, otherwise Migrate would inherit Deploy's check
      var srvCheck = body.check;
      var known = (state.check && state.check.ts) || 0;
      if (srvCheck && srvCheck.result && (!state.checkLoaded || (srvCheck.ts || 0) > known)
          && (srvCheck.result.program || 'migrate') === state.program) {
        state.checkLoaded = true;
        state.check = srvCheck;
        renderCheck(srvCheck);
        applyGating();
      }
      safetyChecks();
    }).catch(function (err) {
      setText('live-age', 'offline');
      setText('topbar-status-text', 'console offline');
      badge('topbar-status', 'v2-badge--err');
      setDockStatus('Offline', 'v2-badge--err');
      console.warn('state poll failed', err);
    });
  }

  /* - node state - */
  function membershipText(n) {
    if (!n.reachable) return 'unreachable';
    if (n.active) return 'active';
    if (n.scheduled) return 'scheduled';
    return 'not member';
  }

  function renderNode(prefix, n) {
    var slot = prefix === 'src' ? 'src' : 'dst';
    state.nodes[slot] = n || null;
    if (!n) {
      // no probe (yet) for this tab: show dashes instead of another program's host
      ['-ip', '-epoch', '-head', '-membership', '-nextset', '-enroll', '-bond', '-foot']
        .forEach(function (suffix) { setText(prefix + suffix, '-'); });
      setText(prefix + '-state-text', 'unknown');
      badge(prefix + '-state', '');
      return;
    }
    setText(prefix + '-ip', n.ip);
    setText(prefix + '-epoch', fmtInt(n.epoch));
    setText(prefix + '-head', n.head_epoch ? 'head ' + fmtInt(n.head_epoch) : '-');
    setText(prefix + '-membership', membershipText(n));
    setText(prefix + '-nextset', n.next_set_epoch ? 'next set ' + fmtInt(n.next_set_epoch) : '-');
    setText(prefix + '-enroll', n.enrollment || '-');
    setText(prefix + '-bond', n.bondOct === null || n.bondOct === undefined
      ? '-'
      : fmtToken(n.bondOct) + ' OCT bonded');
    setText(prefix + '-foot', n.address ? n.address : (n.error || '-'));

    var variant = n.active ? 'v2-badge--ok' : (n.reachable ? 'v2-badge--warn' : 'v2-badge--err');
    var text = n.state === 'validator' ? 'validator'
      : n.state === 'scheduled' ? 'scheduled'
      : n.state === 'ready-idle' ? 'ready (idle)'
      : n.state === 'unreachable' ? 'unreachable' : 'observer';
    setText(prefix + '-state-text', text);
    badge(prefix + '-state', variant);
  }

  function pollNodes() {
    var p = pair();
    // migrate watches two hosts; deploy and manage watch one (the source card is
    // hidden there, so asking for it would only poll a stale address)
    var oldIp = state.program === 'migrate' ? p.oldIp : '';
    var newIp = p.newIp;
    if (!newIp) { return Promise.resolve(); }
    var query = '/api/nodes?new=' + encodeURIComponent(newIp) +
      (oldIp ? '&old=' + encodeURIComponent(oldIp) : '');
    return getJSON(query)
      .then(function (body) {
        var nodes = body.nodes || [];
        var srcNode = oldIp ? (nodes[0] || null) : null;
        var dstNode = oldIp ? (nodes[1] || null) : (nodes[0] || null);
        state.nodesByProgram[state.program] = { src: srcNode, dst: dstNode };
        state.nodes.src = srcNode;
        state.nodes.dst = dstNode;
        renderNode('src', srcNode);
        renderNode('dst', dstNode);
        setText('nodes-meta', 'updated ' + new Date().toLocaleTimeString());
        safetyChecks();
      })
      .catch(function (err) { console.warn('node probe failed', err); });
  }


  /* -- enroll popup: the deploy pauses after verify, the node wallet exists and
        enrolling spends the bond, so the operator funds the address first ------ */
  function showEnrollPrompt(awaiting) {
    var modal = $('enroll-modal');
    if (!modal || !awaiting || awaiting.action !== 'enroll') return;
    var ip = awaiting.ip || '';
    if (!modal.hidden && modal.dataset.ip === ip) return;   // already on screen
    modal.dataset.ip = ip;
    setText('enroll-address', awaiting.address || 'unknown - read wallet.json on the host');
    var bondInput = $('enroll-bond');
    if (bondInput) {
      // the popup speaks OCT; the server keeps the raw amount. The form has no
      // bond field any more, so a -Bond given on the command line (or a re-run)
      // is the only source besides the default of 1 OCT.
      var raw = Number(awaiting.bond) || 0;
      var oct = raw > 0 ? Math.max(1, Math.round(raw / 1000000)) : 1;
      bondInput.value = String(oct);
    }
    var funded = $('enroll-funded');
    if (funded) { funded.checked = false; }
    var ok = $('enroll-ok');
    if (ok) { ok.disabled = true; }
    setText('enroll-note', awaiting.address ? ''
      : 'wallet address unknown - check the host before enrolling');
    modal.hidden = false;
    if (funded) funded.focus();
  }

  function closeEnroll() {
    var modal = $('enroll-modal');
    if (modal) { modal.hidden = true; }
  }

  function submitEnroll() {
    var amount = Number(val('enroll-bond')) || 0;
    var fundedBox = $('enroll-funded');
    if (amount <= 0) {
      setText('enroll-note', 'Enter the enroll amount in whole OCT (minimum 1).');
      return;
    }
    if (!fundedBox || !fundedBox.checked) {
      setText('enroll-note', 'Tick the top-up confirmation first.');
      return;
    }
    var meta = phaseMeta('enroll');
    if (!meta) { setText('enroll-note', 'console config not loaded yet'); return; }
    var payload = buildPayload('enroll');
    var modal = $('enroll-modal');
    if (modal && modal.dataset.ip) { payload.newIp = modal.dataset.ip; }
    payload.role = 'validator';
    payload.bondOct = amount;                 // OCT - the server converts to raw
    payload.funded = true;
    payload.confirm = meta.confirm || 'ENROLL';
    closeEnroll();
    postRun(payload, meta, null);
  }

  /* -- the enroll popup and the activation popup are the only two pauses --------
     The dashboard host name is asked in the Manage tab's own modal (Deploy
     monitor), so there is no domain popup here any more (2026-11-05). --------- */

  /* -- activation popup: the console watched the chain admit the validator ------
     A deploy/migrate run does not fail because the set fold has not happened yet:
     it reports "scheduled for epoch X" and keeps watching. The moment the node
     reports validator_active = true (in the run or from the background watch, long
     after it) this opens by itself, so nobody has to poll controls/stat.sh. ------ */
  function showActivation(activation) {
    var modal = $('activation-modal');
    if (!modal || !activation || !activation.ip) return;
    if (state.seenActivation === activation.id) return;      // already shown
    state.seenActivation = activation.id;
    setText('activation-node', activation.ip);
    setText('activation-epoch', activation.epoch ? String(activation.epoch) : 'not reported');
    var bond = Number(activation.bond) || 0;
    setText('activation-note', bond > 0
      ? 'Bond: ' + (bond / 1000000) + ' OCT (raw ' + bond + ').'
      : '');
    modal.hidden = false;
  }

  function closeActivation() {
    var modal = $('activation-modal');
    if (modal) { modal.hidden = true; }
  }

  /* -- the exit popup: when the stake comes back --------------------------------
     An exit is a chain deadline, not a finished job. The step reports the epoch
     the chain recorded the exit at, the epoch the bond unlocks and how far away
     that is; the console then follows the unbonding in the background (the host
     retries the withdrawal every 15 minutes by itself) and this popup opens again
     the moment validator_bond reaches 0 - nobody re-runs a phase or polls a
     script. `info.id` changes only when the answer really changes (pending ->
     done, or a new exit), so a poll does not reopen it. --------------------- */
  function showExit(info) {
    var modal = $('exit-state-modal');
    if (!modal || !info || !info.ip) return;
    if (state.seenExit === info.id) return;                 // already shown
    state.seenExit = info.id;
    var done = !!info.done;
    setText('exit-state-title', done ? 'Stake is back' : 'Exit accepted');
    setText('exit-state-text', done
      ? 'The bond left the registry: the stake is back in the validator wallet.'
      : 'The validator left the set. The stake unlocks at the epoch below - there is nothing to do on your side.');
    setText('exit-state-node', info.ip);
    setText('exit-state-epoch', info.exit_epoch ? String(info.exit_epoch) : 'not recorded yet');
    setText('exit-state-unlock', info.withdraw_epoch ? String(info.withdraw_epoch) : 'not reported yet');
    setText('exit-state-remaining', (info.remaining === null || info.remaining === undefined)
      ? '-' : String(info.remaining) + ' epoch(s)');
    setText('exit-state-eta', done ? 'done' : (info.eta || 'unknown yet'));
    if (done) {
      clearNote('exit-state-note');
    } else {
      setText('exit-state-note', 'The console keeps following this in the background (the host withdraws the '
        + 'stake by itself) and opens this popup again when the funds are back.');
    }
    modal.hidden = false;
  }

  function closeExitReport() {
    var modal = $('exit-state-modal');
    if (modal) { modal.hidden = true; }
  }

  /* the pause the pipeline stopped on decides which popup opens */
  function showAwaitPrompt(awaiting) {
    if (!awaiting) return;
    showEnrollPrompt(awaiting);
  }

  /* - safety banner - */
  function safetyChecks() {
    var box = $('safety-alert');
    if (!box || !state.cfg) return;
    var notes = [];
    if (state.program === 'manage') {
      // critical, one host: the node must be the voting validator
      var metaM = programMeta();
      if (metaM && !metaM.orchestratorPresent) {
        notes.push(['err', (metaM.orchestrator || 'the manage assets') + ' are missing.']);
      }
      if (state.cfg && state.cfg.bondIncreasePresent === false) {
        notes.push(['err', 'bond_inc.sh is missing in the project root - the increase cannot run.']);
      }
      var node = state.nodes.dst;
      if (node && node.reachable && !node.active) {
        notes.push(['warn', 'this node is not an active validator - the manage program operates the host that votes.']);
      }
    }
    if (state.program === 'manage') {
      // the update actions live in this tab too: the console must have the
      // orchestrator they run through
      if (state.cfg && state.cfg.upgradeOrchestratorPresent === false) {
        notes.push(['err', 'the update assets are missing - the update actions cannot run.']);
      }
      var nodeM = state.nodes.dst;
      if (nodeM && nodeM.reachable && nodeM.active) {
        notes.push(['warn', 'this node is the ACTIVE validator: an update restarts it, so it is offline for a few minutes.']);
      }
    }
    if (state.program !== 'manage') {
      var deploy = state.program === 'deploy';
      var oldIp = deploy ? '' : val('inp-old');
      var newIp = val('inp-new');
      var meta = programMeta();

      if (meta && !meta.orchestratorPresent) {
        notes.push(['err', (meta.orchestrator || 'orchestrator') + ' is missing.']);
      }
      if (oldIp && newIp && oldIp === newIp) notes.push(['err', 'source and target are the same host.']);
      var src = state.nodes.src;
      if (!deploy && src && src.reachable && !src.active) {
        notes.push(['warn', 'source is not an active validator (membership: ' + membershipText(src) + ').']);
      }
      var dst = state.nodes.dst;
      if (!deploy && dst && dst.reachable && (dst.active || dst.scheduled)) {
        notes.push(['warn', 'target already runs a validator - "prep" will refuse (freshness guard).']);
      }
      if (deploy && dst && dst.reachable && dst.active) {
        notes.push(['warn', 'the target already runs a node - deploy is for a fresh VPS.']);
      }
    }

    if (notes.length === 0) { box.hidden = true; box.textContent = ''; return; }
    box.hidden = false;
    box.textContent = '';
    notes.forEach(function (item) {
      var row = document.createElement('div');
      row.className = 'mc-alert__row mc-alert__row--' + item[0];
      row.textContent = item[1];
      box.appendChild(row);
    });
  }

  /* - approval modal: one click, no typing --------------------------- */
  /* The phase catalogue still carries a word (DEPLOY, MIGRATE, ...) for the
     CLI and the API, but the console only asks the operator to approve. */
  function openConfirm(meta, payload) {
    state.confirm = { meta: meta, payload: payload };
    setText('confirm-title', meta.label);
    var text = $('confirm-text');
    if (text) { text.textContent = meta.desc; }
    var target = payload.action === 'trust'
      ? (payload.ip || '')
      : (payload.oldIp && payload.oldIp !== payload.newIp
        ? payload.oldIp + ' -> ' + payload.newIp : payload.newIp);
    var risk = (meta.risk === 'critical' ? 'DESTRUCTIVE - ' : 'Runs on - ') + target;
    if (payload.action === 'trust') { risk = 'Host key for ' + target + ' - only accept a key you expect.'; }
    if (meta.id === 'switch' || meta.id === 'auto' || meta.id === 'all') {
      risk += '. The source node will STOP and go offline.';
    }
    setText('confirm-risk', risk);
    $('confirm-modal').hidden = false;
    var ok = $('confirm-ok');
    if (ok) { ok.disabled = false; ok.focus(); }
  }

  function closeConfirm() {
    state.confirm = null;
    $('confirm-modal').hidden = true;
  }

  function submitConfirm() {
    if (!state.confirm) return;
    var payload = Object.assign({}, state.confirm.payload);
    var meta = state.confirm.meta;
    payload.approved = true;                   // the click IS the confirmation
    payload.confirm = meta.confirm || '';      // kept for CLI-compatible clients
    closeConfirm();
    if (payload.action === 'trust') {
      trustHost(payload.ip, null);
      return;
    }
    postRun(payload, meta);
  }

  /* - project settings (swap) ------------------------------------------- */
  /* The data store is detected and formatted by the program itself, so there is
     nothing to type for it; the monitoring dashboard moved to the Manage active
     node tab (its own modal), so this section only carries the swap size. */
  function fillSettings(settings) {
    settings = settings || {};
    state.settings = settings;
    if ($('set-swap')) { $('set-swap').value = String(settings.swapGB); }
    syncMonitorDomainField(false);
    syncDashboardGate();
  }

  /* The "dashboard is off" row and the follow-up logic below share one idea: it is
     an ACTION row, never something to read while filling the form. */
  /* Which run is the one this page is following: the server keeps the last run in
     memory, so a page opened later (or a reload) receives a *finished* run from a
     previous session through /api/state. Watching means: this page saw it running.
     A different run that was never seen running clears the marker again. */
  function noteRunWatch(s) {
    if (s.running) { state.runWatch = s.startedAt; return; }
    if (state.runWatch !== s.startedAt) { state.runWatch = null; }
  }

  /* Phases that BUILD or MOVE a node. The dashboard deploy is deliberately not one
     of them: once the monitoring UI is online there is nothing left to offer. */
  var BUILD_PHASES = { deploy: true, enroll: true, auto: true, all: true };

  /* The row under Project settings is a *pointer*, not a form field: it says where
     monitoring, bond and exit live now that a deploy/migrate run does not touch the
     dashboard at all (2026-11-05). It appears only after a node-building run that
     finished successfully *while this page was open* (2026-11-04 report: the console
     remembered a finished deploy of an older session and the row was there the moment
     the app was opened, before any address was typed). */
  function finishedNodeRun() {
    var run = state.runner;
    if (!run || run.running || run.exitCode !== 0) return null;
    if (run.awaiting && run.awaiting.action) return null;        // paused for a popup
    if (run.program !== 'deploy' && run.program !== 'migrate') return null;
    if (!run.newIp) return null;
    if (!state.runWatch || state.runWatch !== run.startedAt) return null;
    if (!BUILD_PHASES[run.phase]) return null;                   // 'dashboard' = published
    return run;
  }

  function syncDashboardGate() {
    var row = panelId('settings-off');
    if (!row) return;
    var run = finishedNodeRun();
    row.hidden = !run;
    if (!run) return;
    setText('dash-off-host', run.newIp);
  }

  /* host the follow-up row acts on: the finished run, else what is typed */
  function gateHost() {
    var run = finishedNodeRun();
    return (run && run.newIp) || val('inp-new');
  }

  /* Typing an address invalidates the check; it is no longer a gate condition. */
  function bindHostInputs() {
    ['d-inp-ip', 'inp-new', 'm-inp-ip'].forEach(function (id) {
      var input = document.getElementById(id);
      if (!input || input.__hostBound) return;
      input.__hostBound = true;
      input.addEventListener('input', function () {
        invalidateCheck();
        if (state.program === 'migrate') { rememberHosts(); }
      });
    });
  }

  function loadSettings() {
    return getJSON('/api/settings').then(function (body) {
      fillSettings(body.settings);
    }).catch(function (err) { console.warn('settings load failed', err); });
  }

  function saveSettings(anchor) {
    var previous = state.settings || {};
    var body = {
      swapGB: Number(val('set-swap')),
      // kept server-side with their defaults: the form no longer asks for them
      dataDevice: previous.dataDevice || '/dev/sdb',
      dataMinGB: previous.dataMinGB || 1000
    };
    postJSON('/api/settings', body).then(function (res) {
      fillSettings(res.settings);
      syncDashboardGate();
      tip(anchor, 'Settings saved');
      setText('settings-meta', 'saved ' + new Date().toLocaleTimeString() +
        ' - swap ' + res.settings.swapGB + ' GB');
    }).catch(function (err) {
      tip(anchor, err.message, 'err');
    });
  }

  /* A 404 from these helper endpoints means the console process is older than
     the page (the route only exists in the new server.py): say that instead of
     leaving the operator with a bare "unknown endpoint". */
  function endpointError(err, what) {
    var msg = String((err && err.message) || 'request failed');
    if (/404|unknown endpoint/i.test(msg)) {
      return 'the console runs an older server - restart it and try ' + what + ' again';
    }
    return msg;
  }

  /* -- file picking ------------------------------------------------------ */
  /* Browsers never reveal a path, so every picker ends the same way: the file
     text is read here and the server stores it (tmp/keys/, tmp/certs/) and
     answers with the path the orchestrator receives. The dialog is the
     browser's own: a native dialog opened by the console process is created but
     never activated (Windows refuses the foreground to a background process),
     which is why "Browse" used to look dead. */
  var pendingFilePick = null;

  function browserPicksDirectories() {
    try {
      return 'webkitdirectory' in document.createElement('input');
    } catch (err) { return false; }
  }

  function readFileText(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { reject(new Error('cannot read ' + ((file && file.name) || 'that file'))); };
      reader.readAsText(file);
    });
  }

  /* Open one of the hidden inputs; `onFiles` runs with the chosen FileList. */
  function openFilePicker(inputId, onFiles) {
    var input = document.getElementById(inputId);
    if (!input || typeof input.click !== 'function') return false;
    pendingFilePick = { input: input, onFiles: onFiles };
    input.value = '';
    input.click();
    return true;
  }

  function bindFilePickers() {
    ['inp-key-pick', 'inp-cert-dir'].forEach(function (id) {
      var input = document.getElementById(id);
      if (!input || input.__pickBound) return;
      input.__pickBound = true;
      input.addEventListener('change', function () {
        var pending = pendingFilePick;
        pendingFilePick = null;
        if (!pending || pending.input !== input) return;
        var files = [];
        var list = input.files || [];
        for (var i = 0; i < list.length; i++) { files.push(list[i]); }
        if (files.length) pending.onFiles(files);
      });
    });
  }


  /* -- SSH key: pick a file on this machine, or paste the key text ------- */
  /* The Browse button opens the *browser's* file dialog (always in front) and
     the key text is sent to /api/keyfile, which stores it 0600 under tmp/keys/
     and answers with the path the orchestrator receives. The native picker of
     the console process stays as the fallback. */
  function pickKey(anchor, input) {
    var target = (anchor && anchor.getAttribute('data-key')) || '';
    var field = input || (target ? document.getElementById(target) : null);
    var opened = openFilePicker('inp-key-pick', function (files) {
      readFileText(files[0]).then(function (text) {
        return postJSON('/api/keyfile', { text: text });
      }).then(function (res) {
        if (field) field.value = res.path;
        invalidateCheck();
        tip(anchor, 'Key stored at ' + res.path);
      }).catch(function (err) {
        tip(anchor, endpointError(err, 'the key file'), 'err');
      });
    });
    if (opened) return;
    postJSON('/api/pickkey', {}).then(function (res) {
      if (res.path) {
        if (field) { field.value = res.path; }
        invalidateCheck();
        tip(anchor, 'Key selected');
      } else {
        tip(anchor, res.error || 'no file picked', 'warn');
      }
    }).catch(function (err) { tip(anchor, endpointError(err, 'the key picker'), 'err'); });
  }

  function saveKeyText(area, keyInput) {
    var text = area ? String(area.value || '') : '';
    if (!text.trim()) return;
    postJSON('/api/keyfile', { text: text }).then(function (res) {
      if (keyInput) { keyInput.value = res.path; }
      invalidateCheck();
      setText('settings-meta', 'key stored at ' + res.path);
    }).catch(function (err) {
      setText('settings-meta', 'key paste failed: ' + endpointError(err, 'the key paste'));
      if (window.console) console.warn('key paste failed', err);
    });
  }

  /* -- host key trust (after a VPS re-install) ------------------- */
  function trustHost(ip, anchor) {
    var p = pair();
    var body = { ip: ip };
    if (ip === p.oldIp) {
      body.password = p.oldPassword;
      body.auth = p.oldAuth;
      body.key = p.oldKey;
    } else if (ip === p.newIp) {
      body.password = p.newPassword;
      body.auth = p.newAuth;
      body.key = p.newKey;
    }
    postJSON('/api/trust', body).then(function (result) {
      if (anchor) {
        tip(anchor, result.ok ? 'Host key trusted' : (result.detail || 'trust failed'),
          result.ok ? 'ok' : 'err');
      }
      // re-check so the panel shows the post-trust state
      setTimeout(function () { runCheck(); }, 200);
    }).catch(function (err) {
      if (anchor) tip(anchor, err.message, 'err');
      setText('check-summary', 'trust failed: ' + err.message);
    });
  }

  /* - run / cancel - */
  function buildPayload(phase) {
    var p = pair();
    var payload = {
      phase: phase,
      program: state.program,
      oldIp: p.oldIp,
      newIp: p.newIp,
      oldPassword: p.oldPassword,
      newPassword: p.newPassword,
      oldAuth: p.oldAuth,
      newAuth: p.newAuth,
      oldKey: p.oldKey,
      newKey: p.newKey,
      sameAuth: samePass(),
      // the dashboard host name is NOT part of the form: the pipeline pauses for
      // it (domain popup) and only the follow-up phase carries it
      domain: ''
    };
    if (state.program === 'deploy') {
      payload.role = val('inp-role') || (state.cfg && state.cfg.defaultRole) || 'validator';
      // the node name is generated by the program (octra-node-<hostname>) and the
      // bond is asked in the "Ready for enrollment" popup, so neither is sent here;
      // the verify samples/interval are program constants on the server
      payload.bondOct = 0;
    }
    // the manage program collects its input in modals (bond amount, monitor
    // domain + TLS choice): they set the fields on the payload just before posting
    return payload;
  }

  /* The credential the operator chose for one side is either a password or an
     OpenSSH key file: the console validates whichever it is. */
  function authReady(p, side) {
    var method = side === 'old' ? p.oldAuth : p.newAuth;
    var key = side === 'old' ? p.oldKey : p.newKey;
    var password = side === 'old' ? p.oldPassword : p.newPassword;
    if (method === 'key') { return !!key; }
    if (method === 'agent') { return true; }
    return !!password;
  }

  function phaseMeta(id) {
    var programs = (state.cfg && state.cfg.programs) || [];
    var program = programs.filter(function (p) { return p.id === state.program; })[0];
    var list = (program && program.phases) || (state.cfg && state.cfg.phases) || [];
    return list.filter(function (p) { return p.id === id; })[0] || null;
  }

  function programMeta() {
    var programs = (state.cfg && state.cfg.programs) || [];
    return programs.filter(function (p) { return p.id === state.program; })[0] || null;
  }

  function programMetaById(id) {
    var programs = (state.cfg && state.cfg.programs) || [];
    return programs.filter(function (p) { return p.id === id; })[0] || null;
  }

  /* the pipeline strip inside each dashboard: every step, in order, so the
     operator sees what "Start" will do (deploy pauses before enroll) */
  function renderPipelineInto(boxId, meta, program) {
    var box = panelId(boxId);
    if (!box) return;
    box.textContent = '';
    var mainPhase = program === 'deploy' ? 'deploy' : (program === 'manage' ? 'bond' : 'auto');
    var phases = ((meta && meta.phases) || []).filter(function (ph) {
      return ph.risk !== 'readonly' && ph.id !== 'rollback';
    });
    phases.forEach(function (ph, idx) {
      var chip = document.createElement('span');
      var cls = 'mc-pipeline__step';
      if (ph.id === mainPhase) { cls += ' mc-pipeline__step--main'; }
      else if (ph.risk === 'critical') { cls += ' mc-pipeline__step--critical'; }
      chip.className = cls;
      chip.textContent = ph.label;
      chip.title = ph.desc || '';
      box.appendChild(chip);
      if (idx < phases.length - 1) {
        var sep = document.createElement('span');
        sep.className = 'mc-pipeline__sep';
        sep.textContent = '>';
        box.appendChild(sep);
      }
    });
  }

  /* - program switcher: two independent dashboards ------------------------ */
  /* Only the selected dashboard is on screen (fields, check, progress and
     actions are separate), so nothing from the other program can confuse the
     operator. The choice is remembered (localStorage + #hash). */
  function renderProgram() {
    var program = state.program;
    var meta = programMeta();
    var panelDeploy = panelId('panel-deploy');
    var panelMigrate = panelId('panel-migrate');
    var panelManage = panelId('panel-manage');
    if (panelDeploy) { panelDeploy.hidden = program !== 'deploy'; }
    if (panelMigrate) { panelMigrate.hidden = program !== 'migrate'; }
    if (panelManage) { panelManage.hidden = program !== 'manage'; }
    // Project settings (swap + data store) belong to the deploy and migrate flows.
    // Manage operates a node that already runs (bond, exit, update, prune, monitor),
    // so the section is not shown there.
    // Project settings (swap + data store) belong to the deploy and migrate flows.
    // Manage operates a node that already runs (bond, exit, update, prune, monitor),
    // so the section is not shown there.
    var settingsSection = panelId('settings');
    if (settingsSection) { settingsSection.hidden = program === 'manage'; }

    // one app, three tools: the app name is fixed, the tool is the hero title
    document.title = 'Octra Validator Tools';
    setText('topbar-title', 'Validator Tools');
    setText('hero-title', meta ? meta.label : 'Validator Tools');
    var orchPath = (meta && meta.orchestrator) || (state.cfg && state.cfg.orchestrator) || '';
    var orchName = orchPath ? String(orchPath).replace(/^.*[\\/]/, '') : '-';
    var orchOk = (meta && typeof meta.orchestratorPresent === 'boolean')
      ? meta.orchestratorPresent : !!(state.cfg && state.cfg.orchestratorPresent);
    setText('hero-orchestrator', orchOk ? orchName : (orchName + ' MISSING'));

    var seg = $('seg-programs');
    if (seg) {
      var buttons = seg.querySelectorAll('.mc-tab');
      for (var i = 0; i < buttons.length; i++) {
        var on = buttons[i].getAttribute('data-program') === state.program;
        buttons[i].className = 'mc-tab' + (on ? ' mc-tab--active' : '');
        buttons[i].setAttribute('aria-selected', String(on));
      }
    }

    renderPipelineInto('d-pipeline', programMetaById('deploy'), 'deploy');
    renderPipelineInto('pipeline-list', programMetaById('migrate'), 'migrate');

    var dashWarning = (state.cfg && !state.cfg.dashboardPresent)
      ? 'WARNING: dashboard assets are missing - the dashboard will not be deployed.' : '';
    setText('d-action-note', dashWarning ||
      'One click: check - prep - toolchain - setup - start - verify, then (validator) the top-up popup, '
      + 'enroll - promote - verify, and the console watches the chain admit the validator.');
    setText('m-action-note', (state.cfg && state.cfg.bondIncreasePresent === false)
      ? 'WARNING: bond_inc.sh is missing in the project root - the increase cannot run.'
      : 'Critical: bond and exit need the ACTIVE validator. Increase bond = bond_inc.sh as the octra user '
        + '(the first increase runs plain, later ones add --new automatically). Exit = exit the set, wait '
        + 'for the unbonding, withdraw the stake. Update = controls/upgrade.sh (tested first, then applied) - '
        + 'the manual fallback pulls and rebuilds by hand; prune only drops the preserved states.');
    // the migrate note is only filled when there is something to say (the last
    // identity backup); the stale "one click: ... deploy dashboard" sentence is gone
    var migrateNote = dashWarning;
    if (!dashWarning && state.cfg && state.cfg.archives && state.cfg.archives.length) {
      migrateNote = 'automatic pipeline - last identity backup: ' + state.cfg.archives[0].name +
        ' (' + Math.max(1, Math.round(state.cfg.archives[0].bytes / 1024)) + ' KB)';
    }
    // setText turns '' into '-': an empty note must disappear instead, so it is
    // written directly (the markup keeps the span for the dynamic text)
    var migrateNoteEl = $('action-note');
    if (migrateNoteEl) { migrateNoteEl.textContent = migrateNote || ''; }
    // the manage actions (bond, exit, update, prune, monitor, status) live in the
    // "Live node state" section (next to the state they act on): only that tool
    // shows the block, and a single-host dashboard needs no pair divider
    var nodeActions = panelId('node-actions');
    if (nodeActions) { nodeActions.hidden = program !== 'manage'; }
    var nodesGrid = panelId('nodes-grid');
    if (nodesGrid) {
      nodesGrid.className = 'mc-nodes' + (oneHostProgram(program) ? ' mc-nodes--manage' : '');
    }
    setText('hero-project', (state.cfg && state.cfg.projectRoot) || 'project');
    if (program === 'manage') syncMonitorDomainField(false);

    // the source node card belongs to the migration dashboard
    var srcCard = panelId('node-src-card');
    if (srcCard) { srcCard.hidden = program !== 'migrate'; }

    rememberProgram();
    invalidateCheck();
    bindAuthRows();
    bindHostInputs();
    syncPasswordFields();
    syncAllAuthFields();
    syncDashboardGate();
    // this tab's own data: its log, its host chips, its node cards
    renderLogFor(program);
    var cached = state.nodesByProgram[program];
    renderNode('src', cached ? cached.src : null);
    renderNode('dst', cached ? cached.dst : null);
    safetyChecks();
    applyGating();
    renderRoute();
  }

  /* Bind the auth rows of every panel once (renderProgram calls it on each
     switch): the method selector reveals the key row, Browse opens the native
     dialog, and the paste box becomes a 0600 file whose path fills the field. */
  function bindAuthRows() {
    for (var i = 0; i < AUTH_SELECTS.length; i++) {
      (function (select) {
        if (!select || select.__authBound) return;
        select.__authBound = true;
        select.addEventListener('change', function () {
          syncAuthRow(select);
          invalidateCheck();
        });
        var key = document.getElementById(select.getAttribute('data-key') || '');
        if (key) key.addEventListener('input', function () { invalidateCheck(); });
        var pick = document.getElementById(select.getAttribute('data-pick') || '');
        if (pick) {
          pick.addEventListener('click', function (ev) {
            pickKey(ev && ev.currentTarget ? ev.currentTarget : pick, key);
          });
        }
        var text = document.getElementById(select.getAttribute('data-keytext') || '');
        if (text) text.addEventListener('change', function () { saveKeyText(text, key); });
      })(document.getElementById(AUTH_SELECTS[i]));
    }
    var same = document.getElementById('chk-same-pass');
    if (same && !same.__authBound) {
      same.__authBound = true;
      same.addEventListener('change', function () {
        syncPasswordFields();
        syncAllAuthFields();
        invalidateCheck();
      });
    }
  }

  /* Switch program from anywhere (tabs, "Go to Manage active node"): the address
     typed on one dashboard follows the operator to the next one. */
  function setProgram(program) {
    if (PROGRAMS.indexOf(program) < 0) return;
    if (program === state.program) return;
    var carry = val('inp-new') || val('inp-old');
    state.program = program;
    renderProgram();
    if (carry) {
      var target = $('inp-new');
      if (target && !target.value) { target.value = carry; }
    }
    invalidateCheck();
    renderRoute();
  }

  function rememberProgram() {
    try { localStorage.setItem(PROGRAM_KEY, state.program); } catch (err) { /* private mode */ }
    try {
      if (window.location && window.history
          && window.location.hash !== '#' + state.program) {
        window.history.replaceState(null, '', '#' + state.program);
      }
    } catch (err) { /* an embedded/headless browser may not allow history */ }
  }

  /* which dashboard opens: the #hash wins, then the last used, then the server default */
  function restoreProgram(cfg) {
    var hash = '';
    try {
      hash = (window.location && window.location.hash)
        ? String(window.location.hash).replace('#', '') : '';
    } catch (err) { hash = ''; }
    if (hash && PROGRAMS.indexOf(hash) >= 0) { return hash; }
    try {
      var saved = localStorage.getItem(PROGRAM_KEY);
      if (saved && PROGRAMS.indexOf(saved) >= 0) { return saved; }
    } catch (err) { /* private mode */ }
    var ids = ((cfg && cfg.programs) || []).map(function (p) { return p.id; });
    if (cfg && cfg.defaultProgram && ids.indexOf(cfg.defaultProgram) >= 0) { return cfg.defaultProgram; }
    return 'migrate';
  }

  var DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

  /* The only forward action: the backend runs the whole pipeline of the current
     program in order (deploy: check -> prep -> ... -> dashboard; migrate:
     preconditions -> migration -> dashboard deploy). */
  /* - manage program: three explicit actions on ONE host --------------- */
  /* Bond and exit collect their input in a modal (the panel has no fields any
     more): the operator types the amount - or just confirms the exit - and the
     modal posts it. A passing Check is still required, because both sign a
     transaction with the wallet of the voting validator. */
  function startManage(phase, anchor) {
    var meta = phaseMeta(phase);
    if (!meta) { tip(anchor, 'console config not loaded yet', 'err'); return; }
    var p = pair();
    if (!p.newIp) { tip(anchor, 'Type the node address first', 'err'); return; }
    if (!authReady(p, 'new')) { tip(anchor, 'Type the node credentials first', 'err'); return; }
    if (busy()) { tip(anchor, 'A phase is already running', 'err'); return; }
    if (phase !== 'status' && !checkOk()) {
      tip(anchor, 'Press Check first - the node must be the active validator', 'err');
      return;
    }
    if (phase === 'bond') { openBondModal(); return; }
    if (phase === 'exit') { openExitModal(); return; }
    openConfirm(meta, buildPayload(phase));
  }

  /* -- Increase bond: amount + confirmation in a modal ----------------- */
  function openBondModal() {
    var modal = panelId('bond-modal');
    if (!modal) return;
    setText('bond-node', val('inp-new'));
    var amount = panelId('bond-amount');
    if (amount) { if (!amount.value) amount.value = '1'; amount.focus(); amount.select(); }
    clearNote('bond-note');
    modal.hidden = false;
  }

  function closeBond() {
    var modal = panelId('bond-modal');
    if (modal) modal.hidden = true;
  }

  function submitBond() {
    var amount = String(val('bond-amount') || '').trim();
    if (!/^[0-9]+(\.[0-9]{1,6})?$/.test(amount) || Number(amount) < 1) {
      setText('bond-note', 'Type the amount in OCT (min 1, e.g. 100 or 12.5).');
      return;
    }
    var meta = phaseMeta('bond');
    if (!meta) { setText('bond-note', 'console config not loaded yet'); return; }
    var payload = buildPayload('bond');
    payload.amount = amount;
    payload.approved = true;
    payload.confirm = meta.confirm || 'BOND';
    closeBond();
    postRun(payload, meta, null);
  }

  /* -- Exit validator: an explicit confirmation modal ------------------ */
  function openExitModal() {
    var modal = panelId('exit-modal');
    if (!modal) return;
    setText('exit-node', val('inp-new'));
    clearNote('exit-note');
    modal.hidden = false;
  }

  function closeExit() {
    var modal = panelId('exit-modal');
    if (modal) modal.hidden = true;
  }

  function submitExit() {
    var meta = phaseMeta('exit');
    if (!meta) { setText('exit-note', 'console config not loaded yet'); return; }
    var payload = buildPayload('exit');
    payload.approved = true;
    payload.confirm = meta.confirm || 'EXIT';
    closeExit();
    postRun(payload, meta, null);
  }

  /* "node-<last5 of the wallet>.example.com" - the same rule the server uses for
     the domain popup, computed here so the monitor modal opens with a usable
     name instead of an empty field. */
  function suggestDomain(address) {
    var clean = String(address || '').toLowerCase().replace(/[^0-9a-z]/g, '');
    if (clean.length < 5) return '';
    var suffix = (state.cfg && state.cfg.domainSuffix) || 'example.com';
    return 'node-' + clean.slice(-5) + '.' + suffix;
  }

  /* The domain of an existing monitor deploy: the running/finished job reports
     it, and /api/settings keeps the last one. When it exists the manage tab
     reuses it instead of asking for the host name again. */
  function existingMonitorDomain() {
    var raw = (state.runner && state.runner.domain)
      || (state.settings && state.settings.dashboardDomain)
      || '';
    return String(raw).replace(/^https?:\/\//i, '').replace(/\/+$/, '').trim().toLowerCase();
  }

  function syncMonitorDomainField(force) {
    var field = panelId('monitor-domain');
    if (!field) return;
    var known = existingMonitorDomain();
    if (!known) return;
    if (force || !String(field.value || '').trim()) field.value = known;
  }

  /* A field that failed validation must be impossible to miss: message next to
     it, red outline, focus - plus a tip on the button that was pressed. "The
     button did nothing" is the worst possible feedback. */
  function fieldError(inputId, noteId, message, anchor) {
    var input = panelId(inputId);
    if (input) {
      if (input.classList && input.classList.add) input.classList.add('mc-invalid');
      if (typeof input.focus === 'function') input.focus();
      if (typeof input.select === 'function') input.select();
    }
    setText(noteId, message);
    if (anchor) tip(anchor, message, 'err');
  }

  function clearFieldError(inputId, noteId) {
    var input = panelId(inputId);
    if (input && input.classList && input.classList.remove) input.classList.remove('mc-invalid');
    if (noteId) clearNote(noteId);
  }

  /* setText() turns '' into '-', which would leave a stray dash line in a modal:
     modal notes must become empty so `:empty { display: none }` hides them. */
  function clearNote(id) {
    var node = panelId(id);
    if (node) node.textContent = '';
  }

  /* -- Deploy monitor: domain + TLS choice (Cloudflare origin / certbot) */
  function openMonitorModal() {
    var modal = panelId('monitor-modal');
    if (!modal) return;
    var p = pair();
    if (!p.newIp) { tip(panelId('m-btn-dashboard'), 'Type the node address first', 'err'); return; }
    if (!authReady(p, 'new')) {
      tip(panelId('m-btn-dashboard'), 'Type the node credentials first', 'err'); return;
    }
    if (busy()) { tip(panelId('m-btn-dashboard'), 'A phase is already running', 'err'); return; }
    setText('monitor-node', p.newIp);
    var domain = panelId('monitor-domain');
    syncMonitorDomainField(true);
    if (domain && !String(domain.value || '').trim()) {
      var nodeAddr = (state.nodes.dst && state.nodes.dst.address) || '';
      domain.value = suggestDomain(nodeAddr) || '';
    }
    clearFieldError('monitor-domain', 'monitor-note');
    clearFieldError('monitor-certdir', '');
    var force = panelId('monitor-force');
    if (force) force.checked = false;
    syncMonitorSsl();
    modal.hidden = false;
  }

  function closeMonitor() {
    var modal = panelId('monitor-modal');
    if (modal) modal.hidden = true;
  }

  function monitorSslMode() {
    var certbot = panelId('monitor-ssl-certbot');
    return (certbot && certbot.checked) ? 'certbot' : 'cloudflare';
  }

  /* the Cloudflare folder row and the certbot e-mail row follow the radio */
  function syncMonitorSsl() {
    var mode = monitorSslMode();
    var cf = panelId('monitor-cf-row');
    var le = panelId('monitor-le-row');
    if (cf) cf.hidden = mode !== 'cloudflare';
    if (le) le.hidden = mode !== 'certbot';
  }

  /* the TLS folder note: green when the pair is complete, red when it is not */
  function certDirNote(text, isError) {
    var note = panelId('monitor-certdir-note');
    if (!note) return;
    note.textContent = text;
    note.className = 'v2-t-xs ' + (isError ? 'mc-err' : 'v2-mute');
    if (!isError) clearFieldError('monitor-certdir', '');
  }

  /* "Choose folder": the browser opens the folder dialog (always in front) and
     the two PEM files it holds are sent to /api/certfiles, which stores them in
     tmp/certs/<folder>/ and answers with the path -CertDir receives. A native
     folder dialog opened by the console process is built but never activated,
     so this is the only reliable way on Windows. */
  function pickCertDir() {
    var btn = panelId('monitor-certdir-pick');
    var input = panelId('monitor-certdir');
    if (browserPicksDirectories()) {
      var opened = openFilePicker('inp-cert-dir', function (files) {
        var chain = null, key = null, folder = '';
        for (var i = 0; i < files.length; i++) {
          var name = String(files[i].name || '').toLowerCase();
          var rel = String(files[i].webkitRelativePath || '');
          if (!folder && rel.indexOf('/') > 0) folder = rel.split('/')[0];
          if (name === 'fullchain.pem') chain = files[i];
          if (name === 'privkey.pem') key = files[i];
        }
        if (!chain || !key) {
          var seen = [];
          for (var j = 0; j < files.length; j++) { seen.push(files[j].name); }
          certDirNote('that folder has no fullchain.pem + privkey.pem pair (saw: '
            + seen.slice(0, 6).join(', ') + ')', true);
          return;
        }
        certDirNote('reading ' + (folder || 'the selected folder') + ' ...', false);
        Promise.all([readFileText(chain), readFileText(key)]).then(function (texts) {
          return postJSON('/api/certfiles', {
            folder: folder, fullchain: texts[0], privkey: texts[1]
          });
        }).then(function (res) {
          if (input) input.value = res.path;
          // the field holds the full path; the note shows the short form, so a
          // long C:\...\tmp\certs\... line does not dominate the dialog
          var short = String(res.path || '').replace(/^.*[\\/]tmp[\\/]/i, 'tmp\\');
          certDirNote('certificate stored here: ' + (short || res.path), false);
          tip(btn, 'Folder selected');
        }).catch(function (err) {
          certDirNote(endpointError(err, 'the certificate folder'), true);
        });
      });
      if (opened) return;
    }
    /* fallback: the native folder dialog of the console process */
    postJSON('/api/pickdir', {}).then(function (res) {
      if (!res || !res.path) {
        throw new Error((res && res.error) || 'no folder was picked');
      }
      if (input) input.value = res.path;
      var missing = res.missing || [];
      certDirNote(missing.length
        ? 'missing in that folder: ' + missing.join(', ')
        : 'folder OK: fullchain.pem + privkey.pem found', missing.length > 0);
    }).catch(function (err) { tip(btn, endpointError(err, 'the folder picker'), 'err'); });
  }

  function submitMonitor() {
    var anchor = panelId('monitor-ok');
    var domain = String(val('monitor-domain') || '').trim().toLowerCase();
    var mode = monitorSslMode();
    var certDir = String(val('monitor-certdir') || '').trim();
    var email = String(val('monitor-email') || '').trim();
    var force = panelId('monitor-force');
    if (!domain) {
      fieldError('monitor-domain', 'monitor-note',
        'Type the host name the monitor will be published on (for example node-abcde.example.com).',
        anchor);
      return;
    }
    if (!DOMAIN_RE.test(domain)) {
      fieldError('monitor-domain', 'monitor-note',
        'Use a plain host name like node-abcde.example.com - no http://, no path, no port.', anchor);
      return;
    }
    if (mode === 'cloudflare' && !certDir) {
      fieldError('monitor-certdir', 'monitor-note',
        'Pick the folder that holds fullchain.pem and privkey.pem first.', anchor);
      return;
    }
    var meta = phaseMeta('dashboard');
    if (!meta) { setText('monitor-note', 'console config not loaded yet'); return; }
    var payload = buildPayload('dashboard');
    payload.domain = domain;
    payload.sslMode = mode;
    payload.certDir = mode === 'cloudflare' ? certDir : '';
    payload.email = mode === 'certbot' ? email : '';
    payload.reset = !!(force && force.checked);
    payload.approved = true;                    // the click is the approval
    closeMonitor();
    postRun(payload, meta, null);
  }

  function startMigration(anchor) {
    var phase = state.program === 'deploy' ? 'deploy' : 'auto';
    var meta = phaseMeta(phase);
    if (!meta) { tip(anchor, 'console config not loaded yet', 'err'); return; }
    var payload = buildPayload(phase);
    if (state.program === 'deploy') {
      if (!payload.newIp) { tip(anchor, 'Fill the target host first', 'err'); return; }
      if (!authReady(payload, 'new')) {
        tip(anchor, 'Type the root password or point at an OpenSSH key for the target', 'err');
        return;
      }
    } else {
      if (!payload.oldIp || !payload.newIp) { tip(anchor, 'Fill source and target first', 'err'); return; }
      if (payload.oldIp === payload.newIp) { tip(anchor, 'Source and target must differ', 'err'); return; }
      if (!authReady(payload, 'old') || !authReady(payload, 'new')) {
        tip(anchor, 'Credentials missing for a host (password or key)', 'err');
        return;
      }
    }
    // the dashboard host name is not typed here any more: it belongs to the Manage
    // tab (Deploy monitor), which asks for it in its own modal
    openConfirm(meta, payload);
  }

  function requestRun(phase, anchor) {
    if (phase === 'check') { runCheck(anchor); return; }
    var meta = phaseMeta(phase);
    if (!meta) return;
    var payload = buildPayload(phase);
    if (state.program === 'manage') {
      // single host: only the node address + its credentials exist
      if (!payload.newIp) { tip(anchor, 'Fill the node host', 'err'); return; }
      if (!authReady(payload, 'new')) { tip(anchor, 'Type the node credentials', 'err'); return; }
      // bond/exit sign a transaction with the wallet of the voting validator
      if ((phase === 'bond' || phase === 'exit') && meta.risk === 'critical' && !checkOkFor('manage')) {
        tip(anchor, 'Press Check first - the node must be the active validator', 'err');
        return;
      }
      // the update actions rebuild and restart the node: they need the update half
      if ((phase === 'upgrade' || phase === 'manual') && !checkOkFor('upgrade')) {
        tip(anchor, 'Press Check first - the node must be reachable and updatable', 'err');
        return;
      }
      if (phase === 'upgrade') {
        var testBox = panelId('m-test-only');
        if (testBox && testBox.checked) { payload.testOnly = true; }
      }
      if (meta.risk === 'critical') { openConfirm(meta, payload); return; }
      postRun(payload, meta, anchor);
      return;
    }
    if (!payload.oldIp) { tip(anchor, 'Fill the source host', 'err'); return; }
    if (phase !== 'backup' && !payload.newIp) { tip(anchor, 'Fill the target host', 'err'); return; }
    if (phase === 'rollback' && !checkOk()) {
      tip(anchor, 'Press Check first - rollback is destructive', 'err');
      return;
    }
    if (meta.confirm) { openConfirm(meta, payload); return; }
    postRun(payload, meta, anchor);
  }

  function postRun(payload, meta, anchor) {
    postJSON('/api/run', payload).then(function (body) {
      if (anchor) tip(anchor, 'Started ' + meta.label);
      var result = $('dash-result');
      if (result) { result.hidden = true; result.textContent = ''; }
      // this page owns the run it just started: even a run that finishes before
      // the next poll counts as watched (see finishedNodeRun)
      if (body.state && typeof body.state.startedAt === 'number') {
        state.runWatch = body.state.startedAt;
      }
      renderRunner(body.state);
      // Resume the stream right BEFORE the run's first line (`lastSeq` already
      // contains the "phase started" marker). Resetting to 0 replayed the whole
      // buffer, which is why the first lines used to appear twice.
      var started = body.state && typeof body.state.lastSeq === 'number' ? body.state.lastSeq : 0;
      state.seq = Math.max(0, started - 1);
      clearLog();
      connectLog();
      // the operator just confirmed a popup or pressed a button: show the run
      scrollToLogs();
    }).catch(function (err) {
      if (anchor) tip(anchor, err.message, 'err');
      var note = $('action-note');
      if (note) note.textContent = 'ERROR: ' + err.message;
    });
  }

  function cancelRun(anchor) {
    postJSON('/api/cancel', {}).then(function () {
      if (anchor) tip(anchor, 'Cancel requested', 'warn');
    }).catch(function (err) {
      if (anchor) tip(anchor, err.message, 'err');
    });
  }


  /* - live log (SSE + polling fallback) - */
  var LEVEL_LABEL = { info: 'INFO', ok: 'OK', warn: 'WARN', error: 'ERR' };
  var LEVEL_CLASS = { warn: 'v2-log__row--warn', error: 'v2-log__row--error' };

  /* After a submit - a button, the confirm modal, the enrollment/domain popup -
     the operator wants to watch the run: bring the Live log into view. */
  function scrollToLogs() {
    var section = $('log');
    if (!section || typeof section.scrollIntoView !== 'function') return;
    try { section.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    catch (err) { section.scrollIntoView(); }
  }

  /* stream health: a dropped SSE connection falls back to polling the buffer */
  var sseFailures = 0;
  var logPollTimer = null;

  function logVisible(entry) {
    if (state.logLevel !== 'all' && entry.level !== state.logLevel) return false;
    if (state.hostFilter !== 'all' && (entry.host || '') !== state.hostFilter) return false;
    if (state.logQuery) {
      var hay = (entry.line || '').toLowerCase();
      if (hay.indexOf(state.logQuery) === -1) return false;
    }
    return true;
  }

  // Host tint. The source and the target must NEVER share a colour, so they are
  // not hashed: whichever side the address sits on decides the tint, and it is
  // labelled SRC/DST so the reading does not depend on colour at all.
  // Both hues are deliberately NOT red (--v2-tel-out was rose, and a working step
  // in red reads like an error - 2026-11-04): emerald for SRC, sky for DST.
  var ROLE_COLOR = { src: '--mc-role-src', dst: '--mc-role-dst' };
  var ROLE_TAG = { src: 'SRC', dst: 'DST' };
  var OTHER_COLORS = ['--v2-brand', '--v2-status-warning'];

  function hostRole(ip) {
    if (!ip) return null;
    var runner = state.runner || {};
    if (state.program === 'migrate') {
      var from = runner.oldIp || val('inp-old');
      var to = runner.newIp || val('inp-new');
      if (from && ip === from) return 'src';
      if (to && ip === to) return 'dst';
      return null;
    }
    // deploy/manage have a single host: labelling it "SRC" was wrong (and made
    // the migrate log look like it belonged to the deploy run)
    var only = (runner.program === state.program && runner.newIp) ? runner.newIp : val('inp-new');
    return only && ip === only ? 'dst' : null;
  }

  function hostColor(ip) {
    if (!ip) return null;
    var role = hostRole(ip);
    if (role) return ROLE_COLOR[role];
    var sum = 0;
    for (var i = 0; i < ip.length; i++) sum = (sum + ip.charCodeAt(i) * (i + 7)) % 9973;
    return OTHER_COLORS[sum % OTHER_COLORS.length];
  }

  /* rows that are progress noise rather than news: heartbeats, speed lines,
     the epoch poll while the set fold re-admits the validator. They stay in the
     log but are muted, so a silent-but-busy step cannot look like a hang. */
  var MUTED_RE = /(^\s*\.\.\. still running|^\s*\.\.\.|still running|quiet for|^no output|^\s*sleeping \d+s|^\s*epoch advanced|^\s*epoch=|: \d+% complete|^\s*verifying \d+)/;

  /* Lines the operator must not miss in a 1500-row log: the manage token, the
     published URL/domain, the wallet address and a completed milestone. They get a
     brand-tinted row (never red - red is the error colour). */
  var KEY_RE = /(manage token|wallet address|\b(URL|API|UI)\s*:|https?:\/\/[a-z0-9][a-z0-9.-]*\.[a-z]{2,}|=== DONE:|---> DONE:|=== .*\b(COMPLETE|DONE)\b|voting = enabled|\bbond [0-9.]+ OCT)/i;

  function rowClass(entry) {
    var cls = 'v2-log__row';
    if (entry.level === 'warn' || entry.level === 'error') cls += ' ' + LEVEL_CLASS[entry.level];
    else if (entry.level === 'ok') cls += ' v2-log__row--ok';
    var line = entry.line || '';
    if (/^--> /.test(line)) cls += ' mc-row--step';
    else if (MUTED_RE.test(line) && entry.level === 'info') cls += ' v2-log__row--muted';
    if (KEY_RE.test(line)) cls += ' v2-log__row--key';
    return cls;
  }

  function logRow(entry) {
    var row = document.createElement('div');
    row.className = rowClass(entry);
    row.dataset.level = entry.level || 'info';
    row.dataset.host = entry.host || '';
    row.dataset.text = (entry.line || '').toLowerCase();
    if (KEY_RE.test(entry.line || '')) row.dataset.key = '1';
    if (!logVisible(entry)) row.hidden = true;

    var ts = document.createElement('span');
    ts.className = 'v2-log__ts';
    var d = new Date((entry.ts || 0) * 1000);
    ts.textContent = isNaN(d.getTime()) ? '--:--:--' : d.toLocaleTimeString('en-GB');

    var level = document.createElement('span');
    level.className = 'v2-log__level' + (entry.level === 'warn' ? ' v2-log__level--warn'
      : entry.level === 'error' ? ' v2-log__level--error' : '');
    level.textContent = LEVEL_LABEL[entry.level] || 'INFO';

    var host = document.createElement('span');
    host.className = 'v2-log__comp mc-hostchip';
    if (entry.host) {
      var role = hostRole(entry.host);
      var color = hostColor(entry.host);
      if (color) host.style.color = 'var(' + color + ')';
      if (role) {
        var tag = document.createElement('span');
        tag.className = 'mc-hostchip__role mc-hostchip__role--' + role;
        tag.textContent = ROLE_TAG[role];
        tag.title = role === 'src' ? 'source VPS' : 'target VPS';
        host.appendChild(tag);
      }
      var ip = document.createElement('span');
      ip.className = 'mc-hostchip__ip';
      ip.textContent = entry.host;
      host.appendChild(ip);
      host.title = (role === 'src' ? 'source VPS ' : role === 'dst' ? 'target VPS ' : '')
        + entry.host + ' - step running there';
    }

    var msg = document.createElement('span');
    msg.className = 'v2-log__msg';
    msg.textContent = entry.line || '';
    row.__msg = msg;                 // the duplicate counter rewrites this node

    row.appendChild(ts);
    row.appendChild(level);
    row.appendChild(host);
    row.appendChild(msg);
    rememberRow(entry, row);
    return row;
  }

  /* - collapse a line that repeats identically (a retry loop, a re-printed
       warning): one row with a counter beats 40 copies ---------------------- */
  var lastRow = null;
  var lastKey = '';
  var lastBase = '';
  var repeatCount = 1;

  function dedupeKey(entry) {
    return (entry.level || '') + '|' + (entry.host || '') + '|' + (entry.line || '');
  }

  function rememberRow(entry, row) {
    lastRow = row;
    lastKey = dedupeKey(entry);
    lastBase = entry.line || '';
    row.dataset.repeat = '1';
  }

  /* bump the counter on an existing row instead of printing the same line again */
  function bumpRow(row, entry) {
    var n = Number((row && row.dataset.repeat) || 1) + 1;
    row.dataset.repeat = String(n);
    var msg = row.__msg || row.querySelector('.v2-log__msg');
    if (msg) msg.textContent = (entry.line || lastBase) + '  (x' + n + ')';
    return true;
  }

  function bumpRepeat(entry) {
    if (!lastRow || dedupeKey(entry) !== lastKey) return false;
    return bumpRow(lastRow, entry);
  }

  function atBottom(view) {
    return view.scrollHeight - view.scrollTop - view.clientHeight < 60;
  }

  /* Render in batches: apt/npm can emit hundreds of lines per second and one
     DOM write per line freezes the tab. Entries are queued and flushed once per
     animation frame (or 120 ms when the tab is hidden). */
  var pendingRows = [];
  var flushTimer = null;

  function appendEntry(entry) {
    if (!entry || typeof entry.seq !== 'number') return;
    if (entry.seq <= state.seq) return;          // reconnect replay guard
    state.seq = entry.seq;
    var owner = programOf(entry);
    var store = logStore(owner);
    store.push(entry);
    if (store.length > MAX_ROWS) store.splice(0, store.length - MAX_ROWS);
    if (entry.level === 'error') {
      state.errors[owner] = (state.errors[owner] || 0) + 1;
      setErrorBadge(owner, state.errors[owner]);
    }
    // a line of another program is kept for its tab, but never painted here
    if (owner !== state.program) return;
    paintEntry(entry);
  }

  /* the program a log line belongs to (older servers send no program: the line
     then belongs to whatever is on screen) */
  function programOf(entry) {
    var id = entry && entry.program;
    return PROGRAMS.indexOf(id) >= 0 ? id : state.program;
  }

  function logStore(program) {
    if (!state.logs[program]) { state.logs[program] = []; }
    return state.logs[program];
  }

  function setErrorBadge(program, count) {
    if (program !== state.program) return;
    var node = $('nav-log-badge');
    if (!node) return;
    node.hidden = !count;
    node.textContent = String(count || 0);
  }

  function paintEntry(entry) {
    if (state.logPaused) return;
    // the line right above is identical: count it instead of printing it again
    if (pendingRows.length === 0 && bumpRepeat(entry)) return;

    pendingRows.push(entry);
    if (pendingRows.length > 4000) pendingRows.splice(0, pendingRows.length - 4000);
    if (entry.host) noteHost(entry.host);

    if (flushTimer === null) {
      var schedule = window.requestAnimationFrame || function (fn) { return setTimeout(fn, 120); };
      flushTimer = schedule(flushRows);
    }
  }

  function flushRows() {
    flushTimer = null;
    var view = $('log-view');
    if (!view || pendingRows.length === 0) return;

    var batch = pendingRows;
    pendingRows = [];
    var stick = atBottom(view);

    var frag = document.createDocumentFragment();
    var prev = null;
    batch.forEach(function (entry) {
      if (prev && dedupeKey(entry) === dedupeKey(prev.entry)) {
        bumpRow(prev.row, entry);               // same line twice in one frame
        return;
      }
      var row = logRow(entry);
      frag.appendChild(row);
      prev = { entry: entry, row: row };
    });
    var empty = $('log-empty');
    if (empty) empty.hidden = true;
    view.appendChild(frag);

    // trim in one pass so the DOM never grows unbounded
    var rows = view.querySelectorAll('.v2-log__row');
    if (rows.length > MAX_ROWS) {
      var drop = rows.length - MAX_ROWS;
      for (var i = 0; i < drop; i++) view.removeChild(rows[i]);
    }
    state.rows = view.querySelectorAll('.v2-log__row').length;

    if (stick) view.scrollTop = view.scrollHeight;
    setText('log-meta', 'streaming - ' + state.rows + ' lines' +
      (pendingRows.length ? ' (+' + pendingRows.length + ')' : ''));
  }

  function connectLog() {
    if (state.es) { state.es.close(); state.es = null; }
    var es = new EventSource('/api/log/stream?since=' + state.seq);
    state.es = es;
    es.onmessage = function (event) {
      try { appendEntry(JSON.parse(event.data)); } catch (err) { /* ignore malformed frame */ }
    };
    es.onerror = function () {
      sseFailures += 1;
      setText('log-meta', 'reconnecting - ' + state.rows + ' lines');
      // EventSource retries on its own, but a flaky link can keep it down for
      // minutes. Poll the buffer as a fallback so the operator still sees lines.
      if (sseFailures >= 2) startLogPolling();
    };
    es.onopen = function () {
      sseFailures = 0;
      stopLogPolling();
      setText('log-meta', 'streaming - ' + state.rows + ' lines');
    };
  }

  function startLogPolling() {
    if (logPollTimer) return;
    setText('log-meta', 'polling - ' + state.rows + ' lines');
    logPollTimer = setInterval(function () {
      getJSON('/api/log?since=' + state.seq).then(function (body) {
        var lines = body.lines || [];
        lines.forEach(appendEntry);
        setText('log-meta', 'polling - ' + state.rows + ' lines');
      }).catch(function () { /* stay quiet, the next tick retries */ });
    }, 3000);
  }

  function stopLogPolling() {
    if (logPollTimer) { clearInterval(logPollTimer); logPollTimer = null; }
  }

  function clearLog() {
    var view = $('log-view');
    if (!view) return;
    view.textContent = '';
    lastRow = null;
    lastKey = '';
    lastBase = '';
    var empty = document.createElement('div');
    empty.className = 'v2-log__empty';
    empty.id = 'log-empty';
    empty.textContent = 'waiting for output...';
    view.appendChild(empty);
    state.rows = 0;
    setText('log-meta', 'streaming - 0 lines');
  }

  /* Show one program's output: its own rows, its own host chips, its own error
     count. Called on every program switch, so the tabs never borrow each other's
     history (the backend tags every line with the program that produced it). */
  function renderLogFor(program) {
    clearLog();
    pendingRows = [];
    resetHosts();
    var store = logStore(program);
    var hosts = [];
    var errors = 0;
    store.forEach(function (entry) {
      if (entry.host && hosts.indexOf(entry.host) < 0) { hosts.push(entry.host); }
      if (entry.level === 'error') { errors += 1; }
    });
    state.hosts = hosts;
    state.errors[program] = errors;
    pendingRows = store.slice();
    if (pendingRows.length) {
      flushRows();
    } else {
      var empty = $('log-empty');
      if (empty) empty.hidden = false;
    }
    applyLogFilter();
    renderHostFilter();
    renderLegend();
    setErrorBadge(program, errors);
  }

  function applyLogFilter() {
    var view = $('log-view');
    if (!view) return;
    var rows = view.querySelectorAll('.v2-log__row');
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var show = (state.logLevel === 'all' || row.dataset.level === state.logLevel) &&
        (state.hostFilter === 'all' || row.dataset.host === state.hostFilter) &&
        (!state.logQuery || (row.dataset.text || '').indexOf(state.logQuery) !== -1);
      row.hidden = !show;
    }
  }

  /* -- host chips: which VPS a line came from ------------------------ */
  function noteHost(ip) {
    if (!ip || state.hosts.indexOf(ip) >= 0) return;
    state.hosts.push(ip);
    renderHostFilter();
    renderLegend();
  }

  function resetHosts() {
    state.hosts = [];
    state.hostFilter = 'all';
    renderHostFilter();
    renderLegend();
  }

  function renderHostFilter() {
    var seg = $('seg-host');
    if (!seg) return;
    seg.textContent = '';
    var add = function (value, label) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'v2-seg__btn' + (state.hostFilter === value ? ' v2-seg__btn--active' : '');
      btn.setAttribute('data-host-filter', value);
      btn.textContent = label;
      seg.appendChild(btn);
    };
    add('all', 'All');
    state.hosts.forEach(function (ip) {
      var role = hostRole(ip);
      add(ip, (role ? ROLE_TAG[role] + ' ' : '') + ip);
    });
    seg.hidden = state.hosts.length === 0;
  }

  function renderLegend() {
    var box = $('log-legend');
    if (!box) return;
    box.textContent = '';
    state.hosts.forEach(function (ip) {
      var role = hostRole(ip);
      var item = document.createElement('span');
      item.className = 'mc-legend__item';
      item.title = role === 'src' ? 'source VPS (this box keeps voting until the switch)'
        : role === 'dst' ? 'target VPS (where the validator ends up)' : 'host seen in the log';
      var dot = document.createElement('span');
      dot.className = 'mc-legend__dot';
      dot.style.background = 'var(' + hostColor(ip) + ')';
      var label = document.createElement('span');
      label.className = 'v2-mono';
      label.textContent = (role ? ROLE_TAG[role] + ' ' : '') + ip;
      item.appendChild(dot);
      item.appendChild(label);
      box.appendChild(item);
    });
    box.hidden = state.hosts.length === 0;
  }

  function downloadLog() {
    var view = $('log-view');
    if (!view) return;
    var text = Array.prototype.map.call(view.querySelectorAll('.v2-log__row'), function (row) {
      return row.textContent;
    }).join('\n');
    var blob = new Blob([text], { type: 'text/plain' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ovtools-' + new Date().toISOString().replace(/[:.]/g, '-') + '.log';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  /* - wiring - */
  function wire() {
    $('btn-refresh').addEventListener('click', function (ev) {
      pollState();
      pollNodes();
      tip(ev.currentTarget, 'Refreshed');
    });

    // one console, two dashboards: the tabs swap the whole panel
    var segPrograms = $('seg-programs');
    if (segPrograms) {
      segPrograms.addEventListener('click', function (ev) {
        var node = ev.target;
        var program = null;
        while (node && node !== segPrograms) {
          if (node.getAttribute && node.getAttribute('data-program')) {
            program = node.getAttribute('data-program');
            break;
          }
          node = node.parentElement || null;
        }
        if (!program || program === state.program) return;
        setProgram(program);
        var label = program === 'deploy' ? 'Deploy fresh node'
          : (program === 'manage' ? 'Manage active node' : 'Migrate node');
        tip(node, label);
      });
    }

    // project settings: the row below it is a pointer to the Manage active node
    // tab (monitoring, bond, exit) - there is no dashboard switch any more
    var gotoManage = panelId('btn-goto-manage');
    if (gotoManage) gotoManage.addEventListener('click', function (ev) {
      var ip = gateHost();
      setProgram('manage');
      if (ip) { var m = $('inp-new'); if (m) { m.value = ip; } }
      tip(ev.currentTarget, 'Manage active node');
    });

    // the manage dashboard has its own buttons (bond / exit / monitor / status)
    var mBond = panelId('m-btn-bond');
    if (mBond) mBond.addEventListener('click', function (ev) { startManage('bond', ev.currentTarget); });
    var mExit = panelId('m-btn-exit');
    if (mExit) mExit.addEventListener('click', function (ev) { startManage('exit', ev.currentTarget); });
    var mDash = panelId('m-btn-dashboard');
    if (mDash) mDash.addEventListener('click', function (ev) { openMonitorModal(); });
    var mStatus = panelId('m-btn-status');
    if (mStatus) mStatus.addEventListener('click', function (ev) { requestRun('status', ev.currentTarget); });
    var mCheck = panelId('m-btn-check');
    if (mCheck) mCheck.addEventListener('click', function (ev) { runCheck(ev.currentTarget); });
    var mIp = panelId('m-inp-ip');
    if (mIp) mIp.addEventListener('input', function () { invalidateCheck(); });

    // the update actions of this tab: Update node / Manual update / Prune
    var mUpgrade = panelId('m-btn-upgrade');
    if (mUpgrade) mUpgrade.addEventListener('click', function (ev) { requestRun('upgrade', ev.currentTarget); });
    var mManual = panelId('m-btn-manual');
    if (mManual) mManual.addEventListener('click', function (ev) { requestRun('manual', ev.currentTarget); });
    var mStorage = panelId('m-btn-storage');
    if (mStorage) mStorage.addEventListener('click', function (ev) { requestRun('storage', ev.currentTarget); });
    // "why is it not voting?" + the bounded repair path (2026-11-06)
    var mDiagnose = panelId('m-btn-diagnose');
    if (mDiagnose) mDiagnose.addEventListener('click', function (ev) { requestRun('diagnose', ev.currentTarget); });
    var mRecover = panelId('m-btn-recover');
    if (mRecover) mRecover.addEventListener('click', function (ev) { requestRun('recover', ev.currentTarget); });

    // --- the manage modals (bond amount, exit confirmation, monitor options) --
    var bondOk = panelId('bond-ok');
    if (bondOk) bondOk.addEventListener('click', submitBond);
    var bondCancel = panelId('bond-cancel');
    if (bondCancel) bondCancel.addEventListener('click', closeBond);
    var bondAmount = panelId('bond-amount');
    if (bondAmount) {
      bondAmount.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); submitBond(); }
        if (ev.key === 'Escape') closeBond();
      });
    }
    var exitOk = panelId('exit-ok');
    if (exitOk) exitOk.addEventListener('click', submitExit);
    var exitCancel = panelId('exit-cancel');
    if (exitCancel) exitCancel.addEventListener('click', closeExit);
    var monitorOk = panelId('monitor-ok');
    if (monitorOk) monitorOk.addEventListener('click', submitMonitor);
    var monitorCancel = panelId('monitor-cancel');
    if (monitorCancel) monitorCancel.addEventListener('click', closeMonitor);
    var monitorPick = panelId('monitor-certdir-pick');
    if (monitorPick) monitorPick.addEventListener('click', pickCertDir);
    // editing a field that failed validation clears its error state
    [['monitor-domain', 'monitor-note'], ['monitor-certdir', 'monitor-note']]
      .forEach(function (pairIds) {
        var field = panelId(pairIds[0]);
        if (field) field.addEventListener('input', function () {
          clearFieldError(pairIds[0], pairIds[1]);
        });
      });
    ['monitor-ssl-cloudflare', 'monitor-ssl-certbot'].forEach(function (id) {
      var radio = panelId(id);
      if (radio) radio.addEventListener('change', syncMonitorSsl);
    });

    // the deploy dashboard has its own buttons
    var dStart = panelId('d-btn-start');
    if (dStart) dStart.addEventListener('click', function (ev) { startMigration(ev.currentTarget); });
    var dStatus = panelId('d-btn-status');
    if (dStatus) dStatus.addEventListener('click', function (ev) { requestRun('status', ev.currentTarget); });
    var dCheck = panelId('d-btn-check');
    if (dCheck) dCheck.addEventListener('click', function (ev) { runCheck(ev.currentTarget); });
    var dIp = panelId('d-inp-ip');
    if (dIp) dIp.addEventListener('input', function () { invalidateCheck(); rememberHosts(); });

    // auth rows are bound when a dashboard is rendered (bindAuthRows): the
    // program switcher swaps whole panels, so binding once at boot would only
    // cover the dashboard that happened to be open then.

    wirePassToggles();
    bindFilePickers();

    $('btn-stop').addEventListener('click', function (ev) {
      cancelRun(ev.currentTarget);
    });

    $('btn-swap').addEventListener('click', function () {
      var src = val('inp-old'), dst = val('inp-new');
      if (!src || !dst) return;
      $('inp-old').value = dst;
      $('inp-new').value = src;
      invalidateCheck();
      pollNodes();
      safetyChecks();
    });

    $('btn-check').addEventListener('click', function (ev) { runCheck(ev.currentTarget); });

    // "target uses the same password" mirrors the source field into the target
    var sameBox = $('chk-same-pass');
    if (sameBox) {
      sameBox.addEventListener('change', function () {
        syncPasswordFields();
        syncAllAuthFields();
        invalidateCheck();
      });
    }

    syncPasswordFields();
    syncAllAuthFields();

    ['inp-old', 'inp-new'].forEach(function (id) {
      var input = $(id);
      if (!input) return;
      input.addEventListener('input', function () { renderRoute(); invalidateCheck(); });
      input.addEventListener('change', function () {
        rememberHosts();
        pollNodes();
        safetyChecks();
      });
      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); runCheck(input); }
      });
    });

    // the monitoring dashboard (host name + certificate) is asked in the Manage
    // tab's own modal (Deploy monitor) - there is no domain popup here any more
    $('btn-run-all').addEventListener('click', function (ev) { startMigration(ev.currentTarget); });
    $('btn-run-rollback').addEventListener('click', function (ev) { requestRun('rollback', ev.currentTarget); });
    $('btn-status').addEventListener('click', function (ev) { requestRun('status', ev.currentTarget); });

    $('confirm-cancel').addEventListener('click', closeConfirm);
    $('confirm-ok').addEventListener('click', submitConfirm);
    var settingsSave = $('btn-settings-save');
    if (settingsSave) settingsSave.addEventListener('click', function (ev) { saveSettings(ev.currentTarget); });
    var enrollCancel = $('enroll-cancel');
    if (enrollCancel) enrollCancel.addEventListener('click', closeEnroll);
    var enrollOk = $('enroll-ok');
    if (enrollOk) enrollOk.addEventListener('click', submitEnroll);
    var enrollFunded = $('enroll-funded');
    if (enrollFunded) {
      enrollFunded.addEventListener('change', function () {
        var ok = $('enroll-ok');
        if (ok) ok.disabled = !enrollFunded.checked;
        if (enrollFunded.checked) setText('enroll-note', '');
      });
    }
    // the activation popup (the console watched the chain admit the validator)
    var activationOk = $('activation-ok');
    if (activationOk) activationOk.addEventListener('click', closeActivation);
    var activationModal = $('activation-modal');
    if (activationModal) {
      activationModal.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') closeActivation();
      });
    }
    // the exit popup (unlock epoch + the moment the stake is back)
    var exitOk = $('exit-state-ok');
    if (exitOk) exitOk.addEventListener('click', closeExitReport);
    var exitModal = $('exit-state-modal');
    if (exitModal) {
      exitModal.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') closeExitReport();
      });
    }
    var confirmOk = $('confirm-ok');
    if (confirmOk) confirmOk.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); submitConfirm(); }
      if (ev.key === 'Escape') closeConfirm();
    });

    var seg = document.querySelector('.mc-logbar .v2-seg');
    if (seg) {
      seg.addEventListener('click', function (ev) {
        var btn = ev.target.closest ? ev.target.closest('[data-level]') : null;
        if (!btn) return;
        Array.prototype.forEach.call(seg.querySelectorAll('.v2-seg__btn'), function (b) {
          b.classList.toggle('v2-seg__btn--active', b === btn);
        });
        state.logLevel = btn.getAttribute('data-level');
        applyLogFilter();
      });
    }

    var hostSeg = $('seg-host');
    if (hostSeg) {
      hostSeg.addEventListener('click', function (ev) {
        var btn = ev.target.closest ? ev.target.closest('[data-host-filter]') : null;
        if (!btn) return;
        state.hostFilter = btn.getAttribute('data-host-filter');
        renderHostFilter();
        applyLogFilter();
      });
    }

    $('inp-log-filter').addEventListener('input', function () {
      state.logQuery = val('inp-log-filter').toLowerCase();
      applyLogFilter();
    });

    $('btn-log-pause').addEventListener('click', function (ev) {
      state.logPaused = !state.logPaused;
      ev.currentTarget.setAttribute('aria-pressed', String(state.logPaused));
      ev.currentTarget.textContent = state.logPaused ? 'resume' : 'pause';
      tip(ev.currentTarget, state.logPaused ? 'Log paused' : 'Log resumed', state.logPaused ? 'warn' : 'ok');
    });

    $('btn-log-clear').addEventListener('click', clearLog);
    $('btn-log-download').addEventListener('click', downloadLog);
  }

  function init() {
    wire();
    // project settings (swap / data volume / dashboard) - shared by both programs
    loadSettings();
    syncPasswordFields();
    syncAllAuthFields();
    restoreHosts();
    renderRoute();
    rememberHosts();
    applyGating();
    getJSON('/api/config').then(function (cfg) {
      state.cfg = cfg;
      state.program = restoreProgram(cfg);
      setText('hero-project', cfg.projectRoot || 'project');
      renderProgram();

      var note = $('action-note');
      if (note && state.cfg && !state.cfg.dashboardPresent) {
        note.textContent = 'WARNING: dashboard assets are missing - the dashboard will not be deployed.';
      }
      applyGating();

      pollState();
      pollNodes();
      connectLog();
      setInterval(pollState, POLL_STATE_MS);
      setInterval(pollNodes, POLL_NODES_MS);
      setInterval(function () {
        var s = state.runner;
        if (s && s.running && s.startedAt) {
          setText('hero-elapsed', fmtElapsed(Math.max(0, Math.round(Date.now() / 1000 - s.startedAt))));
        }
      }, 1000);
    }).catch(function (err) {
      var note = $('action-note');
      if (note) note.textContent = 'CONFIG ERROR: ' + err.message;
      setText('topbar-status-text', 'config error');
      badge('topbar-status', 'v2-badge--err');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();


