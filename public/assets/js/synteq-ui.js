/**
 * Synteq UI Runtime  (js/synteq-ui.js)
 * Zero-dependency vanilla JS helpers:
 *  - Theme toggle (dark / light, persisted via localStorage)
 *  - Sticky bottom navigation dock toggle and persisted visibility
 *  - Smooth gauge fill (width-based, uses CSS transition)
 *  - Mini bar chart renderer (network I/O or any dual-series data)
 *  - SVG sparkline renderer
 *  - Line / area chart with axes and hover tooltips
 *  - Stacked bar column renderer
 *  - Advanced table: sorting, row selection, filtering, pagination
 *  - Tree expand / collapse (keyboard navigable)
 *  - Stepper / timeline progress API
 *  - Code block gutter + copy button
 *  - Topbar scroll-shadow
 *  - Reduced-motion guard on all animations
 *  - Stagger mount trigger (IntersectionObserver)
 *  - replayAnimation() — restart a mount animation on demand (WAAPI, reduced-
 *    motion aware) for "replay" demos and success feedback
 *  - Nav scroll + scroll-spy (BoundingClientRect-based, works inside
 *    any scrollable .sq-content container)
 *  - Clipboard copy buttons [data-sq-copy]
 */
(function (global) {
  'use strict';

  /* ---- Helpers ---- */
  const $ = (sel, ctx) => (ctx || document).querySelector(sel);
  const $$ = (sel, ctx) => Array.from((ctx || document).querySelectorAll(sel));
  const prefersReduced = () =>
    typeof matchMedia !== 'undefined' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ======================================================
     THEME
     ====================================================== */
  function setTheme(theme) {
    const t = theme === 'light' ? 'light' : 'dark';
    const root = document.documentElement;
    root.setAttribute('data-theme', t);
    root.classList.remove('theme-dark', 'theme-light');
    root.classList.add('theme-' + t);
    try { localStorage.setItem('sq-theme', t); } catch (_) {}
    return t;
  }

  function getTheme() {
    return document.documentElement.getAttribute('data-theme') || 'dark';
  }

  function toggleTheme() {
    return setTheme(getTheme() === 'dark' ? 'light' : 'dark');
  }

  function initTheme() {
    let saved;
    try { saved = localStorage.getItem('sq-theme'); } catch (_) {}
    if (saved) { setTheme(saved); return; }
    const sys = typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: light)').matches;
    setTheme(sys ? 'light' : 'dark');
  }

  /* ======================================================
     GAUGE  —  sets .sq-gauge__fill width via data-value
     Usage:  renderGauge(el, 72.5)                  // thresholds
             renderGauge(el, 100, { kind:'brand' }) // quorum-style
             renderGauge(el, 42, { kind:'neutral' })// no state colour
             or set data-sq-gauge="72.5" and call initGauges()
     ====================================================== */
  function renderGauge(fillEl, pct, opts) {
    if (!fillEl) return;
    var kind = (opts && opts.kind) || 'auto';
    var clamped = Math.max(0, Math.min(100, pct));
    // Remove state classes then apply the requested one
    fillEl.classList.remove('sq-gauge__fill--ok', 'sq-gauge__fill--warn', 'sq-gauge__fill--err', 'sq-gauge__fill--brand');
    if (kind === 'brand') {
      fillEl.classList.add('sq-gauge__fill--brand');
    } else if (kind !== 'neutral') {
      if (clamped >= 90) fillEl.classList.add('sq-gauge__fill--err');
      else if (clamped >= 75) fillEl.classList.add('sq-gauge__fill--warn');
      else fillEl.classList.add('sq-gauge__fill--ok');
    }
    // Delay so CSS transition fires after paint
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { fillEl.style.width = clamped + '%'; });
    });
    // Update aria on parent track
    var track = fillEl.closest('[role="progressbar"]') || fillEl.parentElement;
    if (track) track.setAttribute('aria-valuenow', String(Math.round(clamped)));
  }

  function initGauges() {
    $$('[data-sq-gauge]').forEach(function (track) {
      const fill = track.querySelector('.sq-gauge__fill');
      if (!fill) return;
      const pct = parseFloat(track.getAttribute('data-sq-gauge')) || 0;
      renderGauge(fill, pct);
    });
  }

  /* ======================================================
     BARS  — dual-series bar chart (in / out)
     stageEl  : .sq-bars container
     samples  : Array of [inPct, outPct] each 0–100
     opts     : { minCols, stepSec, emptyLabel }
                minCols   pad with empty columns so a short series still
                          renders slim bars instead of a few fat ones
                stepSec   seconds per sample, used for the tooltip label
     ====================================================== */
  function renderBars(stageEl, samples, opts) {
    if (!stageEl) return;
    opts = opts || {};
    samples = samples || [];

    var minCols = Math.max(0, opts.minCols || 0);
    var padCols = Math.max(0, minCols - samples.length);
    var total = padCols + samples.length;

    stageEl.innerHTML = '';
    stageEl.style.setProperty('--sq-bars-cols', Math.max(1, total));
    stageEl.classList.toggle('is-empty', samples.length === 0);
    if (samples.length === 0) stageEl.setAttribute('data-sq-bars-empty', 'true');
    else stageEl.removeAttribute('data-sq-bars-empty');

    // Leading empty columns keep the chart geometry stable while data fills in
    for (var p = 0; p < padCols; p++) {
      var padCol = document.createElement('div');
      padCol.className = 'sq-bars__col sq-bars__col--pad';
      padCol.setAttribute('aria-hidden', 'true');
      stageEl.appendChild(padCol);
    }

    // Keep the absolute 0-100 scale for normal data, but expand it when a
    // stacked in/out pair exceeds 100 so the taller column cannot overflow.
    var scale = 100;
    samples.forEach(function (pair) {
      var inPct  = Math.max(0, Math.min(100, pair[0] || 0));
      var outPct = Math.max(0, Math.min(100, pair[1] || 0));
      scale = Math.max(scale, inPct + outPct);
    });

    samples.forEach(function (pair, idx) {
      var inPct  = Math.max(0, Math.min(100, pair[0] || 0));
      var outPct = Math.max(0, Math.min(100, pair[1] || 0));
      var col = document.createElement('div');
      col.className = 'sq-bars__col';

      var offset = samples.length - idx;                       // 1 = newest
      var label = opts.stepSec
        ? ('T-' + (offset * opts.stepSec) + 's')
        : ('Sample -' + offset);
      col.setAttribute('title',
        label + '  ↓ ' + inPct.toFixed(1) + '%  ↑ ' + outPct.toFixed(1) + '%');

      var segOut = document.createElement('div');
      segOut.className = 'sq-bars__seg sq-bars__seg--out';
      segOut.style.height = (outPct / scale) * 100 + '%';

      var segIn = document.createElement('div');
      segIn.className = 'sq-bars__seg sq-bars__seg--in';
      segIn.style.height = (inPct / scale) * 100 + '%';


      col.appendChild(segOut);
      col.appendChild(segIn);
      stageEl.appendChild(col);
    });
  }

  /* ======================================================
     SPARKLINE  — draws an SVG polyline inside .sq-spark
     sparkEl  : SVG element with class .sq-spark
     values   : Array of numbers (raw values, auto-scaled)
     ====================================================== */
  function renderSparkline(sparkEl, values) {
    if (!sparkEl) return;
    if (!values || values.length < 2) {
      // Not enough samples yet — clear the previous path and publish an empty
      // state so consumers can render a placeholder instead of stale data.
      while (sparkEl.firstChild) sparkEl.removeChild(sparkEl.firstChild);
      sparkEl.__sqSparkValues = [];
      sparkEl.setAttribute('data-sq-spark-empty', 'true');
      return;
    }
    sparkEl.removeAttribute('data-sq-spark-empty');
    // Clear previous
    while (sparkEl.firstChild) sparkEl.removeChild(sparkEl.firstChild);

    // Draw in viewBox units, NOT rendered pixels. Using clientWidth here made
    // every point overflow a 200-unit viewBox (the path bled far outside the
    // SVG, which showed up as a blank / clipped chart in the explorer).
    const vb = sparkEl.viewBox && sparkEl.viewBox.baseVal;
    const W = (vb && vb.width) || 200;
    const H = (vb && vb.height) || 40;
    if (!vb || !vb.width) sparkEl.setAttribute('viewBox', '0 0 ' + W + ' ' + H);

    // Remember the series so the sparkline can be redrawn on resize
    sparkEl.__sqSparkValues = values.slice();

    // Pad keeps the 1.5px stroke and the 2.5px end dot inside the viewBox
    const pad = 4;
    const min = Math.min.apply(null, values);
    const max = Math.max.apply(null, values);
    const range = max - min || 1;

    function sx(i) { return pad + (i / (values.length - 1)) * (W - pad * 2); }
    function sy(v) { return pad + (1 - (v - min) / range) * (H - pad * 2); }

    const pts = values.map(function (v, i) { return sx(i) + ',' + sy(v); }).join(' ');

    // Filled area
    const first = sx(0) + ',' + sy(values[0]);
    const last  = sx(values.length - 1) + ',' + sy(values[values.length - 1]);
    const area = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    area.setAttribute('class', 'sq-spark__area');
    area.setAttribute('points',
      first + ' ' + pts + ' ' + last + ' ' +
      sx(values.length - 1) + ',' + H + ' ' + sx(0) + ',' + H);
    sparkEl.appendChild(area);

    // Line
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    line.setAttribute('class', 'sq-spark__line');
    line.setAttribute('points', pts);
    sparkEl.appendChild(line);

    // Latest-point dot
    const lastIdx = values.length - 1;
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('class', 'sq-spark__dot');
    dot.setAttribute('cx', sx(lastIdx));
    dot.setAttribute('cy', sy(values[lastIdx]));
    dot.setAttribute('r', '2.5');
    sparkEl.appendChild(dot);
  }

  /* Draws every .sq-spark from its remembered series (or data-sq-spark="1,2,3")
     and redraws them once the viewport is resized. */
  function initSparklines() {
    $$('.sq-spark').forEach(function (el) {
      if (!el.__sqSparkValues) {
        var raw = el.getAttribute('data-sq-spark');
        if (raw) {
          el.__sqSparkValues = raw.split(',')
            .map(function (n) { return parseFloat(n); })
            .filter(function (n) { return !isNaN(n); });
        }
      }
      if (el.__sqSparkValues) renderSparkline(el, el.__sqSparkValues);
    });

    if (initSparklines.bound) return;
    initSparklines.bound = true;
    var timer;
    window.addEventListener('resize', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        $$('.sq-spark').forEach(function (el) {
          if (el.__sqSparkValues) renderSparkline(el, el.__sqSparkValues);
        });
      }, 120);
    });
  }

  function sidebarOpen() {
    var app = document.getElementById('app') || $('.sq-app');
    if (!app) return;
    app.classList.remove('nav-collapsed');
    $$('[data-sq-sidebar-toggle]').forEach(function (btn) { btn.setAttribute('aria-expanded', 'true'); });
    try { localStorage.setItem('sq-sidebar', 'open'); } catch (_) {}
  }

  function sidebarClose() {
    var app = document.getElementById('app') || $('.sq-app');
    if (!app) return;
    app.classList.add('nav-collapsed');
    $$('[data-sq-sidebar-toggle]').forEach(function (btn) { btn.setAttribute('aria-expanded', 'false'); });
    try { localStorage.setItem('sq-sidebar', 'closed'); } catch (_) {}
  }

  function sidebarToggle() {
    var app = document.getElementById('app') || $('.sq-app');
    if (!app) return;
    app.classList.contains('nav-collapsed') ? sidebarOpen() : sidebarClose();
  }

  function initSidebar() {
    $$('[data-sq-sidebar-toggle]').forEach(function (btn) {
      if (btn.getAttribute('data-sq-sidebar-bound') === 'true') return;
      btn.setAttribute('data-sq-sidebar-bound', 'true');
      btn.addEventListener('click', function (e) { e.stopPropagation(); sidebarToggle(); });
    });

    var app = document.getElementById('app') || $('.sq-app');
    var saved; try { saved = localStorage.getItem('sq-sidebar'); } catch (_) {}
    if (saved === 'closed') sidebarClose(); else if (app) sidebarOpen();
  }

  /* ======================================================
     TOPBAR SCROLL SHADOW  — adds .is-scrolled to .sq-topbar
     when the in-content region scrolls past 4px
     ====================================================== */
  function initScrollShadow() {
    $$('.sq-content').forEach(function (content) {
      var topbar = $('.sq-topbar');
      if (!topbar) return;
      content.addEventListener('scroll', function () {
        topbar.classList.toggle('is-scrolled', content.scrollTop > 4);
      }, { passive: true });
    });
  }

  /* ======================================================
     STAGGER MOUNT  — triggers .sq-stagger animation when
     the element scrolls into view (IntersectionObserver).
     Skips animation if reduced-motion is active.
     ====================================================== */
  function initStagger() {
    if (prefersReduced()) return;
    if (typeof IntersectionObserver === 'undefined') return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('sq-stagger');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1 });
    $$('[data-sq-stagger]').forEach(function (el) { io.observe(el); });
  }

  /* ======================================================
     MOTION  —  replayAnimation(el, opts)
     Restarts a mount animation on demand and is the only place that decides
     what reduced-motion means for a *user-requested* replay.
     opts: { preset: 'fade-up' | 'fade' | 'zoom-in', duration, force }
     Returns the Animation object (or null when unsupported).
     ====================================================== */
  var MOTION_FRAMES = {
    'fade-up': [
      { opacity: 0, transform: 'translateY(6px)' },
      { opacity: 1, transform: 'translateY(0)' }
    ],
    'fade': [
      { opacity: 0 },
      { opacity: 1 }
    ],
    'zoom-in': [
      { opacity: 0, transform: 'scale(0.96)' },
      { opacity: 1, transform: 'scale(1)' }
    ]
  };

  function replayAnimation(el, opts) {
    if (!el) return null;
    opts = opts || {};
    var preset = MOTION_FRAMES[opts.preset || 'fade-up'] || MOTION_FRAMES['fade-up'];
    // user-initiated replays must always be visible: when reduced-motion is on
    // we drop the movement and keep a short cross-fade instead of a 0.001ms
    // "nothing happened" animation (base.css disables CSS animations entirely).
    var reduced = prefersReduced() && !opts.force;
    var frames = reduced ? MOTION_FRAMES.fade : preset;
    var duration = opts.duration || (reduced ? 120 : 280);

    if (!el.classList.contains('sq-fade-up') && (opts.preset || 'fade-up') === 'fade-up') {
      el.classList.add('sq-fade-up');
    }

    if (typeof el.animate !== 'function') {
      // Legacy fallback: restart the CSS animation through a forced reflow.
      el.classList.remove('sq-fade-up');
      void el.offsetWidth;
      el.classList.add('sq-fade-up');
      return null;
    }

    el.getAnimations().forEach(function (anim) { anim.cancel(); });
    return el.animate(frames, {
      duration: duration,
      easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
      fill: 'both'
    });
  }

  /* ======================================================
     THEME TOGGLE BUTTON  — wire all [data-sq-toggle-theme]
     ====================================================== */
  function initThemeToggles() {
    $$('[data-sq-toggle-theme]').forEach(function (btn) {
      btn.addEventListener('click', function () { toggleTheme(); });
    });
  }

  /* ======================================================
     TIP  —  transient anchored label ("Copied", "Paused", …)
     tip(el, 'Copied')                       // ok, 1.5 s
     tip(el, 'Copy failed', { kind: 'err' }) // warn | err | ok
     Auto-positions above the anchor (below when there is no room) and removes
     itself. Only one tip exists at a time, so rapid clicks never stack up.
     ====================================================== */
  var _tipTimer = null;

  function tip(anchor, message, opts) {
    if (!anchor || !message || typeof document === 'undefined') return null;
    opts = opts || {};

    var existing = $('.sq-tip');
    if (existing) existing.remove();

    var el = document.createElement('div');
    el.className = 'sq-tip' + (opts.kind ? ' sq-tip--' + opts.kind : '');
    el.setAttribute('role', 'status');
    el.textContent = String(message);
    document.body.appendChild(el);

    var rect = anchor.getBoundingClientRect();
    var gap = 8;
    var w = el.offsetWidth;
    var h = el.offsetHeight;
    var above = rect.top - h - gap;
    var top = above > gap ? above : rect.bottom + gap;
    var left = rect.left + rect.width / 2 - w / 2;
    var maxLeft = Math.max(gap, window.innerWidth - w - gap);
    left = Math.min(Math.max(gap, left), maxLeft);

    el.style.top = Math.round(top) + 'px';
    el.style.left = Math.round(left) + 'px';

    if (_tipTimer) clearTimeout(_tipTimer);
    _tipTimer = setTimeout(function () {
      el.classList.add('is-out');
      setTimeout(function () { el.remove(); }, 220);
    }, opts.duration || 1500);

    return el;
  }

  /* ======================================================
     CLIPBOARD  — delegated, with a fallback for insecure origins
     Any element carrying [data-sq-copy] copies its value (or the text of its
     previous sibling when the attribute is empty). Delegation means buttons
     added or swapped in later keep working without re-initialisation.
     Feedback: .sq-copy--ok + a "Copied" tip + aria-label swap.
     ====================================================== */
  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    // http:// origins are not secure contexts: fall back to a temp field
    return new Promise(function (resolve, reject) {
      try {
        var area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.top = '-1000px';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(area);
        if (ok) resolve(); else reject(new Error('copy-failed'));
      } catch (err) {
        reject(err);
      }
    });
  }

  function initCopyButtons() {
    if (document.__sqCopyBound) return;
    document.__sqCopyBound = true;

    document.addEventListener('click', function (event) {
      var btn = event.target && event.target.closest
        ? event.target.closest('[data-sq-copy]')
        : null;
      if (!btn) return;

      var text = btn.getAttribute('data-sq-copy');
      if (!text) {
        var prev = btn.previousElementSibling;
        text = prev ? prev.textContent : '';
      }
      text = (text || '').trim();
      if (!text) return;

      var label = btn.getAttribute('data-sq-copy-label') || 'Copied';

      copyToClipboard(text).then(function () {
        var orig = btn.getAttribute('aria-label') || 'Copy';
        btn.setAttribute('aria-label', label);
        btn.classList.add('sq-copy--ok');
        tip(btn, label, { kind: 'ok' });
        setTimeout(function () {
          btn.setAttribute('aria-label', orig);
          btn.classList.remove('sq-copy--ok');
        }, 1800);
      }).catch(function () {
        tip(btn, 'Copy failed', { kind: 'err' });
      });
    });
  }

  /* ======================================================
     TOAST (upgraded with kinds, dismiss, queue)
     toast('Message')                      // default (no border accent)
     toast('Saved', { kind: 'ok' })        // green left border
     toast('Warning', { kind: 'warn' })    // amber left border
     toast('Error', { kind: 'err' })       // red left border
     toast('Info', { kind: 'info' })       // brand left border
     toast(msg, { duration: 5000 })        // custom duration
     toast(msg, { dismissible: true })     // show X button
     ====================================================== */
  var _toastQueue = [];
  var _toastPaused = false;

  function toast(message, opts) {
    if (!message) return;
    opts = opts || {};
    var kind = opts.kind || '';
    var duration = opts.duration || 4000;
    var dismissible = opts.dismissible !== false;

    var region = $('[data-sq-toast-region]') || $('.sq-toast-region');
    if (!region) {
      region = document.createElement('div');
      region.className = 'sq-toast-region';
      region.setAttribute('role', 'status');
      region.setAttribute('aria-live', kind === 'err' ? 'assertive' : 'polite');
      document.body.appendChild(region);
    }

    var item = document.createElement('div');
    item.className = 'sq-toast' + (kind ? ' sq-toast--' + kind : '');

    // Icon (optional, based on kind)
    var iconMap = {
      info: '<svg class="sq-icon sq-icon--16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
      ok: '<svg class="sq-icon sq-icon--16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>',
      warn: '<svg class="sq-icon sq-icon--16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
      err: '<svg class="sq-icon sq-icon--16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>'
    };

    if (iconMap[kind]) {
      var iconSpan = document.createElement('span');
      iconSpan.className = 'sq-toast__icon';
      iconSpan.innerHTML = iconMap[kind];
      item.appendChild(iconSpan);
    }

    // Content
    var content = document.createElement('div');
    content.className = 'sq-toast__content';
    content.textContent = message;
    item.appendChild(content);

    // Dismiss button
    if (dismissible) {
      var dismiss = document.createElement('button');
      dismiss.className = 'sq-toast__dismiss';
      dismiss.setAttribute('aria-label', 'Dismiss');
      dismiss.innerHTML = '<svg class="sq-icon sq-icon--14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      dismiss.addEventListener('click', function () { removeToast(item); });
      item.appendChild(dismiss);
    }

    // Pause on hover
    var timer;
    function startTimer() {
      timer = setTimeout(function () { removeToast(item); }, duration);
    }
    item.addEventListener('mouseenter', function () { clearTimeout(timer); });
    item.addEventListener('mouseleave', startTimer);

    region.appendChild(item);
    startTimer();

    return item;
  }

  function removeToast(item) {
    if (!item || !item.parentNode) return;
    item.classList.add('is-leaving');
    setTimeout(function () { if (item.parentNode) item.remove(); }, 200);
  }

  /* ======================================================
     TABS — roving tabindex + arrow keys
     Wire with data-sq-tabs on .sq-tabs container
     ====================================================== */
  function initTabs() {
    $$('[data-sq-tabs]').forEach(function (container) {
      if (container.dataset.sqTabsReady === 'true') return;
      container.dataset.sqTabsReady = 'true';

      var tabs = $$('[role="tab"]', container);
      var panels = $$('[role="tabpanel"]', container);
      if (tabs.length === 0 || panels.length === 0) return;

      function selectTab(index) {
        tabs.forEach(function (tab, i) {
          var selected = i === index;
          tab.setAttribute('aria-selected', String(selected));
          tab.setAttribute('tabindex', selected ? '0' : '-1');
          if (panels[i]) panels[i].setAttribute('aria-hidden', String(!selected));
        });
        tabs[index].focus();
      }

      tabs.forEach(function (tab, index) {
        tab.addEventListener('click', function (e) {
          e.preventDefault();
          selectTab(index);
        });

        tab.addEventListener('keydown', function (e) {
          var current = tabs.indexOf(document.activeElement);
          if (current === -1) return;

          if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
            e.preventDefault();
            selectTab((current + 1) % tabs.length);
          } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
            e.preventDefault();
            selectTab((current - 1 + tabs.length) % tabs.length);
          } else if (e.key === 'Home') {
            e.preventDefault();
            selectTab(0);
          } else if (e.key === 'End') {
            e.preventDefault();
            selectTab(tabs.length - 1);
          }
        });
      });

      // Initialize first tab as selected if none is
      var hasSelected = tabs.some(function (tab) { return tab.getAttribute('aria-selected') === 'true'; });
      if (!hasSelected) selectTab(0);
    });
  }

  /* ======================================================
     MENU — open/close, keyboard nav, escape
     Trigger: data-sq-menu-trigger="menu-id"
     Menu: .sq-menu#menu-id
     ====================================================== */
  function initMenus() {
    $$('[data-sq-menu-trigger]').forEach(function (trigger) {
      if (trigger.dataset.sqMenuReady === 'true') return;
      trigger.dataset.sqMenuReady = 'true';

      var menuId = trigger.getAttribute('data-sq-menu-trigger');
      var menu = document.getElementById(menuId);
      if (!menu) return;

      var items = $$('.sq-menu__item', menu);
      var currentFocus = -1;

      function openMenu() {
        menu.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
        currentFocus = -1;
        items[0]?.focus();
      }

      function closeMenu() {
        menu.hidden = true;
        trigger.setAttribute('aria-expanded', 'false');
        trigger.focus();
      }

      function focusItem(index) {
        if (index < 0 || index >= items.length) return;
        currentFocus = index;
        items[index].focus();
      }

      trigger.addEventListener('click', function (e) {
        e.stopPropagation();
        menu.hidden ? openMenu() : closeMenu();
      });

      menu.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          closeMenu();
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          focusItem((currentFocus + 1) % items.length);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          focusItem((currentFocus - 1 + items.length) % items.length);
        } else if (e.key === 'Home') {
          e.preventDefault();
          focusItem(0);
        } else if (e.key === 'End') {
          e.preventDefault();
          focusItem(items.length - 1);
        }
      });

      items.forEach(function (item, index) {
        item.addEventListener('click', function () { closeMenu(); });
        item.addEventListener('focus', function () { currentFocus = index; });
      });

      document.addEventListener('click', function (e) {
        if (!menu.hidden && !menu.contains(e.target) && !trigger.contains(e.target)) {
          closeMenu();
        }
      });
    });
  }

  /* ======================================================
     POPOVER — show/hide, positioning, escape
     Trigger: data-sq-popover-trigger="popover-id"
     Popover: .sq-popover#popover-id
     ====================================================== */
  function initPopovers() {
    $$('[data-sq-popover-trigger]').forEach(function (trigger) {
      if (trigger.dataset.sqPopoverReady === 'true') return;
      trigger.dataset.sqPopoverReady = 'true';

      var popoverId = trigger.getAttribute('data-sq-popover-trigger');
      var popover = document.getElementById(popoverId);
      if (!popover) return;

      function showPopover() {
        popover.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
        positionPopover();
      }

      function hidePopover() {
        popover.hidden = true;
        trigger.setAttribute('aria-expanded', 'false');
      }

      function positionPopover() {
        var rect = trigger.getBoundingClientRect();
        var gap = 8;
        var top = rect.bottom + gap;
        var left = rect.left + rect.width / 2 - popover.offsetWidth / 2;

        // Keep in viewport
        if (top + popover.offsetHeight > window.innerHeight) {
          top = rect.top - popover.offsetHeight - gap;
        }
        if (left < gap) left = gap;
        if (left + popover.offsetWidth > window.innerWidth - gap) {
          left = window.innerWidth - popover.offsetWidth - gap;
        }

        popover.style.top = top + 'px';
        popover.style.left = left + 'px';
      }

      trigger.addEventListener('click', function (e) {
        e.stopPropagation();
        popover.hidden ? showPopover() : hidePopover();
      });

      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !popover.hidden) {
          hidePopover();
          trigger.focus();
        }
      });

      document.addEventListener('click', function (e) {
        if (!popover.hidden && !popover.contains(e.target) && !trigger.contains(e.target)) {
          hidePopover();
        }
      });
    });
  }

  function initProductionControls() {
    $$('[data-sq-toast]').forEach(function (button) {
      button.addEventListener('click', function () {
        // data-sq-toast-kind lets markup pick the semantic variant; without it
        // every trigger rendered an identical, untyped toast.
        toast(button.getAttribute('data-sq-toast') || button.textContent.trim() + ' complete', {
          kind: button.getAttribute('data-sq-toast-kind') || ''
        });
      });
    });
    $$('[data-sq-dialog-open]').forEach(function (button) {
      button.addEventListener('click', function () {
        var dialog = document.getElementById(button.getAttribute('data-sq-dialog-open'));
        if (dialog && typeof dialog.showModal === 'function') dialog.showModal();
      });
    });
    $$('[data-sq-dialog-close]').forEach(function (button) {
      button.addEventListener('click', function () { var dialog = button.closest('dialog'); if (dialog) dialog.close(); });
    });
    $$('[data-sq-search-trigger]').forEach(function (button) { button.addEventListener('click', function () { var input = $('[data-sq-search-input]'); if (input) { var dialog = input.closest('dialog'); if (dialog && !dialog.open) dialog.showModal(); input.focus(); input.select && input.select(); } }); });
    document.addEventListener('keydown', function (event) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        var trigger = $('[data-sq-search-trigger]');
        if (trigger) { event.preventDefault(); trigger.click(); }
      }
    });
    $$('[data-sq-search-input]').forEach(function (input) {
      input.addEventListener('input', function () {
        var query = input.value.trim().toLowerCase();
        $$('.sq-command [data-sq-command]').forEach(function (item) { item.hidden = query && !item.textContent.toLowerCase().includes(query); });
      });
      // A text input inside <form method="dialog"> triggers implicit submission
      // on Enter, which closed the palette before anything was picked. Enter now
      // activates the first visible result (or does nothing when none match).
      var form = input.closest('form');
      if (form) {
        form.addEventListener('submit', function (event) {
          event.preventDefault();
          var first = $$('[data-sq-command]', form).filter(function (item) { return !item.hidden; })[0];
          if (first) first.click();
        });
      }
      // Reopening the palette must not show a stale filter.
      var dialog = input.closest('dialog');
      if (dialog) {
        dialog.addEventListener('close', function () {
          input.value = '';
          $$('.sq-command [data-sq-command]', dialog).forEach(function (item) { item.hidden = false; });
        });
      }
    });
    $$('[data-sq-command]').forEach(function (item) {
      item.addEventListener('click', function () {
        var target = item.getAttribute('data-sq-command');
        var dialog = item.closest('dialog');
        if (dialog) dialog.close();
        if (target && target.charAt(0) === '#') {
          var section = document.querySelector(target);
          var content = $('.sq-content');
          if (section && content) {
            // Rect-based math: offsetTop is relative to offsetParent, not the
            // scroll container, and lands on the wrong section.
            var delta = section.getBoundingClientRect().top - content.getBoundingClientRect().top + content.scrollTop - 16;
            content.scrollTo({ top: Math.max(0, delta), behavior: prefersReduced() ? 'auto' : 'smooth' });
          }
        }
        else toast(item.textContent.trim() + ' selected');
      });
    });
  }

  /* ======================================================
     BOTTOM DOCK  —  drag-to-scroll + "More" drop-up
     • Items are safe-centred by CSS; when they overflow the strip can be
       dragged (mouse / pen), wheel-scrolled horizontally, and a More button
       opens a drop-up with every item that is currently out of view.
     • Keeps the active item visible when the scroll-spy changes.
     ====================================================== */
  function initNavDock() {
    var aside = $('.sq-aside');
    if (!aside) return;
    var nav = $('.sq-nav', aside);
    if (!nav) return;
    if (nav.getAttribute('data-sq-dock-ready') === 'true') {
      // Re-scan after dynamic nav changes (new destinations added/removed)
      if (typeof nav.__sqDockRefresh === 'function') nav.__sqDockRefresh();
      return;
    }
    nav.setAttribute('data-sq-dock-ready', 'true');

    var isActive = function (el) {
      return el.classList.contains('is-active') || el.classList.contains('sq-nav__item--active');
    };
    var navItems = function () { return $$('.sq-nav__item', nav); };
    var overflowing = function () { return nav.scrollWidth - nav.clientWidth > 1; };

    /* ---- More trigger + drop-up shell ---- */
    var more = document.createElement('button');
    more.type = 'button';
    more.className = 'sq-nav__more';
    more.hidden = true;
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    more.setAttribute('aria-label', 'More navigation items');
    more.innerHTML = '<svg class="sq-icon sq-icon--18" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg><span aria-hidden="true">More</span>';

    var menu = document.createElement('div');
    menu.className = 'sq-nav__menu';
    menu.hidden = true;
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'All navigation items');

    nav.parentNode.insertBefore(more, nav.nextSibling);
    aside.appendChild(menu);

    function closeMenu() {
      if (menu.hidden) return;
      menu.hidden = true;
      more.setAttribute('aria-expanded', 'false');
    }

    function buildMenu() {
      while (menu.firstChild) menu.removeChild(menu.firstChild);
      var navRect = nav.getBoundingClientRect();
      var left = navRect.left + 2;
      var right = navRect.right - 2;
      var outOfView = navItems().filter(function (item) {
        var r = item.getBoundingClientRect();
        return r.left < left - 1 || r.right > right + 1;
      });
      outOfView.forEach(function (src) {
        var clone = src.cloneNode(true);
        clone.classList.remove('sq-nav__item');
        clone.classList.remove('sq-nav__item--active');
        clone.classList.remove('is-active');
        clone.classList.add('sq-nav__menu-item');
        if (isActive(src)) clone.classList.add('is-active');
        clone.removeAttribute('aria-current');
        clone.setAttribute('role', 'menuitem');
        clone.addEventListener('click', function (e) {
          e.preventDefault();
          closeMenu();
          // Delegate to the real item so scroll-spy + smooth scroll stay in sync
          src.click();
          ensureVisible(src);
        });
        menu.appendChild(clone);
      });
      return outOfView.length;
    }

    function openMenu() {
      if (!buildMenu()) return;
      menu.hidden = false;
      more.setAttribute('aria-expanded', 'true');
    }

    more.addEventListener('click', function (e) {
      e.stopPropagation();
      menu.hidden ? openMenu() : closeMenu();
    });
    document.addEventListener('click', function (e) {
      if (menu.hidden) return;
      if (menu.contains(e.target) || more.contains(e.target)) return;
      closeMenu();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || menu.hidden) return;
      var hadFocus = menu.contains(document.activeElement);
      closeMenu();
      if (hadFocus) more.focus();
    });

    /* ---- Keep the active item inside the visible strip ---- */
    function ensureVisible(item) {
      if (!item || !overflowing()) return;
      var navRect = nav.getBoundingClientRect();
      var r = item.getBoundingClientRect();
      var pad = 8;
      // Already comfortably in view — leave the strip alone
      if (r.left >= navRect.left + pad && r.right <= navRect.right - pad) return;
      // Otherwise centre it so the neighbouring destinations stay discoverable
      var max = nav.scrollWidth - nav.clientWidth;
      var centered = nav.scrollLeft + (r.left - navRect.left) - (navRect.width - r.width) / 2;
      nav.scrollTo({
        left: Math.max(0, Math.min(max, centered)),
        behavior: prefersReduced() ? 'auto' : 'smooth'
      });
    }

    /* ---- Overflow state (More button + edge shadows) ---- */
    function updateOverflow() {
      var canOverflow = overflowing();
      more.hidden = !canOverflow;
      nav.classList.toggle('has-overflow', canOverflow);
      if (!canOverflow) closeMenu();
      var max = nav.scrollWidth - nav.clientWidth;
      nav.setAttribute('data-overflow-start', String(max > 1 && nav.scrollLeft > 1));
      nav.setAttribute('data-overflow-end', String(max > 1 && nav.scrollLeft < max - 1));
    }

    var frame = 0;
    nav.addEventListener('scroll', function () {
      if (frame) return;
      frame = requestAnimationFrame(function () { frame = 0; updateOverflow(); });
    }, { passive: true });

    /* ---- Drag-to-scroll (mouse / pen) ---- */
    var drag = { active: false, moved: false, startX: 0, startLeft: 0 };
    nav.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'touch' || e.button !== 0 || !overflowing()) return;
      drag.active = true;
      drag.moved = false;
      drag.startX = e.clientX;
      drag.startLeft = nav.scrollLeft;
      nav.classList.add('is-dragging');
    });
    document.addEventListener('pointermove', function (e) {
      if (!drag.active) return;
      var dx = e.clientX - drag.startX;
      if (!drag.moved && Math.abs(dx) < 4) return;
      drag.moved = true;
      nav.scrollLeft = drag.startLeft - dx;
      e.preventDefault();
    });
    document.addEventListener('pointerup', function () {
      if (!drag.active) return;
      drag.active = false;
      nav.classList.remove('is-dragging');
    });
    nav.addEventListener('click', function (e) {
      if (!drag.moved) return;
      e.preventDefault();
      e.stopPropagation();
      drag.moved = false;
    }, true);
    nav.addEventListener('dragstart', function (e) { e.preventDefault(); });

    /* ---- Vertical wheel → horizontal strip ---- */
    nav.addEventListener('wheel', function (e) {
      if (!overflowing() || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      var max = nav.scrollWidth - nav.clientWidth;
      var step = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      if ((step < 0 && nav.scrollLeft <= 0) || (step > 0 && nav.scrollLeft >= max - 1)) return;
      nav.scrollLeft += step;
      e.preventDefault();
    }, { passive: false });

    /* ---- React to scroll-spy changes ---- */
    document.addEventListener('sq:navchange', function (e) {
      var item = e.detail && e.detail.item;
      if (item) ensureVisible(item);
      updateOverflow();
      if (!menu.hidden) openMenu();
    });

    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(function () { updateOverflow(); }).observe(nav);
    }
    window.addEventListener('resize', updateOverflow);

    nav.__sqDockRefresh = function () {
      updateOverflow();
      ensureVisible(nav.querySelector('.is-active, .sq-nav__item--active'));
    };

    requestAnimationFrame(function () {
      updateOverflow();
      ensureVisible(nav.querySelector('.is-active, .sq-nav__item--active'));
    });
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () {
        updateOverflow();
        ensureVisible(nav.querySelector('.is-active, .sq-nav__item--active'));
      });
    }
  }

  /* ======================================================
     NAV SCROLL & SCROLL-SPY
     - Click nav item → smooth scroll to target section
     - Scroll-spy: highlight nav item when section in view
     Uses getBoundingClientRect for accurate scroll detection
     inside any scrollable container (.sq-content).
     ====================================================== */

  /* ======================================================
     SECTION SCROLL — shared by nav clicks and #deep links
     scrollToSection('logs') / scrollToSection('#logs')
     ====================================================== */
  function scrollToSection(id, opts) {
    var content = $('.sq-content');
    if (!content || !id) return false;
    var target = document.getElementById(String(id).replace(/^#/, ''));
    if (!target) return false;

    var behavior = (opts && opts.behavior) || (prefersReduced() ? 'auto' : 'smooth');
    var containerTop = content.getBoundingClientRect().top;
    var targetTop = target.getBoundingClientRect().top;
    content.scrollTo({
      top: Math.max(0, content.scrollTop + targetTop - containerTop - 16),
      behavior: behavior
    });
    return true;
  }

  /* Applies #section deep links on load and on hash change. */
  function initHashSection() {
    function apply(behavior) {
      var id = (window.location.hash || '').replace('#', '');
      if (id) scrollToSection(id, { behavior: behavior });
    }
    if (window.location.hash) {
      // Defer a tick so layout (and any first render) settles first.
      setTimeout(function () { apply('auto'); }, 0);
    }
    window.addEventListener('hashchange', function () { apply('smooth'); });
  }

  function initNavScroll() {
    var content = $('.sq-content');
    if (!content) return;
    if (content.dataset.sqNavReady === 'true') return;
    content.dataset.sqNavReady = 'true';

    // Build map of nav items → sections via href="#id"
    var navItems = $$('.sq-nav__item[href^="#"]');
    var sections = [];
    var app = document.getElementById('app') || $('.sq-app');

    navItems.forEach(function (item) {
      var href = item.getAttribute('href');
      if (!href || href === '#') return;
      var id = href.slice(1);
      var section = document.getElementById(id);
      if (section) {
        sections.push({ item: item, section: section });

        // Click: scroll section into view inside container
        item.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          scrollToSection(id);
          // Keep the URL shareable without triggering a native jump
          try { history.replaceState(null, '', '#' + id); } catch (_) {}
          // Immediate active update on click
          navItems.forEach(function (n) {
            n.classList.remove('is-active', 'sq-nav__item--active');
            n.removeAttribute('aria-current');
          });
          item.classList.add('is-active', 'sq-nav__item--active');
          item.setAttribute('aria-current', 'page');
          if (app && app.classList.contains('nav-collapsed')) sidebarOpen();
        });
      }
    });

    if (sections.length === 0) return;

    // Scroll-spy: update active item as user scrolls
    var lastActiveItem = null;
    function updateActive() {
      var containerTop = content.getBoundingClientRect().top;
      var threshold    = 60; // px from container top edge
      var activeIdx    = 0;

      for (var i = 0; i < sections.length; i++) {
        var rect = sections[i].section.getBoundingClientRect();
        if (rect.top - containerTop <= threshold) activeIdx = i;
      }

      var activeItem = null;
      sections.forEach(function (pair, idx) {
        var active = idx === activeIdx;
        pair.item.classList.toggle('is-active',           active);
        pair.item.classList.toggle('sq-nav__item--active', active);
        if (active) {
          pair.item.setAttribute('aria-current', 'page');
          activeItem = pair.item;
        }
        else        pair.item.removeAttribute('aria-current');
      });

      // Let the dock keep the active item in view / sync the More drop-up
      if (activeItem && activeItem !== lastActiveItem) {
        lastActiveItem = activeItem;
        document.dispatchEvent(new CustomEvent('sq:navchange', { detail: { item: activeItem } }));
      }
    }

    content.addEventListener('scroll', updateActive, { passive: true });
    // Run once on init to set correct initial state
    updateActive();
  }

  /* ======================================================
     ADVANCED TABLE  — sort, select, filter, paginate
     Markup contract:
       <table class="sq-table" data-sq-table data-sq-page-size="8">
         thead th > button.sq-table__sort[data-sq-sort="text|number"]
         tbody tr > td.sq-table__check > input.sq-checkbox[data-sq-row-select]
       Optional, inside the same scope element ([data-sq-table-scope] or
       the enclosing .sq-section):
         [data-sq-select-all] [data-sq-table-filter]
         [data-sq-table-count] [data-sq-table-pagination]
     Events: sq:rowselection, sq:pagechange (both bubble)
     ====================================================== */
  function tableScope(table) {
    return table.closest('[data-sq-table-scope]') || table.closest('.sq-section') || table.parentElement;
  }

  function tableRows(table) {
    if (!table.__sqRows) {
      table.__sqRows = Array.prototype.slice.call(table.tBodies[0].rows)
        .filter(function (row) { return !row.hasAttribute('data-sq-table-skip'); });
    }
    return table.__sqRows;
  }

  function tableCellValue(row, colIndex, type) {
    var cell = row.cells[colIndex];
    var raw = cell ? cell.textContent.trim() : '';
    if (type === 'number') {
      var num = parseFloat(raw.replace(/[^0-9.\-]/g, ''));
      return isNaN(num) ? Number.NEGATIVE_INFINITY : num;
    }
    if (type === 'date') {
      var time = Date.parse(raw);
      return isNaN(time) ? 0 : time;
    }
    return raw.toLowerCase();
  }

  function sortTable(table, colIndex, direction, opts) {
    if (!table || !table.tBodies || !table.tBodies[0]) return false;
    var tbody = table.tBodies[0];
    var rows = tableRows(table).slice();
    var dir = direction === 'descending' ? -1 : 1;

    var th = table.tHead && table.tHead.rows[0] ? table.tHead.rows[0].cells[colIndex] : null;
    var btn = th ? th.querySelector('[data-sq-sort]') : null;
    var type = (opts && opts.type) ||
      (th && th.getAttribute('data-sq-sort-type')) ||
      (btn && btn.getAttribute('data-sq-sort')) || 'text';

    rows.sort(function (a, b) {
      var av = tableCellValue(a, colIndex, type);
      var bv = tableCellValue(b, colIndex, type);
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return 0;
    });

    rows.forEach(function (row) { tbody.appendChild(row); });
    table.__sqRows = rows;
    table.__sqPage = 1;

    if (table.tHead && table.tHead.rows[0]) {
      Array.prototype.forEach.call(table.tHead.rows[0].cells, function (cell, i) {
        if (i === colIndex) cell.setAttribute('aria-sort', dir === 1 ? 'ascending' : 'descending');
        else cell.removeAttribute('aria-sort');
      });
    }

    applyTable(table);
    return true;
  }

  function setRowSelected(table, row, on) {
    if (!row) return;
    row.classList.toggle('is-selected', !!on);
    var box = row.querySelector('[data-sq-row-select]');
    if (box) box.checked = !!on;
  }

  function syncTableSelection(table, silent) {
    var rows = tableRows(table);
    var selected = rows.filter(function (row) { return row.classList.contains('is-selected'); });
    var scope = tableScope(table);
    var selectAll = $('[data-sq-select-all]', scope);

    if (selectAll) {
      selectAll.checked = selected.length > 0 && selected.length === rows.length;
      selectAll.indeterminate = selected.length > 0 && selected.length < rows.length;
    }

    var count = $('[data-sq-table-count]', scope);
    if (count) {
      count.textContent = selected.length
        ? selected.length + ' of ' + rows.length + ' selected'
        : rows.length + ' rows';
    }

    if (!silent) {
      table.dispatchEvent(new CustomEvent('sq:rowselection', {
        bubbles: true,
        detail: { count: selected.length, rows: selected }
      }));
    }
  }

  function applyTable(table) {
    var tbody = table.tBodies[0];
    if (!tbody) return;
    var rows = tableRows(table);
    var filter = (table.__sqFilter || '').toLowerCase();

    var visible = rows.filter(function (row) {
      return !filter || row.textContent.toLowerCase().indexOf(filter) !== -1;
    });

    var size = table.__sqPageSize || 0;
    var pages = size > 0 ? Math.max(1, Math.ceil(visible.length / size)) : 1;
    table.__sqPage = Math.min(Math.max(1, table.__sqPage || 1), pages);
    var start = size > 0 ? (table.__sqPage - 1) * size : 0;
    var end = size > 0 ? start + size : visible.length;

    rows.forEach(function (row) { row.hidden = true; });
    visible.slice(start, end).forEach(function (row) { row.hidden = false; });

    renderTableEmpty(table, visible.length);
    renderTablePagination(table, visible.length, pages, start, end);
    syncTableSelection(table, true);
  }

  function renderTableEmpty(table, visibleCount) {
    var tbody = table.tBodies[0];
    var empty = tbody.querySelector('[data-sq-table-generated]');
    if (visibleCount > 0) {
      if (empty) empty.remove();
      return;
    }
    if (empty) return;
    var columns = table.tHead && table.tHead.rows[0] ? table.tHead.rows[0].cells.length : 1;
    var tr = document.createElement('tr');
    tr.setAttribute('data-sq-table-generated', '');
    var td = document.createElement('td');
    td.className = 'sq-table__empty';
    td.colSpan = columns;
    td.textContent = table.getAttribute('data-sq-empty-label') || 'No matching rows';
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  function renderTablePagination(table, total, pages, start, end) {
    var nav = $('[data-sq-table-pagination]', tableScope(table));
    if (!nav) return;

    nav.innerHTML = '';

    var info = document.createElement('span');
    info.className = 'sq-pagination__info';
    info.textContent = total === 0
      ? 'No rows'
      : (start + 1) + '\u2013' + Math.min(end, total) + ' of ' + total;
    nav.appendChild(info);

    var list = document.createElement('div');
    list.className = 'sq-pagination__pages';
    nav.appendChild(list);

    function pageButton(label, target, current, disabled, ariaLabel) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sq-pagination__btn';
      btn.textContent = label;
      if (ariaLabel) btn.setAttribute('aria-label', ariaLabel);
      if (current) btn.setAttribute('aria-current', 'page');
      btn.disabled = !!disabled;
      if (!disabled && !current) {
        btn.addEventListener('click', function () {
          table.__sqPage = target;
          applyTable(table);
          table.dispatchEvent(new CustomEvent('sq:pagechange', {
            bubbles: true,
            detail: { page: target, pages: pages }
          }));
        });
      }
      return btn;
    }

    function gap() {
      var el = document.createElement('span');
      el.className = 'sq-pagination__gap';
      el.textContent = '\u2026';
      return el;
    }

    if (pages <= 1) return;

    list.appendChild(pageButton('\u2039', table.__sqPage - 1, false, table.__sqPage === 1, 'Previous page'));

    var windowSize = 5;
    var to = Math.min(pages, Math.max(1, table.__sqPage - Math.floor(windowSize / 2)) + windowSize - 1);
    var from = Math.max(1, to - windowSize + 1);

    if (from > 1) {
      list.appendChild(pageButton('1', 1, table.__sqPage === 1, false, 'Page 1'));
      if (from > 2) list.appendChild(gap());
    }

    for (var p = from; p <= to; p++) {
      list.appendChild(pageButton(String(p), p, p === table.__sqPage, false, 'Page ' + p));
    }

    if (to < pages) {
      if (to < pages - 1) list.appendChild(gap());
      list.appendChild(pageButton(String(pages), pages, table.__sqPage === pages, false, 'Page ' + pages));
    }

    list.appendChild(pageButton('\u203A', table.__sqPage + 1, false, table.__sqPage === pages, 'Next page'));
  }

  function initTables() {
    $$('[data-sq-table]').forEach(function (table) {
      if (!table.tBodies || !table.tBodies[0]) return;

      if (table.dataset.sqTableReady !== 'true') {
        table.dataset.sqTableReady = 'true';
        table.__sqPage = 1;
        table.__sqPageSize = parseInt(table.getAttribute('data-sq-page-size'), 10) || 0;
        table.__sqFilter = '';
        table.__sqLastIndex = -1;

        var scope = tableScope(table);

        $$('[data-sq-sort]', table).forEach(function (btn) {
          btn.addEventListener('click', function (event) {
            event.preventDefault();
            var th = btn.closest('th');
            if (!th) return;
            var colIndex = Array.prototype.indexOf.call(th.parentNode.children, th);
            var dir = th.getAttribute('aria-sort') === 'ascending' ? 'descending' : 'ascending';
            sortTable(table, colIndex, dir);
          });
        });

        var selectAll = $('[data-sq-select-all]', scope);
        if (selectAll) {
          selectAll.addEventListener('change', function () {
            tableRows(table).forEach(function (row) {
              setRowSelected(table, row, selectAll.checked);
            });
            syncTableSelection(table);
          });
        }

        table.tBodies[0].addEventListener('change', function (event) {
          var box = event.target;
          if (!box || !box.matches || !box.matches('[data-sq-row-select]')) return;
          var row = box.closest('tr');
          var index = tableRows(table).indexOf(row);

          if (event.shiftKey && table.__sqLastIndex > -1 && index > -1) {
            var first = Math.min(table.__sqLastIndex, index);
            var last = Math.max(table.__sqLastIndex, index);
            for (var i = first; i <= last; i++) {
              setRowSelected(table, tableRows(table)[i], box.checked);
            }
          }

          setRowSelected(table, row, box.checked);
          table.__sqLastIndex = index;
          syncTableSelection(table);
        });

        $$('[data-sq-table-filter]', scope).forEach(function (input) {
          input.addEventListener('input', function () {
            table.__sqFilter = input.value.trim();
            table.__sqPage = 1;
            applyTable(table);
          });
        });
      }

      applyTable(table);
    });
  }

  /* ======================================================
     CHART EXTENSIONS  — line / area chart, stacked bars, hover tooltip
     renderLineChart(svgEl, series, opts)
       series: [{ name, values: [n, ...] }]
       opts  : { labels, min, max, unit, area: true, yTicks: 4, xTickEvery, decimals }
     renderStackedBars(colsEl, series, opts)
       series: [{ name, values: [n, ...] }]   // n values are stacked per column
       opts  : { labels, max, minCols, unit, legend: true }
     Both draw in element pixel units (the SVG height comes from CSS), so the
     chart redraws on resize instead of scaling stale geometry.
     ====================================================== */
  var CHART_TINTS = ['sq-chart__s1', 'sq-chart__s2', 'sq-chart__s3', 'sq-chart__s4'];

  function svgNode(tag, attrs) {
    var el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.keys(attrs || {}).forEach(function (key) { el.setAttribute(key, attrs[key]); });
    return el;
  }

  function chartFormat(value, opts) {
    var out;
    if (opts && typeof opts.format === 'function') {
      out = opts.format(value);
    } else {
      var decimals = opts && typeof opts.decimals === 'number' ? opts.decimals : 0;
      out = Number(value).toFixed(decimals);
    }
    return opts && opts.unit ? out + opts.unit : out;
  }

  function niceStep(raw) {
    if (!isFinite(raw) || raw <= 0) return 1;
    var magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / magnitude;
    var mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    return mult * magnitude;
  }

  function chartHost(el) {
    return el.closest('.sq-chart__body') || el.parentElement;
  }

  // SVG geometry is in viewBox units, while pointer/tooltip coordinates are CSS
  // pixels. getScreenCTM() also accounts for preserveAspectRatio letterboxing,
  // so hover alignment survives responsive scaling.
  function svgClientPoint(svgEl, x, y) {
    if (!svgEl || !svgEl.createSVGPoint || !svgEl.getScreenCTM) return null;
    var pt = svgEl.createSVGPoint();
    pt.x = x;
    pt.y = y;
    var ctm = svgEl.getScreenCTM();
    return ctm ? pt.matrixTransform(ctm) : null;
  }

  function ensureChartTip(host) {
    var tip = host.querySelector('.sq-chart__tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'sq-chart__tip';
      tip.hidden = true;
      tip.setAttribute('role', 'status');
      host.appendChild(tip);
    }
    return tip;
  }

  function hideChartTip(event) {
    var host = chartHost(event.currentTarget);
    if (!host) return;
    var tip = host.querySelector('.sq-chart__tip');
    if (tip) tip.hidden = true;
    var cursor = host.querySelector('.sq-chart__cursor');
    if (cursor) cursor.style.opacity = '0';
    var cols = host.querySelectorAll('.sq-chart__col.is-hover');
    Array.prototype.forEach.call(cols, function (col) { col.classList.remove('is-hover'); });
  }

  function fillChartLegend(chartEl, series) {
    if (!chartEl) return;
    var legend = chartEl.querySelector('[data-sq-chart-legend]');
    if (!legend) return;
    legend.innerHTML = '';
    series.forEach(function (item, index) {
      var wrap = document.createElement('span');
      wrap.className = 'sq-chart__legend-item';
      var sw = document.createElement('span');
      sw.className = 'sq-chart__sw ' + CHART_TINTS[index % CHART_TINTS.length];
      var name = document.createElement('span');
      name.textContent = item.name || 'Series ' + (index + 1);
      wrap.appendChild(sw);
      wrap.appendChild(name);
      legend.appendChild(wrap);
    });
  }

  function renderLineChart(svgEl, series, opts) {
    if (!svgEl || !series || !series.length) return;
    svgEl.__sqChart = { series: series, opts: opts || {} };

    if (!svgEl.__sqHoverBound) {
      svgEl.__sqHoverBound = true;
      svgEl.addEventListener('mousemove', onLineChartHover);
      svgEl.addEventListener('mouseleave', hideChartTip);
    }

    drawLineChart(svgEl);

    if (!renderLineChart.bound) {
      renderLineChart.bound = true;
      var timer;
      window.addEventListener('resize', function () {
        clearTimeout(timer);
        timer = setTimeout(function () {
          $$('.sq-chart__svg').forEach(function (el) {
            if (el.__sqChart) drawLineChart(el);
          });
        }, 120);
      });
    }
  }

  function drawLineChart(svgEl) {
    var state = svgEl.__sqChart;
    if (!state) return;

    var series = state.series || [];
    var opts = state.opts || {};
    var box = svgEl.getBoundingClientRect();
    var W = Math.max(180, Math.round(box.width || 360));
    var H = Math.max(96, Math.round(box.height || 168));

    svgEl.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);

    var padL = 38;
    var padR = 10;
    var padT = 10;
    var padB = 22;
    var plotW = Math.max(10, W - padL - padR);
    var plotH = Math.max(10, H - padT - padB);

    var values = [];
    series.forEach(function (s) { values = values.concat(s.values || []); });
    if (!values.length) return;

    var labels = opts.labels || [];
    var count = Math.max(labels.length, series[0].values.length);

    var min = typeof opts.min === 'number' ? opts.min : Math.min.apply(null, values);
    var max = typeof opts.max === 'number' ? opts.max : Math.max.apply(null, values);
    if (max === min) max = min + 2;

    var step = niceStep((max - min) / (opts.yTicks || 4));
    var yMin = Math.floor(min / step) * step;
    var yMax = Math.ceil(max / step) * step;
    var tickCount = Math.max(1, Math.round((yMax - yMin) / step));

    function sx(index) {
      return count === 1 ? padL + plotW / 2 : padL + (index / (count - 1)) * plotW;
    }
    function sy(value) {
      return padT + (1 - (value - yMin) / (yMax - yMin)) * plotH;
    }

    // Gridlines + y tick labels
    for (var t = 0; t <= tickCount; t++) {
      var tickValue = yMin + t * step;
      var tickY = sy(tickValue);
      svgEl.appendChild(svgNode('line', {
        class: 'sq-chart__grid',
        x1: padL, x2: W - padR, y1: tickY, y2: tickY
      }));
      var tick = svgNode('text', {
        class: 'sq-chart__tick',
        x: padL - 6, y: tickY + 3, 'text-anchor': 'end'
      });
      tick.textContent = chartFormat(tickValue, opts);
      svgEl.appendChild(tick);
    }

    // Value axis
    svgEl.appendChild(svgNode('line', {
      class: 'sq-chart__axis', x1: padL, x2: padL, y1: padT, y2: padT + plotH
    }));

    // x tick labels
    var every = opts.xTickEvery || Math.max(1, Math.ceil(count / 6));
    for (var i = 0; i < count; i++) {
      if (i % every !== 0 && i !== count - 1) continue;
      var label = svgNode('text', {
        class: 'sq-chart__tick',
        x: sx(i), y: padT + plotH + 15, 'text-anchor': 'middle'
      });
      label.textContent = labels[i] !== undefined ? labels[i] : String(i + 1);
      svgEl.appendChild(label);
    }

    // Areas first so lines always sit on top
    series.forEach(function (s, index) {
      if (opts.area === false) return;
      var pts = [];
      s.values.forEach(function (value, idx) { pts.push(sx(idx) + ',' + sy(value)); });
      if (!pts.length) return;
      svgEl.appendChild(svgNode('polygon', {
        class: 'sq-chart__area ' + CHART_TINTS[index % CHART_TINTS.length],
        points: pts.join(' ') + ' ' + sx(s.values.length - 1) + ',' + (padT + plotH) +
                ' ' + sx(0) + ',' + (padT + plotH)
      }));
    });

    series.forEach(function (s, index) {
      var pts = [];
      s.values.forEach(function (value, idx) { pts.push(sx(idx) + ',' + sy(value)); });
      if (!pts.length) return;

      svgEl.appendChild(svgNode('polyline', {
        class: 'sq-chart__line ' + CHART_TINTS[index % CHART_TINTS.length],
        points: pts.join(' ')
      }));

      var lastIdx = s.values.length - 1;
      svgEl.appendChild(svgNode('circle', {
        class: 'sq-chart__dot ' + CHART_TINTS[index % CHART_TINTS.length],
        cx: sx(lastIdx), cy: sy(s.values[lastIdx]), r: 2.5
      }));
    });

    // Crosshair used by the hover handler
    var cursor = svgNode('line', {
      class: 'sq-chart__cursor',
      x1: padL, x2: padL, y1: padT, y2: padT + plotH
    });
    cursor.style.opacity = '0';
    svgEl.appendChild(cursor);

    svgEl.__sqGeom = {
      series: series, opts: opts, labels: labels, count: count,
      padL: padL, padT: padT, plotW: plotW, plotH: plotH,
      sx: sx, sy: sy, cursor: cursor
    };

    fillChartLegend(svgEl.closest('.sq-chart'), series);
  }

  function onLineChartHover(event) {
    var svgEl = event.currentTarget;
    var g = svgEl.__sqGeom;
    if (!g) return;

    var ctm = svgEl.getScreenCTM && svgEl.getScreenCTM();
    if (!ctm) return;

    var pointer = svgEl.createSVGPoint();
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    var local = pointer.matrixTransform(ctm.inverse());
    var ratio = (local.x - g.padL) / (g.plotW || 1);
    var index = Math.round(ratio * (g.count - 1));
    index = Math.max(0, Math.min(g.count - 1, index));

    var host = chartHost(svgEl);
    var tip = ensureChartTip(host);

    var labelEl = document.createElement('div');
    labelEl.className = 'sq-chart__tip-label';
    labelEl.textContent = g.labels[index] !== undefined ? g.labels[index] : '#' + (index + 1);
    tip.innerHTML = '';
    tip.appendChild(labelEl);

    var topY = Infinity;
    g.series.forEach(function (s, seriesIndex) {
      var value = (s.values || [])[index];
      if (value === undefined) return;
      topY = Math.min(topY, g.sy(value));

      var row = document.createElement('div');
      row.className = 'sq-chart__tip-row';

      var sw = document.createElement('span');
      sw.className = 'sq-chart__tip-swatch ' + CHART_TINTS[seriesIndex % CHART_TINTS.length];

      var name = document.createElement('span');
      name.textContent = s.name || 'Series ' + (seriesIndex + 1);

      var val = document.createElement('span');
      val.className = 'sq-chart__tip-value';
      val.textContent = chartFormat(value, g.opts);

      row.appendChild(sw);
      row.appendChild(name);
      row.appendChild(val);
      tip.appendChild(row);
    });

    if (!isFinite(topY)) topY = g.padT;

    var hostBox = host.getBoundingClientRect();
    var anchor = svgClientPoint(svgEl, g.sx(index), topY);
    if (anchor) {
      tip.style.left = Math.round(anchor.x - hostBox.left) + 'px';
      tip.style.top = Math.round(anchor.y - hostBox.top) + 'px';
    }
    tip.hidden = false;

    if (g.cursor) {
      g.cursor.setAttribute('x1', String(g.sx(index)));
      g.cursor.setAttribute('x2', String(g.sx(index)));
      g.cursor.style.opacity = '1';
    }
  }

  function renderStackedBars(colsEl, series, opts) {
    if (!colsEl || !series || !series.length) return;
    opts = opts || {};

    var count = 0;
    series.forEach(function (s) { count = Math.max(count, (s.values || []).length); });
    count = Math.max(count, opts.minCols || 0, 1);

    var totals = [];
    var peak = 1;
    for (var i = 0; i < count; i++) {
      var sum = 0;
      series.forEach(function (s) { sum += Math.max(0, (s.values || [])[i] || 0); });
      totals.push(sum);
      peak = Math.max(peak, sum);
    }
    var scale = typeof opts.max === 'number' ? opts.max : peak;

    colsEl.innerHTML = '';
    colsEl.style.setProperty('--sq-chart-cols', String(count));

    for (var c = 0; c < count; c++) {
      var col = document.createElement('div');
      col.className = 'sq-chart__col';
      col.setAttribute('data-sq-index', String(c));
      col.setAttribute('data-sq-total', String(totals[c]));

      series.forEach(function (item, seriesIndex) {
        var value = Math.max(0, (item.values || [])[c] || 0);
        var seg = document.createElement('div');
        seg.className = 'sq-chart__seg sq-chart__seg--s' + ((seriesIndex % 4) + 1);
        seg.style.height = ((value / scale) * 100) + '%';
        seg.setAttribute('data-sq-series', item.name || String(seriesIndex));
        seg.setAttribute('data-sq-value', String(value));
        col.appendChild(seg);
      });

      colsEl.appendChild(col);
    }

    if (!colsEl.__sqHoverBound) {
      colsEl.__sqHoverBound = true;
      colsEl.addEventListener('mousemove', onStackedBarsHover);
      colsEl.addEventListener('mouseleave', hideChartTip);
    }
    colsEl.__sqBars = { series: series, opts: opts, labels: opts.labels || [] };

    if (opts.labels && opts.labels.length) {
      var host = colsEl.closest('.sq-chart');
      var labelRow = host ? host.querySelector('[data-sq-chart-labels]') : null;
      if (labelRow) {
        labelRow.innerHTML = '';
        labelRow.style.setProperty('--sq-chart-cols', String(count));
        for (var l = 0; l < count; l++) {
          var span = document.createElement('span');
          span.className = 'sq-chart__xlabel';
          span.textContent = opts.labels[l] !== undefined ? opts.labels[l] : '';
          labelRow.appendChild(span);
        }
      }
    }

    fillChartLegend(colsEl.closest('.sq-chart'), series);
  }

  function onStackedBarsHover(event) {
    var colsEl = event.currentTarget;
    var state = colsEl.__sqBars;
    if (!state) return;

    var col = event.target.closest ? event.target.closest('.sq-chart__col') : null;
    if (!col || !colsEl.contains(col)) {
      hideChartTip(event);
      return;
    }

    Array.prototype.forEach.call(colsEl.querySelectorAll('.sq-chart__col'), function (item) {
      item.classList.toggle('is-hover', item === col);
    });

    var index = parseInt(col.getAttribute('data-sq-index'), 10) || 0;
    var host = chartHost(colsEl);
    var tip = ensureChartTip(host);

    tip.innerHTML = '';

    var labelEl = document.createElement('div');
    labelEl.className = 'sq-chart__tip-label';
    labelEl.textContent = state.labels[index] !== undefined ? state.labels[index] : '#' + (index + 1);
    tip.appendChild(labelEl);

    state.series.forEach(function (item, seriesIndex) {
      var value = (item.values || [])[index] || 0;
      var row = document.createElement('div');
      row.className = 'sq-chart__tip-row';

      var sw = document.createElement('span');
      sw.className = 'sq-chart__tip-swatch ' + CHART_TINTS[seriesIndex % CHART_TINTS.length];

      var name = document.createElement('span');
      name.textContent = item.name || 'Series ' + (seriesIndex + 1);

      var val = document.createElement('span');
      val.className = 'sq-chart__tip-value';
      val.textContent = chartFormat(value, state.opts);

      row.appendChild(sw);
      row.appendChild(name);
      row.appendChild(val);
      tip.appendChild(row);
    });

    var hostBox = host.getBoundingClientRect();
    tip.style.left = Math.round(event.clientX - hostBox.left) + 'px';
    tip.style.top = Math.round(event.clientY - hostBox.top - 8) + 'px';
    tip.hidden = false;
  }

  /* ======================================================
     TREE  — expand / collapse with keyboard support (max 3 levels)
     Markup:
       <div class="sq-tree" data-sq-tree>
         <div class="sq-tree__item">
           <div class="sq-tree__row">
             <button class="sq-tree__toggle" aria-expanded="true" aria-label="Toggle X">…</button>
             <span class="sq-tree__label">…</span>
           </div>
           <div class="sq-tree__group"> …nested items… </div>
         </div>
       </div>
     ====================================================== */
  var TREE_MAX_DEPTH = 3;

  function treeGroupOf(item) {
    for (var i = 0; i < item.children.length; i++) {
      if (item.children[i].classList.contains('sq-tree__group')) return item.children[i];
    }
    return null;
  }

  function toggleTreeNode(btn, expand) {
    var item = btn.closest('.sq-tree__item');
    if (!item) return null;
    var group = treeGroupOf(item);
    if (!group) return null;

    var open = typeof expand === 'boolean' ? expand : btn.getAttribute('aria-expanded') !== 'true';
    btn.setAttribute('aria-expanded', String(open));
    group.hidden = !open;
    return open;
  }

  function treeVisibleToggles(root) {
    return $$('.sq-tree__toggle', root).filter(function (btn) {
      var node = btn;
      while (node && node !== root) {
        if (node.hidden) return false;
        node = node.parentElement;
      }
      return true;
    });
  }

  function onTreeKeydown(event) {
    var btn = event.currentTarget;
    var root = btn.closest('[data-sq-tree]');
    if (!root) return;

    var toggles = treeVisibleToggles(root);
    var current = toggles.indexOf(btn);

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      var next = event.key === 'ArrowDown' ? current + 1 : current - 1;
      if (next >= 0 && next < toggles.length) toggles[next].focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      if (toggles.length) toggles[0].focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      if (toggles.length) toggles[toggles.length - 1].focus();
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      if (btn.getAttribute('aria-expanded') !== 'true') {
        toggleTreeNode(btn, true);
      } else {
        var item = btn.closest('.sq-tree__item');
        var group = item ? treeGroupOf(item) : null;
        var child = group ? group.querySelector('.sq-tree__toggle') : null;
        if (child) child.focus();
      }
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (btn.getAttribute('aria-expanded') === 'true') {
        toggleTreeNode(btn, false);
      } else {
        var own = btn.closest('.sq-tree__item');
        var parentGroup = own ? own.parentElement : null;
        var parentItem = parentGroup && parentGroup.classList.contains('sq-tree__group')
          ? parentGroup.closest('.sq-tree__item')
          : null;
        var parentToggle = parentItem ? parentItem.querySelector('.sq-tree__toggle') : null;
        if (parentToggle) parentToggle.focus();
      }
    }
  }

  function initTree() {
    $$('[data-sq-tree]').forEach(function (root) {
      if (root.dataset.sqTreeReady === 'true') return;
      root.dataset.sqTreeReady = 'true';

      $$('.sq-tree__toggle', root).forEach(function (btn) {
        btn.addEventListener('click', function (event) {
          event.preventDefault();
          toggleTreeNode(btn);
        });
        btn.addEventListener('keydown', onTreeKeydown);
      });

      // Normalise the initial state: the group follows aria-expanded
      $$('.sq-tree__item', root).forEach(function (item) {
        var group = treeGroupOf(item);
        if (!group) return;
        var row = item.querySelector('.sq-tree__row');
        var btn = row ? row.querySelector('.sq-tree__toggle') : null;
        if (!btn) return;
        toggleTreeNode(btn, btn.getAttribute('aria-expanded') === 'true');
      });

      if (root.getAttribute('data-sq-tree-depth') === null) {
        var deepest = 1;
        $$('.sq-tree__item', root).forEach(function (item) {
          var levels = 0;
          var node = item.parentElement;
          while (node && node !== root) {
            if (node.classList.contains('sq-tree__group')) levels++;
            node = node.parentElement;
          }
          deepest = Math.max(deepest, levels + 1);
        });
        root.setAttribute('data-sq-tree-depth', String(deepest));
        if (deepest > TREE_MAX_DEPTH && typeof console !== 'undefined') {
          console.warn('[SynteqUI] tree depth ' + deepest + ' exceeds the supported ' + TREE_MAX_DEPTH + ' levels');
        }
      }
    });
  }

  /* ======================================================
     STEPPER  — vertical progress indicator
     setStep(el, index) marks items before index complete, index active.
     ====================================================== */
  function setStep(stepperEl, index) {
    if (!stepperEl) return null;
    var items = $$('.sq-stepper__item', stepperEl);
    if (!items.length) return null;

    var current = Math.min(Math.max(0, index | 0), items.length - 1);

    items.forEach(function (item, i) {
      item.classList.toggle('is-complete', i < current);
      item.classList.toggle('is-active', i === current);
      item.classList.toggle('is-pending', i > current);
      if (i === current) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    });

    stepperEl.setAttribute('data-sq-step', String(current));
    stepperEl.dispatchEvent(new CustomEvent('sq:stepchange', {
      bubbles: true,
      detail: { index: current, item: items[current] }
    }));
    return current;
  }

  function initStepper() {
    $$('[data-sq-stepper]').forEach(function (el) {
      var declared = parseInt(el.getAttribute('data-sq-step'), 10);
      setStep(el, isNaN(declared) ? 0 : declared);
    });
  }

  /* ======================================================
     CODE BLOCK  — gutter with line numbers + copy button
     Markup:
       <div class="sq-code" data-sq-code data-sq-line-numbers>
         <div class="sq-code__head">
           <span class="sq-code__title">terminal</span>
           <button class="sq-code__copy" data-sq-code-copy aria-label="Copy code">Copy</button>
         </div>
         <div class="sq-code__body">
           <pre class="sq-code__pre"><code>...</code></pre>
         </div>
       </div>
     Pass data-sq-line-numbers="false" to hide the gutter.
     ====================================================== */
  function addCodeLineNumbers(block, pre) {
    var body = pre.parentElement;
    if (!body || body.querySelector('.sq-code__lines')) return;

    var text = pre.textContent.replace(/\n+$/, '');
    var total = text ? text.split('\n').length : 1;

    var gutter = document.createElement('div');
    gutter.className = 'sq-code__lines';
    gutter.setAttribute('aria-hidden', 'true');

    for (var i = 1; i <= total; i++) {
      var line = document.createElement('span');
      line.className = 'sq-code__line-num';
      line.textContent = String(i);
      gutter.appendChild(line);
    }

    body.insertBefore(gutter, pre);
  }

  function copyCodeBlock(block, pre, button) {
    var text = pre.textContent.replace(/\n+$/, '');
    if (!text) return;

    var label = button.getAttribute('data-sq-code-copy') || 'Copied';
    var original = button.getAttribute('aria-label') || 'Copy code';

    copyToClipboard(text).then(function () {
      button.classList.add('is-copied');
      button.setAttribute('aria-label', label);
      tip(button, label, { kind: 'ok' });
      setTimeout(function () {
        button.classList.remove('is-copied');
        button.setAttribute('aria-label', original);
      }, 1800);
    }).catch(function () {
      tip(button, 'Copy failed', { kind: 'err' });
    });
  }

  function initCodeBlocks() {
    $$('[data-sq-code]').forEach(function (block) {
      if (block.dataset.sqCodeReady === 'true') return;
      block.dataset.sqCodeReady = 'true';

      var pre = $('.sq-code__pre', block);
      if (!pre) return;

      if (block.getAttribute('data-sq-line-numbers') !== 'false') {
        addCodeLineNumbers(block, pre);
      }

      var copy = $('[data-sq-code-copy]', block) || $('.sq-code__copy', block);
      if (copy) {
        copy.addEventListener('click', function () { copyCodeBlock(block, pre, copy); });
      }
    });
  }

  /* ======================================================
     AUTO-INIT  — runs on DOMContentLoaded
     ====================================================== */
  function init() {
    initTheme();
    initThemeToggles();
    initSidebar();
    initGauges();
    initSparklines();
    initScrollShadow();
    initStagger();
    initCopyButtons();
    initProductionControls();
    initNavDock();
    initNavScroll();
    initHashSection();
    initTabs();
    initMenus();
    initPopovers();
    initTables();
    initTree();
    initStepper();
    initCodeBlocks();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* ======================================================
     PUBLIC API
     ====================================================== */
  global.SynteqUI = {
    version: '2.2.0',
    // Theme
    setTheme:        setTheme,
    getTheme:        getTheme,
    toggleTheme:     toggleTheme,
    // Sidebar
    sidebarToggle:   sidebarToggle,
    sidebarOpen:     sidebarOpen,
    sidebarClose:    sidebarClose,
    // Data viz
    renderGauge:     renderGauge,
    renderBars:      renderBars,
    renderSparkline: renderSparkline,
    renderLineChart: renderLineChart,
    renderStackedBars: renderStackedBars,
    // Advanced table
    sortTable:       sortTable,
    // Tree / stepper
    setStep:         setStep,
    // Overlays & feedback
    toast:           toast,
    tip:             tip,
    // Motion
    replayAnimation: replayAnimation,
    prefersReducedMotion: prefersReduced,
    // Navigation
    scrollToSection: scrollToSection,
    // Init helpers (call after dynamic content changes)
    init:            init,
    initGauges:      initGauges,
    initSparklines:  initSparklines,
    initNavDock:     initNavDock,
    initNavScroll:   initNavScroll,
    initTabs:        initTabs,
    initMenus:       initMenus,
    initPopovers:    initPopovers,
    initTables:      initTables,
    initTree:        initTree,
    initStepper:     initStepper,
    initCodeBlocks:  initCodeBlocks,
  };

})(window);
