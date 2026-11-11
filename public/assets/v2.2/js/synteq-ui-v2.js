/**
 * Synteq UI V2 Runtime  (V2/js/synteq-ui-v2.js)
 * Zero-dependency vanilla JS helpers:
 *  - Theme toggle (dark / light, persisted via localStorage)
 *  - Sticky bottom navigation dock toggle and persisted visibility
 *  - Smooth gauge fill (width-based, uses CSS transition)
 *  - Mini bar chart renderer (network I/O or any dual-series data)
 *  - SVG sparkline renderer
 *  - Topbar scroll-shadow
 *  - Reduced-motion guard on all animations
 *  - Stagger mount trigger (IntersectionObserver)
 *  - Nav scroll + scroll-spy (BoundingClientRect-based, works inside
 *    any scrollable .v2-content container)
 *  - Clipboard copy buttons [data-v2-copy]
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
    try { localStorage.setItem('sq-v2-theme', t); } catch (_) {}
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
    try { saved = localStorage.getItem('sq-v2-theme'); } catch (_) {}
    if (saved) { setTheme(saved); return; }
    const sys = typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: light)').matches;
    setTheme(sys ? 'light' : 'dark');
  }

  /* ======================================================
     GAUGE  —  sets .v2-gauge__fill width via data-value
     Usage:  renderGauge(el, 72.5)                  // thresholds
             renderGauge(el, 100, { kind:'brand' }) // quorum-style
             renderGauge(el, 42, { kind:'neutral' })// no state colour
             or set data-v2-gauge="72.5" and call initGauges()
     ====================================================== */
  function renderGauge(fillEl, pct, opts) {
    if (!fillEl) return;
    var kind = (opts && opts.kind) || 'auto';
    var clamped = Math.max(0, Math.min(100, pct));
    // Remove state classes then apply the requested one
    fillEl.classList.remove('v2-gauge__fill--ok', 'v2-gauge__fill--warn', 'v2-gauge__fill--err', 'v2-gauge__fill--brand');
    if (kind === 'brand') {
      fillEl.classList.add('v2-gauge__fill--brand');
    } else if (kind !== 'neutral') {
      if (clamped >= 90) fillEl.classList.add('v2-gauge__fill--err');
      else if (clamped >= 75) fillEl.classList.add('v2-gauge__fill--warn');
      else fillEl.classList.add('v2-gauge__fill--ok');
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
    $$('[data-v2-gauge]').forEach(function (track) {
      const fill = track.querySelector('.v2-gauge__fill');
      if (!fill) return;
      const pct = parseFloat(track.getAttribute('data-v2-gauge')) || 0;
      renderGauge(fill, pct);
    });
  }

  /* ======================================================
     BARS  — dual-series bar chart (in / out)
     stageEl  : .v2-bars container
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
    stageEl.style.setProperty('--v2-bars-cols', Math.max(1, total));
    stageEl.classList.toggle('is-empty', samples.length === 0);
    if (samples.length === 0) stageEl.setAttribute('data-v2-bars-empty', 'true');
    else stageEl.removeAttribute('data-v2-bars-empty');

    // Leading empty columns keep the chart geometry stable while data fills in
    for (var p = 0; p < padCols; p++) {
      var padCol = document.createElement('div');
      padCol.className = 'v2-bars__col v2-bars__col--pad';
      padCol.setAttribute('aria-hidden', 'true');
      stageEl.appendChild(padCol);
    }

    samples.forEach(function (pair, idx) {
      var inPct  = Math.max(0, Math.min(100, pair[0] || 0));
      var outPct = Math.max(0, Math.min(100, pair[1] || 0));
      var col = document.createElement('div');
      col.className = 'v2-bars__col';

      var offset = samples.length - idx;                       // 1 = newest
      var label = opts.stepSec
        ? ('T-' + (offset * opts.stepSec) + 's')
        : ('Sample -' + offset);
      col.setAttribute('title',
        label + '  ↓ ' + inPct.toFixed(1) + '%  ↑ ' + outPct.toFixed(1) + '%');

      var segOut = document.createElement('div');
      segOut.className = 'v2-bars__seg v2-bars__seg--out';
      segOut.style.height = outPct + '%';

      var segIn = document.createElement('div');
      segIn.className = 'v2-bars__seg v2-bars__seg--in';
      segIn.style.height = inPct + '%';

      col.appendChild(segOut);
      col.appendChild(segIn);
      stageEl.appendChild(col);
    });
  }

  /* ======================================================
     SPARKLINE  — draws an SVG polyline inside .v2-spark
     sparkEl  : SVG element with class .v2-spark
     values   : Array of numbers (raw values, auto-scaled)
     ====================================================== */
  function renderSparkline(sparkEl, values) {
    if (!sparkEl) return;
    if (!values || values.length < 2) {
      // Not enough samples yet — clear the previous path and publish an empty
      // state so consumers can render a placeholder instead of stale data.
      while (sparkEl.firstChild) sparkEl.removeChild(sparkEl.firstChild);
      sparkEl.__v2SparkValues = [];
      sparkEl.setAttribute('data-v2-spark-empty', 'true');
      return;
    }
    sparkEl.removeAttribute('data-v2-spark-empty');
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
    sparkEl.__v2SparkValues = values.slice();

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
    area.setAttribute('class', 'v2-spark__area');
    area.setAttribute('points',
      first + ' ' + pts + ' ' + last + ' ' +
      sx(values.length - 1) + ',' + H + ' ' + sx(0) + ',' + H);
    sparkEl.appendChild(area);

    // Line
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    line.setAttribute('class', 'v2-spark__line');
    line.setAttribute('points', pts);
    sparkEl.appendChild(line);

    // Latest-point dot
    const lastIdx = values.length - 1;
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('class', 'v2-spark__dot');
    dot.setAttribute('cx', sx(lastIdx));
    dot.setAttribute('cy', sy(values[lastIdx]));
    dot.setAttribute('r', '2.5');
    sparkEl.appendChild(dot);
  }

  /* Draws every .v2-spark from its remembered series (or data-v2-spark="1,2,3")
     and redraws them once the viewport is resized. */
  function initSparklines() {
    $$('.v2-spark').forEach(function (el) {
      if (!el.__v2SparkValues) {
        var raw = el.getAttribute('data-v2-spark');
        if (raw) {
          el.__v2SparkValues = raw.split(',')
            .map(function (n) { return parseFloat(n); })
            .filter(function (n) { return !isNaN(n); });
        }
      }
      if (el.__v2SparkValues) renderSparkline(el, el.__v2SparkValues);
    });

    if (initSparklines.bound) return;
    initSparklines.bound = true;
    var timer;
    window.addEventListener('resize', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        $$('.v2-spark').forEach(function (el) {
          if (el.__v2SparkValues) renderSparkline(el, el.__v2SparkValues);
        });
      }, 120);
    });
  }

  function sidebarOpen() {
    var app = document.getElementById('app') || $('.v2-app');
    if (!app) return;
    app.classList.remove('nav-collapsed');
    $$('[data-v2-sidebar-toggle]').forEach(function (btn) { btn.setAttribute('aria-expanded', 'true'); });
    try { localStorage.setItem('sq-v2-sidebar', 'open'); } catch (_) {}
  }

  function sidebarClose() {
    var app = document.getElementById('app') || $('.v2-app');
    if (!app) return;
    app.classList.add('nav-collapsed');
    $$('[data-v2-sidebar-toggle]').forEach(function (btn) { btn.setAttribute('aria-expanded', 'false'); });
    try { localStorage.setItem('sq-v2-sidebar', 'closed'); } catch (_) {}
  }

  function sidebarToggle() {
    var app = document.getElementById('app') || $('.v2-app');
    if (!app) return;
    app.classList.contains('nav-collapsed') ? sidebarOpen() : sidebarClose();
  }

  function initSidebar() {
    $$('[data-v2-sidebar-toggle]').forEach(function (btn) {
      btn.addEventListener('click', function (e) { e.stopPropagation(); sidebarToggle(); });
    });

    var app = document.getElementById('app') || $('.v2-app');
    var saved; try { saved = localStorage.getItem('sq-v2-sidebar'); } catch (_) {}
    if (saved === 'closed') sidebarClose(); else if (app) sidebarOpen();
  }

  /* ======================================================
     TOPBAR SCROLL SHADOW  — adds .is-scrolled to .v2-topbar
     when the in-content region scrolls past 4px
     ====================================================== */
  function initScrollShadow() {
    $$('.v2-content').forEach(function (content) {
      var topbar = $('.v2-topbar');
      if (!topbar) return;
      content.addEventListener('scroll', function () {
        topbar.classList.toggle('is-scrolled', content.scrollTop > 4);
      }, { passive: true });
    });
  }

  /* ======================================================
     STAGGER MOUNT  — triggers .v2-stagger animation when
     the element scrolls into view (IntersectionObserver).
     Skips animation if reduced-motion is active.
     ====================================================== */
  function initStagger() {
    if (prefersReduced()) return;
    if (typeof IntersectionObserver === 'undefined') return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('v2-stagger');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1 });
    $$('[data-v2-stagger]').forEach(function (el) { io.observe(el); });
  }

  /* ======================================================
     THEME TOGGLE BUTTON  — wire all [data-v2-toggle-theme]
     ====================================================== */
  function initThemeToggles() {
    $$('[data-v2-toggle-theme]').forEach(function (btn) {
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

    var existing = $('.v2-tip');
    if (existing) existing.remove();

    var el = document.createElement('div');
    el.className = 'v2-tip' + (opts.kind ? ' v2-tip--' + opts.kind : '');
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
     Any element carrying [data-v2-copy] copies its value (or the text of its
     previous sibling when the attribute is empty). Delegation means buttons
     added or swapped in later keep working without re-initialisation.
     Feedback: .v2-copy--ok + a "Copied" tip + aria-label swap.
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
    if (document.__v2CopyBound) return;
    document.__v2CopyBound = true;

    document.addEventListener('click', function (event) {
      var btn = event.target && event.target.closest
        ? event.target.closest('[data-v2-copy]')
        : null;
      if (!btn) return;

      var text = btn.getAttribute('data-v2-copy');
      if (!text) {
        var prev = btn.previousElementSibling;
        text = prev ? prev.textContent : '';
      }
      text = (text || '').trim();
      if (!text) return;

      var label = btn.getAttribute('data-v2-copy-label') || 'Copied';

      copyToClipboard(text).then(function () {
        var orig = btn.getAttribute('aria-label') || 'Copy';
        btn.setAttribute('aria-label', label);
        btn.classList.add('v2-copy--ok');
        tip(btn, label, { kind: 'ok' });
        setTimeout(function () {
          btn.setAttribute('aria-label', orig);
          btn.classList.remove('v2-copy--ok');
        }, 1800);
      }).catch(function () {
        tip(btn, 'Copy failed', { kind: 'err' });
      });
    });
  }

  function toast(message) {
    var region = $('[data-v2-toast-region]');
    if (!region) {
      region = document.createElement('div');
      region.className = 'v2-toast-region';
      region.setAttribute('data-v2-toast-region', '');
      region.setAttribute('role', 'status');
      region.setAttribute('aria-live', 'polite');
      document.body.appendChild(region);
    }
    var item = document.createElement('div');
    item.className = 'v2-toast';
    item.textContent = message;
    region.appendChild(item);
    window.setTimeout(function () { item.remove(); }, 3200);
  }

  function initProductionControls() {
    $$('[data-v2-toast]').forEach(function (button) {
      button.addEventListener('click', function () { toast(button.getAttribute('data-v2-toast') || button.textContent.trim() + ' complete'); });
    });
    $$('[data-v2-dialog-open]').forEach(function (button) {
      button.addEventListener('click', function () {
        var dialog = document.getElementById(button.getAttribute('data-v2-dialog-open'));
        if (dialog && typeof dialog.showModal === 'function') dialog.showModal();
      });
    });
    $$('[data-v2-dialog-close]').forEach(function (button) {
      button.addEventListener('click', function () { var dialog = button.closest('dialog'); if (dialog) dialog.close(); });
    });
    $$('[data-v2-search-trigger]').forEach(function (button) { button.addEventListener('click', function () { var input = $('[data-v2-search-input]'); if (input) { var dialog = input.closest('dialog'); if (dialog && !dialog.open) dialog.showModal(); input.focus(); } }); });
    document.addEventListener('keydown', function (event) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        var trigger = $('[data-v2-search-trigger]');
        if (trigger) { event.preventDefault(); trigger.click(); }
      }
    });
    $$('[data-v2-search-input]').forEach(function (input) {
      input.addEventListener('input', function () {
        var query = input.value.trim().toLowerCase();
        $$('.v2-command [data-v2-command]').forEach(function (item) { item.hidden = query && !item.textContent.toLowerCase().includes(query); });
      });
    });
    $$('[data-v2-command]').forEach(function (item) {
      item.addEventListener('click', function () {
        var target = item.getAttribute('data-v2-command');
        var dialog = item.closest('dialog');
        if (dialog) dialog.close();
        if (target && target.charAt(0) === '#') {
          var section = document.querySelector(target);
          var content = $('.v2-content');
          if (section && content) {
            // Rect-based math: offsetTop is relative to offsetParent, not the
            // scroll container, and lands on the wrong section.
            var delta = section.getBoundingClientRect().top - content.getBoundingClientRect().top + content.scrollTop - 16;
            content.scrollTo({ top: Math.max(0, delta), behavior: 'smooth' });
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
    var aside = $('.v2-aside');
    if (!aside) return;
    var nav = $('.v2-nav', aside);
    if (!nav) return;
    if (nav.getAttribute('data-v2-dock-ready') === 'true') {
      // Re-scan after dynamic nav changes (new destinations added/removed)
      if (typeof nav.__v2DockRefresh === 'function') nav.__v2DockRefresh();
      return;
    }
    nav.setAttribute('data-v2-dock-ready', 'true');

    var isActive = function (el) {
      return el.classList.contains('is-active') || el.classList.contains('v2-nav__item--active');
    };
    var navItems = function () { return $$('.v2-nav__item', nav); };
    var overflowing = function () { return nav.scrollWidth - nav.clientWidth > 1; };

    /* ---- More trigger + drop-up shell ---- */
    var more = document.createElement('button');
    more.type = 'button';
    more.className = 'v2-nav__more';
    more.hidden = true;
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    more.setAttribute('aria-label', 'More navigation items');
    more.innerHTML = '<svg class="v2-icon v2-icon--18" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg><span aria-hidden="true">More</span>';

    var menu = document.createElement('div');
    menu.className = 'v2-nav__menu';
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
        clone.classList.remove('v2-nav__item');
        clone.classList.remove('v2-nav__item--active');
        clone.classList.remove('is-active');
        clone.classList.add('v2-nav__menu-item');
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
    document.addEventListener('v2:navchange', function (e) {
      var item = e.detail && e.detail.item;
      if (item) ensureVisible(item);
      updateOverflow();
      if (!menu.hidden) openMenu();
    });

    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(function () { updateOverflow(); }).observe(nav);
    }
    window.addEventListener('resize', updateOverflow);

    nav.__v2DockRefresh = function () {
      updateOverflow();
      ensureVisible(nav.querySelector('.is-active, .v2-nav__item--active'));
    };

    requestAnimationFrame(function () {
      updateOverflow();
      ensureVisible(nav.querySelector('.is-active, .v2-nav__item--active'));
    });
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () {
        updateOverflow();
        ensureVisible(nav.querySelector('.is-active, .v2-nav__item--active'));
      });
    }
  }

  /* ======================================================
     NAV SCROLL & SCROLL-SPY
     - Click nav item → smooth scroll to target section
     - Scroll-spy: highlight nav item when section in view
     Uses getBoundingClientRect for accurate scroll detection
     inside any scrollable container (.v2-content).
     ====================================================== */

  /* ======================================================
     SECTION SCROLL — shared by nav clicks and #deep links
     scrollToSection('logs') / scrollToSection('#logs')
     ====================================================== */
  function scrollToSection(id, opts) {
    var content = $('.v2-content');
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
    var content = $('.v2-content');
    if (!content) return;
    if (content.dataset.v2NavReady === 'true') return;
    content.dataset.v2NavReady = 'true';

    // Build map of nav items → sections via href="#id"
    var navItems = $$('.v2-nav__item[href^="#"]');
    var sections = [];
    var app = document.getElementById('app') || $('.v2-app');

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
            n.classList.remove('is-active', 'v2-nav__item--active');
            n.removeAttribute('aria-current');
          });
          item.classList.add('is-active', 'v2-nav__item--active');
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
        pair.item.classList.toggle('v2-nav__item--active', active);
        if (active) {
          pair.item.setAttribute('aria-current', 'page');
          activeItem = pair.item;
        }
        else        pair.item.removeAttribute('aria-current');
      });

      // Let the dock keep the active item in view / sync the More drop-up
      if (activeItem && activeItem !== lastActiveItem) {
        lastActiveItem = activeItem;
        document.dispatchEvent(new CustomEvent('v2:navchange', { detail: { item: activeItem } }));
      }
    }

    content.addEventListener('scroll', updateActive, { passive: true });
    // Run once on init to set correct initial state
    updateActive();
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
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* ======================================================
     PUBLIC API
     ====================================================== */
  global.SynteqV2 = {
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
    toast:           toast,
    tip:             tip,
    // Navigation
    scrollToSection: scrollToSection,
    // Init helpers (call after dynamic content changes)
    initGauges:      initGauges,
    initSparklines:  initSparklines,
    initNavDock:     initNavDock,
    initNavScroll:   initNavScroll,
  };

})(window);
