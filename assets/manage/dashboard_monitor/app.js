/**
 * Octra Live Monitor - dashboard runtime
 * =====================================
 * Polls /api/status and /api/logs, then renders every section in place.
 * Navigation, theme, dock and gauge CSS are handled by Synteq UI V2.
 *
 * Design notes
 *  - Values are written with textContent (never innerHTML) so node output can
 *    never inject markup.
 *  - A failed poll never blanks the dashboard: the last good snapshot stays on
 *    screen and the topbar switches to "stale" so the operator sees its age.
 *  - Derived numbers come from the backend snapshot, keeping the browser free
 *    of heuristics that could disagree with the server.
 */
(function () {
  'use strict';

  var POLL_MS     = 5000;
  var LOG_POLL_MS = 5000;
  var STALE_AFTER = 15000;   // ms without a good poll before flagging stale
  var LOG_LINES   = 200;

  var state = {
    status: null,
    lastOkAt: 0,
    failures: 0,
    paused: false,
    logs: [],
    logLevel: 'all',
    logQuery: '',
    logPaused: false,
    fetching: false
  };

  /* -- tiny DOM helpers ------------------------------------------- */
  function $(id) { return document.getElementById(id); }

  function setText(id, value) {
    var node = $(id);
    if (!node) return;
    var next = (value === undefined || value === null) ? '-' : String(value);
    if (node.textContent !== next) node.textContent = next;
  }

  function clearBadge(node, keep) {
    if (!node) return;
    node.classList.remove('v2-badge--ok', 'v2-badge--warn', 'v2-badge--err', 'v2-badge--brand');
    if (keep) node.classList.add(keep);
  }

  /* -- formatting ------------------------------------------------- */
  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  function fmtInt(v) {
    if (!isNum(v)) return '-';
    return v.toLocaleString('en-US');
  }

  function fmtFixed(v, digits) {
    if (!isNum(v)) return '-';
    return v.toFixed(digits === undefined ? 1 : digits);
  }

  function fmtAge(sec) {
    if (!isNum(sec)) return '-';
    if (sec < 1) return '<1s';
    if (sec < 60) return Math.round(sec) + 's';
    if (sec < 3600) return Math.round(sec / 60) + 'm';
    if (sec < 86400) return Math.floor(sec / 3600) + 'h ' + Math.round((sec % 3600) / 60) + 'm';
    return Math.floor(sec / 86400) + 'd ' + Math.floor((sec % 86400) / 3600) + 'h';
  }

  function fmtCompact(v) {
    if (!isNum(v)) return '-';
    var abs = Math.abs(v);
    if (abs >= 1e12) return (v / 1e12).toFixed(2) + 'T';
    if (abs >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (abs >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return String(Math.round(v));
  }

  /** Ledger amounts: 6 decimals of precision, never trailing noise. */
  function fmtToken(v, withUnit) {
    if (!isNum(v)) return '-';
    var text = v.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 6
    });
    // Non-breaking space keeps the unit glued to the amount when a stat wraps.
    return withUnit === false ? text : (text + '\u00A0OCT');
  }

  function fmtBytes(bytes) {
    if (!isNum(bytes) || bytes <= 0) return '0 B';
    if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return Math.round(bytes) + ' B';
  }

  function fmtClock(iso) {
    if (!iso) return '-';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '-';
    return d.toLocaleTimeString('en-GB', { hour12: false });
  }

  function fmtShortHash(hash, head, tail) {
    if (!hash || hash === '-') return '-';
    var h = String(hash);
    if (h.length <= (head + tail + 1)) return h;
    return h.slice(0, head) + '...' + h.slice(-tail);
  }

  function shortAddr(addr) { return fmtShortHash(addr, 12, 8); }

  function num(v) { return isNum(v) ? v : 0; }

  /* -- gauges ----------------------------------------------------- */
  /** Quorum-style bar: brand coloured, no threshold colouring. */
  function setBar(fillId, trackId, pct) {
    var fill = $(fillId);
    if (!fill) return;
    var value = num(pct);
    if (window.SynteqV2 && SynteqV2.renderGauge) {
      SynteqV2.renderGauge(fill, value, { kind: 'brand' });
    } else {
      fill.style.width = Math.max(0, Math.min(100, value)) + '%';
    }
    var track = $(trackId);
    if (track) track.setAttribute('aria-valuenow', String(Math.round(value)));
  }

  /** Resource bar: framework threshold colouring (ok / warn / err). */
  function setResourceBar(fillId, trackId, pct) {
    var fill = $(fillId);
    if (!fill) return;
    var value = num(pct);
    if (window.SynteqV2 && SynteqV2.renderGauge) {
      SynteqV2.renderGauge(fill, value);
    } else {
      fill.style.width = Math.max(0, Math.min(100, value)) + '%';
    }
    var track = $(trackId);
    if (track) track.setAttribute('aria-valuenow', String(Math.round(value)));
  }

  /* -- status vocabulary ------------------------------------------ */
  /* `short` is the one-word form the bottom navigation badge shows ("Active"),
     `text` the sentence-style form the topbar/hero use. */
  var STATUS_MAP = {
    validator_active: { text: 'validator active', short: 'Active',      cls: 'v2-badge--ok',   dot: '' },
    observer_synced:  { text: 'observer synced',  short: 'Observer',    cls: 'v2-badge--ok',   dot: '' },
    syncing:          { text: 'syncing',          short: 'Syncing',     cls: 'v2-badge--warn', dot: 'v2-dot--warn' },
    offline:          { text: 'offline',          short: 'Offline',     cls: 'v2-badge--err',  dot: 'v2-dot--err' },
    connecting:       { text: 'connecting',       short: 'Connecting',  cls: '',               dot: 'v2-dot--idle' },
    unreachable:      { text: 'api unreachable',  short: 'Unreachable', cls: 'v2-badge--err',  dot: 'v2-dot--err' }
  };

  function paintDot(node, dotClass) {
    if (!node) return;
    node.classList.remove('v2-dot--ok', 'v2-dot--warn', 'v2-dot--err', 'v2-dot--idle',
      'v2-dot--stopped', 'v2-dot--reboot');
    if (dotClass) node.classList.add(dotClass);
  }

  /* Hero status and the bottom-navigation badge: a coloured dot plus coloured
     text (no badge chrome). The tone class is what the smoke test asserts, and
     what CSS colours. */
  var HERO_TONE = {
    'v2-badge--ok': 'dash-status--ok',
    'v2-badge--warn': 'dash-status--warn',
    'v2-badge--err': 'dash-status--err'
  };

  function paintStatusTone(node, info) {
    if (!node) return;
    var tone = HERO_TONE[info.cls] || 'dash-status--info';
    ['dash-status--ok', 'dash-status--warn', 'dash-status--err', 'dash-status--info']
      .forEach(function (name) { node.classList.remove(name); });
    node.classList.add(tone);
  }

  function setHeroStatus(info) {
    setText('hero-status-text', info.text);
    paintDot($('hero-status-dot'), info.dot);
    paintStatusTone($('hero-status'), info);
  }

  /* Bottom-right of the navigation dock: one word, the validator state. */
  function setDockStatus(info) {
    setText('dock-status-text', info.short || info.text);
    paintDot($('dock-dot'), info.dot);
    paintStatusTone($('dock-status'), info);
    var host = $('dock-status');
    if (host) host.title = 'Validator status: ' + info.text;
  }

  function applyStatus(key) {
    var info = STATUS_MAP[key] || STATUS_MAP.connecting;

    clearBadge($('topbar-status'), info.cls);
    setText('topbar-status-text', info.text);
    paintDot($('topbar-dot'), info.dot);

    setHeroStatus(info);
    setDockStatus(info);

    document.body.setAttribute('data-node-status', key);
  }

  /* -- health checks ---------------------------------------------- */
  function buildChecks(d) {
    var n = d.node || {}, s = d.system || {}, c = d.consensus || {}, p = d.peers || {};
    var proc = n.process || {};
    var procOnline = String(proc.status || '').toLowerCase() === 'online';
    var checks = [];

    checks.push({
      label: 'RPC endpoint',
      status: n.rpc_ready ? 'ok' : 'err',
      detail: n.rpc_ready ? ('port ' + n.api_port + ' -> 200 OK') : ('no answer on port ' + n.api_port)
    });

    checks.push({
      label: 'Node process',
      status: procOnline ? 'ok' : 'err',
      detail: proc.name ? (proc.name + ' | ' + (proc.status || 'unknown')) : 'pm2 state unavailable'
    });

    checks.push({
      label: 'Voting',
      status: c.voting === 'enabled' ? 'ok' : 'warn',
      detail: c.voting === 'enabled' ? 'validator is voting' : (c.voting_reason || c.voting || 'unknown')
    });

    var rate = (n.epochs || {}).rate_per_min;
    var stalled = !!(n.epochs || {}).stalled;
    var lastAdvance = num((n.epochs || {}).last_change_age_sec);
    checks.push({
      label: 'Epoch progression',
      status: stalled ? 'err' : (num(rate) > 0 ? 'ok' : (lastAdvance < 90 ? 'ok' : 'warn')),
      detail: stalled
        ? 'head epoch stopped advancing'
        : (num(rate) > 0
            ? (fmtFixed(rate, 1) + ' epochs/min')
            : 'collecting samples... (' + fmtAge(lastAdvance) + ' since last advance)')
    });

    var lag = num(p.lag_max);
    checks.push({
      label: 'Sync vs network',
      status: lag > 20 ? 'err' : (lag > 2 ? 'warn' : 'ok'),
      detail: lag > 0
        ? (lag + ' epoch' + (lag === 1 ? '' : 's') + ' behind network head')
        : 'in sync with network head'
    });

    var connected = num(p.connected);
    checks.push({
      label: 'Peer connectivity',
      status: connected >= 8 ? 'ok' : (connected > 0 ? 'warn' : 'err'),
      detail: connected + ' connected | ' + num(p.known) + ' known | ' + num(p.consensus_peers) + ' consensus'
    });

    var q = c.quorum || {};
    var quorumPct = Math.max(num(q.prevote_pct), num(q.precommit_pct));
    var step = String(c.step || '').toLowerCase();
    var roundFresh = step === 'propose' || !isNum((c.participants || {}).newest_age_sec);
    checks.push({
      label: 'Quorum',
      status: roundFresh ? 'ok' : (quorumPct >= 100 ? 'ok' : (quorumPct >= 60 ? 'warn' : 'err')),
      detail: roundFresh
        ? 'round starting - ' + num(q.prevotes) + '/' + num(q.quorum) + ' prevotes so far'
        : (num(q.prevotes) + '/' + num(q.quorum) + ' prevotes | ' + num(q.precommits) + '/' + num(q.quorum) + ' precommits')
    });

    var memPct = num(s.mem_percent);
    var cpuPct = num(s.cpu_percent);
    checks.push({
      label: 'Compute headroom',
      status: (memPct >= 90 || cpuPct >= 95) ? 'err' : ((memPct >= 80 || cpuPct >= 80) ? 'warn' : 'ok'),
      detail: 'cpu ' + fmtFixed(cpuPct, 1) + '% | mem ' + fmtFixed(memPct, 1) + '%'
    });

    var diskPct = Math.max(num(s.disk_percent), num(s.disk_root_percent));
    checks.push({
      label: 'Disk space',
      status: diskPct >= 90 ? 'err' : (diskPct >= 80 ? 'warn' : 'ok'),
      detail: 'data ' + fmtFixed(s.disk_percent, 1) + '% | root ' + fmtFixed(s.disk_root_percent, 1) + '%'
    });

    var restarts = num(proc.restarts);
    checks.push({
      label: 'Restart count',
      status: restarts === 0 ? 'ok' : (restarts < 3 ? 'warn' : 'err'),
      detail: restarts === 0 ? 'no restarts since pm2 start' : (restarts + ' restart(s) recorded')
    });

    var counts = (d.logs || {}).counts || {};
    var errors = num(counts.error) + num(counts.fatal);
    checks.push({
      label: 'Log errors',
      status: errors === 0 ? 'ok' : 'warn',
      detail: errors === 0 ? 'no errors in the last 120 lines' : (errors + ' error line(s) in the last 120 lines')
    });

    return checks;
  }

  var CHECK_BADGE = {
    ok:   { cls: 'v2-badge--ok',   text: 'OK' },
    warn: { cls: 'v2-badge--warn', text: 'WARN' },
    err:  { cls: 'v2-badge--err',  text: 'FAIL' }
  };

  function renderHealth(d) {
    var list = $('health-list');
    if (!list) return [];
    var checks = buildChecks(d);
    var okCount = 0, warnCount = 0, errCount = 0;

    list.textContent = '';
    checks.forEach(function (check) {
      var info = CHECK_BADGE[check.status] || CHECK_BADGE.ok;
      if (check.status === 'ok') okCount++;
      else if (check.status === 'warn') warnCount++;
      else errCount++;

      var row = document.createElement('div');
      row.className = 'health__row';
      row.setAttribute('role', 'listitem');

      var badge = document.createElement('span');
      badge.className = 'v2-badge ' + info.cls;
      badge.textContent = info.text;

      var label = document.createElement('span');
      label.className = 'health__label';
      label.textContent = check.label;

      var detail = document.createElement('span');
      detail.className = 'health__detail';
      detail.textContent = check.detail;
      detail.title = check.detail;

      row.appendChild(badge);
      row.appendChild(label);
      row.appendChild(detail);
      list.appendChild(row);
    });

    setText('health-meta', okCount + ' ok | ' + warnCount + ' warn | ' + errCount + ' fail');
    return checks;
  }

  /* -- alerts ----------------------------------------------------- */
  function collectAlerts(d, checks) {
    var alerts = [];
    var n = d.node || {}, c = d.consensus || {}, p = d.peers || {}, s = d.system || {};
    var proc = n.process || {};

    (checks || []).forEach(function (check) {
      if (check.status === 'err') {
        alerts.push({ id: 'check|' + check.label, level: 'error', title: check.label, text: check.detail });
      }
    });

    if (!n.rpc_ready) {
      alerts.push({
        id: 'rpc',
        level: 'error',
        title: 'Node RPC unreachable',
        text: 'The node process is ' + (proc.status || 'unknown') + ' and not answering on port ' + n.api_port + '.'
      });
    }
    if (n.rpc_ready && c.voting === 'disabled') {
      alerts.push({
        id: 'voting',
        level: 'warn',
        title: 'Voting disabled',
        text: c.voting_reason || 'The node runs as an observer until voting resumes.'
      });
    }
    var ahead = num(p.ahead_count);
    if (ahead > 0) {
      alerts.push({ id: 'peers-ahead', level: 'warn', title: 'Behind ' + ahead + ' peer(s)', text: 'Peers report a newer head epoch than this node.' });
    }
    var lag = num(p.lag_max);
    if (lag > 2 && ahead === 0) {
      alerts.push({
        id: 'lag',
        level: lag > 20 ? 'error' : 'warn',
        title: 'Sync lag ' + lag + ' epoch(s)',
        text: 'Local head is ' + lag + ' epoch(s) behind the network head.'
      });
    }
    if ((n.epochs || {}).stalled) {
      alerts.push({
        id: 'stall',
        level: 'error',
        title: 'Epoch seems stalled',
        text: 'Head epoch has not advanced for ' + fmtAge((n.epochs || {}).last_change_age_sec) + '.'
      });
    }
    if (num(proc.restarts) > 0) {
      alerts.push({
        id: 'restarts',
        level: 'info',
        title: 'Process restarted ' + num(proc.restarts) + 'x',
        text: 'pm2 counters reset only when the process is restarted.'
      });
    }
    if (num(s.swap_percent) >= 50) {
      alerts.push({
        id: 'swap',
        level: 'warn',
        title: 'Swap in use',
        text: fmtFixed(s.swap_percent, 1) + '% of swap is allocated - memory pressure is likely.'
      });
    }

    var order = { error: 0, warn: 1, info: 2 };
    alerts.sort(function (a, b) { return order[a.level] - order[b.level]; });
    return alerts;
  }

  var ALERT_ICON = {
    error: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    warn:  '<circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    info:  '<circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16"/><line x1="12" y1="8" x2="12.01" y2="8"/>'
  };

  /* -- alert dismissal -------------------------------------------- */
  /* "Sync lag 3 epoch(s)" / "Process restarted 1x" came back on every 5 s poll,
     so the operator could not get rid of them. Each row now carries a close
     button; the dismissal is remembered per alert kind (localStorage) and is
     dropped as soon as the condition is gone, so a returning problem shows up
     again. A link offers to bring the hidden rows back (2026-11-06). */
  var DISMISS_KEY = 'octra-dash-dismissed-alerts';
  var dismissedIds = {};
  var lastAlerts = [];

  function storageGet(key) {
    try {
      if (typeof localStorage !== 'undefined' && localStorage) return localStorage.getItem(key);
    } catch (err) { /* private mode: memory only */ }
    return null;
  }

  function storageSet(key, value) {
    try {
      if (typeof localStorage !== 'undefined' && localStorage) localStorage.setItem(key, value);
    } catch (err) { /* private mode: memory only */ }
  }

  function loadDismissed() {
    dismissedIds = {};
    var raw = storageGet(DISMISS_KEY);
    if (!raw) return dismissedIds;
    try {
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') dismissedIds = parsed;
    } catch (err) {
      dismissedIds = {};
    }
    return dismissedIds;
  }

  function saveDismissed() {
    storageSet(DISMISS_KEY, JSON.stringify(dismissedIds));
  }

  function alertId(alert) {
    var raw = String((alert && (alert.id || alert.title)) || 'alert');
    return raw.toLowerCase().replace(/[^a-z0-9|]+/g, '-');
  }

  function renderAlerts(alerts) {
    var box = $('alerts');
    if (!box) return;
    lastAlerts = alerts || [];
    box.textContent = '';

    var stored = loadDismissed();
    var live = {}, shown = [], hidden = 0;
    lastAlerts.forEach(function (alert) {
      var id = alertId(alert);
      live[id] = true;
      if (stored[id]) { hidden++; return; }
      shown.push(alert);
    });
    // forget dismissals whose alert is gone: a problem that returns is news
    var pruned = false;
    Object.keys(stored).forEach(function (id) {
      if (!live[id]) { delete stored[id]; pruned = true; }
    });
    if (pruned) saveDismissed();

    if (!lastAlerts.length) {
      box.hidden = true;
      return;
    }
    box.hidden = false;

    shown.slice(0, 5).forEach(function (alert) {
      var row = document.createElement('div');
      row.className = 'alert alert--' + alert.level;

      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'v2-icon v2-icon--14');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      svg.innerHTML = ALERT_ICON[alert.level] || ALERT_ICON.info;

      var text = document.createElement('div');
      text.className = 'alert__text';
      var strong = document.createElement('strong');
      strong.textContent = alert.title + ' - ';
      text.appendChild(strong);
      text.appendChild(document.createTextNode(alert.text));

      var close = document.createElement('button');
      close.type = 'button';
      close.className = 'alert__close';
      close.setAttribute('aria-label', 'Dismiss: ' + alert.title);
      close.title = 'Dismiss this message';
      var x = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      x.setAttribute('class', 'v2-icon v2-icon--12');
      x.setAttribute('viewBox', '0 0 24 24');
      x.setAttribute('aria-hidden', 'true');
      x.innerHTML = '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>';
      close.appendChild(x);
      close.addEventListener('click', function () {
        dismissedIds[alertId(alert)] = 1;
        saveDismissed();
        renderAlerts(lastAlerts);
      });

      row.appendChild(svg);
      row.appendChild(text);
      row.appendChild(close);
      box.appendChild(row);
    });

    var rest = shown.length - Math.min(shown.length, 5);
    if (rest > 0) {
      var more = document.createElement('div');
      more.className = 'alert alert--info';
      more.textContent = rest + ' more issue(s) - see the health checks below.';
      box.appendChild(more);
    }
    if (hidden > 0) {
      var link = document.createElement('div');
      link.className = 'alerts__restore';
      link.textContent = hidden + ' message(s) hidden - show them';
      link.addEventListener('click', function () {
        dismissedIds = {};
        saveDismissed();
        renderAlerts(lastAlerts);
      });
      box.appendChild(link);
    }
  }

  function renderBadgeInto(id, text, cls) {
    var host = $(id);
    if (!host) return;
    host.textContent = '';
    var badge = document.createElement('span');
    badge.className = 'v2-badge ' + (cls || '');
    badge.textContent = text;
    host.appendChild(badge);
  }

  /* -- overview --------------------------------------------------- */
  function renderOverview(d) {
    var n = d.node || {}, s = d.system || {}, p = d.peers || {}, c = d.consensus || {};
    var q = c.quorum || {}, e = n.epochs || {}, proc = n.process || {}, be = d.backend || {};

    var hostname = s.hostname || n.name || 'node';
    setText('hero-hostname', hostname);
    /* The topbar title is fixed ("Dashboard Monitoring") and the role/chain
       badges next to the hostname were removed on request: the hostname stays
       in the hero, the chain is shown in the System section. */

    var address = n.address || 'unknown';
    setText('hero-address', address === 'unknown' ? 'not configured' : shortAddr(address));
    var addrBtn = $('hero-address-btn');
    if (addrBtn) {
      addrBtn.setAttribute('data-v2-copy', address === 'unknown' ? '' : address);
      addrBtn.setAttribute('aria-label', 'Copy validator address');
      addrBtn.title = address;
    }

    setText('hero-node-uptime', proc.uptime || '-');
    setText('hero-updated', fmtClock(d.timestamp));

    setText('kpi-head', fmtInt(n.head_epoch));
    setText('kpi-head-sub', 'current epoch ' + fmtInt(n.current_epoch));

    var lag = num(p.lag_max);
    setText('kpi-lag', lag + ' epoch' + (lag === 1 ? '' : 's'));
    setText('kpi-lag-sub', 'network head ' + fmtInt(p.network_head));
    var lagNode = $('kpi-lag');
    if (lagNode) {
      lagNode.style.color = lag > 20 ? 'var(--v2-status-error)'
        : (lag > 2 ? 'var(--v2-status-warning)' : '');
    }

    setText('kpi-quorum', fmtFixed(q.prevote_pct, 0) + '%');
    setText('kpi-quorum-sub',
      num(q.prevotes) + ' / ' + num(q.quorum) + ' voters | ' + fmtFixed(q.prevote_weight_pct, 0) + '% weight');

    setText('kpi-peers', fmtInt(p.consensus_peers));
    setText('kpi-peers-sub', num(p.connected) + ' connected | ' + num(p.known) + ' known');

    setText('kpi-rate', fmtFixed(e.rate_per_min, 1) + '/min');
    setText('kpi-rate-sub', isNum(e.interval_sec) ? (fmtFixed(e.interval_sec, 1) + ' s per epoch') : 'measuring...');

    setText('kpi-avail', fmtFixed(be.availability_pct, 1) + '%');
    setText('kpi-avail-sub', fmtInt(be.samples) + ' samples | up ' + (be.uptime || '-'));

    /* consensus round panel */
    setText('con-step-badge', c.step || '-');
    clearBadge($('con-step-badge'), c.agreed ? 'v2-badge--ok' : '');
    setText('con-epoch', fmtInt(c.epoch));
    setText('con-round', isNum(c.round) && c.round >= 0 ? c.round : '-');
    setText('con-step', c.step || '-');
    renderBadgeInto('con-agreed', c.agreed ? 'agreed' : 'pending', c.agreed ? 'v2-badge--ok' : 'v2-badge--warn');
    var parts = c.participants || {};
    setText('con-participants', num(parts.total) + ' validators');
    renderBadgeInto('con-voting',
      c.voting === 'enabled' ? 'voting' : (c.voting === 'disabled' ? 'observer' : 'unknown'),
      c.voting === 'enabled' ? 'v2-badge--ok' : 'v2-badge--warn');

    setText('prevote-count', fmtInt(q.prevotes));
    setText('prevote-quorum', '/ ' + fmtInt(q.quorum));
    setText('prevote-sub',
      fmtFixed(q.prevote_weight_pct, 1) + '% of quorum weight | ' + num(q.prevote_proposals) + ' proposal(s)');
    setBar('prevote-fill', 'gauge-prevote', q.prevote_pct);

    setText('precommit-count', fmtInt(q.precommits));
    setText('precommit-quorum', '/ ' + fmtInt(q.quorum));
    setText('precommit-sub', fmtFixed(q.precommit_weight_pct, 1) + '% of quorum weight');
    setBar('precommit-fill', 'gauge-precommit', q.precommit_pct);
  }

  /* -- consensus section ------------------------------------------ */
  function renderConsensus(d) {
    var n = d.node || {}, c = d.consensus || {}, q = c.quorum || {}, e = n.epochs || {};
    var parts = c.participants || {};

    setText('c-step', c.step || '-');
    setText('c-round', isNum(c.round) && c.round >= 0 ? c.round : '-');
    setText('c-participants', fmtInt(parts.total));
    setText('c-participants-sub',
      num(parts.propose) + ' propose | ' + num(parts.prevote) + ' prevote | ' + num(parts.precommit) + ' precommit');
    setText('c-vote-age', isNum(parts.newest_age_sec) ? fmtAge(parts.newest_age_sec) : '-');
    setText('c-interval', isNum(e.interval_sec) ? (fmtFixed(e.interval_sec, 1) + ' s') : '-');
    setText('c-last-advance', fmtAge(e.last_change_age_sec));
    setText('c-last-advance-sub', e.stalled ? 'stalled - investigate' : 'head epoch advanced');

    setText('c-quorum-weight', fmtCompact(q.quorum_weight) + ' weight');
    setText('c-quorum-weight-kv', fmtCompact(q.quorum_weight));
    setText('c-proposals', fmtInt(q.prevote_proposals));
    renderBadgeInto('c-agreed', c.agreed ? 'agreed' : 'pending', c.agreed ? 'v2-badge--ok' : 'v2-badge--warn');

    setText('prevote-w-pct', fmtFixed(q.prevote_weight_pct, 1) + '%');
    setText('prevote-w-raw', fmtCompact(q.prevote_weight) + ' of ' + fmtCompact(q.quorum_weight) + ' quorum weight');
    setBar('prevote-w-fill', 'gauge-prevote-w', q.prevote_weight_pct);

    setText('precommit-w-pct', fmtFixed(q.precommit_weight_pct, 1) + '%');
    setText('precommit-w-raw', fmtCompact(q.precommit_weight) + ' of ' + fmtCompact(q.quorum_weight) + ' quorum weight');
    setBar('precommit-w-fill', 'gauge-precommit-w', q.precommit_weight_pct);

    setText('c-head', fmtInt(n.head_epoch));
    setText('c-current', fmtInt(n.current_epoch));
    setText('c-pending', fmtInt(n.pending_epochs));
    setText('c-rate', fmtFixed(e.rate_per_min, 2) + ' / min');

    /* epoch progression sparkline (series kept by the backend) */
    var history = e.history || [];
    var heads = [];
    for (var i = 0; i < history.length; i++) {
      if (Array.isArray(history[i]) && isNum(history[i][1])) heads.push(history[i][1]);
    }
    var spark = $('epoch-spark');
    if (spark && heads.length >= 2) {
      SynteqV2.renderSparkline(spark, heads);
    }
    setText('epoch-spark-meta', heads.length >= 2
      ? (heads.length + ' samples | ' + fmtFixed(e.rate_per_min, 1) + ' ep/min')
      : 'collecting samples...');

    /* prevote proposal table */
    var body = $('votes-body');
    if (!body) return;
    var proposals = c.proposals || [];
    setText('votes-meta', proposals.length + ' proposal(s) | ' + num(q.prevotes) + ' voters');
    body.textContent = '';

    if (!proposals.length) {
      var empty = document.createElement('tr');
      var cell = document.createElement('td');
      cell.colSpan = 3;
      cell.className = 'v2-table__mute';
      cell.textContent = c.available ? 'No prevotes recorded in this round yet.' : 'Consensus RPC unavailable.';
      empty.appendChild(cell);
      body.appendChild(empty);
      return;
    }

    proposals.forEach(function (proposal) {
      var tr = document.createElement('tr');

      var tdId = document.createElement('td');
      tdId.className = 'v2-table__mono';
      tdId.textContent = fmtShortHash(proposal.proposal_id, 14, 8);
      tdId.title = proposal.proposal_id;

      var tdVoters = document.createElement('td');
      tdVoters.className = 'v2-table__num';
      tdVoters.textContent = fmtInt(proposal.voters);

      var tdWeight = document.createElement('td');
      tdWeight.className = 'v2-table__num';
      tdWeight.textContent = fmtCompact(proposal.weight);

      tr.appendChild(tdId);
      tr.appendChild(tdVoters);
      tr.appendChild(tdWeight);
      body.appendChild(tr);
    });
  }

  /* -- resources -------------------------------------------------- */
  function renderResources(d) {
    var s = d.system || {}, n = d.node || {};
    var load = s.load_avg || [0, 0, 0];

    setText('res-meta', 'live | ' + fmtClock(d.timestamp));
    setText('res-cores-meta', num(s.cpu_cores) + ' vCPU | ' + (s.arch || '-'));

    setText('res-cpu-pct', fmtFixed(s.cpu_percent, 1) + '%');
    setText('res-cpu-sub', 'load 1m ' + fmtFixed(load[0], 2) + ' on ' + num(s.cpu_cores) + ' cores');
    setResourceBar('res-cpu-fill', 'gauge-cpu', s.cpu_percent);

    setText('res-mem-pct', fmtFixed(s.mem_percent, 1) + '%');
    setText('res-mem-sub',
      fmtFixed(s.mem_used_gb, 1) + ' / ' + fmtFixed(s.mem_total_gb, 1) + ' GB | ' +
      fmtFixed(s.mem_avail_gb, 1) + ' GB available');
    setResourceBar('res-mem-fill', 'gauge-mem', s.mem_percent);

    setText('res-swap-pct', fmtFixed(s.swap_percent, 1) + '%');
    setText('res-swap-sub',
      fmtFixed(s.swap_used_gb, 1) + ' / ' + fmtFixed(s.swap_total_gb, 1) + ' GB');
    setResourceBar('res-swap-fill', 'gauge-swap', s.swap_percent);

    setText('res-disk-pct', fmtFixed(s.disk_percent, 1) + '%');
    setText('res-disk-sub',
      fmtFixed(s.disk_used_gb, 1) + ' / ' + fmtFixed(s.disk_total_gb, 1) + ' GB | ' +
      fmtFixed(s.disk_free_gb, 1) + ' GB free');
    setResourceBar('res-disk-fill', 'gauge-disk', s.disk_percent);

    setText('res-root-pct', fmtFixed(s.disk_root_percent, 1) + '%');
    setText('res-root-sub',
      fmtFixed(s.disk_root_used_gb, 1) + ' / ' + fmtFixed(s.disk_root_total_gb, 1) + ' GB');
    setResourceBar('res-root-fill', 'gauge-root', s.disk_root_percent);

    setText('res-load',
      fmtFixed(load[0], 2) + ' / ' + fmtFixed(load[1], 2) + ' / ' + fmtFixed(load[2], 2));
    setText('res-load-pct', fmtFixed(s.load_percent, 1) + '% of ' + num(s.cpu_cores) + ' cores');
    setText('res-uptime', s.uptime || '-');
    setText('res-disk-read', fmtFixed(s.disk_read_mbps, 2) + ' MB/s');
    setText('res-disk-write', fmtFixed(s.disk_write_mbps, 2) + ' MB/s');
    setText('res-data-dir', n.data_dir || '-');
    setText('res-storage-meta', fmtFixed(s.disk_total_gb, 0) + ' GB volume');

    var history = s.cpu_history || [];
    var spark = $('cpu-spark');
    if (spark && history.length >= 2) {
      SynteqV2.renderSparkline(spark, history);
    }
    var sum = 0;
    for (var i = 0; i < history.length; i++) sum += num(history[i]);
    var avg = history.length ? (sum / history.length) : 0;
    setText('cpu-spark-meta',
      history.length >= 2
        ? ('now ' + fmtFixed(s.cpu_percent, 1) + '% | avg ' + fmtFixed(avg, 1) + '% | ' + history.length + ' samples')
        : 'collecting samples...');
  }

  /* -- peers ------------------------------------------------------ */
  /* Column budget for the Network I/O chart. The backend keeps a 240-sample
     ring buffer (20 min @ 5 s); drawing one grid track per sample needs
     239 x 4px of gap alone - wider than the panel - so every 1fr track
     collapsed to 0 px and the chart looked empty after the buffer filled.
     Peak per bucket keeps the spikes, 64 columns always fit. */
  var NET_COLS = 64;

  function netBuckets(history, maxCols) {
    var n = history.length;
    if (!n) return [];
    var groups = Math.min(maxCols, n);
    var out = [];
    for (var i = 0; i < groups; i++) {
      var from = Math.floor(i * n / groups);
      var to = Math.floor((i + 1) * n / groups);
      if (to <= from) to = from + 1;
      var inPeak = 0, outPeak = 0;
      for (var j = from; j < to; j++) {
        var pair = history[j] || [0, 0];
        inPeak = Math.max(inPeak, num(pair[0]));
        outPeak = Math.max(outPeak, num(pair[1]));
      }
      out.push([inPeak, outPeak]);
    }
    return out;
  }

  function renderPeers(d) {
    var p = d.peers || {}, s = d.system || {};

    setText('peers-meta', 'live | ' + fmtClock(d.timestamp));
    setText('p-connected', fmtInt(p.connected));
    setText('p-known-sub', 'of ' + fmtInt(p.known) + ' known');
    setText('p-consensus', fmtInt(p.consensus_peers));
    setText('p-lag-max', fmtInt(p.lag_max));
    setText('p-drift-median', fmtFixed(p.drift_median, 0));
    setText('p-behind', fmtInt(p.behind_count));
    setText('p-stale', fmtInt(p.stale_count));

    setText('p-synced', fmtInt(p.synced_count));
    setText('p-drift-max', fmtInt(p.drift_max));
    setText('p-ahead', fmtInt(p.ahead_count));
    setText('p-sources', fmtInt(p.public_sources));
    renderBadgeInto('p-banned', fmtInt(p.banned_count), num(p.banned_count) > 0 ? 'v2-badge--err' : '');
    renderBadgeInto('p-paused', fmtInt(p.paused_count), num(p.paused_count) > 0 ? 'v2-badge--warn' : '');

    setText('net-in', fmtFixed(s.net_in_mbps, 2) + ' Mbps');
    setText('net-out', fmtFixed(s.net_out_mbps, 2) + ' Mbps');

    var history = s.net_history || [];
    var peakIn = 0, peakOut = 0;
    for (var i = 0; i < history.length; i++) {
      if (!Array.isArray(history[i])) continue;
      peakIn = Math.max(peakIn, num(history[i][0]));
      peakOut = Math.max(peakOut, num(history[i][1]));
    }
    var peak = Math.max(peakIn, peakOut, 1);
    var cols = netBuckets(history, NET_COLS);
    var bars = [];
    for (var j = 0; j < cols.length; j++) {
      bars.push([cols[j][0] / peak * 100, cols[j][1] / peak * 100]);
    }
    var bucketSec = cols.length
      ? (history.length / cols.length) * (POLL_MS / 1000)
      : POLL_MS / 1000;
    // Pad short series so freshly started backends still draw slim columns
    // instead of a handful of very wide bars.
    var barsEl = $('net-bars');
    if (barsEl && bars.length) {
      SynteqV2.renderBars(barsEl, bars, {
        minCols: 24,
        stepSec: Math.max(POLL_MS / 1000, bucketSec)
      });
    }
    setText('net-bars-meta',
      history.length
        ? ('peak v ' + fmtFixed(peakIn, 2) + ' | ^ ' + fmtFixed(peakOut, 2) +
           ' Mbps over ' + history.length + ' samples in ' + cols.length + ' columns')
        : 'collecting samples...');

    var body = $('peers-body');
    if (!body) return;
    var rows = p.top || [];
    body.textContent = '';

    if (!rows.length) {
      var empty = document.createElement('tr');
      var cell = document.createElement('td');
      cell.colSpan = 6;
      cell.className = 'v2-table__mute';
      cell.textContent = p.available ? 'No peer records received yet.' : 'Consensus RPC unavailable.';
      empty.appendChild(cell);
      body.appendChild(empty);
      setText('peers-table-meta', '-');
      return;
    }

    rows.forEach(function (peer) {
      var tr = document.createElement('tr');
      if (peer.stale) tr.className = 'is-stale';

      var tdAddr = document.createElement('td');
      tdAddr.className = 'v2-table__mono';
      tdAddr.textContent = peer.short || shortAddr(peer.addr);
      tdAddr.title = peer.addr;

      var tdHead = document.createElement('td');
      tdHead.className = 'v2-table__num';
      tdHead.textContent = fmtInt(peer.head_epoch);

      var tdLag = document.createElement('td');
      tdLag.className = 'v2-table__num';
      tdLag.textContent = fmtInt(peer.lag);
      if (num(peer.lag) > 20) tdLag.classList.add('lag-err');
      else if (num(peer.lag) > 2) tdLag.classList.add('lag-warn');

      var tdDrift = document.createElement('td');
      tdDrift.className = 'v2-table__num';
      tdDrift.textContent = fmtInt(peer.drift);
      if (num(peer.drift) > 10) tdDrift.classList.add('lag-err');
      else if (num(peer.drift) > 3) tdDrift.classList.add('lag-warn');

      var tdAge = document.createElement('td');
      tdAge.className = 'v2-table__num';
      tdAge.textContent = fmtAge(peer.age_sec);

      var tdSrc = document.createElement('td');
      tdSrc.className = 'v2-table__mute';
      tdSrc.textContent = peer.source || '-';

      tr.appendChild(tdAddr);
      tr.appendChild(tdHead);
      tr.appendChild(tdLag);
      tr.appendChild(tdDrift);
      tr.appendChild(tdAge);
      tr.appendChild(tdSrc);
      body.appendChild(tr);
    });

    setText('peers-table-meta', rows.length + ' of ' + fmtInt(p.consensus_peers) + ' records | drift = lag beyond record age');
  }

  /* -- process ---------------------------------------------------- */
  function renderProcess(d) {
    var n = d.node || {}, proc = n.process || {}, logs = d.logs || {};
    var counts = logs.counts || {};
    var online = String(proc.status || '').toLowerCase() === 'online';

    setText('pr-meta', 'pm2 | ' + (proc.name || 'unknown'));
    renderBadgeInto('pr-status', proc.status || 'unknown',
      online ? 'v2-badge--ok' : (proc.status === 'unavailable' ? 'v2-badge--warn' : 'v2-badge--err'));
    setText('pr-name-sub', proc.name || '-');
    setText('pr-pid', proc.pid ? fmtInt(proc.pid) : '-');
    setText('pr-uptime', proc.uptime || '-');
    setText('pr-restarts', fmtInt(proc.restarts));
    setText('pr-cpu', fmtFixed(proc.cpu, 1) + '%');
    setText('pr-mem', fmtFixed(proc.memory_mb, 0) + ' MB');

    setText('pr-name', proc.name || '-');
    setText('pr-exec', proc.exec_mode || '-');
    setText('pr-instances', fmtInt(proc.instances));
    setText('pr-commit', n.source_commit || '-');
    setText('pr-rpc', '127.0.0.1:' + (n.api_port || '-'));
    setText('pr-runtime-meta', proc.node_version && proc.node_version !== 'none' ? proc.node_version : 'pm2 daemon');

    var warns = num(counts.warn);
    var errors = num(counts.error) + num(counts.fatal);
    renderBadgeInto('pr-warn', fmtInt(warns) + ' lines', warns > 0 ? 'v2-badge--warn' : '');

    var lastWarn = logs.last_warn || {};
    var lastError = logs.last_error || {};
    renderBadgeInto('pr-error', fmtInt(errors) + ' lines', errors > 0 ? 'v2-badge--err' : '');

    setText('pr-last-warn', warns ? shortEvent(lastWarn) : 'none');
    setText('pr-last-error', errors ? shortEvent(lastError) : 'none');
    var lw = $('pr-last-warn');
    if (lw) lw.title = warns ? (lastWarn.msg || '') : 'No warnings in the last 120 lines';
    var le = $('pr-last-error');
    if (le) le.title = errors ? (lastError.msg || '') : 'No errors in the last 120 lines';

    setText('pr-log-meta', fmtInt(logs.total) + ' lines sampled');
  }

  function shortEvent(entry) {
    if (!entry || !entry.msg) return '-';
    var parts = [];
    if (entry.component) parts.push(entry.component);
    if (entry.event) parts.push(entry.event);
    if (entry.reason) parts.push('reason=' + entry.reason);
    if (parts.length) return parts.join(' | ');
    return entry.msg.slice(0, 60);
  }

  /* -- system ----------------------------------------------------- */
  function renderSystem(d) {
    var n = d.node || {}, s = d.system || {}, be = d.backend || {};

    setText('sys-meta', 'backend v' + (be.version || '-') + ' | up ' + (be.uptime || '-'));
    setText('sys-chain', n.chain || '-');
    setText('sys-role', n.role || '-');
    setText('sys-api', n.api_port ? ('127.0.0.1:' + n.api_port) : '-');
    setText('sys-network-version', n.network_version || '-');
    setText('sys-storage', n.storage_backend || '-');
    setText('sys-data-dir', n.data_dir || '-');

    setText('sys-hostname', s.hostname || '-');
    setText('sys-os', s.os || '-');
    setText('sys-kernel', s.kernel || '-');
    setText('sys-arch', s.arch || '-');
    setText('sys-cores', fmtInt(s.cpu_cores));
    setText('sys-uptime', s.uptime || '-');

    setText('sys-accounts', fmtInt(n.accounts));
    setText('sys-active-accounts', fmtInt(n.active_accounts));
    setText('sys-supply', fmtCompact(parseFloat(n.total_supply)) + ' OCT');
    setText('sys-circulating', fmtCompact(parseFloat(n.circulating_supply)) + ' OCT');
    setText('sys-encrypted', fmtCompact(parseFloat(n.encrypted_supply)) + ' OCT');
    setText('sys-txid', n.txid_hi || '-');

    setText('sys-state-root', fmtShortHash(n.state_root, 16, 12));
    setText('sys-irmin', fmtShortHash(n.irmin_commit, 16, 12));
    setText('sys-commit', n.source_commit || '-');
    setText('sys-backend', 'octra-dashboard | python3 | 127.0.0.1:9090');
    setText('sys-backend-avail',
      fmtFixed(be.availability_pct, 1) + '% of ' + fmtInt(be.samples) + ' samples');

    var rootBtn = $('copy-state-root');
    if (rootBtn) {
      rootBtn.setAttribute('data-v2-copy', n.state_root || '');
      rootBtn.title = n.state_root || '';
    }
    var irminBtn = $('copy-irmin');
    if (irminBtn) {
      irminBtn.setAttribute('data-v2-copy', n.irmin_commit || '');
      irminBtn.title = n.irmin_commit || '';
    }

    setText('sys-foot',
      'Octra live monitor - read-only telemetry from the node RPC, /proc and pm2 | ' +
      'poll ' + (POLL_MS / 1000) + ' s | snapshot ' + fmtClock(d.timestamp) + ' UTC+0');
  }

  /* -- wallets ---------------------------------------------------- */
  function renderWallets(d) {
    var w = d.wallet || {};
    var r = w.rewards || {};
    var t = w.tracking || {};
    var b = w.baseline || {};
    var m = w.membership || {};
    var duty = w.duty || {};
    var deltaRaw = parseFloat(b.delta_raw || '0');
    if (!isNum(deltaRaw)) deltaRaw = 0;

    setText('wal-meta', w.available ? ('wallet | ' + fmtClock(d.timestamp)) : (w.reason || 'unavailable'));

    /* KPI strip */
    setText('wal-balance', fmtToken(w.balance));
    setText('wal-balance-sub', 'raw ' + (w.balance_raw || '0') + ' | 6 dp');
    setText('wal-bond', fmtToken(w.bond));
    setText('wal-bond-sub', w.bonded_epoch
      ? ('since epoch ' + fmtInt(w.bonded_epoch) + ' | ' + fmtInt(w.epochs_in_set) + ' epochs')
      : 'no bond recorded');
    setText('wal-nonce', fmtInt(w.nonce));
    setText('wal-nonce-sub', w.tx_count_known
      ? (fmtInt(w.tx_count) + ' tx | pending ' + fmtInt(w.pending_nonce))
      : ('pending ' + fmtInt(w.pending_nonce) + ' | tx count sampling...'));
    setText('wal-proposals', fmtInt(r.proposer_epochs));
    setText('wal-proposals-sub', num(t.span_epochs)
      ? (fmtFixed(r.share_pct, 1) + '% of ' + fmtInt(t.span_epochs) + ' reward epochs')
      : 'waiting for the log index');
    setText('wal-reward', fmtToken(r.total));
    setText('wal-reward-sub', num(r.epochs)
      ? (fmtInt(r.epochs) + ' epochs | from ' + fmtInt(t.first_epoch))
      : 'no rewards indexed yet');
    /* A balance-delta reward total is an estimate: the operator has to see it. */
    setText('wal-reward-tag', r.est ? '(EST)' : '');
    setText('wal-reward-rate', fmtToken(r.est_per_day));
    setText('wal-reward-rate-sub', num(r.avg_per_epoch)
      ? ('avg ' + fmtToken(r.avg_per_epoch) + ' / epoch' +
         (num(r.epochs_per_day) ? ' | ' + fmtInt(Math.round(r.epochs_per_day)) + ' epochs/day' : ''))
      : 'measuring epoch interval...');

    /* Account panel */
    setText('wal-address', w.address ? shortAddr(w.address) : 'not configured');
    var copyBtn = $('wal-copy-address');
    if (copyBtn) {
      copyBtn.setAttribute('data-v2-copy', w.address || '');
      copyBtn.title = w.address || '';
    }
    clearBadge($('wal-state'), w.state === 'ready' ? 'v2-badge--ok' : 'v2-badge--warn');
    setText('wal-state', w.state || 'unknown');
    setText('wal-balance-raw', w.balance_raw || '-');
    setText('wal-holdings', fmtToken(w.holdings));
    setText('wal-pending', fmtInt(w.pending_nonce));
    setText('wal-tx-count', w.tx_count_known ? fmtInt(w.tx_count) : 'sampling...');
    renderBadgeInto('wal-pubkey', w.has_public_key ? 'registered' : 'missing',
      w.has_public_key ? 'v2-badge--ok' : 'v2-badge--warn');
    renderBadgeInto('wal-encrypted',
      !w.detail_known ? 'sampling...' : (w.encrypted_balance ? 'enabled' : 'not set'),
      !w.detail_known ? '' : (w.encrypted_balance ? 'v2-badge--brand' : ''));

    /* Stake & duty panel */
    setText('wal-duty', num(duty.required_span)
      ? ('span ' + fmtInt(duty.required_span) + ' | gap ' + fmtInt(duty.max_gap))
      : '-');
    setText('wal-bond-raw', w.bond_raw || '0');
    setText('wal-bonded-epoch', w.bonded_epoch ? fmtInt(w.bonded_epoch) : '-');
    setText('wal-ready-epoch', w.ready_epoch ? fmtInt(w.ready_epoch) : '-');
    setText('wal-epochs-in-set', fmtInt(w.epochs_in_set));
    renderBadgeInto('wal-membership',
      m.active ? 'active' : (m.scheduled ? 'scheduled' : 'inactive'),
      m.active ? 'v2-badge--ok' : (m.scheduled ? 'v2-badge--warn' : ''));
    setText('wal-next-set',
      (m.activate_epoch ? fmtInt(m.activate_epoch) : '-') + ' / ' +
      (m.next_set_epoch ? fmtInt(m.next_set_epoch) : '-'));
    setText('wal-exit', w.exit_epoch ? fmtInt(w.exit_epoch) : 'none');

    /* Reward attribution panel */
    setText('wal-reward-meta', num(r.epochs) ? (fmtInt(r.epochs) + ' epochs attributed') : 'no data');
    setText('wal-reward-proposer', fmtToken(r.proposer));
    setText('wal-reward-validator', fmtToken(r.validator));
    setText('wal-avg', fmtToken(r.avg_per_epoch));
    setText('wal-share', fmtFixed(r.share_pct, 1) + '%');
    setText('wal-last-reward', r.last_epoch
      ? (fmtToken(r.last_amount) + ' | epoch ' + fmtInt(r.last_epoch))
      : '-');
    renderBadgeInto('wal-last-role', r.last_role || '-',
      r.last_role === 'proposer' ? 'v2-badge--brand' : '');
    var lastNode = $('wal-last-reward');
    if (lastNode) {
      lastNode.title = isNum(r.epochs_since)
        ? (fmtInt(r.epochs_since) + ' epoch(s) since the last attributed reward')
        : '';
    }

    /* Baseline & index panel */
    setText('wal-baseline-age', isNum(b.age_sec) && b.age_sec >= 0
      ? ('captured ' + fmtAge(b.age_sec) + ' ago')
      : 'no baseline');
    setText('wal-baseline', fmtToken(b.balance));
    setText('wal-baseline-epoch', b.epoch ? fmtInt(b.epoch) : '-');
    setText('wal-delta', (deltaRaw >= 0 ? '+' : '') + fmtToken(b.delta));
    var deltaNode = $('wal-delta');
    if (deltaNode) {
      deltaNode.style.color = deltaRaw < 0 ? 'var(--v2-status-warning)' : '';
      deltaNode.title = 'Balance movement since the setup snapshot - rewards, transfers and fees combined';
    }
    setText('wal-index', fmtFixed(t.progress_pct, 1) + '% | ' +
      fmtBytes(t.indexed_bytes) + ' / ' + fmtBytes(t.log_size));
    setText('wal-epoch-span', num(t.span_epochs)
      ? (fmtInt(t.first_epoch) + ' -> ' + fmtInt(t.last_epoch) + ' (' + fmtInt(t.span_epochs) + ')')
      : '-');
    setText('wal-since', t.since ? fmtClock(t.since) : '-');
    setText('wal-log', t.log_path || '-');
    var logNode = $('wal-log');
    if (logNode) logNode.title = t.log_path || '';
    /* The log fold is the gross figure the EST total is measured against; it is
       kept visible so a suspicious estimate can be checked by hand. */
    setText('wal-log-total', isNum(r.log_total) ? fmtToken(r.log_total) : '-');
    setText('wal-log-ratio', isNum(r.log_ratio_pct)
      ? (fmtFixed(r.log_ratio_pct, 1) + '% of the log fold')
      : '-');

    /* Recent epoch rewards */
    var body = $('wal-rewards-body');
    if (!body) return;
    var rows = r.recent || [];
    setText('wal-rewards-meta', rows.length
      ? (rows.length + ' most recent | ' + fmtInt(r.epochs) + ' tracked')
      : '-');
    body.textContent = '';

    if (!rows.length) {
      var empty = document.createElement('tr');
      var cell = document.createElement('td');
      cell.colSpan = 4;
      cell.className = 'v2-table__mute';
      cell.textContent = w.available
        ? 'No epoch rewards indexed yet - the index fills while the node keeps producing epochs.'
        : (w.reason || 'Wallet telemetry unavailable.');
      empty.appendChild(cell);
      body.appendChild(empty);
    } else {
      rows.forEach(function (row) {
        var tr = document.createElement('tr');

        var tdEpoch = document.createElement('td');
        tdEpoch.className = 'v2-table__num';
        tdEpoch.textContent = fmtInt(row.epoch);

        var tdRole = document.createElement('td');
        tdRole.className = 'v2-table__mute';
        tdRole.textContent = row.role || '-';

        var tdAmount = document.createElement('td');
        tdAmount.className = 'v2-table__num';
        tdAmount.textContent = fmtToken(row.amount);
        if (row.role === 'proposer') tdAmount.style.color = 'var(--v2-brand)';

        var tdTime = document.createElement('td');
        tdTime.className = 'v2-table__num';
        tdTime.textContent = row.at ? fmtClock(row.at) : '-';
        if (row.at) tdTime.title = row.at;

        tr.appendChild(tdEpoch);
        tr.appendChild(tdRole);
        tr.appendChild(tdAmount);
        tr.appendChild(tdTime);
        body.appendChild(tr);
      });
    }

    setText('wal-foot',
      'Wallet & rewards - rewards are folded per epoch from the node operator log ' +
      '(proposer_total + each when this wallet proposed, each otherwise); the balance ' +
      'baseline captured at deploy is the cross-check. Poll ' + (POLL_MS / 1000) +
      ' s | snapshot ' + fmtClock(d.timestamp) + ' UTC+0');
  }

  /* -- logs ------------------------------------------------------- */
  function fmtLogTime(ts) {
    if (!ts) return '--:--:--';
    var m = /T(\d{2}:\d{2}:\d{2})/.exec(String(ts));
    return m ? m[1] : String(ts).slice(0, 8);
  }

  function levelKey(entry) {
    var lvl = entry.level || 'info';
    if (lvl === 'fatal') return 'error';
    if (lvl === 'trace' || lvl === 'debug') return 'info';
    return lvl;
  }

  function logMatches(entry, level, query) {
    if (level !== 'all' && levelKey(entry) !== level) return false;
    if (!query) return true;
    var hay = (entry.msg || '') + ' ' + (entry.component || '') + ' ' + (entry.event || '');
    return hay.toLowerCase().indexOf(query) !== -1;
  }

  function logRow(entry) {
    var row = document.createElement('div');
    row.className = 'v2-log__row' +
      (entry.level === 'warn' ? ' v2-log__row--warn' : '') +
      ((entry.level === 'error' || entry.level === 'fatal') ? ' v2-log__row--error' : '');

    var ts = document.createElement('span');
    ts.className = 'v2-log__ts';
    ts.textContent = fmtLogTime(entry.ts);

    var level = document.createElement('span');
    level.className = 'v2-log__level v2-log__level--' + levelKey(entry);
    level.textContent = (entry.level || 'info').toUpperCase();

    var comp = document.createElement('span');
    comp.className = 'v2-log__comp';
    comp.textContent = entry.component || '|';

    var msg = document.createElement('span');
    msg.className = 'v2-log__msg';
    msg.textContent = entry.detail || entry.msg || '';

    row.appendChild(ts);
    row.appendChild(level);
    row.appendChild(comp);
    row.appendChild(msg);
    return row;
  }

  function renderLogs() {
    var body = $('log-body');
    if (!body) return;

    var visible = [];
    for (var i = 0; i < state.logs.length; i++) {
      if (logMatches(state.logs[i], state.logLevel, state.logQuery)) visible.push(state.logs[i]);
    }

    var nearBottom = (body.scrollHeight - body.scrollTop - body.clientHeight) < 48;
    body.textContent = '';

    if (!visible.length) {
      var empty = document.createElement('div');
      empty.className = 'v2-log__empty';
      empty.textContent = state.logs.length ? 'No lines match the current filter.' : 'Waiting for log stream...';
      body.appendChild(empty);
    } else {
      var frag = document.createDocumentFragment();
      for (var j = 0; j < visible.length; j++) frag.appendChild(logRow(visible[j]));
      body.appendChild(frag);
    }

    if (nearBottom) body.scrollTop = body.scrollHeight;

    var counts = { warn: 0, error: 0 };
    for (var k = 0; k < state.logs.length; k++) {
      var key = levelKey(state.logs[k]);
      if (key === 'warn') counts.warn++;
      else if (key === 'error') counts.error++;
    }

    setText('log-meta', visible.length + ' / ' + state.logs.length + ' lines');
    setText('log-section-meta',
      state.logs.length
        ? ('tail ' + state.logs.length + ' | ' + counts.warn + ' warn | ' + counts.error + ' err')
        : '-');

    var badge = $('nav-log-badge');
    if (badge) {
      var issues = counts.warn + counts.error;
      badge.textContent = issues > 99 ? '99+' : String(issues);
      badge.hidden = issues === 0;
    }
  }

  /* -- data fetching ---------------------------------------------- */
  function fetchJSON(path, timeoutMs) {
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = null;
    var options = { cache: 'no-store', headers: { Accept: 'application/json' } };
    if (controller) {
      options.signal = controller.signal;
      timer = setTimeout(function () { controller.abort(); }, timeoutMs || 9000);
    }
    return fetch(path, options).then(function (res) {
      if (timer) clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).catch(function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  function updateLiveAge() {
    var node = $('live-age');
    if (!node) return;

    if (!state.lastOkAt) {
      node.textContent = state.paused ? 'paused' : 'connecting...';
      node.classList.remove('is-stale');
      return;
    }

    var ageSec = (Date.now() - state.lastOkAt) / 1000;
    var stale = (ageSec * 1000) > STALE_AFTER;
    node.textContent = state.paused
      ? 'paused | ' + fmtAge(ageSec) + ' old'
      : ((stale ? 'stale | ' : 'live | ') + fmtAge(ageSec));
    node.classList.toggle('is-stale', stale && !state.paused);
  }

  function showUnreachable() {
    applyStatus('unreachable');
    var box = $('alerts');
    if (!box) return;
    box.textContent = '';
    box.hidden = false;

    var row = document.createElement('div');
    row.className = 'alert alert--error';
    var text = document.createElement('div');
    text.className = 'alert__text';
    var strong = document.createElement('strong');
    strong.textContent = 'Telemetry unreachable - ';
    text.appendChild(strong);
    text.appendChild(document.createTextNode(
      'the dashboard backend did not answer. Last good snapshot: ' +
      (state.lastOkAt ? fmtClock(new Date(state.lastOkAt).toISOString()) : 'none') +
      '. Retrying every ' + (POLL_MS / 1000) + ' s.'
    ));
    row.appendChild(text);
    box.appendChild(row);
  }

  function renderSnapshot(d) {
    var node = d.node || {};
    applyStatus(node.status || 'connecting');

    var checks = renderHealth(d);
    renderAlerts(collectAlerts(d, checks));
    renderOverview(d);
    renderConsensus(d);
    renderResources(d);
    renderPeers(d);
    renderProcess(d);
    renderSystem(d);
    renderWallets(d);

    applyHashSection();
  }

  /** Re-apply the #section deep link once the first render settled the layout. */
  var hashApplied = false;
  function applyHashSection() {
    if (hashApplied) return;
    hashApplied = true;
    var id = (window.location.hash || '').replace('#', '');
    if (!id || !window.SynteqV2 || !SynteqV2.scrollToSection) return;
    requestAnimationFrame(function () {
      SynteqV2.scrollToSection(id, { behavior: 'auto' });
    });
  }

  function pollStatus() {
    if (state.paused || state.fetching) return;
    state.fetching = true;

    fetchJSON('/api/status', 9000).then(function (data) {
      state.fetching = false;
      state.failures = 0;
      state.lastOkAt = Date.now();
      state.status = data;
      renderSnapshot(data);
      updateLiveAge();
    }).catch(function () {
      state.fetching = false;
      state.failures++;
      if (state.failures >= 1) showUnreachable();
      updateLiveAge();
    });
  }

  function fetchLogs() {
    if (state.logPaused) return;
    fetchJSON('/api/logs?lines=' + LOG_LINES, 9000).then(function (data) {
      state.logs = (data && data.logs) || [];
      renderLogs();
    }).catch(function () {
      /* keep the previous tail on screen */
    });
  }

  /* -- controls --------------------------------------------------- */
  function swapIcons(root, showPause) {
    if (!root) return;
    var pauseIcon = root.querySelector('.icon-pause');
    var playIcon = root.querySelector('.icon-play');
    if (pauseIcon) pauseIcon.style.display = showPause ? '' : 'none';
    if (playIcon) playIcon.style.display = showPause ? 'none' : '';
  }

  /** Transient feedback next to a control (framework tip primitive). */
  function showTip(target, message, kind) {
    if (!target || !window.SynteqV2 || !SynteqV2.tip) return;
    SynteqV2.tip(target, message, kind ? { kind: kind } : undefined);
  }

  function initControls() {
    var refresh = $('btn-refresh');
    if (refresh) {
      refresh.addEventListener('click', function () {
        refresh.classList.add('is-spinning');
        setTimeout(function () { refresh.classList.remove('is-spinning'); }, 800);
        state.paused = false;
        syncPauseButton();
        pollStatus();
        fetchLogs();
        showTip(refresh, 'Refreshed');
      });
    }

    var pause = $('btn-pause');
    if (pause) pause.addEventListener('click', function () {
      state.paused = !state.paused;
      syncPauseButton();
      updateLiveAge();
      if (!state.paused) {
        pollStatus();
        fetchLogs();
      }
      showTip(pause,
        state.paused ? 'Auto-refresh paused' : 'Auto-refresh resumed',
        state.paused ? 'warn' : 'ok');
    });

    var logPause = $('log-pause');
    if (logPause) logPause.addEventListener('click', function () {
      state.logPaused = !state.logPaused;
      logPause.setAttribute('aria-pressed', String(state.logPaused));
      swapIcons(logPause, !state.logPaused);
      setText('log-pause-text', state.logPaused ? 'Resume' : 'Pause');
      if (!state.logPaused) fetchLogs();
      showTip(logPause,
        state.logPaused ? 'Log stream paused' : 'Log stream resumed',
        state.logPaused ? 'warn' : 'ok');
    });

    var search = $('log-search');
    if (search) search.addEventListener('input', function () {
      state.logQuery = search.value.trim().toLowerCase();
      renderLogs();
    });

    var filter = $('log-filter');
    if (filter) filter.addEventListener('click', function (event) {
      var button = event.target.closest('[data-log-level]');
      if (!button) return;
      state.logLevel = button.getAttribute('data-log-level') || 'all';
      var buttons = filter.querySelectorAll('[data-log-level]');
      for (var i = 0; i < buttons.length; i++) {
        buttons[i].classList.toggle('v2-seg__btn--active', buttons[i] === button);
      }
      renderLogs();
    });

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && !state.paused) {
        pollStatus();
        fetchLogs();
      }
    });
  }

  function syncPauseButton() {
    var pause = $('btn-pause');
    if (!pause) return;
    pause.setAttribute('aria-pressed', String(state.paused));
    pause.setAttribute('aria-label', state.paused ? 'Resume auto-refresh' : 'Pause auto-refresh');
    pause.title = state.paused ? 'Resume auto-refresh' : 'Pause auto-refresh';
    swapIcons(pause, !state.paused);
  }

  /* -- boot ------------------------------------------------------- */
  function start() {
    applyStatus('connecting');      // the dock badge must never read "-"
    initControls();
    syncPauseButton();
    updateLiveAge();
    pollStatus();
    fetchLogs();

    setInterval(function () {
      if (!document.hidden) pollStatus();
    }, POLL_MS);

    setInterval(function () {
      if (!document.hidden) fetchLogs();
    }, LOG_POLL_MS);

    setInterval(updateLiveAge, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
