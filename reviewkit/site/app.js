/* review-kit site. Vanilla JS, no dependencies, works offline and from file://. Data: window.REVIEW (data.js). */
(function () {
  'use strict';
  var D = window.REVIEW;
  var app = document.getElementById('app');
  if (!D) { app.innerHTML = '<p>data.js is missing. Run <code>review-kit build</code>.</p>'; return; }
  var wide = window.matchMedia('(min-width: 820px)');
  var P = D.project;

  // ------------------------------------------------------------ model
  var PLATS = D.platforms.map(function (p) { return p.id; });
  var PL = {}; D.platforms.forEach(function (p) { PL[p.id] = p; });
  var MULTI = PLATS.length > 1;
  var SEVS = D.severities.map(function (s) { return s.id; });
  var SEV = {}; D.severities.forEach(function (s) { SEV[s.id] = s; });
  var STATUS = ['open', 'partial', 'fixed', 'notabug', 'wontfix'];
  var RESOLVED = { fixed: 1, notabug: 1, wontfix: 1 };
  var SNAME = D.statusLabels;
  var AREA = {}; D.areas.forEach(function (a) { AREA[a.id] = a; });
  var FIX = {}; D.fixes.forEach(function (f) { FIX[f.id] = f; });
  var ALL = D.issues;
  var BYID = {};
  ALL.forEach(function (it, i) {
    it.idx = i; BYID[it.id] = it;
    it.search = [it.id, it.title, plain(it.html), plain(it.note), plain(it.where), areaTitle(it), (it.tags || []).join(' ')].join(' ').toLowerCase();
  });
  var USED_ST = STATUS.filter(function (s) { return s === 'open' || s === 'partial' || s === 'fixed' || ALL.some(function (it) { return it.status === s; }); });
  var HAS_UNRANKED = ALL.some(function (it) { return !it.sev; });
  var HAS_SUMMARY = ALL.some(function (it) { return !it.counted; });

  // ------------------------------------------------------------ utils
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function plain(html) { if (!html) return ''; var d = document.createElement('div'); d.innerHTML = html; return d.textContent || ''; }
  var NS = 'rk.' + P.name + '.';
  function store(k, v) { try { if (v === undefined) return JSON.parse(localStorage.getItem(NS + k)); localStorage.setItem(NS + k, JSON.stringify(v)); } catch (e) { return null; } }
  function sevTag(sev) { var s = SEV[sev]; return s ? '<span class="tag ' + s.cls + '" title="' + esc(s.desc) + '">' + esc(s.label) + '</span>' : '<span class="tag NA" title="Unranked">—</span>'; }
  function stTag(st) { return '<span class="st st-' + st + '">' + esc(SNAME[st] || st) + '</span>'; }
  function plTag(p) { return MULTI ? '<span class="badge-pl">' + esc((PL[p] || { label: p }).label).toUpperCase() + '</span>' : ''; }
  function areaTitle(it) { var a = AREA[it.area]; return a ? (a.num ? a.num + '. ' : '') + a.title : (it.area || ''); }
  function seg(name, opts, cur, cls) {
    return '<div class="seg ' + (cls || '') + '" data-seg="' + name + '" role="group">' + opts.map(function (o) {
      return '<button type="button" data-v="' + esc(o[0]) + '"' + (o[0] === cur ? ' class="on" aria-pressed="true"' : ' aria-pressed="false"') + (o[2] ? ' disabled' : '') + '>' + esc(o[1]) + '</button>';
    }).join('') + '</div>';
  }
  function dateKey(s) { var t = Date.parse(s || ''); return isNaN(t) ? 0 : t; }
  function pct(n, d) { return d ? 100 * n / d : 0; }

  // ------------------------------------------------------------ theme
  (function theme() {
    function hex(c) { c = c.replace('#', ''); if (c.length === 3) c = c.replace(/./g, '$&$&'); return [0, 2, 4].map(function (i) { return parseInt(c.substr(i, 2), 16); }); }
    function mix(c, w, t) { return 'rgb(' + c.map(function (v, i) { return Math.round(v + (w[i] - v) * t); }).join(',') + ')'; }
    function lum(c) { return c.map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }).reduce(function (a, v, i) { return a + v * [0.2126, 0.7152, 0.0722][i]; }, 0); }
    var a = hex(P.theme.accent);
    var light = lum(a) > 0.45;
    var brandLight = light ? mix(a, [0, 0, 0], 0.45) : P.theme.accent;
    var brandDark = P.theme.accentDark || (lum(a) < 0.25 ? mix(a, [255, 255, 255], 0.55) : P.theme.accent);
    var css = ':root{--accent:' + P.theme.accent + ';--brand:' + brandLight + ';--on-accent:' + (light ? '#13232a' : '#fff') + '}' +
      '@media (prefers-color-scheme: dark){:root{--brand:' + brandDark + '}}';
    D.severities.forEach(function (s) {
      var dark = lum(hex(s.color)) > 0.5;
      var sels = ['.tag.' + s.cls];
      if (/^[A-Za-z_-][A-Za-z0-9_-]*$/.test(s.id)) sels.push('.tag.' + s.id); // tags embedded in HTML content, e.g. <span class="tag P0">
      css += sels.join(',') + '{background:' + s.color + (dark ? ';color:#13232a' : '') + '}';
      css += '.chip.on.' + s.cls + '{background:' + s.color + ';border-color:' + s.color + ';color:' + (dark ? '#13232a' : '#fff') + '}';
      css += '.issue.s-open.v-' + s.cls + '{border-left-color:' + s.color + '}';
    });
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    document.getElementById('logo').textContent = P.theme.logoText;
    document.getElementById('brand').innerHTML = '<b>' + esc(P.name) + '</b> ' + esc(P.title);
  })();

  function sortIssues(a, b) {
    var R = { open: 0, partial: 1, fixed: 2, notabug: 3, wontfix: 4 };
    function sr(s) { var i = SEVS.indexOf(s); return i < 0 ? SEVS.length : i; }
    return R[a.status] - R[b.status] || sr(a.sev) - sr(b.sev) || PLATS.indexOf(a.platform) - PLATS.indexOf(b.platform) || a.idx - b.idx;
  }

  // ------------------------------------------------------------ tabs / routing
  var VIEWS = [['overview', 'Overview', '◎'], ['fixes', 'Fixes', '✓'], ['issues', 'Issues', '☰'], ['plan', 'Plan', '▤']].filter(function (v) {
    return v[0] === 'overview' || (v[0] === 'fixes' && D.fixes.length) || (v[0] === 'issues' && ALL.length) || (v[0] === 'plan' && (D.plan.length || D.appendix.length));
  });
  if (VIEWS.length < 2) document.body.classList.add('no-bottom');
  function renderTabs(cur) {
    function link(v, ic) { return '<a href="#/' + v[0] + '"' + (v[0] === cur ? ' class="on" aria-current="page"' : '') + '>' + (ic ? '<span class="ic" aria-hidden="true">' + v[2] + '</span>' : '') + v[1] + '</a>'; }
    document.getElementById('tabs-top').innerHTML = VIEWS.length > 1 ? VIEWS.map(function (v) { return link(v, false); }).join('') : '';
    document.getElementById('tabs-bottom').innerHTML = VIEWS.length > 1 ? VIEWS.map(function (v) { return link(v, true); }).join('') : '';
  }
  function route() {
    var parts = location.hash.replace(/^#\/?/, '').split('/');
    var view = VIEWS.some(function (v) { return v[0] === parts[0]; }) ? parts[0] : 'overview';
    renderTabs(view);
    ({ overview: viewOverview, fixes: viewFixes, issues: viewIssues, plan: viewPlan })[view](parts.slice(1).map(decodeURIComponent));
  }
  window.addEventListener('hashchange', function () { if (!lb.ignoreHash) { route(); window.scrollTo(0, 0); } });

  // ------------------------------------------------------------ overview
  function counts(list) {
    var c = { total: list.length, sev: {} };
    STATUS.forEach(function (s) { c[s] = 0; });
    SEVS.concat(['none']).forEach(function (s) { c.sev[s] = { total: 0 }; STATUS.forEach(function (x) { c.sev[s][x] = 0; }); });
    list.forEach(function (it) { c[it.status]++; var s = c.sev[SEV[it.sev] ? it.sev : 'none']; s.total++; s[it.status]++; });
    return c;
  }
  function resolved(c) { return c.fixed + c.notabug + c.wontfix; }
  function bar(c, cls) {
    var t = c.total || 1;
    return '<div class="bar ' + (cls || '') + '" role="img" aria-label="' + c.fixed + ' fixed, ' + c.partial + ' partly fixed, ' + c.open + ' open">' +
      '<i class="f" style="width:' + pct(c.fixed, t) + '%"></i><i class="n" style="width:' + pct(c.notabug, t) + '%"></i><i class="w" style="width:' + pct(c.wontfix, t) + '%"></i><i class="p" style="width:' + pct(c.partial, t) + '%"></i></div>';
  }
  function frac(x) { return resolved(x) + (x.partial ? ' + ' + x.partial + '◐' : '') + ' / ' + x.total; }
  function progressCard(title, list, sub) {
    var c = counts(list);
    var other = c.notabug + c.wontfix;
    var rows = SEVS.map(function (s) {
      var x = c.sev[s];
      return x.total ? '<div class="sevrow">' + sevTag(s) + bar(x, 'sm') + '<span class="cnt">' + frac(x) + '</span></div>' : '';
    }).join('');
    if (c.sev.none.total) rows += '<div class="sevrow"><span class="tag NA" title="No severity (e.g. root causes)">—</span>' + bar(c.sev.none, 'sm') + '<span class="cnt">' + frac(c.sev.none) + '</span></div>';
    return '<section class="card"><h2>' + title + '</h2>' + (sub ? '<div class="small">' + sub + '</div>' : '') +
      '<div class="stats"><div class="stat fixed"><b>' + resolved(c) + '</b><span>' + (other ? 'Resolved' : 'Fixed') + '</span></div><div class="stat partial"><b>' + c.partial + '</b><span>Partly fixed</span></div><div class="stat open"><b>' + c.open + '</b><span>Open</span></div></div>' +
      bar(c) + '<div class="legend"><span><i style="background:var(--fixed)"></i>Fixed' + (other ? ' ' + c.fixed : '') + '</span>' +
      (c.notabug ? '<span><i style="background:var(--notabug)"></i>Not a bug ' + c.notabug + '</span>' : '') +
      (c.wontfix ? '<span><i style="background:var(--wontfix)"></i>Won\'t fix ' + c.wontfix + '</span>' : '') +
      '<span><i style="background:var(--partial)"></i>Partly fixed</span><span><i style="background:var(--chip)"></i>Open</span><span>' + Math.round(pct(resolved(c) + c.partial / 2, c.total || 1)) + '% done</span></div>' +
      rows + '</section>';
  }
  function issueRow(it) {
    return '<li class="toprow">' + sevTag(it.sev) + '<div class="t"><a class="row" href="#/issues/' + encodeURIComponent(it.id) + '"><div class="lf-title' + (RESOLVED[it.status] ? ' struck' : '') + '">' + esc(it.title) + '</div></a><div class="lf-meta">' + stTag(it.status) + ' ' + plTag(it.platform) + (areaTitle(it) ? ' · ' + esc(areaTitle(it)) : '') + '</div></div></li>';
  }
  function fixPlatsLabel(x) { return PLATS.filter(function (p) { return x.platforms[p]; }).map(function (p) { return PL[p].label; }).join(' + '); }
  function newestFixes() { return D.fixes.slice().sort(function (a, b) { return dateKey(b.date) - dateKey(a.date) || b.order - a.order; }); }
  function viewOverview() {
    var counted = ALL.filter(function (it) { return it.counted; });
    var html = '<h1 class="view-title">Overview</h1>' + (P.desc ? '<div class="intro">' + P.desc + '</div>' : '');
    var meta = [counted.length + ' issue' + (counted.length === 1 ? '' : 's') + (MULTI ? ' across ' + PLATS.length + ' platforms' : ''), D.fixes.length + ' fix' + (D.fixes.length === 1 ? '' : 'es')];
    if (P.date) meta.push('review date ' + esc(P.date));
    meta.push('updated ' + esc(D.generated));
    if (P.repo) meta.push(/^https?:/.test(P.repo) ? '<a href="' + esc(P.repo) + '">repository</a>' : '<code>' + esc(P.repo) + '</code>');
    html += progressCard(MULTI ? 'All issues' : 'Issues', counted, meta.join(' · '));
    if (MULTI) {
      var cards = PLATS.map(function (p) {
        var l = counted.filter(function (it) { return it.platform === p; });
        return l.length ? progressCard(esc(PL[p].label), l, '<a href="#/issues" data-goto-plat="' + esc(p) + '">' + l.length + ' issues</a>' + (PL[p].desc ? ' · ' + esc(PL[p].desc) : '')) : '';
      }).filter(Boolean);
      if (cards.length) html += '<div class="grid2">' + cards.join('') + '</div>';
    }
    if (P.links.length) {
      html += '<section class="card"><h2>Links</h2><div class="links">' + P.links.map(function (l, i) {
        return '<a class="btn' + (i < 2 ? ' primary' : '') + '" href="' + esc(l.href) + '"' + (/^https?:/.test(l.href) ? ' target="_blank" rel="noopener"' : '') + '>' + (l.kind === 'pdf' ? '⇩ ' : '') + esc(l.label) + '</a>';
      }).join('') + '</div></section>';
    }
    var left = counted.filter(function (it) { return it.status === 'open' || it.status === 'partial'; }).sort(function (a, b) {
      function sr(s) { var i = SEVS.indexOf(s); return i < 0 ? SEVS.length : i; }
      return sr(a.sev) - sr(b.sev) || (a.status === 'partial' ? -1 : 0) - (b.status === 'partial' ? -1 : 0) || a.idx - b.idx;
    });
    var second = [];
    if (D.fixes.length) {
      second.push('<section class="card"><h2>Latest fixes</h2><ul class="list">' + newestFixes().slice(0, 4).map(function (x) {
        var pl = fixPlatsLabel(x), n = 0;
        PLATS.forEach(function (p) { if (x.platforms[p]) n += x.platforms[p].pairs.length; });
        return '<li><a class="row" href="#/fixes/' + encodeURIComponent(x.id) + '"><div class="lf-title">' + (x.num != null ? '<span class="fix-num">' + x.num + '</span>' : '') + esc(x.title) + '</div><div class="lf-meta">' +
          [x.date ? esc(x.date) : '', MULTI ? esc(pl) : '', n ? n + ' before / after ›' : 'details ›'].filter(Boolean).join(' · ') + '</div></a></li>';
      }).join('') + '</ul><p style="margin:10px 0 0"><a class="btn" href="#/fixes">All ' + D.fixes.length + ' fixes</a></p></section>');
    }
    if (counted.length) second.push('<section class="card"><h2>What\'s left</h2>' + (left.length ? '<div class="small">' + left.length + ' open or partly fixed, most severe first</div><ul class="list" style="margin-top:8px">' + left.slice(0, 6).map(issueRow).join('') + '</ul>' +
      '<p style="margin:10px 0 0"><a class="btn" href="#/issues" data-goto-open="1">All ' + left.length + ' open issues</a></p>' : '<p class="small">Nothing open. Every issue is resolved.</p>') + '</section>');
    html += second.length > 1 ? '<div class="grid2">' + second.join('') + '</div>' : second.join('');
    var tops = PLATS.map(function (p) {
      var top = ALL.filter(function (it) { return it.top && it.platform === p; }).sort(function (a, b) { return (a.rank == null ? 1e9 : a.rank) - (b.rank == null ? 1e9 : b.rank) || a.idx - b.idx; });
      return top.length ? '<section class="card"><h2>' + (MULTI ? esc(PL[p].label) + ': top' : 'Top') + ' issues, ranked</h2><ul class="list">' + top.map(issueRow).join('') + '</ul></section>' : '';
    }).filter(Boolean);
    if (tops.length) html += tops.length > 1 ? '<div class="grid2">' + tops.join('') + '</div>' : tops[0];
    if (D.plan.length) {
      var items = [];
      D.plan.forEach(function (g) { items = items.concat(g.items); });
      if (items.length) {
        var done = items.filter(function (i) { return i.status === 'done'; }).length, part = items.filter(function (i) { return i.status === 'partial' || i.status === 'doing'; }).length;
        html += '<section class="card"><h2>Plan</h2><div class="small">' + done + ' of ' + items.length + ' items done' + (part ? ', ' + part + ' in progress or partly done' : '') + '</div><div style="margin:10px 0">' +
          bar({ total: items.length, fixed: done, partial: part, open: items.length - done - part, notabug: 0, wontfix: items.filter(function (i) { return i.status === 'dropped'; }).length }) +
          '</div><a class="btn" href="#/plan">Open the plan</a></section>';
      }
    }
    app.innerHTML = html;
    app.querySelectorAll('[data-goto-plat]').forEach(function (a) {
      a.addEventListener('click', function () { var f = loadFilters(); f.plat = a.getAttribute('data-goto-plat'); store('filters', f); });
    });
    app.querySelectorAll('[data-goto-open]').forEach(function (a) {
      a.addEventListener('click', function () { var f = defaultFilters(); f.st = ['open', 'partial']; store('filters', f); });
    });
  }

  // ------------------------------------------------------------ fixes
  var cmpMode = store('cmpMode');
  function defaultMode() { return cmpMode || (wide.matches ? 'side' : 'slider'); }
  function capOf(f) { return f.cap || ''; }
  function figHtml(f, label, cls) {
    return '<figure class="fig"><img loading="lazy" src="' + esc(f.src) + '" alt="' + esc(f.alt || label || 'Screenshot') + '" data-lb="1"' + (f.w ? ' width="' + f.w + '" height="' + f.h + '" style="height:auto"' : '') + '><figcaption>' + (label ? '<span class="' + cls + '">' + label + '</span> ' : '') + capOf(f) + '</figcaption></figure>';
  }
  function pairHtml(p, mode) {
    var shared = p.cap ? '<div class="caps"><p>' + p.cap + '</p></div>' : '';
    if (!p.before || !p.after) {
      var f = p.before || p.after;
      return '<div class="pair">' + figHtml(f, p.before ? 'BEFORE' : 'AFTER', p.before ? 'ba-before' : 'ba-after') + shared + '</div>';
    }
    if (mode === 'side') {
      return '<div class="pair"><div class="side">' + figHtml(p.before, 'BEFORE', 'ba-before') + figHtml(p.after, 'AFTER', 'ba-after') + '</div>' + shared + '</div>';
    }
    return '<div class="pair"><div class="cmp mode-' + mode + '" style="--x:50%" tabindex="0" role="slider" aria-label="Before / after comparison" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50">' +
      '<img class="before" src="' + esc(p.before.src) + '" alt="Before" loading="lazy"><img class="after" src="' + esc(p.after.src) + '" alt="After" loading="lazy">' +
      '<div class="handle"></div><span class="lbl b">BEFORE</span><span class="lbl a">AFTER</span>' +
      '<button type="button" class="zoom" aria-label="View full size">⤢</button></div>' +
      '<div class="hint">' + (mode === 'slider' ? 'Drag across the image (or use ← →) to compare.' : 'Tap the image (or press Space) to switch before / after.') + ' ⤢ opens full size.</div>' +
      '<div class="caps">' + (p.cap ? '<p>' + p.cap + '</p>' : '') + (capOf(p.before) ? '<p><span class="ba-before">BEFORE</span> ' + capOf(p.before) + '</p>' : '') + (capOf(p.after) ? '<p><span class="ba-after">AFTER</span> ' + capOf(p.after) + '</p>' : '') + '</div></div>';
  }
  function fixBody(fix, plat, mode) {
    var d = fix.platforms[plat];
    if (!d) return Object.keys(fix.platforms).length ? '<div class="noplat">No ' + esc(PL[plat] ? PL[plat].label.toLowerCase() : plat) + ' screenshots for this fix.</div>' : '';
    return (d.desc ? '<div class="fix-desc">' + d.desc + '</div>' : '') + '<div class="fix-body">' +
      d.pairs.map(function (p) { return pairHtml(p, mode); }).join('') +
      (d.other.length ? '<div class="side">' + d.other.map(function (f) { return figHtml(f, '', ''); }).join('') + '</div>' : '') +
      '</div>';
  }
  function issueChip(id) {
    var it = BYID[id];
    if (!it) return '<span class="ichip">' + esc(id) + '</span>';
    return '<a class="ichip" href="#/issues/' + encodeURIComponent(id) + '" title="' + esc(it.title) + '">' + sevTag(it.sev) + '<span class="t' + (RESOLVED[it.status] ? ' struck' : '') + '">' + esc(it.title) + '</span></a>';
  }
  function fixDetails(fix) {
    var parts = [];
    if (fix.summary) parts.push('<div>' + fix.summary + '</div>');
    if (fix.files.length) parts.push('<div class="files">Files: ' + fix.files.map(function (f) { return '<code>' + esc(f) + '</code>'; }).join(' ') + '</div>');
    if (fix.commits.length) parts.push('<div class="files">Commits: ' + fix.commits.map(function (c) { var t = '<code>' + esc(c.sha.slice(0, 10)) + '</code>' + (c.message ? ' ' + esc(c.message) : ''); return c.url ? '<a href="' + esc(c.url) + '">' + t + '</a>' : t; }).join(', ') + '</div>');
    if (fix.links.length) parts.push('<div class="files">' + fix.links.map(function (l) { return '<a href="' + esc(l.href) + '">' + esc(l.label) + '</a>'; }).join(' · ') + '</div>');
    if (!parts.length) return '';
    var open = !Object.keys(fix.platforms).length;
    return '<details class="fix-log"' + (open ? ' open' : '') + '><summary>What changed' + (fix.date ? ' · ' + esc(fix.date) : '') + '</summary>' + parts.join('') + '</details>';
  }
  function hasFullPair(fix) { return Object.keys(fix.platforms).some(function (p) { return fix.platforms[p].pairs.some(function (x) { return x.before && x.after; }); }); }
  function viewFixes(args) {
    var pref = store('fixPlat') || PLATS[0];
    var fixes = newestFixes();
    app.innerHTML = '<h1 class="view-title">Fixes <span class="small">' + D.fixes.length + ' shipped · newest first</span></h1>' + fixes.map(function (fix) {
      var avail = PLATS.filter(function (p) { return fix.platforms[p]; });
      var plat = fix.platforms[pref] ? pref : avail[0] || pref;
      var ctl = (MULTI && avail.length ? seg('plat', PLATS.map(function (p) { return [p, PL[p].label, !fix.platforms[p]]; }), plat) : '') +
        (hasFullPair(fix) ? seg('mode', [['slider', 'Slider'], ['flip', 'Tap'], ['side', 'Side by side']], defaultMode(), 'sm') : '');
      var meta = [fix.date ? esc(fix.date) : '', MULTI && avail.length ? esc(fixPlatsLabel(fix)) : ''].filter(Boolean).join(' · ');
      return '<article class="card fixcard' + (PL[plat] && PL[plat].shape === 'portrait' ? ' portrait' : '') + '" id="fix-' + esc(fix.id) + '" data-id="' + esc(fix.id) + '" data-plat="' + esc(plat) + '">' +
        '<div class="fix-head"><h2>' + (fix.num != null ? '<span class="fix-num">' + fix.num + '</span>' : '') + esc(fix.title) + '</h2>' + (meta ? '<div class="fix-meta">' + meta + '</div>' : '') + '</div>' +
        (ctl ? '<div class="fix-ctl">' + ctl + '</div>' : '') +
        (fix.issues.length ? '<div class="resolves">Addresses ' + fix.issues.map(issueChip).join('') + '</div>' : '') +
        '<div class="fb">' + fixBody(fix, plat, defaultMode()) + '</div>' + fixDetails(fix) + '</article>';
    }).join('');
    app.querySelectorAll('.fixcard').forEach(wireFixCard);
    if (args[0]) {
      var c = document.getElementById('fix-' + args[0]);
      if (c) setTimeout(function () { c.scrollIntoView({ block: 'start' }); window.scrollBy(0, -64); }, 30);
    }
  }
  function wireFixCard(card) {
    var fix = FIX[card.getAttribute('data-id')];
    function rerender() {
      var plat = card.getAttribute('data-plat');
      var m = card.querySelector('[data-seg=mode] .on');
      card.classList.toggle('portrait', !!(PL[plat] && PL[plat].shape === 'portrait'));
      card.querySelector('.fb').innerHTML = fixBody(fix, plat, m ? m.getAttribute('data-v') : defaultMode());
      wireBody();
    }
    function wireBody() {
      card.querySelectorAll('.cmp').forEach(wireCmp);
      var imgs = Array.prototype.slice.call(card.querySelectorAll('.fb img[data-lb]'));
      imgs.forEach(function (img, i) { img.addEventListener('click', function () { lb.open(imgs.map(imgItem), i); }); });
    }
    card.querySelectorAll('[data-seg]').forEach(function (s) {
      s.addEventListener('click', function (e) {
        var b = e.target.closest('button'); if (!b || b.disabled) return;
        s.querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', x === b); });
        if (s.getAttribute('data-seg') === 'plat') { card.setAttribute('data-plat', b.getAttribute('data-v')); store('fixPlat', b.getAttribute('data-v')); }
        else { cmpMode = b.getAttribute('data-v'); store('cmpMode', cmpMode); }
        rerender();
      });
    });
    wireBody();
  }
  function imgItem(img) {
    var cap = img.closest('figure').querySelector('figcaption');
    var lab = cap && cap.querySelector('.ba-before') ? 'b' : cap && cap.querySelector('.ba-after') ? 'a' : '';
    return { src: img.getAttribute('src'), cap: cap ? cap.innerHTML : '', label: lab };
  }
  function wireCmp(cmp) {
    var start = null, dragging = false;
    var caps = cmp.closest('.pair').querySelectorAll('.caps p');
    function capFor(cls) { for (var i = 0; i < caps.length; i++) if (caps[i].querySelector('.' + cls)) return caps[i].innerHTML; return ''; }
    var items = [
      { src: cmp.querySelector('.before').getAttribute('src'), cap: capFor('ba-before'), label: 'b' },
      { src: cmp.querySelector('.after').getAttribute('src'), cap: capFor('ba-after'), label: 'a' }
    ];
    cmp.querySelector('.zoom').addEventListener('click', function (e) {
      e.stopPropagation();
      lb.open(items, cmp.classList.contains('mode-flip') && cmp.classList.contains('show-before') ? 0 : 1);
    });
    function setPct(x) { x = Math.max(0, Math.min(100, x)); cmp.style.setProperty('--x', x + '%'); cmp.setAttribute('aria-valuenow', Math.round(x)); }
    function setX(clientX) { var r = cmp.getBoundingClientRect(); setPct(100 * (clientX - r.left) / r.width); }
    cmp.addEventListener('keydown', function (e) {
      if (cmp.classList.contains('mode-flip')) { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); cmp.classList.toggle('show-before'); } return; }
      var cur = parseFloat(cmp.style.getPropertyValue('--x')) || 50;
      if (e.key === 'ArrowLeft') { e.preventDefault(); setPct(cur - 5); } else if (e.key === 'ArrowRight') { e.preventDefault(); setPct(cur + 5); }
    });
    cmp.addEventListener('pointerdown', function (e) {
      if (e.target.closest('.zoom')) return;
      start = { x: e.clientX, y: e.clientY, id: e.pointerId };
      dragging = false;
      if (e.pointerType === 'mouse' && cmp.classList.contains('mode-slider')) { dragging = true; setX(e.clientX); cmp.setPointerCapture(e.pointerId); }
    });
    cmp.addEventListener('pointermove', function (e) {
      if (!start || e.pointerId !== start.id || !cmp.classList.contains('mode-slider')) return;
      var dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (!dragging && Math.abs(dx) > 6 && Math.abs(dx) > Math.abs(dy)) { dragging = true; try { cmp.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
      if (dragging) { e.preventDefault(); setX(e.clientX); }
    });
    function end(e) {
      if (!start || e.pointerId !== start.id) return;
      var moved = Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y);
      if (e.type === 'pointerup' && moved < 8) {
        if (cmp.classList.contains('mode-flip')) cmp.classList.toggle('show-before');
        else setX(e.clientX);
      }
      start = null; dragging = false;
    }
    cmp.addEventListener('pointerup', end);
    cmp.addEventListener('pointercancel', end);
    cmp.addEventListener('touchmove', function (e) { if (dragging) e.preventDefault(); }, { passive: false });
  }

  // ------------------------------------------------------------ issues
  function defaultFilters() { return { plat: 'all', sev: [], st: [], area: '', q: '', src: 'counted' }; }
  function loadFilters() {
    var f = store('filters') || {}, d = defaultFilters();
    Object.keys(d).forEach(function (k) { if (f[k] === undefined) f[k] = d[k]; });
    if (!MULTI) f.plat = 'all';
    return f;
  }
  function chips(key, opts, cur, multi) {
    return opts.map(function (o) {
      var on = multi ? cur.indexOf(o[0]) >= 0 : cur === o[0];
      return '<button type="button" class="chip ' + (o[2] || '') + (on ? ' on' : '') + '" data-f="' + key + '" data-v="' + esc(o[0]) + '" aria-pressed="' + on + '">' + esc(o[1]) + '</button>';
    }).join('');
  }
  function viewIssues(args) {
    var f = loadFilters();
    var focus = args[0] && BYID[args[0]] ? args[0] : null;
    var panelOpen = wide.matches || store('fpanel') === true;
    var sevOpts = SEVS.map(function (s) { return [s, SEV[s].label, SEV[s].cls]; });
    if (HAS_UNRANKED) sevOpts.push(['none', 'Unranked']);
    app.innerHTML = '<h1 class="view-title">Issues</h1>' +
      '<div class="filters"><div class="search"><input type="search" id="q" placeholder="Search issues…" aria-label="Search issues" value="' + esc(f.q) + '" autocomplete="off"><button type="button" class="btn" id="ftoggle" aria-expanded="' + panelOpen + '" aria-controls="fpanel">Filters<span id="fcount"></span></button></div>' +
      '<div class="fpanel' + (panelOpen ? ' open' : '') + '" id="fpanel">' +
      (MULTI ? '<div class="frow"><label class="k">Platform</label>' + chips('plat', [['all', 'All']].concat(PLATS.map(function (p) { return [p, PL[p].label]; })), f.plat) + '</div>' : '') +
      '<div class="frow"><label class="k">Severity</label>' + chips('sev', sevOpts, f.sev, true) + '</div>' +
      '<div class="frow"><label class="k">Status</label>' + chips('st', USED_ST.map(function (s) { return [s, SNAME[s], 'st-chip-' + s]; }), f.st, true) + '</div>' +
      (HAS_SUMMARY ? '<div class="frow"><label class="k">Source</label>' + chips('src', [['counted', 'Findings'], ['summary', 'Summary rows'], ['all', 'Both']], f.src) + '</div>' : '') +
      (D.areas.length || ALL.some(function (it) { return it.area; }) ? '<div class="frow' + (MULTI && !HAS_SUMMARY ? '' : ' wide') + '"><label class="k" for="area">Area / page</label><select id="area"></select></div>' : '') +
      '</div></div>' +
      '<div class="resinfo"><span id="rcount" aria-live="polite"></span><button type="button" class="linkbtn" id="freset">Reset filters</button></div><div id="ilist"></div>';
    var list = document.getElementById('ilist');
    var sel = document.getElementById('area');
    function save() { store('filters', f); }
    function fillAreas() {
      if (!sel) return;
      var html = '<option value="">All areas</option>';
      function opts(filter) {
        var seen = {};
        var out = '';
        ALL.forEach(function (it) {
          if (!it.area || seen[it.area] || !filter(it)) return;
          seen[it.area] = 1;
          out += '<option value="' + esc(it.area) + '"' + (f.area === it.area ? ' selected' : '') + '>' + esc(areaTitle(it)) + '</option>';
        });
        return out;
      }
      if (MULTI) {
        PLATS.forEach(function (p) {
          if (f.plat !== 'all' && f.plat !== p) return;
          var o = opts(function (it) { return it.platform === p; });
          if (o) html += '<optgroup label="' + esc(PL[p].label) + '">' + o + '</optgroup>';
        });
      } else html += opts(function () { return true; });
      sel.innerHTML = html;
      if (f.area && sel.value !== f.area) { f.area = ''; sel.value = ''; }
    }
    function match(it) {
      if (f.plat !== 'all' && it.platform !== f.plat) return false;
      if (f.sev.length && f.sev.indexOf(SEV[it.sev] ? it.sev : 'none') < 0) return false;
      if (f.st.length && f.st.indexOf(it.status) < 0) return false;
      if (f.area && it.area !== f.area) return false;
      if (f.src === 'counted' && !it.counted) return false;
      if (f.src === 'summary' && it.counted) return false;
      if (f.q) { var words = f.q.toLowerCase().split(/\s+/).filter(Boolean); for (var i = 0; i < words.length; i++) if (it.search.indexOf(words[i]) < 0) return false; }
      return true;
    }
    function render() {
      var items = ALL.filter(function (it) { return focus ? it.id === focus : match(it); }).sort(sortIssues);
      var n = (f.plat !== 'all') + f.sev.length + f.st.length + !!f.area + (f.src !== 'counted');
      document.getElementById('fcount').textContent = n ? ' (' + n + ')' : '';
      var c = counts(items);
      document.getElementById('rcount').textContent = focus ? 'Showing one issue' : items.length + ' issues · ' + c.open + ' open · ' + c.partial + ' partly · ' + resolved(c) + ' resolved';
      document.getElementById('freset').textContent = focus ? 'Show all issues' : 'Reset filters';
      list.innerHTML = items.length ? items.map(issueHtml).join('') : '<div class="empty">No issues match these filters.</div>';
      if (focus) { var only = list.querySelector('.issue'); if (only) toggleIssue(only); }
    }
    app.querySelector('.filters').addEventListener('click', function (e) {
      var b = e.target.closest('[data-f]'); if (!b) return;
      var k = b.getAttribute('data-f'), v = b.getAttribute('data-v');
      focus = null;
      if (k === 'plat' || k === 'src') {
        f[k] = v;
        b.parentNode.querySelectorAll('.chip').forEach(function (x) { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', x === b); });
        if (k === 'plat') fillAreas();
      } else {
        var i = f[k].indexOf(v); if (i >= 0) f[k].splice(i, 1); else f[k].push(v);
        b.classList.toggle('on'); b.setAttribute('aria-pressed', b.classList.contains('on'));
      }
      save(); render();
    });
    if (sel) sel.addEventListener('change', function (e) { focus = null; f.area = e.target.value; save(); render(); });
    var qt;
    document.getElementById('q').addEventListener('input', function (e) { clearTimeout(qt); qt = setTimeout(function () { focus = null; f.q = e.target.value.trim(); save(); render(); }, 120); });
    document.getElementById('ftoggle').addEventListener('click', function () {
      var p = document.getElementById('fpanel'); p.classList.toggle('open');
      this.setAttribute('aria-expanded', p.classList.contains('open')); store('fpanel', p.classList.contains('open'));
    });
    document.getElementById('freset').addEventListener('click', function () {
      if (focus) { focus = null; if (location.hash !== '#/issues') { lb.ignoreHash = true; history.replaceState(null, '', '#/issues'); lb.ignoreHash = false; } render(); return; }
      f = defaultFilters(); save(); viewIssues([]);
    });
    list.addEventListener('click', function (e) {
      var t = e.target.closest('[data-shot]');
      if (t) {
        var box = t.closest('.thumbs');
        var shots = Array.prototype.map.call(box.querySelectorAll('[data-shot]'), function (b) { return { src: b.getAttribute('data-src'), cap: b.getAttribute('data-cap'), label: '' }; });
        lb.open(shots, +t.getAttribute('data-shot'));
        return;
      }
      var h = e.target.closest('.ih'); if (h) toggleIssue(h.parentNode);
    });
    fillAreas();
    render();
  }
  function issueHtml(it) {
    var meta = [plTag(it.platform), esc(areaTitle(it)), it.date ? esc(it.date) : ''].filter(Boolean).join(' · ');
    return '<div class="issue s-' + it.status + ' v-' + (SEV[it.sev] ? SEV[it.sev].cls : 'NA') + '" data-i="' + it.idx + '"><button type="button" class="ih" aria-expanded="false"><span class="chev" aria-hidden="true">›</span>' +
      '<div class="tags">' + sevTag(it.sev) + stTag(it.status) + (it.top ? '<span class="badge">Top' + (it.rank != null ? ' #' + it.rank : '') + '</span>' : '') + (!it.counted ? '<span class="badge">Summary row</span>' : '') +
      it.tags.map(function (t) { return '<span class="badge">' + esc(t === 'root-cause' ? 'Root cause' : t) + '</span>'; }).join('') + '</div>' +
      '<div class="tt">' + esc(it.title) + '</div>' + (meta ? '<div class="mt">' + meta + '</div>' : '') + '</button><div class="ib"></div></div>';
  }
  function thumbs(label, shots, plat) {
    if (!shots.length) return '';
    var land = !(PL[plat] && PL[plat].shape === 'portrait');
    return '<div class="thumbs-k">' + label + ' (' + shots.length + ')</div><div class="thumbs' + (land ? ' d' : '') + '">' + shots.map(function (s, i) {
      return '<button type="button" data-shot="' + i + '" data-src="' + esc(s.src) + '" data-cap="' + esc(s.cap) + '" aria-label="Screenshot ' + (i + 1) + '"><img loading="lazy" src="' + esc(s.src) + '" alt=""></button>';
    }).join('') + '</div>';
  }
  function toggleIssue(box) {
    var open = box.classList.toggle('open');
    box.querySelector('.ih').setAttribute('aria-expanded', open);
    var body = box.querySelector('.ib');
    if (!open || body.childNodes.length) return;
    var it = ALL[+box.getAttribute('data-i')];
    var area = AREA[it.area];
    body.innerHTML = (it.html && plain(it.html).replace(/\s+/g, ' ').trim() !== it.title ? '<div>' + it.html + '</div>' : '') +
      (it.note ? '<div class="fixnote ' + it.status + '">' + it.note + '</div>' : '') +
      (it.where ? '<div class="where">Where: ' + it.where + '</div>' : '') +
      (it.fixes.length ? '<div class="fixedby">Fixed in ' + it.fixes.map(function (id) { var fx = FIX[id]; return '<a class="ichip" href="#/fixes/' + encodeURIComponent(id) + '">' + (fx && fx.num != null ? '<span class="fix-num">' + fx.num + '</span>' : '') + '<span class="t">' + esc(fx ? fx.title : id) + '</span></a>'; }).join('') + '</div>' : '') +
      thumbs('Screenshots', it.shots, it.platform) +
      (area ? thumbs('Screenshots in this area', area.shots, area.platform || it.platform) : '');
  }

  // ------------------------------------------------------------ plan
  function viewPlan() {
    var groupPlats = PLATS.filter(function (p) { return D.plan.some(function (g) { return g.platform === p; }) || D.appendix.some(function (a) { return a.platform === p; }); });
    var pref = store('planPlat');
    if (groupPlats.indexOf(pref) < 0) pref = groupPlats[0];
    function visible(x) { return !x.platform || !pref || x.platform === pref; }
    function body() {
      return D.plan.filter(visible).map(function (g) {
        var items = g.items;
        var done = items.filter(function (i) { return i.status === 'done'; }).length;
        var has = function (k) { return items.some(function (i) { return i[k]; }); };
        var cols = [['phase', 'Phase'], ['title', 'Change'], ['files', 'Files'], ['effort', 'Effort']].filter(function (c) { return c[0] === 'title' || has(c[0]) || (c[0] === 'phase' && has('sev')); });
        function cell(i, k) {
          if (k === 'phase') return (i.sev ? sevTag(i.sev) : '') + esc(i.phase);
          if (k === 'title') return '<div class="ptitle">' + i.title + '</div>' + (i.details ? '<div class="small">' + i.details + '</div>' : '') + (i.note ? '<span class="pnote">' + i.note + '</span>' : '') + links(i);
          return i[k] ? (k === 'effort' ? esc(i[k]) : i[k]) : '';
        }
        function links(i) {
          var l = i.issues.map(issueChip).concat(i.fixes.map(function (id) { var fx = FIX[id]; return '<a class="ichip" href="#/fixes/' + encodeURIComponent(id) + '">' + (fx && fx.num != null ? '<span class="fix-num">' + fx.num + '</span>' : '') + '<span class="t">' + esc(fx ? fx.title : id) + '</span></a>'; }));
          return l.length ? '<div class="resolves" style="padding:6px 0 0">' + l.join('') + '</div>' : '';
        }
        var desk = '<div class="plan-desk"><table class="ptable"><tr>' + cols.map(function (c) { return '<th>' + c[1] + '</th>'; }).join('') + '<th>Status</th></tr>' +
          items.map(function (i) { return '<tr class="s-' + i.status + '">' + cols.map(function (c) { return '<td class="c-' + c[0] + '">' + cell(i, c[0]) + '</td>'; }).join('') + '<td class="stc">' + planTag(i.status) + '</td></tr>'; }).join('') + '</table></div>';
        var mob = '<div class="plan-mob">' + items.map(function (i) {
          return '<div class="prow s-' + i.status + '"><div class="ph"><span>' + cell(i, 'phase') + '</span><span>' + (i.effort ? esc(i.effort) + ' · ' : '') + planTag(i.status) + '</span></div>' + cell(i, 'title') +
            (i.files ? '<div class="kv">Files: ' + i.files + '</div>' : '') + '</div>';
        }).join('') + '</div>';
        return '<section class="card"><h2>' + esc(g.title) + '</h2>' + (g.intro ? '<div class="small">' + g.intro + '</div>' : '') +
          (items.length ? '<p class="small">' + done + ' of ' + items.length + ' done</p>' + bar({ total: items.length, fixed: done, partial: items.filter(function (i) { return i.status === 'partial' || i.status === 'doing'; }).length, open: 0, notabug: 0, wontfix: items.filter(function (i) { return i.status === 'dropped'; }).length }, 'sm') + '<div style="height:10px"></div>' + desk + mob : '') + '</section>';
      }).join('') + D.appendix.filter(visible).map(function (a) {
        return '<section class="card"><h2>' + esc(a.title) + '</h2><div class="appx">' + a.body + '</div></section>';
      }).join('');
    }
    function planTag(s) { return '<span class="st st-' + s + '">' + esc(D.planLabels[s] || s) + '</span>'; }
    app.innerHTML = '<h1 class="view-title">Plan</h1>' + (MULTI && groupPlats.length > 1 ? '<div style="margin:0 0 12px">' + seg('plat', groupPlats.map(function (p) { return [p, PL[p].label]; }), pref) + '</div>' : '') + '<div id="pbody">' + body() + '</div>';
    var s = app.querySelector('[data-seg=plat]');
    if (s) s.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      this.querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', x === b); });
      pref = b.getAttribute('data-v'); store('planPlat', pref);
      document.getElementById('pbody').innerHTML = body();
    });
  }

  // ------------------------------------------------------------ lightbox (pinch / wheel / double-tap zoom, swipe)
  var lb = (function () {
    var root = document.getElementById('lightbox'), stage = document.getElementById('lb-stage'), img = document.getElementById('lb-img');
    var items = [], idx = 0, s = 1, tx = 0, ty = 0, fit = 1, nw = 1, nh = 1, ptrs = {}, gesture = null, lastTap = 0, pushed = false, opener = null;
    function apply() { img.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + s + ')'; }
    function clamp() {
      var sw = stage.clientWidth, sh = stage.clientHeight, w = nw * s, h = nh * s;
      tx = w <= sw ? (sw - w) / 2 : Math.min(0, Math.max(sw - w, tx));
      ty = h <= sh ? (sh - h) / 2 : Math.min(0, Math.max(sh - h, ty));
    }
    function reset() {
      var sw = stage.clientWidth, sh = stage.clientHeight;
      fit = Math.min(sw / nw, sh / nh, 2);
      s = fit; clamp(); apply();
    }
    function zoomAt(ns, cx, cy) {
      ns = Math.max(fit, Math.min(fit * 6, ns));
      var r = stage.getBoundingClientRect(), px = cx - r.left, py = cy - r.top;
      tx = px - (px - tx) * ns / s; ty = py - (py - ty) * ns / s; s = ns; clamp(); apply();
    }
    function show(i) {
      idx = (i + items.length) % items.length;
      var it = items[idx];
      img.style.visibility = 'hidden';
      img.onload = function () { nw = img.naturalWidth; nh = img.naturalHeight; img.style.width = nw + 'px'; img.style.height = nh + 'px'; reset(); img.style.visibility = 'visible'; };
      img.src = it.src;
      var lab = document.getElementById('lb-label');
      lab.textContent = it.label === 'b' ? 'BEFORE' : it.label === 'a' ? 'AFTER' : '';
      lab.className = 'lb-label ' + (it.label || '');
      document.getElementById('lb-count').textContent = items.length > 1 ? (idx + 1) + ' / ' + items.length : '';
      document.getElementById('lb-cap').innerHTML = it.cap || '';
      document.getElementById('lb-prev').hidden = document.getElementById('lb-next').hidden = items.length < 2;
    }
    function open(list, i) {
      opener = document.activeElement;
      items = list; root.hidden = false; document.body.style.overflow = 'hidden';
      if (!pushed) { history.pushState({ lb: 1 }, ''); pushed = true; }
      show(i || 0);
      document.getElementById('lb-close').focus();
    }
    function close(fromPop) {
      root.hidden = true; document.body.style.overflow = ''; img.removeAttribute('src');
      if (pushed && !fromPop) { pushed = false; history.back(); } else pushed = false;
      if (opener && opener.focus) opener.focus();
    }
    window.addEventListener('popstate', function () { if (!root.hidden) close(true); });
    document.getElementById('lb-close').addEventListener('click', function () { close(); });
    document.getElementById('lb-prev').addEventListener('click', function () { show(idx - 1); });
    document.getElementById('lb-next').addEventListener('click', function () { show(idx + 1); });
    document.addEventListener('keydown', function (e) {
      if (root.hidden) return;
      if (e.key === 'Escape') close(); else if (e.key === 'ArrowLeft') show(idx - 1); else if (e.key === 'ArrowRight') show(idx + 1);
    });
    window.addEventListener('resize', function () { if (!root.hidden) reset(); });
    stage.addEventListener('wheel', function (e) { e.preventDefault(); zoomAt(s * Math.exp(-e.deltaY * 0.002), e.clientX, e.clientY); }, { passive: false });
    function pts() { return Object.keys(ptrs).map(function (k) { return ptrs[k]; }); }
    stage.addEventListener('pointerdown', function (e) {
      stage.setPointerCapture(e.pointerId);
      ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
      var p = pts();
      if (p.length === 2) gesture = { type: 'pinch', d: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y), s: s, mx: (p[0].x + p[1].x) / 2, my: (p[0].y + p[1].y) / 2, tx: tx, ty: ty };
      else if (p.length === 1) gesture = { type: 'pan', x: e.clientX, y: e.clientY, tx: tx, ty: ty, t: Date.now(), moved: false };
    });
    stage.addEventListener('pointermove', function (e) {
      if (!ptrs[e.pointerId]) return;
      ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
      var p = pts();
      if (gesture && gesture.type === 'pinch' && p.length >= 2) {
        var d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y), mx = (p[0].x + p[1].x) / 2, my = (p[0].y + p[1].y) / 2;
        var ns = Math.max(fit * 0.8, Math.min(fit * 6, gesture.s * d / gesture.d));
        var r = stage.getBoundingClientRect();
        var ox = gesture.mx - r.left, oy = gesture.my - r.top;
        tx = (mx - r.left) - (ox - gesture.tx) * ns / gesture.s; ty = (my - r.top) - (oy - gesture.ty) * ns / gesture.s; s = ns; apply();
      } else if (gesture && gesture.type === 'pan') {
        var dx = e.clientX - gesture.x, dy = e.clientY - gesture.y;
        if (Math.abs(dx) + Math.abs(dy) > 6) gesture.moved = true;
        if (s > fit * 1.01) { tx = gesture.tx + dx; ty = gesture.ty + dy; clamp(); apply(); }
        else { tx = gesture.tx + dx; apply(); }
      }
    });
    function up(e) {
      if (!ptrs[e.pointerId]) return;
      delete ptrs[e.pointerId];
      var p = pts();
      if (gesture && gesture.type === 'pinch') {
        if (s < fit) s = fit;
        clamp(); apply();
        gesture = p.length === 1 ? { type: 'pan', x: p[0].x, y: p[0].y, tx: tx, ty: ty, t: Date.now(), moved: true } : null;
        return;
      }
      if (!gesture) return;
      var dx = e.clientX - gesture.x;
      if (s <= fit * 1.01 && gesture.moved && Math.abs(dx) > 60 && items.length > 1) { show(idx + (dx < 0 ? 1 : -1)); gesture = null; return; }
      if (!gesture.moved) {
        var now = Date.now();
        if (now - lastTap < 300) { if (s > fit * 1.01) reset(); else zoomAt(fit * 2.5, e.clientX, e.clientY); lastTap = 0; }
        else lastTap = now;
      }
      if (s <= fit * 1.01) reset();
      gesture = null;
    }
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', up);
    return { open: open, close: close, ignoreHash: false };
  })();

  if (wide.addEventListener) wide.addEventListener('change', function () { if (/fixes/.test(location.hash)) route(); });
  route();
})();
