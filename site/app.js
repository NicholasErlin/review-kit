/* review-kit site. Vanilla JS, no dependencies, works offline and from file://. Data: window.REVIEW (data.js),
   or window.REVIEWS ([{key, label, data}]) for a combined site with a switch between the reviews. */
(function () {
  'use strict';
  var app = document.getElementById('app');
  var LIST = window.REVIEWS || (window.REVIEW ? [{ key: '', label: '', data: window.REVIEW }] : null);
  if (!LIST || !LIST.length) { app.innerHTML = '<p>data.js is missing. Run <code>review-kit build</code>.</p>'; return; }
  var COMBINED = !!window.REVIEWS;
  var wide = window.matchMedia('(min-width: 820px)');

  // ------------------------------------------------------------ shared utils
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function plain(html) { if (!html) return ''; var d = document.createElement('div'); d.innerHTML = html; return d.textContent || ''; }
  function dateKey(s) { var t = Date.parse(s || ''); return isNaN(t) ? 0 : t; }
  function pct(n, d) { return d ? 100 * n / d : 0; }
  function hex(c) { c = c.replace('#', ''); if (c.length === 3) c = c.replace(/./g, '$&$&'); return [0, 2, 4].map(function (i) { return parseInt(c.substr(i, 2), 16); }); }
  var KINDS = { ui: 1, backend: 1, ideas: 1, design: 1 };
  function kindOf(D, key) { // project.kind, else the combined-site key, else guess from the data
    var k = D.project.kind || (KINDS[key] ? key : '');
    if (KINDS[k]) return k;
    if ((D.proposals || []).length && !D.issues.length) return 'design';
    if (((D.ideas || []).length || (D.research || []).length) && !D.issues.length) return 'ideas';
    return k || 'ui';
  }
  function safeHref(h) { h = String(h || ''); return /^(https?:|mailto:)/i.test(h) || !/^[a-z][a-z0-9+.-]*:/i.test(h) ? h : ''; }
  function lum(c) { return c.map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }).reduce(function (a, v, i) { return a + v * [0.2126, 0.7152, 0.0722][i]; }, 0); }

  // ------------------------------------------------------------ one review
  // Everything a review needs to render its own Overview / Fixes / Issues / Plan. `key` prefixes its hash routes
  // (#/<key>/issues/...) in a combined site; it is '' in a single-review site (#/issues/...).
  function Review(D, key) {
    var P = D.project;
    var H = key ? '#/' + key + '/' : '#/';
    var current = 'overview';
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
    // ideas / research / design proposals (optional sections; older data.js has none of them)
    var RESEARCH = D.research || [], IDEAS = D.ideas || [], PROPS = D.proposals || [];
    var KIND = kindOf(D, key);
    var RES = {}; RESEARCH.forEach(function (r, i) { r.idx = i; RES[r.id] = r; });
    var IDEA = {}; IDEAS.forEach(function (x, i) { x.idx = i; IDEA[x.id] = x; });
    var PROP = {}; PROPS.forEach(function (x) { PROP[x.id] = x; });
    var ISNAME = D.ideaStatusLabels || { proposed: 'Proposed', go: 'Go', maybe: 'Maybe', no: 'No', done: 'Done' };
    var PSNAME = D.proposalStatusLabels || { open: 'Open', adopted: 'Adopted', closed: 'Closed' };
    var USED_ST = STATUS.filter(function (s) { return s === 'open' || s === 'partial' || s === 'fixed' || ALL.some(function (it) { return it.status === s; }); });
    var HAS_UNRANKED = ALL.some(function (it) { return !it.sev; });
    var HAS_SUMMARY = ALL.some(function (it) { return !it.counted; });

    // ------------------------------------------------------------ utils
    var NS = 'rk.' + P.name + '.' + (key ? key + '.' : '');
    function store(k, v) { try { if (v === undefined) return JSON.parse(localStorage.getItem(NS + k)); localStorage.setItem(NS + k, JSON.stringify(v)); } catch (e) { return null; } }
    function sevTag(sev) { var s = SEV[sev]; return s ? '<span class="tag ' + s.cls + '" title="' + esc(s.desc) + '">' + esc(s.label) + '</span>' : '<span class="tag NA" title="Unranked">—</span>'; }
    function stTag(st) { return '<span class="st st-' + st + '">' + esc(SNAME[st] || st) + '</span>'; }
    function plTag(p) { return MULTI ? '<span class="badge-pl">' + esc((PL[p] || { label: p }).label).toUpperCase() + '</span>' : ''; }
    function areaTitle(it) { var a = AREA[it.area]; return a ? (a.num ? a.num + '. ' : '') + a.title : (it.area || ''); }
    function seg(name, opts, cur, cls) {
      var label = { plat: 'Platform', mode: 'Comparison view', sort: 'Sort ideas by' }[name] || name;
      return '<div class="seg ' + (cls || '') + '" data-seg="' + name + '" role="group" aria-label="' + label + '">' + opts.map(function (o) {
        return '<button type="button" data-v="' + esc(o[0]) + '"' + (o[0] === cur ? ' class="on" aria-pressed="true"' : ' aria-pressed="false"') + (o[2] ? ' disabled' : '') + '>' + esc(o[1]) + '</button>';
      }).join('') + '</div>';
    }

    // ------------------------------------------------------------ theme
    function theme() {
      function mix(c, w, t) { return 'rgb(' + c.map(function (v, i) { return Math.round(v + (w[i] - v) * t); }).join(',') + ')'; }
      function ratio(x, y) { var p = lum(x), q = lum(y); return (Math.max(p, q) + 0.05) / (Math.min(p, q) + 0.05); }
      var INK = hex('#13232a'), WHITE = [255, 255, 255];
      var a = hex(P.theme.accent);
      var light = lum(a) > 0.45;
      var brandLight = light ? mix(a, [0, 0, 0], 0.45) : P.theme.accent;
      var brandDark = P.theme.accentDark || (lum(a) < 0.25 ? mix(a, [255, 255, 255], 0.55) : P.theme.accent);
      var css = ':root{--accent:' + P.theme.accent + ';--brand:' + brandLight + ';--on-accent:' + (light ? '#13232a' : '#fff') + '}' +
        '@media (prefers-color-scheme: dark){:root{--brand:' + brandDark + '}}';
      D.severities.forEach(function (s) {
        var dark = ratio(hex(s.color), INK) > ratio(hex(s.color), WHITE); // dark text when it reads better than white
        var sels = ['.tag.' + s.cls];
        if (/^[A-Za-z_-][A-Za-z0-9_-]*$/.test(s.id)) sels.push('.tag.' + s.id); // tags embedded in HTML content, e.g. <span class="tag P0">
        css += sels.join(',') + '{background:' + s.color + (dark ? ';color:#13232a' : '') + '}';
        css += '.chip.on.' + s.cls + '{background:' + s.color + ';border-color:' + s.color + ';color:' + (dark ? '#13232a' : '#fff') + '}';
        css += '.issue.s-open.v-' + s.cls + '{border-left-color:' + s.color + '}';
      });
      var st = document.getElementById('rk-theme');
      if (!st) { st = document.createElement('style'); st.id = 'rk-theme'; document.head.appendChild(st); }
      st.textContent = css;
      document.getElementById('logo').textContent = P.theme.logoText;
      document.getElementById('brand').innerHTML = '<b>' + esc(P.name) + '</b> ' + esc(P.title);
    }

    function sortIssues(a, b) {
      var R = { open: 0, partial: 1, fixed: 2, notabug: 3, wontfix: 4 };
      function sr(s) { var i = SEVS.indexOf(s); return i < 0 ? SEVS.length : i; }
      return R[a.status] - R[b.status] || sr(a.sev) - sr(b.sev) || PLATS.indexOf(a.platform) - PLATS.indexOf(b.platform) || a.idx - b.idx;
    }

    // ------------------------------------------------------------ tabs / routing
    // the kind decides the order: an ideas review leads with Ideas and Research, a design review with Proposals
    var ORDER = KIND === 'ideas' ? ['overview', 'ideas', 'research', 'proposals', 'fixes', 'issues', 'plan']
      : KIND === 'design' ? ['overview', 'proposals', 'ideas', 'research', 'fixes', 'issues', 'plan']
        : ['overview', 'fixes', 'issues', 'ideas', 'research', 'proposals', 'plan'];
    var VDEF = { overview: ['Overview', '◎'], fixes: ['Fixes', '✓'], issues: ['Issues', '☰'], plan: ['Plan', '▤'], ideas: ['Ideas', '✦'], research: ['Research', '❞'], proposals: ['Proposals', '⇆'] };
    var VIEWS = ORDER.map(function (v) { return [v, VDEF[v][0], VDEF[v][1]]; }).filter(function (v) {
      return v[0] === 'overview' || (v[0] === 'fixes' && D.fixes.length) || (v[0] === 'issues' && ALL.length) || (v[0] === 'plan' && (D.plan.length || D.appendix.length)) ||
        (v[0] === 'ideas' && IDEAS.length) || (v[0] === 'research' && RESEARCH.length) || (v[0] === 'proposals' && PROPS.length);
    });
    function renderTabs(cur) {
      function link(v, ic) { return '<a href="' + H + v[0] + '"' + (v[0] === cur ? ' class="on" aria-current="page"' : '') + '>' + (ic ? '<span class="ic" aria-hidden="true">' + v[2] + '</span>' : '') + v[1] + '</a>'; }
      document.getElementById('tabs-top').innerHTML = VIEWS.length > 1 ? VIEWS.map(function (v) { return link(v, false); }).join('') : '';
      document.getElementById('tabs-bottom').innerHTML = VIEWS.length > 1 ? VIEWS.map(function (v) { return link(v, true); }).join('') : '';
    }
    function route(parts) {
      var view = VIEWS.some(function (v) { return v[0] === parts[0]; }) ? parts[0] : 'overview';
      current = view;
      document.body.classList.toggle('no-bottom', VIEWS.length < 2);
      renderTabs(view);
      ({ overview: viewOverview, fixes: viewFixes, issues: viewIssues, plan: viewPlan, ideas: viewIdeas, research: viewResearch, proposals: viewProposals })[view](parts.slice(1).map(decodeURIComponent));
    }

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
      var label = [[c.fixed, 'fixed'], [c.notabug, 'not a bug'], [c.wontfix, 'won\'t fix'], [c.partial, 'partly fixed'], [c.open, 'open']].filter(function (x) { return x[0]; }).map(function (x) { return x[0] + ' ' + x[1]; }).join(', ');
      return '<div class="bar ' + (cls || '') + '" role="img" aria-label="' + esc(label || 'none') + '">' +
        '<i class="f" style="width:' + pct(c.fixed, t) + '%"></i><i class="n" style="width:' + pct(c.notabug, t) + '%"></i><i class="w" style="width:' + pct(c.wontfix, t) + '%"></i><i class="p" style="width:' + pct(c.partial, t) + '%"></i></div>';
    }
    function frac(x) { return '<span title="' + resolved(x) + ' of ' + x.total + ' resolved">' + resolved(x) + ' / ' + x.total + '</span>' + (x.partial ? ' · ' + x.partial + ' partly' : ''); }
    function progressCard(title, list, sub) {
      var c = counts(list);
      var rows = SEVS.map(function (s) {
        var x = c.sev[s];
        return x.total ? '<div class="sevrow">' + sevTag(s) + bar(x, 'sm') + '<span class="cnt">' + frac(x) + '</span></div>' : '';
      }).join('');
      if (c.sev.none.total) rows += '<div class="sevrow"><span class="tag NA" title="No severity (e.g. root causes)">—</span>' + bar(c.sev.none, 'sm') + '<span class="cnt">' + frac(c.sev.none) + '</span></div>';
      return '<section class="card"><h2>' + title + '</h2>' + (sub ? '<div class="small">' + sub + '</div>' : '') + statsHtml(c) + rows + '</section>';
    }
    function statsHtml(c) { // resolved / partly / open tiles, the progress bar and its legend
      var other = c.notabug + c.wontfix;
      return '<div class="stats"><div class="stat fixed"><b>' + resolved(c) + '</b><span>' + (other ? 'Resolved' : 'Fixed') + '</span></div><div class="stat partial"><b>' + c.partial + '</b><span>Partly fixed</span></div><div class="stat open"><b>' + c.open + '</b><span>Open</span></div></div>' +
        bar(c) + '<div class="legend"><span><i style="background:var(--fixed)"></i>Fixed' + (other ? ' ' + c.fixed : '') + '</span>' +
        (c.notabug ? '<span><i style="background:var(--notabug)"></i>Not a bug ' + c.notabug + '</span>' : '') +
        (c.wontfix ? '<span><i style="background:var(--wontfix)"></i>Won\'t fix ' + c.wontfix + '</span>' : '') +
        '<span><i style="background:var(--partial)"></i>Partly fixed</span><span><i class="o" style="background:var(--chip)"></i>Open</span><span>' + Math.round(pct(resolved(c) + c.partial / 2, c.total || 1)) + '% done</span></div>';
    }
    function planCounts(items) {
      function n(f) { return items.filter(function (i) { return f(i.status); }).length; }
      var c = { total: items.length, fixed: n(function (s) { return s === 'done'; }), partial: n(function (s) { return s === 'partial' || s === 'doing'; }), wontfix: n(function (s) { return s === 'dropped'; }), notabug: 0 };
      c.open = c.total - c.fixed - c.partial - c.wontfix;
      return c;
    }
    function planSummary(c) {
      return [c.fixed + ' of ' + c.total + ' done', c.partial ? c.partial + ' in progress or partly done' : '', c.wontfix ? c.wontfix + ' dropped' : '', c.open ? c.open + ' to do' : ''].filter(Boolean).join(' · ');
    }
    function planLegend(c) {
      return '<div class="legend">' + [[c.fixed, 'var(--fixed)', 'Done', ''], [c.partial, 'var(--partial)', 'In progress / partly done', ''], [c.wontfix, 'var(--wontfix)', 'Dropped', ''], [c.open, 'var(--chip)', 'To do', ' class="o"']].filter(function (x) { return x[0]; }).map(function (x) {
        return '<span><i' + x[3] + ' style="background:' + x[1] + '"></i>' + x[2] + '</span>';
      }).join('') + '</div>';
    }
    function planCard() {
      var items = [];
      D.plan.forEach(function (g) { items = items.concat(g.items); });
      if (!items.length) return '';
      var pc = planCounts(items);
      return '<section class="card"><h2>Plan</h2><div class="small">' + planSummary(pc) + '</div><div style="margin:10px 0">' + bar(pc) + planLegend(pc) +
        '</div><a class="btn" href="' + H + 'plan">Open the plan</a></section>';
    }
    function issueRow(it) {
      return '<li class="toprow">' + sevTag(it.sev) + '<div class="t"><a class="row" href="' + H + 'issues/' + encodeURIComponent(it.id) + '"><div class="lf-title' + (RESOLVED[it.status] ? ' struck' : '') + '">' + esc(it.title) + '</div></a><div class="lf-meta">' + stTag(it.status) + ' ' + plTag(it.platform) + (areaTitle(it) ? ' · ' + esc(areaTitle(it)) : '') + '</div></div></li>';
    }
    function fixPlatsLabel(x) { return PLATS.filter(function (p) { return x.platforms[p]; }).map(function (p) { return PL[p].label; }).join(' + '); }
    function newestFixes() { return D.fixes.slice().sort(function (a, b) { return dateKey(b.date) - dateKey(a.date) || b.order - a.order; }); }
    function viewOverview() {
      var counted = ALL.filter(function (it) { return it.counted; });
      var html = '<h1 class="view-title">Overview</h1>' + (P.desc ? '<div class="intro">' + P.desc + '</div>' : '');
      var think = thinkCards(), thinking = KIND === 'ideas' || KIND === 'design';
      if (thinking) html += think;
      if (thinking && !counted.length && !D.fixes.length) { // an ideas / design review with no issues: no issue progress to show
        html += planCard();
        app.innerHTML = html;
        linkRefs(app.querySelector('.intro'), key);
        return;
      }
      var meta = [counted.length + ' issue' + (counted.length === 1 ? '' : 's') + (MULTI ? ' across ' + PLATS.length + ' platforms' : ''), D.fixes.length + ' fix' + (D.fixes.length === 1 ? '' : 'es')];
      if (P.date) meta.push('review date ' + esc(P.date));
      meta.push('updated ' + esc(D.generated));
      if (P.repo) meta.push(/^https?:/.test(P.repo) ? '<a href="' + esc(P.repo) + '">repository</a>' : '<code>' + esc(P.repo) + '</code>');
      html += progressCard(MULTI ? 'All issues' : 'Issues', counted, meta.join(' · '));
      if (MULTI) {
        var cards = PLATS.map(function (p) {
          var l = counted.filter(function (it) { return it.platform === p; });
          return l.length ? progressCard(esc(PL[p].label), l, '<a href="' + H + 'issues" data-goto-plat="' + esc(p) + '">' + l.length + ' issues</a>' + (PL[p].desc ? ' · ' + esc(PL[p].desc) : '')) : '';
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
          return '<li><a class="row" href="' + H + 'fixes/' + encodeURIComponent(x.id) + '"><div class="lf-title">' + (x.num != null ? '<span class="fix-num">' + x.num + '</span>' : '') + esc(x.title) + '</div><div class="lf-meta">' +
            [x.date ? esc(x.date) : '', MULTI ? esc(pl) : '', n ? n + ' before / after ›' : 'details ›'].filter(Boolean).join(' · ') + '</div></a></li>';
        }).join('') + '</ul><p style="margin:10px 0 0"><a class="btn" href="' + H + 'fixes">All ' + D.fixes.length + ' fixes</a></p></section>');
      }
      if (counted.length) second.push('<section class="card"><h2>What\'s left</h2>' + (left.length ? '<div class="small">' + left.length + ' open or partly fixed, most severe first</div><ul class="list" style="margin-top:8px">' + left.slice(0, 6).map(issueRow).join('') + '</ul>' +
        '<p style="margin:10px 0 0"><a class="btn" href="' + H + 'issues" data-goto-open="1">All ' + left.length + ' open issues</a></p>' : '<p class="small">Nothing open. Every issue is resolved.</p>') + '</section>');
      html += second.length > 1 ? '<div class="grid2">' + second.join('') + '</div>' : second.join('');
      var tops = PLATS.map(function (p) {
        var top = ALL.filter(function (it) { return it.top && it.platform === p; }).sort(function (a, b) { return (a.rank == null ? 1e9 : a.rank) - (b.rank == null ? 1e9 : b.rank) || a.idx - b.idx; });
        return top.length ? '<section class="card"><h2>' + (MULTI ? esc(PL[p].label) + ': top' : 'Top') + ' issues, ranked</h2><ul class="list">' + top.map(issueRow).join('') + '</ul></section>' : '';
      }).filter(Boolean);
      if (tops.length) html += tops.length > 1 ? '<div class="grid2">' + tops.join('') + '</div>' : tops[0];
      if (!thinking) html += think;
      html += planCard();
      app.innerHTML = html;
      linkRefs(app.querySelector('.intro'), key);
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
    var FLIP_LABEL = ['Showing before. Press to show after.', 'Showing after. Press to show before.'];
    function pairHtml(p, mode) {
      var shared = p.cap ? '<div class="caps"><p>' + p.cap + '</p></div>' : '';
      if (!p.before || !p.after) {
        var f = p.before || p.after;
        return '<div class="pair">' + figHtml(f, p.before ? 'BEFORE' : 'AFTER', p.before ? 'ba-before' : 'ba-after') + shared + '</div>';
      }
      if (mode === 'side') {
        return '<div class="pair"><div class="side">' + figHtml(p.before, 'BEFORE', 'ba-before') + figHtml(p.after, 'AFTER', 'ba-after') + '</div>' + shared + '</div>';
      }
      var aria = mode === 'flip' ? 'role="button" aria-label="' + FLIP_LABEL[1] + '"' : 'role="slider" aria-label="Before / after comparison" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"';
      return '<div class="pair"><div class="cmp mode-' + mode + '" style="--x:50%" tabindex="0" ' + aria + '>' +
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
      return '<a class="ichip" href="' + H + 'issues/' + encodeURIComponent(id) + '" title="' + esc(it.title) + '">' + sevTag(it.sev) + '<span class="t' + (RESOLVED[it.status] ? ' struck' : '') + '">' + esc(it.title) + '</span></a>';
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
    function hasPair(fix, p) { return !!fix.platforms[p] && fix.platforms[p].pairs.some(function (x) { return x.before && x.after; }); }
    function hasFullPair(fix) { return Object.keys(fix.platforms).some(function (p) { return hasPair(fix, p); }); }
    function viewFixes(args) {
      var pref = store('fixPlat') || PLATS[0];
      var fixes = newestFixes();
      app.innerHTML = '<h1 class="view-title">Fixes <span class="small">' + D.fixes.length + ' shipped · newest first</span></h1>' + fixes.map(function (fix) {
        var avail = PLATS.filter(function (p) { return fix.platforms[p]; });
        var withPair = avail.filter(function (p) { return hasPair(fix, p); });
        // open on the preferred platform unless it has no before / after and another platform does
        var plat = hasPair(fix, pref) || (fix.platforms[pref] && !withPair.length) ? pref : withPair[0] || avail[0] || pref;
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
        if (c) setTimeout(function () { c.scrollIntoView({ block: 'start' }); /* scroll-padding-top keeps it below the header */ }, 30);
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
        var ms = card.querySelector('[data-seg=mode]');
        if (ms) ms.hidden = !hasPair(fix, card.getAttribute('data-plat')); // compare modes only where there is a pair
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
      function flip() { var b = cmp.classList.toggle('show-before'); cmp.setAttribute('aria-label', FLIP_LABEL[b ? 0 : 1]); }
      function setPct(x) { x = Math.max(0, Math.min(100, x)); cmp.style.setProperty('--x', x + '%'); cmp.setAttribute('aria-valuenow', Math.round(x)); }
      function setX(clientX) { var r = cmp.getBoundingClientRect(); setPct(100 * (clientX - r.left) / r.width); }
      cmp.addEventListener('keydown', function (e) {
        if (cmp.classList.contains('mode-flip')) { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); } return; }
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
          if (cmp.classList.contains('mode-flip')) flip();
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
        (MULTI ? '<div class="frow" role="group" aria-labelledby="fk-plat"><span class="k" id="fk-plat">Platform</span>' + chips('plat', [['all', 'All']].concat(PLATS.map(function (p) { return [p, PL[p].label]; })), f.plat) + '</div>' : '') +
        '<div class="frow" role="group" aria-labelledby="fk-sev"><span class="k" id="fk-sev">Severity</span>' + chips('sev', sevOpts, f.sev, true) + '</div>' +
        '<div class="frow" role="group" aria-labelledby="fk-st"><span class="k" id="fk-st">Status</span>' + chips('st', USED_ST.map(function (s) { return [s, SNAME[s], 'st-chip-' + s]; }), f.st, true) + '</div>' +
        (HAS_SUMMARY ? '<div class="frow" role="group" aria-labelledby="fk-src"><span class="k" id="fk-src">Source</span>' + chips('src', [['counted', 'Findings'], ['summary', 'Summary rows'], ['all', 'Both']], f.src) + '</div>' : '') +
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
        if (focus) { focus = null; if (location.hash !== H + 'issues') { lb.ignoreHash = true; history.replaceState(null, '', H + 'issues'); lb.ignoreHash = false; } render(); return; }
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
        (it.fixes.length ? '<div class="fixedby">Fixed in ' + it.fixes.map(function (id) { var fx = FIX[id]; return '<a class="ichip" href="' + H + 'fixes/' + encodeURIComponent(id) + '">' + (fx && fx.num != null ? '<span class="fix-num">' + fx.num + '</span>' : '') + '<span class="t">' + esc(fx ? fx.title : id) + '</span></a>'; }).join('') + '</div>' : '') +
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
          var pc = planCounts(items);
          var has = function (k) { return items.some(function (i) { return i[k]; }); };
          var cols = [['phase', 'Phase'], ['title', 'Change'], ['files', 'Files'], ['effort', 'Effort']].filter(function (c) { return c[0] === 'title' || has(c[0]) || (c[0] === 'phase' && has('sev')); });
          function cell(i, k) {
            if (k === 'phase') return (i.sev ? sevTag(i.sev) : '') + esc(i.phase);
            if (k === 'title') return '<div class="ptitle">' + i.title + '</div>' + (i.details ? '<div class="small">' + i.details + '</div>' : '') + (i.note ? '<span class="pnote">' + i.note + '</span>' : '') + links(i);
            return i[k] ? (k === 'effort' ? esc(i[k]) : i[k]) : '';
          }
          function links(i) {
            var l = i.issues.map(issueChip).concat(i.fixes.map(function (id) { var fx = FIX[id]; return '<a class="ichip" href="' + H + 'fixes/' + encodeURIComponent(id) + '">' + (fx && fx.num != null ? '<span class="fix-num">' + fx.num + '</span>' : '') + '<span class="t">' + esc(fx ? fx.title : id) + '</span></a>'; }));
            return l.length ? '<div class="resolves" style="padding:6px 0 0">' + l.join('') + '</div>' : '';
          }
          var desk = '<div class="plan-desk"><table class="ptable"><tr>' + cols.map(function (c) { return '<th>' + c[1] + '</th>'; }).join('') + '<th>Status</th></tr>' +
            items.map(function (i) { return '<tr class="s-' + i.status + '">' + cols.map(function (c) { return '<td class="c-' + c[0] + '">' + cell(i, c[0]) + '</td>'; }).join('') + '<td class="stc">' + planTag(i.status) + '</td></tr>'; }).join('') + '</table></div>';
          var mob = '<div class="plan-mob">' + items.map(function (i) {
            return '<div class="prow s-' + i.status + '"><div class="ph"><span>' + cell(i, 'phase') + '</span><span>' + (i.effort ? esc(i.effort) + ' · ' : '') + planTag(i.status) + '</span></div>' + cell(i, 'title') +
              (i.files ? '<div class="kv">Files: ' + i.files + '</div>' : '') + '</div>';
          }).join('') + '</div>';
          return '<section class="card"><h2>' + esc(g.title) + '</h2>' + (g.intro ? '<div class="small">' + g.intro + '</div>' : '') +
            (items.length ? '<p class="small">' + planSummary(pc) + '</p>' + bar(pc, 'sm') + planLegend(pc) + '<div style="height:10px"></div>' + desk + mob : '') + '</section>';
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

    // ------------------------------------------------------------ ideas, research, design proposals
    var SIZE = { S: 'small', M: 'medium', L: 'large' };
    var SIZE_N = { S: 1, M: 2, L: 3 };
    var CONF_N = { low: 1, medium: 2, high: 3 };
    var ISTATUS = ['proposed', 'go', 'maybe', 'no', 'done'];
    function cap1(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
    function iTag(st) { return '<span class="st st-i-' + esc(st) + '">' + esc(ISNAME[st] || st) + '</span>'; }
    function pTag(st) { return '<span class="st st-p-' + esc(st) + '">' + esc(PSNAME[st] || st) + '</span>'; }
    function confTag(c) { return c ? '<span class="badge conf-' + esc(c) + '">' + esc(cap1(c)) + ' confidence</span>' : ''; }
    function sizeTag(k, v) { return v ? '<span class="badge">' + k + ' ' + esc(SIZE[v] || v) + '</span>' : ''; }
    function given(html) { return !!html && !!plain(html).trim(); }
    function missing(what) { return '<p class="missing">' + esc(what || 'Not given') + '</p>'; }
    function orMissing(html, what) { return given(html) ? '<div class="rich">' + html + '</div>' : missing(what); }
    function sec(title, body) { return '<section class="card isec"><h2>' + title + '</h2>' + body + '</section>'; }
    function clip(s, n) { s = s.replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s; }
    function byRank(a, b) { return (a.rank == null ? 1e9 : a.rank) - (b.rank == null ? 1e9 : b.rank) || a.idx - b.idx; }
    function ideaMeta(x) { return [x.impact ? 'Impact ' + (SIZE[x.impact] || x.impact) : '', x.effort ? 'Effort ' + (SIZE[x.effort] || x.effort) : '', x.confidence ? cap1(x.confidence) + ' confidence' : ''].filter(Boolean).map(esc).join(' · '); }
    function ideaChip(id) { // ideas may live in another review of a combined site
      var f = findIn('ideas', id, key);
      if (!f) return '<span class="ichip"><span class="t">' + esc(id) + '</span></span>';
      return '<a class="ichip" href="' + f.h + 'ideas/' + encodeURIComponent(id) + '">' + iTag(f.x.status) + '<span class="t">' + esc(f.x.title) + '</span></a>';
    }
    function propChip(id) {
      var f = findIn('proposals', id, key);
      if (!f) return '<span class="ichip"><span class="t">' + esc(id) + '</span></span>';
      return '<a class="ichip" href="' + f.h + 'proposals/' + encodeURIComponent(id) + '">' + pTag(f.x.status) + '<span class="t">' + esc(f.x.title) + '</span></a>';
    }
    function proscons(pros, cons) {
      function ul(l, cls, none) { return l && l.length ? '<ul class="' + cls + '">' + l.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ul>' : missing(none); }
      return '<div class="pc"><div><h3>Pros</h3>' + ul(pros, 'pros', 'None listed') + '</div><div><h3>Cons</h3>' + ul(cons, 'cons', 'None listed') + '</div></div>';
    }
    function tiles(list) { return '<div class="stats">' + list.map(function (t) { return '<div class="stat ' + t[2] + '"><b>' + t[0] + '</b><span>' + esc(t[1]) + '</span></div>'; }).join('') + '</div>'; }
    function ideaCounts() { var n = {}; ISTATUS.forEach(function (s) { n[s] = 0; }); IDEAS.forEach(function (x) { n[x.status] = (n[x.status] || 0) + 1; }); return n; }
    function optTitle(p, id) { for (var i = 0; i < p.options.length; i++) if (p.options[i].id === id) return p.options[i].title; return id; }
    function propLine(p) {
      var bits = [p.options.length + ' option' + (p.options.length === 1 ? '' : 's')];
      if (p.adopted) bits.push('Adopted: ' + esc(optTitle(p, p.adopted.option)));
      else if (p.recommendation) bits.push('Recommended: ' + esc(optTitle(p, p.recommendation.option)));
      else if (p.status === 'open' && p.options.length > 1) bits.push('no recommendation yet');
      return bits.join(' · ');
    }
    function ideaRow(x) {
      return '<li class="toprow">' + iTag(x.status) + '<div class="t"><a class="row" href="' + H + 'ideas/' + encodeURIComponent(x.id) + '"><div class="lf-title">' + esc(x.title) + '</div></a><div class="lf-meta">' + (ideaMeta(x) || 'Not sized') + '</div></div></li>';
    }
    function propRow(p) {
      return '<li class="toprow">' + pTag(p.status) + '<div class="t"><a class="row" href="' + H + 'proposals/' + encodeURIComponent(p.id) + '"><div class="lf-title">' + esc(p.title) + '</div></a><div class="lf-meta">' + propLine(p) + '</div></div></li>';
    }
    function thinkCards() { // overview cards for ideas, research and proposals
      var out = [];
      if (IDEAS.length) {
        var n = ideaCounts();
        var go = IDEAS.filter(function (x) { return x.status === 'go'; }).sort(byRank);
        var rest = [n.no ? n.no + ' no' : '', n.done ? n.done + ' done' : ''].filter(Boolean).join(' · ');
        out.push('<section class="card"><h2>Ideas</h2><div class="small">' + IDEAS.length + ' idea' + (IDEAS.length === 1 ? '' : 's') + ' · ' + RESEARCH.length + ' research finding' + (RESEARCH.length === 1 ? '' : 's') + (rest ? ' · ' + rest : '') + '</div>' +
          tiles([[n.go, 'Go', 'fixed'], [n.maybe, 'Maybe', 'partial'], [n.proposed, 'Proposed', 'open']]) +
          (go.length ? '<h3>Taken forward</h3><ul class="list">' + go.map(ideaRow).join('') + '</ul>' : '<p class="small">No idea has a go yet. Open them and decide which to take forward.</p>') +
          '<div class="rv-go"><a class="btn" href="' + H + 'ideas">All ideas</a>' + (RESEARCH.length ? '<a class="btn" href="' + H + 'research">Research</a>' : '') + '</div></section>');
      } else if (RESEARCH.length) {
        out.push('<section class="card"><h2>Research</h2><div class="small">' + RESEARCH.length + ' findings</div><div class="rv-go"><a class="btn" href="' + H + 'research">Open the research</a></div></section>');
      }
      if (PROPS.length) {
        var open = PROPS.filter(function (p) { return p.status === 'open'; });
        var nOpt = PROPS.reduce(function (a, p) { return a + p.options.length; }, 0);
        out.push('<section class="card"><h2>Design proposals</h2><div class="small">' + PROPS.length + ' proposal' + (PROPS.length === 1 ? '' : 's') + ' · ' + nOpt + ' options · ' + open.length + ' waiting for a decision</div>' +
          '<ul class="list" style="margin-top:8px">' + PROPS.map(propRow).join('') + '</ul></section>');
      }
      return out.length > 1 ? '<div class="grid2">' + out.join('') + '</div>' : out.join('');
    }

    // ideas list: status chips, sort, and an impact vs effort grid
    function viewIdeas(args) {
      if (args[0] && IDEA[args[0]]) return ideaDetail(IDEA[args[0]]);
      var f = store('ideaFilters') || {};
      if (!f.st) f.st = [];
      if (!f.sort) f.sort = 'rank';
      var n = ideaCounts();
      app.innerHTML = '<h1 class="view-title">Ideas <span class="small">' + IDEAS.length + ' · ' + n.go + ' go</span></h1>' +
        '<div class="filters icontrols"><div class="frow" role="group" aria-labelledby="ik-st"><span class="k" id="ik-st">Status</span>' +
        chips('st', ISTATUS.map(function (s) { return [s, (ISNAME[s] || s) + ' ' + n[s], 'st-chip-i-' + s]; }), f.st, true) + '</div>' +
        '<div class="frow"><span class="k" id="ik-sort">Sort by</span>' + seg('sort', [['rank', 'Rank'], ['impact', 'Impact'], ['effort', 'Effort'], ['confidence', 'Confidence']], f.sort) + '</div></div>' +
        '<div id="imatrix"></div><div class="resinfo"><span id="icount" aria-live="polite"></span><button type="button" class="linkbtn" id="ireset">Show all</button></div><div id="idlist"></div>';
      function sorter(a, b) {
        if (f.sort === 'impact') return (SIZE_N[b.impact] || 0) - (SIZE_N[a.impact] || 0) || (SIZE_N[a.effort] || 9) - (SIZE_N[b.effort] || 9) || byRank(a, b);
        if (f.sort === 'effort') return (SIZE_N[a.effort] || 9) - (SIZE_N[b.effort] || 9) || (SIZE_N[b.impact] || 0) - (SIZE_N[a.impact] || 0) || byRank(a, b);
        if (f.sort === 'confidence') return (CONF_N[b.confidence] || 0) - (CONF_N[a.confidence] || 0) || byRank(a, b);
        return byRank(a, b);
      }
      function render() {
        var items = IDEAS.filter(function (x) { return !f.st.length || f.st.indexOf(x.status) >= 0; }).sort(sorter);
        document.getElementById('icount').textContent = items.length + ' of ' + IDEAS.length + ' ideas';
        document.getElementById('imatrix').innerHTML = matrixHtml(items);
        document.getElementById('idlist').innerHTML = items.length ? items.map(ideaCard).join('') : '<div class="empty">No ideas with this status.</div>';
      }
      app.querySelector('.icontrols').addEventListener('click', function (e) {
        var b = e.target.closest('[data-f]');
        if (b) {
          var v = b.getAttribute('data-v'), i = f.st.indexOf(v);
          if (i >= 0) f.st.splice(i, 1); else f.st.push(v);
          b.classList.toggle('on'); b.setAttribute('aria-pressed', b.classList.contains('on'));
        } else {
          var s = e.target.closest('[data-seg=sort] button'); if (!s) return;
          f.sort = s.getAttribute('data-v');
          s.parentNode.querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x === s); x.setAttribute('aria-pressed', x === s); });
        }
        store('ideaFilters', f); render();
      });
      document.getElementById('ireset').addEventListener('click', function () { f = { st: [], sort: 'rank' }; store('ideaFilters', f); viewIdeas([]); });
      render();
    }
    function matrixHtml(items) {
      var sized = items.filter(function (x) { return SIZE_N[x.impact] && SIZE_N[x.effort]; });
      var unsized = items.filter(function (x) { return !(SIZE_N[x.impact] && SIZE_N[x.effort]); });
      if (!sized.length && !unsized.length) return '';
      function link(x) { return '<a class="mx-i" href="' + H + 'ideas/' + encodeURIComponent(x.id) + '">' + esc(x.title) + ' <span class="mx-st">' + esc(ISNAME[x.status] || x.status) + '</span></a>'; }
      var rows = ['L', 'M', 'S'].map(function (imp) {
        return '<tr><th scope="row">' + cap1(SIZE[imp]) + '</th>' + ['S', 'M', 'L'].map(function (eff) {
          var cell = sized.filter(function (x) { return x.impact === imp && x.effort === eff; });
          var qw = imp === 'L' && eff === 'S' ? ' qw' : '';
          return '<td class="c-' + imp + eff + qw + '">' + (cell.length ? cell.map(link).join('') : '<span class="mx-none" aria-label="none">·</span>') + '</td>';
        }).join('') + '</tr>';
      }).join('');
      return '<section class="card"><h2>Impact vs effort</h2><p class="small">Rows are impact, columns are effort. The top-left cell (large impact, small effort) holds the quick wins.</p>' +
        '<div class="mx-scroll" role="region" aria-label="Impact versus effort grid" tabindex="0"><table class="imx"><thead><tr><td></td><th colspan="3" class="axis">Effort →</th></tr><tr><td class="corner">Impact ↓</td><th scope="col">Small</th><th scope="col">Medium</th><th scope="col">Large</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
        (unsized.length ? '<p class="small">Not sized: ' + unsized.map(function (x) { return '<a href="' + H + 'ideas/' + encodeURIComponent(x.id) + '">' + esc(x.title) + '</a>'; }).join(', ') + '</p>' : '') + '</section>';
    }
    function weakParts(x) {
      return [['reasoning', 'reasoning'], ['alternatives', 'alternatives'], ['risks', 'risks']].filter(function (k) { return !given(x[k[0]]); }).map(function (k) { return k[1]; })
        .concat(x.evidence && x.evidence.length ? [] : ['evidence']);
    }
    function ideaCard(x) {
      var weak = weakParts(x);
      return '<article class="card icard s-i-' + esc(x.status) + '"><div class="tags">' + iTag(x.status) + (x.rank != null ? '<span class="badge">#' + esc(x.rank) + '</span>' : '') + sizeTag('Impact', x.impact) + sizeTag('Effort', x.effort) + confTag(x.confidence) + '</div>' +
        '<h2><a href="' + H + 'ideas/' + encodeURIComponent(x.id) + '">' + esc(x.title) + '</a></h2>' +
        (given(x.problem) ? '<p class="ic-p">' + esc(clip(plain(x.problem), 200)) + '</p>' : '') +
        '<div class="lf-meta">' + [x.evidence.length ? x.evidence.length + ' research finding' + (x.evidence.length === 1 ? '' : 's') + ' cited' : '',
          weak.length ? '<span class="weak">Not given: ' + esc(weak.join(', ')) + '</span>' : ''].filter(Boolean).join(' · ') + '</div></article>';
    }
    function ideaDetail(x) {
      var ev = (x.evidence || []).map(function (id) { return RES[id]; }).filter(Boolean);
      var props = x.proposals || [];
      app.innerHTML = '<p class="back"><a href="' + H + 'ideas">‹ All ideas</a></p><h1 class="view-title">' + esc(x.title) + '</h1>' +
        '<div class="tags dtags">' + iTag(x.status) + (x.rank != null ? '<span class="badge">Rank #' + esc(x.rank) + '</span>' : '') + sizeTag('Impact', x.impact) + sizeTag('Effort', x.effort) + confTag(x.confidence) +
        (x.tags || []).map(function (t) { return '<span class="badge">' + esc(t) + '</span>'; }).join('') + (x.date ? '<span class="small">' + esc(x.date) + '</span>' : '') + '</div>' +
        sec('Problem', orMissing(x.problem)) + sec('Proposal', orMissing(x.proposal)) + sec('Why this', orMissing(x.reasoning)) +
        sec('Evidence', ev.length ? '<div class="rlist">' + ev.map(function (r) { return researchCard(r, true); }).join('') + '</div>' : missing('No research cited')) +
        sec('Alternatives considered', orMissing(x.alternatives)) + sec('Risks', orMissing(x.risks)) +
        sec('Pros and cons', proscons(x.pros, x.cons)) +
        sec('Decision', orMissing(x.decision, x.status === 'proposed' ? 'Not decided yet' : 'No note on the decision')) +
        (props.length || x.status === 'go' ? sec('Design proposals', props.length ? '<div class="chips-l">' + props.map(propChip).join('') + '</div>' : missing('No design proposal yet')) : '');
      linkRefs(app, key);
    }

    // research
    function sourceHtml(s) {
      var h = safeHref(s.href), ext = /^https?:/i.test(h);
      var label = h ? '<a href="' + esc(h) + '"' + (ext ? ' target="_blank" rel="noopener noreferrer"' : '') + '>' + esc(s.label || s.href) + '</a>' : esc(s.label || s.href);
      var meta = [s.kind ? esc(s.kind) : '', s.accessed ? 'accessed <span class="nw">' + esc(s.accessed) + '</span>' : '', ext ? esc(h.replace(/^https?:\/\/(www\.)?/i, '').split('/')[0]) : ''].filter(Boolean).join(' · ');
      return '<li>' + label + (meta ? ' <span class="small">' + meta + '</span>' : '') + (s.quote ? '<blockquote>' + esc(s.quote) + '</blockquote>' : '') + '</li>';
    }
    function researchCard(r, inner) {
      var hN = inner ? 'h3' : 'h2';
      var title = inner ? '<a href="' + H + 'research/' + encodeURIComponent(r.id) + '">' + esc(r.title) + '</a>' : esc(r.title);
      var cited = (r.ideas || []);
      return '<article class="' + (inner ? 'rcard inner' : 'card rcard') + '" id="' + (inner ? '' : 'res-' + esc(r.id)) + '">' +
        '<' + hN + ' tabindex="-1">' + title + '</' + hN + '><div class="tags">' + confTag(r.confidence) + (r.tags || []).map(function (t) { return '<span class="badge">' + esc(t) + '</span>'; }).join('') + (r.date ? '<span class="small">' + esc(r.date) + '</span>' : '') + '</div>' +
        orMissing(r.html, 'No summary') +
        '<div class="src-k">Sources</div>' + (r.sources && r.sources.length ? '<ol class="sources">' + r.sources.map(sourceHtml).join('') + '</ol>' : missing('No sources given')) +
        (!inner && cited.length ? '<div class="resolves citedby">Cited by ' + cited.map(ideaChip).join('') + '</div>' : '') + '</article>';
    }
    function viewResearch(args) {
      var conf = { high: 0, medium: 0, low: 0 };
      RESEARCH.forEach(function (r) { if (conf[r.confidence] != null) conf[r.confidence]++; });
      var nsrc = RESEARCH.reduce(function (a, r) { return a + (r.sources || []).length; }, 0);
      app.innerHTML = '<h1 class="view-title">Research <span class="small">' + RESEARCH.length + ' findings · ' + nsrc + ' sources</span></h1>' +
        '<p class="intro">' + ['high', 'medium', 'low'].filter(function (c) { return conf[c]; }).map(function (c) { return conf[c] + ' ' + c + ' confidence'; }).join(' · ') + '</p>' +
        RESEARCH.map(function (r) { return researchCard(r, false); }).join('');
      linkRefs(app, key);
      if (args[0] && RES[args[0]]) {
        var c = document.getElementById('res-' + args[0]);
        c.classList.add('hl');
        setTimeout(function () { c.scrollIntoView({ block: 'start' }); c.querySelector('h2').focus({ preventScroll: true }); }, 30);
      }
    }

    // proposals
    function viewProposals(args) {
      if (args[0] && PROP[args[0]]) return proposalDetail(PROP[args[0]], args[1]);
      app.innerHTML = '<h1 class="view-title">Design proposals <span class="small">' + PROPS.length + '</span></h1>' + PROPS.map(function (p) {
        return '<article class="card icard"><div class="tags">' + pTag(p.status) + (p.date ? '<span class="small">' + esc(p.date) + '</span>' : '') + '</div>' +
          '<h2><a href="' + H + 'proposals/' + encodeURIComponent(p.id) + '">' + esc(p.title) + '</a></h2>' +
          (given(p.brief) ? '<p class="ic-p">' + esc(clip(plain(p.brief), 220)) + '</p>' : '') + '<div class="lf-meta">' + propLine(p) + '</div></article>';
      }).join('');
    }
    function totalOf(p, o) {
      if (o.total != null) return o.total;
      var w = 0, t = 0;
      p.criteria.forEach(function (c) { var wt = c.weight || 1, s = o.scores && o.scores[c.id]; w += 5 * wt; t += (s ? s.score : 0) * wt; });
      return w ? Math.round(100 * t / w) : null;
    }
    function dots(n) { var s = ''; for (var i = 1; i <= 5; i++) s += i <= n ? '●' : '○'; return '<span class="dots" aria-hidden="true">' + s + '</span>'; }
    function optBadges(p, o) {
      var rec = p.recommendation && p.recommendation.option === o.id;
      return (o.status === 'adopted' ? '<span class="obadge ad">Adopted</span>' : '') + (rec ? '<span class="obadge rec">Recommended</span>' : '') +
        (o.status === 'rejected' ? '<span class="obadge rej">Rejected</span>' : '') + (o.status !== 'adopted' && o.status !== 'rejected' && !rec ? '<span class="obadge">Proposed</span>' : '');
    }
    function optHref(p, o) { return H + 'proposals/' + encodeURIComponent(p.id) + '/' + encodeURIComponent(o.id); }
    function compareHtml(p) {
      var opts = p.options;
      if (!p.criteria.length) return missing('No criteria agreed for this proposal, so the options are not scored.');
      var tot = opts.map(function (o) { return totalOf(p, o); });
      var best = Math.max.apply(null, tot.filter(function (t) { return t != null; }).concat([-1]));
      var head = '<tr><th scope="col" class="cr">Criterion <span class="small">(weight)</span></th>' + opts.map(function (o) {
        return '<th scope="col"><a href="' + optHref(p, o) + '">' + esc(o.title) + '</a><div class="ob">' + optBadges(p, o) + '</div></th>';
      }).join('') + '</tr>';
      var body = p.criteria.map(function (c) {
        return '<tr><th scope="row" class="cr">' + esc(c.label) + ' <span class="w" title="weight">×' + esc(c.weight || 1) + '</span>' + (c.desc ? '<div class="small">' + esc(c.desc) + '</div>' : '') + '</th>' + opts.map(function (o) {
          var s = o.scores && o.scores[c.id];
          if (!s) return '<td class="nos"><span class="missing-i">Not scored</span></td>';
          var face = '<span class="sc">' + esc(s.score) + '</span><span class="of">/5</span>' + dots(s.score);
          return '<td class="s' + esc(s.score) + '">' + (given(s.note) ? '<details class="sn"><summary>' + face + '<span class="sr"> (note)</span></summary><div class="note">' + s.note + '</div></details>' : '<div class="sn0">' + face + '</div>') + '</td>';
        }).join('') + '</tr>';
      }).join('');
      var foot = '<tr class="tot"><th scope="row" class="cr">Weighted total <span class="small">out of 100</span></th>' + tot.map(function (t) {
        return '<td' + (t === best && t != null ? ' class="best"' : '') + '><b>' + (t == null ? '—' : esc(t)) + '</b>' + (t === best && t != null && opts.length > 1 ? ' <span class="obadge hi">Highest</span>' : '') + '</td>';
      }).join('') + '</tr>';
      var notes = p.options.some(function (o) { return p.criteria.some(function (c) { var s = o.scores && o.scores[c.id]; return s && given(s.note); }); });
      return '<div class="mx-scroll" role="region" aria-label="Comparison matrix" tabindex="0"><table class="cmx" style="--n:' + opts.length + '"><thead>' + head + '</thead><tbody>' + body + '</tbody><tfoot>' + foot + '</tfoot></table></div>' +
        (p.criteria.some(function (c) { return c.desc; }) ? '<ul class="crit-m">' + p.criteria.filter(function (c) { return c.desc; }).map(function (c) { return '<li><b>' + esc(c.label) + ':</b> ' + esc(c.desc) + '</li>'; }).join('') + '</ul>' : '') +
        (notes ? '<button type="button" class="linkbtn" id="mx-notes" aria-pressed="false">Show all score notes</button>' : '');
    }
    function optShots(o, plat) {
      var d = o.platforms && o.platforms[plat];
      if (!d) return '<p class="noshot">No ' + esc(PL[plat] ? PL[plat].label.toLowerCase() : plat) + ' screenshots for this option.</p>';
      return (d.desc ? '<div class="small">' + d.desc + '</div>' : '') + d.images.map(function (f) { return figHtml(f, '', ''); }).join('');
    }
    function cmdHtml(label, cmd) {
      return '<div class="cmd"><div class="k">' + esc(label) + '</div><div class="cmd-row"><code>' + esc(cmd) + '</code><button type="button" class="btn copy" data-copy="' + esc(cmd) + '" aria-label="Copy: ' + esc(cmd) + '">Copy</button></div></div>';
    }
    function optionCard(p, o, plat, plats) {
      var adopted = !!p.adopted || p.status === 'adopted';
      var d = o.diff, t = totalOf(p, o);
      var branch = o.branch || 'design/' + p.id + '/' + o.id;
      var cmds = (!o.gone ? cmdHtml('Look at it locally', 'git switch ' + branch) : '<p class="small">The branch was discarded. The diff and screenshots above are the saved snapshot.</p>') +
        (!adopted ? cmdHtml('Adopt this option', 'review-kit adopt ' + (KINDS[key] ? key + ' ' : '') + p.id + ' ' + o.id) : '');
      return '<article class="card opt' + (o.status === 'adopted' ? ' s-ad' : '') + (p.recommendation && p.recommendation.option === o.id ? ' s-rec' : '') + (o.status === 'rejected' ? ' s-rej' : '') + '" id="opt-' + esc(o.id) + '" data-o="' + esc(o.id) + '">' +
        '<div class="ob">' + optBadges(p, o) + (t != null && p.criteria.length ? '<span class="otot">' + esc(t) + ' / 100</span>' : '') + '</div>' +
        '<h3 tabindex="-1">' + esc(o.title) + '</h3>' +
        (plats.length ? '<div class="oshots">' + optShots(o, plat) + '</div>' : '') +
        '<h4>Summary</h4>' + orMissing(o.summary) + '<h4>Why</h4>' + orMissing(o.reasoning) +
        proscons(o.pros, o.cons).replace(/<h3>/g, '<h4>').replace(/<\/h3>/g, '</h4>') +
        (given(o.evidence) ? '<h4>Evidence</h4><div class="rich ev">' + o.evidence + '</div>' : '') +
        '<h4>Changes</h4>' + (d ? '<p class="small">' + d.files.length + ' file' + (d.files.length === 1 ? '' : 's') + ' · <span class="add">+' + esc(d.insertions) + '</span> <span class="del">−' + esc(d.deletions) + '</span>' + (o.head ? ' · <code>' + esc(String(o.head).slice(0, 7)) + '</code>' : '') + '</p>' +
          '<ul class="dstat">' + d.files.map(function (f) { return '<li><code>' + esc(f.path) + '</code><span>' + (f.binary ? '<span class="small">binary</span>' : '<span class="add">+' + esc(f.add) + '</span> <span class="del">−' + esc(f.del) + '</span>') + '</span></li>'; }).join('') + '</ul>' +
          (d.text ? '<details class="diffbox"><summary>Show the diff</summary><div class="diffv"></div></details>' : '') : missing('No diff recorded')) +
        '<div class="cmds">' + cmds + '</div></article>';
    }
    function renderDiff(box, text, truncated) { // text is shown with textContent only, never parsed as HTML
      var files = [], cur = null;
      var lines = String(text).split('\n');
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      lines.forEach(function (line) {
        if (/^diff --git /.test(line) || !cur) {
          var m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
          cur = { path: m ? m[2] : (/^diff /.test(line) ? line.slice(5) : 'Patch'), lines: [], add: 0, del: 0 };
          files.push(cur);
          if (/^diff /.test(line)) { cur.lines.push(line); return; }
        }
        cur.lines.push(line);
      });
      files.forEach(function (f, i) {
        var det = document.createElement('details');
        det.className = 'dfile';
        if (i < 4) det.open = true;
        var sum = document.createElement('summary');
        var pre = document.createElement('pre'), inner = document.createElement('div');
        pre.className = 'dl'; inner.className = 'dli';
        pre.appendChild(inner);
        f.lines.forEach(function (l) {
          var s = document.createElement('span');
          var c = /^(\+\+\+|---) /.test(l) || /^(diff |index |new file|deleted file|similarity|rename |old mode|new mode|Binary files)/.test(l) ? 'm' : l.charAt(0) === '+' ? 'a' : l.charAt(0) === '-' ? 'd' : /^@@/.test(l) ? 'h' : 'c';
          if (c === 'a') f.add++; else if (c === 'd') f.del++;
          s.className = c;
          s.textContent = l;
          inner.appendChild(s);
        });
        var code = document.createElement('code'); code.textContent = f.path;
        var cnt = document.createElement('span'); cnt.className = 'small'; cnt.textContent = ' +' + f.add + ' −' + f.del;
        sum.appendChild(code); sum.appendChild(cnt);
        det.appendChild(sum); det.appendChild(pre);
        box.appendChild(det);
      });
      if (truncated) {
        var p = document.createElement('p'); p.className = 'missing';
        p.textContent = 'This diff was cut short because it is large. Switch to the branch to see all of it.';
        box.appendChild(p);
      }
    }
    function copyText(btn) {
      var txt = btn.getAttribute('data-copy');
      function done(ok) {
        btn.textContent = ok ? 'Copied' : 'Select and copy';
        var live = document.getElementById('rk-live'); if (live) live.textContent = ok ? 'Copied: ' + txt : 'Copy failed. Select the command and copy it.';
        setTimeout(function () { btn.textContent = 'Copy'; }, 2000);
        if (!ok) { var r = document.createRange(); r.selectNodeContents(btn.parentNode.querySelector('code')); var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r); }
      }
      function fallback() {
        var ta = document.createElement('textarea'); ta.value = txt; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        var ok = false; try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
        document.body.removeChild(ta); btn.focus(); done(ok);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(function () { done(true); }, fallback);
      else fallback();
    }
    function proposalDetail(p, optId) {
      var opts = p.options;
      var plats = PLATS.filter(function (pid) { return opts.some(function (o) { return o.platforms && o.platforms[pid]; }); });
      var plat = store('propPlat');
      if (plats.indexOf(plat) < 0) plat = plats[0];
      var rec = p.recommendation, ad = p.adopted;
      var recO = rec && opts.filter(function (o) { return o.id === rec.option; })[0];
      var html = '<p class="back"><a href="' + H + 'proposals">‹ All proposals</a></p><h1 class="view-title">' + esc(p.title) + '</h1>' +
        '<div class="tags dtags">' + pTag(p.status) + (p.date ? '<span class="small">' + esc(p.date) + '</span>' : '') + (p.idea ? '<span class="small">From idea</span> ' + ideaChip(p.idea) : '') + '</div>' +
        sec('Brief', orMissing(p.brief));
      if (ad) html += '<div class="callout ok"><div class="k">Adopted</div><h2>' + esc(optTitle(p, ad.option)) + '</h2><p class="small">' + [ad.date ? 'on ' + esc(ad.date) : '', ad.commit ? 'commit <code>' + esc(String(ad.commit).slice(0, 10)) + '</code>' : ''].filter(Boolean).join(' · ') + '</p>' + (given(p.decision) ? '<div class="rich">' + p.decision + '</div>' : '') + '</div>';
      else if (given(p.decision)) html += '<div class="callout"><div class="k">Decision</div><div class="rich">' + p.decision + '</div></div>';
      if (rec) html += '<div class="callout rec"><div class="k">Recommended</div><h2><a href="' + optHref(p, { id: rec.option }) + '">' + esc(recO ? recO.title : rec.option) + '</a></h2>' + orMissing(rec.html, 'No reasoning given for the recommendation') + '</div>';
      else if (p.status === 'open' && opts.length > 1) html += '<div class="callout"><div class="k">Recommended</div>' + missing('No recommendation yet') + '</div>';
      html += sec('Comparison', compareHtml(p));
      html += '<section class="opts-sec"><div class="opts-head"><h2>Options <span class="small">' + opts.length + '</span></h2>' + (plats.length > 1 ? seg('plat', plats.map(function (x) { return [x, PL[x].label]; }), plat) : '') + '</div>' +
        '<div class="opts" style="--n:' + Math.min(opts.length, 3) + '">' + opts.map(function (o) { return optionCard(p, o, plat, plats); }).join('') + '</div>' +
        '<section class="card diffpanel" id="diffpanel" hidden aria-labelledby="dp-h"><div class="dp-head"><h3 id="dp-h" tabindex="-1"></h3><button type="button" class="btn" id="dp-close">Close the diff</button></div><div class="diffv"></div></section></section>';
      app.innerHTML = html;
      linkRefs(app, key);
      var s = app.querySelector('.opts-head [data-seg=plat]');
      if (s) s.addEventListener('click', function (e) {
        var b = e.target.closest('button'); if (!b) return;
        s.querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', x === b); });
        plat = b.getAttribute('data-v'); store('propPlat', plat);
        opts.forEach(function (o) { var el = app.querySelector('#opt-' + CSS.escape(o.id) + ' .oshots'); if (el) { el.innerHTML = optShots(o, plat); linkRefs(el, key); } });
      });
      var nb = document.getElementById('mx-notes');
      if (nb) nb.addEventListener('click', function () {
        var on = nb.getAttribute('aria-pressed') !== 'true';
        app.querySelectorAll('.cmx details').forEach(function (d) { d.open = on; });
        nb.setAttribute('aria-pressed', on); nb.textContent = on ? 'Hide all score notes' : 'Show all score notes';
      });
      // Diffs: inline when the options are stacked (phones), in one full-width panel under the columns when they sit
      // side by side, so long lines stay readable. The option's <details> stays the toggle in both layouts.
      var panel = document.getElementById('diffpanel');
      function sideBySide() { return getComputedStyle(app.querySelector('.opts')).gridTemplateColumns.split(' ').length > 1; }
      function optOf(det) { var id = det.closest('.opt').getAttribute('data-o'); return opts.filter(function (x) { return x.id === id; })[0]; }
      function hidePanel() { panel.hidden = true; panel.removeAttribute('data-o'); panel.querySelector('.diffv').textContent = ''; }
      app.querySelectorAll('.diffbox').forEach(function (det) {
        det.addEventListener('toggle', function () {
          var o = optOf(det), v = det.querySelector('.diffv');
          if (!det.open) { if (panel.getAttribute('data-o') === o.id) hidePanel(); return; }
          if (!sideBySide()) { if (!v.childNodes.length || v.querySelector('.dp-note')) { v.textContent = ''; renderDiff(v, o.diff.text, o.diff.truncated); } return; }
          app.querySelectorAll('.diffbox[open]').forEach(function (d) { if (d !== det) d.open = false; }); // one diff at a time
          v.textContent = '';
          var note = document.createElement('p'); note.className = 'small dp-note'; note.textContent = 'The diff is open below the options.';
          v.appendChild(note);
          var pv = panel.querySelector('.diffv');
          pv.textContent = '';
          renderDiff(pv, o.diff.text, o.diff.truncated);
          document.getElementById('dp-h').textContent = 'Diff: ' + o.title;
          panel.setAttribute('data-o', o.id);
          panel.hidden = false;
          panel.scrollIntoView({ block: 'start' });
          document.getElementById('dp-h').focus({ preventScroll: true });
        });
      });
      document.getElementById('dp-close').addEventListener('click', function () {
        var id = panel.getAttribute('data-o');
        var det = id && app.querySelector('#opt-' + CSS.escape(id) + ' .diffbox');
        hidePanel();
        if (det) { det.open = false; var sm = det.querySelector('summary'); sm.scrollIntoView({ block: 'center' }); sm.focus({ preventScroll: true }); }
      });
      app.querySelector('.opts').addEventListener('click', function (e) {
        var c = e.target.closest('[data-copy]'); if (c) { copyText(c); return; }
        var img = e.target.closest('img[data-lb]'); if (!img) return;
        var all = Array.prototype.slice.call(app.querySelectorAll('.opts img[data-lb]'));
        lb.open(all.map(function (x) { var it = imgItem(x); it.cap = '<b>' + esc(x.closest('.opt').querySelector('h3').textContent) + '</b> ' + it.cap; return it; }), all.indexOf(img));
      });
      if (optId) {
        var oc = app.querySelector('#opt-' + CSS.escape(optId));
        if (oc) {
          oc.classList.add('hl');
          setTimeout(function () { oc.scrollIntoView({ block: 'start' }); oc.querySelector('h3').focus({ preventScroll: true }); }, 30);
        }
      }
    }

    // a card for the combined landing page, with numbers that fit the kind
    function card(label) {
      var acc = P.theme.accent, body;
      if (KIND === 'ideas' || (KIND === 'design' && !PROPS.length && IDEAS.length)) {
        var n = ideaCounts();
        body = '<div class="small">' + [IDEAS.length + ' idea' + (IDEAS.length === 1 ? '' : 's'), RESEARCH.length + ' research finding' + (RESEARCH.length === 1 ? '' : 's'), 'updated ' + esc(D.generated)].join(' · ') + '</div>' +
          tiles([[n.go, 'Go', 'fixed'], [n.maybe, 'Maybe', 'partial'], [n.proposed, 'Proposed', 'open']]);
      } else if (KIND === 'design') {
        var nOpt = PROPS.reduce(function (a, p) { return a + p.options.length; }, 0);
        var cnt = function (st) { return PROPS.filter(function (p) { return p.status === st; }).length; };
        body = '<div class="small">' + [PROPS.length + ' proposal' + (PROPS.length === 1 ? '' : 's'), nOpt + ' options', 'updated ' + esc(D.generated)].join(' · ') + '</div>' +
          tiles([[cnt('open'), 'Open', 'open'], [cnt('adopted'), 'Adopted', 'fixed'], [cnt('closed'), 'Closed', 'open']]) +
          '<ul class="list rv-props">' + PROPS.filter(function (p) { return p.status === 'open'; }).slice(0, 3).map(propRow).join('') + '</ul>';
      } else {
        var list = ALL.filter(function (it) { return it.counted; }), c = counts(list);
        var items = []; D.plan.forEach(function (g) { items = items.concat(g.items); });
        body = '<div class="small">' + [list.length + ' issue' + (list.length === 1 ? '' : 's'), D.fixes.length + ' fix' + (D.fixes.length === 1 ? '' : 'es'), 'updated ' + esc(D.generated)].join(' · ') + '</div>' + statsHtml(c) +
          (items.length ? '<p class="small rv-plan">Plan: ' + planSummary(planCounts(items)) + '</p>' : '');
      }
      var go = VIEWS.filter(function (v) { return v[0] !== 'overview'; });
      return '<section class="card rv-card"><h2><a class="rv-t" href="' + H + 'overview">' + esc(label) + '</a></h2>' + body +
        '<div class="rv-go"><a class="btn primary rv-open" href="' + H + 'overview" style="background:' + esc(acc) + ';border-color:' + esc(acc) + ';color:' + (lum(hex(acc)) > 0.45 ? '#13232a' : '#fff') + '">Open ' + esc(label) + ' review</a>' +
        go.map(function (v) { return '<a class="btn" href="' + H + v[0] + '">' + v[1] + '</a>'; }).join('') + '</div></section>';
    }

    return {
      key: key, D: D, P: P, kind: KIND, theme: theme, route: route, hasView: function (v) { return VIEWS.some(function (x) { return x[0] === v; }); },
      view: function () { return current; }, card: card,
      lookup: function (what, id) { return what === 'ideas' ? IDEA[id] : what === 'research' ? RES[id] : PROP[id]; },
      ids: function () { return RESEARCH.map(function (r) { return r.id; }).concat(IDEAS.map(function (x) { return x.id; })); }
    };
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
      if (e.key === 'Tab') { // keep focus inside the dialog
        var f = Array.prototype.filter.call(root.querySelectorAll('button, a[href]'), function (x) { return x.offsetParent !== null; });
        var i = f.indexOf(document.activeElement);
        if (e.shiftKey ? i <= 0 : i === f.length - 1 || i < 0) { e.preventDefault(); f[e.shiftKey ? f.length - 1 : 0].focus(); }
        return;
      }
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

  // ------------------------------------------------------------ reviews, switch and routing
  var REV = LIST.map(function (x) { var r = Review(x.data, x.key); r.label = x.label; return r; });
  function findIn(what, id, key) { // an idea or proposal by id: this review first, then the others in a combined site
    var order = REV.filter(function (r) { return r.key === key; }).concat(REV.filter(function (r) { return r.key !== key; }));
    for (var i = 0; i < order.length; i++) {
      var x = order[i].lookup(what, id);
      if (x) return { x: x, h: order[i].key ? '#/' + order[i].key + '/' : '#/' };
    }
    return null;
  }
  // Research and idea ids mentioned in rich text ("[r-1]", "(r-2)", "i-3") become links. Works on rendered text nodes
  // only (never rebuilds HTML) and skips text already inside a link, code, a button or a summary.
  var REF_RE;
  function refRe() {
    if (REF_RE !== undefined) return REF_RE;
    var ids = [];
    REV.forEach(function (r) { r.ids().forEach(function (id) { if (ids.indexOf(id) < 0) ids.push(id); }); });
    ids.sort(function (a, b) { return b.length - a.length; });
    REF_RE = ids.length ? new RegExp('(^|[^\\w.:-])(\\[)?(' + ids.map(function (id) { return id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|') + ')(\\])?(?![\\w-])', 'g') : null;
    return REF_RE;
  }
  function linkRefs(root, key) {
    var re = refRe();
    if (!re || !root) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) { return n.parentNode.closest('a, code, pre, button, summary, textarea, script, style, .ref') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; }
    });
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(function (n) {
      var text = n.nodeValue, m, last = 0, frag = null;
      re.lastIndex = 0;
      while ((m = re.exec(text))) {
        var id = m[3];
        var f = findIn('research', id, key), what = 'research';
        if (!f) { f = findIn('ideas', id, key); what = 'ideas'; }
        if (!f) continue;
        if (m[2] && !m[4]) continue; // "[r-1" without its closing bracket: leave it alone
        frag = frag || document.createDocumentFragment();
        var start = m.index + m[1].length;
        frag.appendChild(document.createTextNode(text.slice(last, start)));
        var a = document.createElement('a');
        a.className = 'ref';
        a.href = f.h + what + '/' + encodeURIComponent(id);
        a.textContent = id;
        a.setAttribute('aria-label', (what === 'research' ? 'Research ' : 'Idea ') + id + ': ' + f.x.title);
        frag.appendChild(a);
        last = m.index + m[0].length - (m[4] && !m[2] ? 1 : 0); // keep a "]" that had no opening bracket
      }
      if (!frag) return;
      frag.appendChild(document.createTextNode(text.slice(last)));
      n.parentNode.replaceChild(frag, n);
    });
  }
  var BYKEY = {}; REV.forEach(function (r) { BYKEY[r.key] = r; });
  var shown = null;
  var TITLE = document.title;
  var sw = null;
  if (COMBINED) {
    document.documentElement.classList.add('rk-combined');
    sw = document.createElement('nav');
    sw.className = 'rsw'; sw.id = 'review-switch'; sw.setAttribute('aria-label', 'Reviews');
    var brand = document.querySelector('.brand');
    brand.setAttribute('href', '#/');
    brand.parentNode.insertBefore(sw, brand.nextSibling);
  }
  function renderSwitch(cur) {
    var view = cur ? cur.view() : 'overview';
    function link(href, label, on) { return '<a href="' + href + '"' + (on ? ' class="on" aria-current="true"' : '') + '>' + esc(label) + '</a>'; }
    sw.innerHTML = link('#/', 'All', !cur) + REV.map(function (r) {
      return link('#/' + r.key + '/' + (r.hasView(view) ? view : 'overview'), r.label, r === cur);
    }).join('');
  }
  function show(r, parts) {
    if (shown !== r) {
      r.theme();
      if (COMBINED) document.title = (r.P.name + ' ' + r.P.title).trim();
      shown = r;
    }
    r.route(parts);
    if (COMBINED) renderSwitch(r);
  }
  function route() {
    var parts = location.hash.replace(/^#\/?/, '').split('/');
    if (!COMBINED) return show(REV[0], parts);
    if (BYKEY[parts[0]]) return show(BYKEY[parts[0]], parts.slice(1));
    if (parts[0] && REV[0].hasView(parts[0])) return show(shown || REV[0], parts); // a single-review link such as #/issues/x
    landing();
  }

  function focusView() { // keyboard and screen reader users land on the new view, not back at the top of the page
    var h = app.querySelector('h1'); if (!h) return;
    h.setAttribute('tabindex', '-1');
    h.focus({ preventScroll: true });
  }
  window.addEventListener('hashchange', function () { if (!lb.ignoreHash) { route(); window.scrollTo(0, 0); focusView(); } });
  document.getElementById('skip').addEventListener('click', function (e) { e.preventDefault(); focusView(); });

  // ------------------------------------------------------------ combined landing: every review side by side
  function landing() {
    if (shown !== null || !document.getElementById('rk-theme')) REV[0].theme();
    shown = null;
    var names = REV.map(function (r) { return r.P.name; }).filter(function (n, i, a) { return a.indexOf(n) === i; });
    document.getElementById('brand').innerHTML = names.length === 1 ? '<b>' + esc(names[0]) + '</b> reviews' : '<b>Reviews</b>';
    document.title = TITLE;
    document.getElementById('tabs-top').innerHTML = '';
    document.getElementById('tabs-bottom').innerHTML = '';
    document.body.classList.add('no-bottom');
    renderSwitch(null);
    app.innerHTML = '<h1 class="view-title">Overview</h1><div class="grid2">' + REV.map(function (r) { return r.card(r.label); }).join('') + '</div>';
  }

  if (wide.addEventListener) wide.addEventListener('change', function () { if (/fixes/.test(location.hash)) route(); });
  route();
})();
