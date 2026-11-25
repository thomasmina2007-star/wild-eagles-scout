/* Wild Eagles Scout - frontend SPA */
(function () {
'use strict';

var $app = document.getElementById('app');
var state = {
  token: localStorage.getItem('wes_token') || '',
  me: null,
  boot: null,          // bootstrap payload
  week: null, weekOffset: 0,
  person: null,
  hist: null, histPage: 1,
  busy: false
};

var DEMO = /[?&]demo=1/.test(location.search);

/* ---------------- API (JSONP - works from any static host) ---------------- */

function api(params) {
  if (DEMO) return demoApi(params);
  return new Promise(function (resolve, reject) {
    var cb = 'wescb' + Math.random().toString(36).slice(2);
    var s = document.createElement('script');
    var done = false;
    function cleanup() { try { delete window[cb]; } catch (e) { window[cb] = undefined; } s.remove(); }
    var timer = setTimeout(function () {
      if (!done) { done = true; cleanup(); reject(new Error('The server took too long. Check your internet and try again.')); }
    }, 25000);
    window[cb] = function (data) {
      if (done) return; done = true; clearTimeout(timer); cleanup();
      resolve(data);
    };
    s.onerror = function () {
      if (done) return; done = true; clearTimeout(timer); cleanup();
      reject(new Error('Could not reach the server. Check the app URL and your internet.'));
    };
    var q = [];
    Object.keys(params).forEach(function (k) {
      if (params[k] !== undefined && params[k] !== null && params[k] !== '') {
        q.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
      }
    });
    q.push('callback=' + cb);
    s.src = CONFIG.API_URL + (CONFIG.API_URL.indexOf('?') === -1 ? '?' : '&') + q.join('&');
    document.head.appendChild(s);
  });
}

/* Read-only pages keep their last good answer on the phone, so the app opens and
   shows the last synced data with no internet. (Person details are never kept:
   they hold private sign-up data.) */
var CACHED_READS = { bootstrap: 1, week: 1, history: 1, halls: 1 };
function readKey(params) {
  var o = {};
  Object.keys(params).sort().forEach(function (k) { if (k !== 'token' && k !== 'callback') o[k] = params[k]; });
  return 'wes_c_' + JSON.stringify(o);
}
function clearReadCache() {
  Object.keys(localStorage).forEach(function (k) { if (k.indexOf('wes_c_') === 0 || k.indexOf('wes_week_') === 0) localStorage.removeItem(k); });
}

function call(params) {
  if (state.token && !params.token) params.token = state.token;
  var ck = CACHED_READS[params.action] && !DEMO ? readKey(params) : null;
  return api(params).then(function (r) {
    if (ck && r && r.ok === true) {
      state.offline = false;
      try { localStorage.setItem(ck, JSON.stringify(r)); } catch (e) {}
      renderSyncPill();
    }
    if (!r || r.ok !== true) {
      var msg = (r && r.error) || 'Something went wrong.';
      if (/log in|Session expired|access was removed/i.test(msg)) { logoutLocal(); }
      throw new Error(msg);
    }
    return r;
  }, function (e) { throw e; }).catch(function (e) {
    if (ck && isOfflineErr(e)) {
      var saved = null;
      try { saved = JSON.parse(localStorage.getItem(ck) || 'null'); } catch (e2) {}
      if (saved) { state.offline = true; renderSyncPill(); return saved; }
    }
    throw e;
  });
}

/* ---------------- offline support ---------------- */

function isOfflineErr(e) {
  return /internet|reach the server|took too long/i.test((e && e.message) || '');
}

/* Mutating calls (mark / markAll): on no internet, queue locally and pretend success.
   The server upsert is idempotent per member-week, so a later retry cannot duplicate. */
function callMut(params) {
  return call(params).catch(function (e) {
    if (!isOfflineErr(e)) throw e;
    WESOutbox.enqueue(params);
    renderSyncPill();
    return { ok: true, queued: true };
  });
}

var flushing = false;
function flushOutbox() {
  if (flushing || DEMO) return;
  if (!WESOutbox.count()) { renderSyncPill(); return; }
  if (!state.token) return;
  flushing = true;
  renderSyncPill();
  var progress = false;
  (function next() {
    if (!WESOutbox.count()) {
      flushing = false;
      renderSyncPill();
      if (progress) {
        toast('Offline marks synced.');
        refreshBoot().then(function () { render(); });
      }
      return;
    }
    var op = WESOutbox.all()[0];
    call(op).then(function () {
      progress = true;
      WESOutbox.shift();
      next();
    }).catch(function (e) {
      if (isOfflineErr(e)) {
        flushing = false; // still offline; try again on the next trigger
        renderSyncPill();
      } else if (/Record not found/i.test(e.message || '')) {
        WESOutbox.shift(); // already gone server-side; nothing to undo
        next();
      } else {
        // keep the mark (never lose it) but don't let one bad op block the rest
        WESOutbox.requeue();
        flushing = false;
        renderSyncPill();
      }
    });
  })();
}

function renderSyncPill() {
  var pill = document.getElementById('syncpill');
  if (!pill) return;
  var n = (typeof WESOutbox !== 'undefined') ? WESOutbox.count() : 0;
  if (state.offline && !n) {
    pill.style.display = '';
    pill.textContent = 'Offline \u00b7 last synced data';
    pill.className = 'syncpill pending';
  } else if (flushing && n) {
    pill.style.display = '';
    pill.textContent = 'Syncing ' + n + ' mark' + (n > 1 ? 's' : '') + '...';
    pill.className = 'syncpill syncing';
  } else if (n) {
    pill.style.display = '';
    pill.textContent = n + ' mark' + (n > 1 ? 's' : '') + ' pending sync';
    pill.className = 'syncpill pending';
  } else {
    pill.style.display = 'none';
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', function () {
    flushOutbox();
    if (state.offline && state.token) { state.boot = null; render(); } // back online: load fresh data
  });
  setInterval(function () { flushOutbox(); }, 30000);
}

/* ---------------- helpers ---------------- */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function da(s) { return '<span dir="auto">' + esc(s) + '</span>'; } // bidi-safe text
function initials(name) {
  var p = String(name || '?').trim().split(/\s+/);
  return ((p[0] || ' ')[0] + (p[1] ? p[1][0] : '')).toUpperCase();
}
function fmtDate(d) {
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || '');
  if (!m) return d;
  return parseInt(m[3], 10) + ' ' + months[parseInt(m[2], 10) - 1];
}
function el(html) { var d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; }
function go(hash) { location.hash = hash; }
function setBusy(b) { state.busy = b; $$('button').forEach(function (x) { x.disabled = b; }); }
function $(s, r) { return (r || document).querySelector(s); }
function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
function toast(msg, isErr) {
  var t = el('<div style="position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:99;' +
    'background:' + (isErr ? '#3a1518' : '#122b1b') + ';color:' + (isErr ? '#f87171' : '#4ade80') + ';' +
    'border:1px solid ' + (isErr ? '#7f2d33' : '#1f5c34') + ';padding:11px 18px;border-radius:11px;' +
    'font-size:14px;font-weight:600;max-width:88%;box-shadow:0 6px 24px rgba(0,0,0,.5)">' + esc(msg) + '</div>');
  document.body.appendChild(t);
  setTimeout(function () { t.remove(); }, 2600);
}
function handleErr(e) { setBusy(false); toast(e.message || String(e), true); }

var I = {
  menu: '<svg viewBox="0 0 24 24"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>',
  home: '<svg viewBox="0 0 24 24"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>',
  users: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><circle cx="17" cy="9" r="2.6"/><path d="M15.7 14.4c2.9.3 5.8 2.2 5.8 5.6"/></svg>',
  check: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="17" rx="3"/><path d="m8 12.5 2.7 2.7L16.5 9"/></svg>',
  hist: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/></svg>',
  flag: '<svg viewBox="0 0 24 24"><path d="M12 3 4.5 7.5 12 12l7.5-4.5z"/><path d="M12 12v9"/></svg>',
  shield: '<svg viewBox="0 0 24 24"><path d="M12 3 5 6v5c0 4.5 3 8.2 7 10 4-1.8 7-5.5 7-10V6z"/><path d="m9 11.5 2.2 2.2L15.5 9"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.8-3.8"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  pin: '<svg viewBox="0 0 24 24"><path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11z"/><circle cx="12" cy="10" r="2.6"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2m-8 0 1 13h8l1-13"/></svg>',
  left: '<svg viewBox="0 0 24 24"><path d="m15 5-7 7 7 7"/></svg>',
  right: '<svg viewBox="0 0 24 24"><path d="m9 5 7 7-7 7"/></svg>',
  out: '<svg viewBox="0 0 24 24"><path d="M15 12H4m0 0 4-4m-4 4 4 4"/><path d="M10 4h9v16h-9"/></svg>',
  userplus: '<svg viewBox="0 0 24 24"><circle cx="10" cy="8" r="3.5"/><path d="M3.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><path d="M18 8v6M15 11h6"/></svg>',
  logoGlyph: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.2"/><path d="M3.4 19.5c0-3.3 2.5-5.5 5.6-5.5s5.6 2.2 5.6 5.5"/><circle cx="17" cy="9" r="2.4"/><path d="m15.6 15.6 1.6 1.6 3-3.4"/></svg>'
};

function statusBadge(s) {
  if (s === 'Present') return '<span class="badge green">Present</span>';
  if (s === 'Absent') return '<span class="badge red">Absent</span>';
  if (s === 'Excused') return '<span class="badge orange">Excused</span>';
  if (s === 'Week off') return '<span class="badge blue">Week off</span>';
  return '<span class="badge">' + esc(s || '') + '</span>';
}
function memberStatusBadge(s) {
  return s === 'flagged' ? '<span class="badge red">Flagged</span>' : '<span class="badge">Active</span>';
}

/* ---------------- shell ---------------- */

function shell(title, bodyHtml, activeNav) {
  var me = state.me || {};
  var nav = [
    ['home', '#/home', I.home, 'Home'],
    ['members', '#/members', I.users, 'Members'],
    ['attendance', '#/attendance', I.check, 'Take attendance'],
    ['history', '#/history', I.hist, 'Attendance history'],
    ['followup', '#/followup', I.flag, 'Needs follow-up'],
    ['halls', '#/halls', I.pin, 'Halls \u00b7 \u0642\u0627\u0639\u0627\u062a']
  ];
  if (me.role === 'admin') nav.push(['admins', '#/admins', I.shield, 'Admins and leaders']);
  var navHtml = nav.map(function (n) {
    return '<a href="' + n[1] + '" class="' + (activeNav === n[0] ? 'active' : '') + '">' + n[2] + esc(n[3]) + '</a>';
  }).join('');
  $app.innerHTML =
    '<div class="topbar">' +
      '<button class="iconbtn" id="menuBtn" aria-label="Menu">' + I.menu + '</button>' +
      '<div class="brand"><span class="logo crest"><img src="crest.png" alt=""></span> Wild Eagles Scout</div>' +
      '<span id="syncpill" class="syncpill" style="display:none"></span>' +
    '</div>' +
    '<div class="page">' + bodyHtml + '</div>' +
    '<div class="drawer" id="drawer">' +
      '<div class="scrim" id="scrim"></div>' +
      '<div class="panel">' +
        '<div class="phead"><span class="logo crest"><img src="crest.png" alt=""></span>' +
          '<div><div class="t1">Wild Eagles Scout</div><div class="t2">Team attendance</div></div></div>' +
        '<nav>' + navHtml + '</nav>' +
        '<div class="pfoot"><span class="avatar">' + esc(initials(me.name)) + '</span>' +
          '<div><div class="nm">' + da(me.name || '') + '</div><div class="em">' + esc(me.email || '') + '</div></div>' +
          '<button class="iconbtn out" id="logoutBtn" aria-label="Log out">' + I.out + '</button></div>' +
      '</div>' +
    '</div>';
  var drawer = $('#drawer');
  $('#menuBtn').onclick = function () { drawer.classList.add('open'); };
  $('#scrim').onclick = function () { drawer.classList.remove('open'); };
  $$('nav a', drawer).forEach(function (a) { a.onclick = function () { drawer.classList.remove('open'); }; });
  $('#logoutBtn').onclick = function () {
    call({ action: 'logout' }).catch(function () {}).then(function () { logoutLocal(); go('#/login'); render(); });
  };
  renderSyncPill();
}

function logoutLocal() {
  state.token = ''; state.me = null; state.boot = null; state.week = null; state.person = null; state.hist = null;
  localStorage.removeItem('wes_token');
  clearReadCache();
}

/* ---------------- login ---------------- */

function loginView(step, email) {
  var configured = DEMO || (typeof CONFIG !== 'undefined' && CONFIG.API_URL && CONFIG.API_URL.indexOf('http') === 0);
  var inner;
  if (!configured) {
    inner = '<div class="err">The app is not connected yet. Open <b>config.js</b> and paste your Apps Script Web app URL, then refresh.</div>';
  } else if (step === 'code') {
    inner =
      '<h1>Check your email</h1><div class="sub">We sent a 6-digit code to <b>' + esc(email) + '</b>.</div>' +
      '<div class="card">' +
        '<label class="f">Login code</label>' +
        '<input class="input" id="code" inputmode="numeric" autocomplete="one-time-code" placeholder="6-digit code" maxlength="6">' +
        '<button class="btn green block big" id="verifyBtn">Log in</button>' +
        '<button class="backlink" id="backBtn">&larr; Use a different email</button>' +
      '</div>';
  } else {
    inner =
      '<h1>Wild Eagles Scout</h1><div class="sub">Team attendance. Log in with your admin or leader email.</div>' +
      '<div class="card">' +
        '<label class="f">Email</label>' +
        '<input class="input" id="email" type="email" autocomplete="email" placeholder="you@gmail.com" dir="ltr">' +
        '<button class="btn green block big" id="sendBtn">Send login code</button>' +
      '</div>' +
      '<div class="sub" style="font-size:12.5px">Only admins and team leaders can log in. Members do not need to log in.</div>';
  }
  $app.innerHTML = '<div class="loginwrap"><span class="logo crest"><img src="crest.png" alt=""></span>' + inner + '</div>';

  var sendBtn = $('#sendBtn');
  if (sendBtn) sendBtn.onclick = function () {
    var email = $('#email').value.trim();
    if (!email) return toast('Type your email first.', true);
    setBusy(true);
    api({ action: 'login', email: email }).then(function (r) {
      setBusy(false);
      if (!r.ok) return toast(r.error || 'Could not send the code.', true);
      loginView('code', email.toLowerCase());
    }).catch(handleErr);
  };
  var verifyBtn = $('#verifyBtn');
  if (verifyBtn) verifyBtn.onclick = function () {
    var code = $('#code').value.trim();
    if (!code) return toast('Type the code from the email.', true);
    setBusy(true);
    api({ action: 'verify', email: email, code: code }).then(function (r) {
      setBusy(false);
      if (!r.ok) return toast(r.error || 'Wrong code.', true);
      state.token = r.token; state.me = r.me;
      localStorage.setItem('wes_token', r.token);
      state.boot = null;
      go('#/home'); render();
    }).catch(handleErr);
  };
  var backBtn = $('#backBtn');
  if (backBtn) backBtn.onclick = function () { loginView('email'); };
  var inp = $('#email') || $('#code');
  if (inp) inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') (sendBtn || verifyBtn).click(); });
}

/* ---------------- home ---------------- */

function bdayCard(list) {
  if (!list || !list.length) return '';
  var rows = list.map(function (x) {
    var when = x.inDays === 0 ? '<span class="badge green">Today</span>'
      : '<span class="badge">' + (x.inDays === 1 ? 'Tomorrow' : 'In ' + x.inDays + ' days') + '</span>';
    return '<div class="listrow" data-go="#/person/' + esc(x.id) + '"><div><div class="nm">&#127874; ' + da(x.name) + '</div>' +
      '<div class="tm">' + da(x.team) + ' &middot; turns ' + x.turns + (x.inDays ? ' on ' + fmtDate(x.date) : '') + '</div></div>' + when + '</div>';
  }).join('');
  var today = list.filter(function (x) { return x.inDays === 0; });
  if (today.length) {
    var day = new Date().toISOString().slice(0, 10);
    if (localStorage.getItem('wes_bday_seen') !== day) {
      localStorage.setItem('wes_bday_seen', day);
      setTimeout(function () { toast('\ud83c\udf82 Birthday today: ' + today.map(function (x) { return x.name; }).join(', ')); }, 400);
    }
  }
  return '<div class="card"><h3>Birthdays this week</h3>' + rows + '</div>';
}

function homeView() {
  var b = state.boot;
  var s = b.stats;
  var maxChart = 1;
  b.chart.forEach(function (c) { maxChart = Math.max(maxChart, c.Present + c.Absent + c.Excused); });
  var bars = b.chart.map(function (c, idx) {
    var hP = c.Present / maxChart * 100, hA = c.Absent / maxChart * 100, hE = c.Excused / maxChart * 100;
    var label = (idx % 2 === 0) ? fmtDate(c.date) : '';
    return '<div class="col" title="' + fmtDate(c.date) + ' - Present ' + c.Present + ', Absent ' + c.Absent + ', Excused ' + c.Excused + '">' +
      '<div class="bar" style="height:100%">' +
        '<span style="height:' + hP + '%;background:var(--green)"></span>' +
        '<span style="height:' + hA + '%;background:var(--blue)"></span>' +
        '<span style="height:' + hE + '%;background:var(--orange)"></span>' +
      '</div><div class="x">' + label + '</div></div>';
  }).join('');
  var teams = Object.keys(b.teamCounts).sort(function (a, z) { return b.teamCounts[z] - b.teamCounts[a]; });
  var maxT = Math.max.apply(null, teams.map(function (t) { return b.teamCounts[t]; }).concat([1]));
  var teamBars = teams.slice(0, 8).map(function (t) {
    return '<div class="row"><div class="lbl">' + da(t) + '<span>' + b.teamCounts[t] + '</span></div>' +
      '<div class="track"><div class="fill" style="width:' + (b.teamCounts[t] / maxT * 100) + '%"></div></div></div>';
  }).join('');
  var flagHtml = b.flagged.length
    ? b.flagged.slice(0, 5).map(function (f) {
        return '<div class="listrow" data-go="#/person/' + f.id + '"><div><div class="nm">' + da(f.name) + '</div>' +
          '<div class="tm">' + da(f.team) + ' &middot; ' + esc(f.reasons.join(', ')) + '</div></div>' +
          '<span class="badge red">Flagged</span></div>';
      }).join('')
    : '<div class="sub" style="margin:6px 0 0">No members are flagged.</div>';

  shell('Home',
    bdayCard(b.birthdays) +
    '<a class="btn green block big" href="#/attendance" style="margin:6px 0 16px">Take attendance</a>' +
    '<div class="statgrid">' +
      '<div class="stat"><div class="t">Members</div><div class="n">' + s.members + '</div><div class="d">On your list</div></div>' +
      '<div class="stat"><div class="t">Not yet marked this week</div><div class="n red">' + s.notMarked + '</div><div class="d">Of ' + s.members + ' members</div></div>' +
      '<div class="stat"><div class="t">Absent this week</div><div class="n">' + s.absent + '</div><div class="d">Marked absent</div></div>' +
      '<div class="stat"><div class="t">Flagged</div><div class="n">' + s.flagged + '</div><div class="d">Flagged as inactive</div></div>' +
    '</div>' +
    '<div class="card"><a class="seeall" href="#/history">See all</a><h3>Attendance, last 14 days</h3>' +
      '<p class="hint">Present, absent and excused marks per day.</p>' +
      '<div class="chart">' + bars + '</div>' +
      '<div class="legend"><span><i style="background:var(--green)"></i>Present</span>' +
      '<span><i style="background:var(--blue)"></i>Absent</span>' +
      '<span><i style="background:var(--orange)"></i>Excused</span></div></div>' +
    '<div class="card"><a class="seeall" href="#/members">See all</a><h3>Members by team</h3>' +
      '<p class="hint">How many members each team has.</p><div class="teambars">' + teamBars + '</div></div>' +
    '<div class="card"><a class="seeall" href="#/followup">Follow-up</a><h3>Flagged as inactive</h3>' +
      '<p class="hint">Members flagged for follow-up.</p>' + flagHtml + '</div>',
    'home');
  $$('[data-go]').forEach(function (x) { x.onclick = function () { go(x.getAttribute('data-go')); }; });
}

/* ---------------- members ---------------- */

var memberFilters = { q: '', team: '', status: '' };

// scout team order, youngest first - drives the Members page grouping
var TEAM_ORDER = ['براعم', 'زهرات', 'كشافين', 'متقدم', 'متقدمات', 'مرشدات', 'جوالة', 'ساعد', 'مساعد قائد', 'قائد'];
function teamRank(t) { var i = TEAM_ORDER.indexOf(t); return i === -1 ? 999 : i; }

function membersView() {
  var b = state.boot;
  var teams = {};
  b.members.forEach(function (m) { teams[m.team] = 1; });
  var teamOpts = ['<option value="">Any team</option>'].concat(Object.keys(teams).sort().map(function (t) {
    return '<option ' + (memberFilters.team === t ? 'selected' : '') + ' value="' + esc(t) + '">' + esc(t) + '</option>';
  })).join('');
  var q = memberFilters.q.toLowerCase();
  var list = b.members.filter(function (m) {
    if (memberFilters.team && m.team !== memberFilters.team) return false;
    if (memberFilters.status && (m.status === 'flagged' ? 'flagged' : 'active') !== memberFilters.status) return false;
    if (q && m.name.toLowerCase().indexOf(q) === -1 && m.id.toLowerCase().indexOf(q) === -1 && (m.phone || '').indexOf(q) === -1) return false;
    return true;
  }).sort(function (a, z) { return a.name.toLowerCase() < z.name.toLowerCase() ? -1 : 1; });
  // group members under team headers, youngest team first
  var byTeam = {};
  list.forEach(function (m) { (byTeam[m.team] = byTeam[m.team] || []).push(m); });
  var teamNames = Object.keys(byTeam).sort(function (a, z) { return teamRank(a) - teamRank(z) || (a < z ? -1 : 1); });
  var rows = teamNames.map(function (t) {
    var people = byTeam[t].map(function (m) {
      return '<div class="listrow" data-id="' + esc(m.id) + '"><div>' +
        '<div class="nm">' + da(m.name) + '</div>' +
        (m.phone ? '<div class="ph">' + esc(m.phone) + '</div>' : '') +
        '</div>' + memberStatusBadge(m.status) + '</div>';
    }).join('');
    return '<div class="teamhead">' + da(t) + ' <span class="countpill">' + byTeam[t].length + ' members</span></div>' +
      '<div class="card" style="padding:4px 14px">' + people + '</div>';
  }).join('');

  shell('Members',
    '<div class="pagehead"><h1>Members</h1>' +
      '<button class="btn green" id="addBtn">' + I.plus + ' Add member</button></div>' +
    '<div class="searchwrap">' + I.search +
      '<input class="input" id="q" placeholder="Search by name or id" value="' + esc(memberFilters.q) + '"></div>' +
    '<div class="filterrow">' +
      '<select class="input" id="fteam">' + teamOpts + '</select>' +
      '<select class="input" id="fstatus">' +
        '<option value="">Any status</option>' +
        '<option value="active" ' + (memberFilters.status === 'active' ? 'selected' : '') + '>Active</option>' +
        '<option value="flagged" ' + (memberFilters.status === 'flagged' ? 'selected' : '') + '>Flagged</option>' +
      '</select></div>' +
    (rows || '<div class="card" style="padding:4px 14px"><div class="empty"><div class="t">No members found</div></div></div>') +
    '<div id="addSlot"></div>',
    'members');

  var rerender = function () { membersView(); };
  $('#q').oninput = function () { memberFilters.q = this.value; };
  $('#q').onchange = rerender;
  $('#q').addEventListener('search', rerender);
  $('#q').onkeyup = function (e) { if (e.key === 'Enter') rerender(); };
  $('#fteam').onchange = function () { memberFilters.team = this.value; rerender(); };
  $('#fstatus').onchange = function () { memberFilters.status = this.value; rerender(); };
  $$('.listrow[data-id]').forEach(function (x) { x.onclick = function () { go('#/person/' + x.getAttribute('data-id')); }; });
  $('#addBtn').onclick = function () {
    var me = state.me;
    var myTeams = me.role === 'admin' ? Object.keys(teams).sort() : me.teams;
    var opts = myTeams.map(function (t) { return '<option value="' + esc(t) + '">' + esc(t) + '</option>'; }).join('');
    var card = el('<div class="card"><h3>Add member</h3>' +
      '<label class="f">Name</label><input class="input" id="aname" dir="auto">' +
      '<label class="f">Team</label><select class="input" id="ateam">' + opts + '</select>' +
      (me.role === 'admin' ? '<label class="f">Or a new team (exactly as in the sign-up form)</label><input class="input" id="anewteam" dir="auto">' : '') +
      '<label class="f">Phone (optional)</label><input class="input" id="aphone" inputmode="tel" dir="ltr">' +
      '<div class="btnrow" style="margin-top:12px"><button class="btn green" id="saveAdd">Save member</button>' +
      '<button class="btn" id="cancelAdd">Cancel</button></div></div>');
    var slot = $('#addSlot'); slot.innerHTML = ''; slot.appendChild(card);
    card.scrollIntoView({ behavior: 'smooth' });
    $('#cancelAdd').onclick = function () { slot.innerHTML = ''; };
    $('#saveAdd').onclick = function () {
      var name = $('#aname').value.trim();
      var team = ($('#anewteam') && $('#anewteam').value.trim()) || $('#ateam').value;
      if (!name || !team) return toast('Name and team are required.', true);
      setBusy(true);
      call({ action: 'addMember', name: name, team: team, phone: $('#aphone').value.trim() })
        .then(function () { toast('Member added.'); return refreshBoot(); })
        .then(function () { setBusy(false); membersView(); })
        .catch(handleErr);
    };
  };
}

/* ---------------- person ---------------- */

function personView(id) {
  shell('Member', '<div class="center"><span class="spinner"></span></div>', 'members');
  call({ action: 'person', id: id }).then(function (r) {
    var m = r.member, d = r.detail || {};
    function row(k, v, isLink) {
      if (!v) return '';
      var val = isLink
        ? '<a href="' + esc(v) + '" target="_blank" rel="noopener">Open link</a>'
        : da(v);
      return '<div class="it"><div class="k">' + esc(k) + '</div><div class="v">' + val + '</div></div>';
    }
    var marks = (r.marks || []).map(function (k) {
      return '<div class="listrow" style="cursor:default"><div><div class="nm" style="font-size:14px">' + fmtDate(k.date) + '</div>' +
        '<div class="tm">' + esc(k.taker || '') + '</div></div>' + statusBadge(k.status) + '</div>';
    }).join('');
    shell(m.name,
      '<button class="backlink" onclick="location.hash=\'#/members\'">&larr; All members</button>' +
      '<div class="pagehead"><h1>' + da(m.name) + '</h1>' + memberStatusBadge(m.status) + '</div>' +
      '<div class="sub">' + da(m.team) + ' &middot; ' + esc(m.id) + (m.joined ? ' &middot; Joined ' + fmtDate(m.joined) : '') + '</div>' +
      '<div class="card"><h3>Sign-up details</h3><p class="hint">Private. Only admins and this member&rsquo;s team leader can see this.</p><div class="dl">' +
        row('Name', m.name) + row('Team', m.team) + row('Phone', m.phone) +
        row('Email', d.email) + row('Address', d.address) + row('National ID', d.nationalId) +
        row('Birthdate', d.birthdate) + row('Area', d.area) +
        row("Kid's phone", d.kidPhone) + row("Father's phone", d.fatherPhone) + row("Father's job", d.fatherJob) +
        row("Mother's phone", d.motherPhone) + row("Mother's job", d.motherJob) +
        row('Siblings', d.siblings) + row('Siblings in the scout', d.siblingsInScout) +
        row('School', d.school) + row('School year', d.schoolYear) +
        row('Church', d.church) + row('Sunday-school family patron', d.patron) +
        row('Family servant', d.servant) + row("Family servant's phone", d.servantPhone) +
        row('Medical / food allergies', d.medical) +
        row('Owns the scout shirt', d.uniformShirt) + row('Owns the summer t-shirt', d.uniformTshirt) +
        row('Personal photo', d.photoUrl, true) + row('Birth certificate', d.birthCertUrl, true) +
      '</div></div>' +
      '<div class="card"><h3>Recent attendance</h3>' + (marks || '<div class="sub" style="margin:8px 0 0">No marks yet.</div>') + '</div>' +
      (state.me && state.me.role === 'admin'
        ? '<div class="card" id="rmCard"><h3>Remove from the app</h3>' +
          '<p class="hint">Hides this person from every list in the app. Nothing is deleted from your Sheet or the sign-up form, and their attendance history stays. You can bring them back from the Admins page.</p>' +
          '<div id="rmSlot"><button class="btn danger-text" id="rmBtn" style="padding-left:0">' + I.trash + ' Remove ' + da(m.name) + ' from the app</button></div></div>'
        : ''),
      'members');
    var rmBtn = $('#rmBtn');
    if (rmBtn) rmBtn.onclick = function () {
      $('#rmSlot').innerHTML =
        '<div class="err" style="margin-bottom:10px">Remove <b>' + da(m.name) + '</b> from the app?</div>' +
        '<div class="btnrow"><button class="btn danger" id="rmYes">Yes, remove</button><button class="btn" id="rmNo">Cancel</button></div>';
      $('#rmNo').onclick = function () { personView(id); };
      $('#rmYes').onclick = function () {
        setBusy(true);
        call({ action: 'archive', memberId: m.id })
          .then(function () { toast('Removed from the app.'); return refreshBoot(); })
          .then(function () { setBusy(false); go('#/members'); render(); })
          .catch(handleErr);
      };
    };
  }).catch(function (e) {
    shell('Member', '<div class="err">' + esc(e.message) + '</div>', 'members');
  });
}

/* ---------------- take attendance ---------------- */

function attendanceView() {
  shell('Take attendance', '<div class="center"><span class="spinner"></span></div>', 'attendance');
  var weekCacheKey = 'wes_week_' + state.weekOffset;
  call({ action: 'week', offset: state.weekOffset }).then(function (w) {
    try { localStorage.setItem(weekCacheKey, JSON.stringify(w)); } catch (e) {}
    renderAttendance(w, false);
    flushOutbox(); // connectivity is good; push any pending marks
  }).catch(function (e) {
    if (isOfflineErr(e)) {
      var cached = null;
      try { cached = JSON.parse(localStorage.getItem(weekCacheKey) || 'null'); } catch (e2) {}
      if (cached) {
        renderAttendance(cached, true); // last loaded data + pending marks overlayed
        return;
      }
    }
    shell('Take attendance', '<div class="err">' + esc(e.message) + '</div>', 'attendance');
  });
}

function renderAttendance(w, offline) {
  WESOutbox.applyToWeek(w); // pending offline marks show as taken
  {
    var teams = w.teams;
    var teamNames = [''].concat(teams.map(function (t) { return t.team; }));
    var cur = attendanceView._team || '';
    if (cur && teamNames.indexOf(cur) === -1) cur = '';
    var opts = teamNames.map(function (t) {
      return '<option value="' + esc(t) + '" ' + (cur === t ? 'selected' : '') + '>' + (t ? esc(t) : 'All teams') + '</option>';
    }).join('');
    var body = teams.filter(function (t) { return !cur || t.team === cur; }).map(function (t) {
      var rows = t.members.map(function (m) {
        function opt(st, cls, lbl) {
          return '<button class="opt' + (m.mark === st ? ' on-' + cls : '') + '" data-id="' + esc(m.id) + '" data-st="' + st + '">' + lbl + '</button>';
        }
        return '<div class="attrow"><div class="nm">' + da(m.name) + '</div><div class="seg">' +
          opt('Present', 'P', 'Present') + opt('Absent', 'A', 'Absent') + opt('Excused', 'E', 'Excused') +
          '</div></div>';
      }).join('');
      return '<div class="teamhead">' + da(t.team) + ' <span class="countpill">' + t.members.length + ' members</span></div>' +
        '<div class="card" style="padding:4px 14px">' + rows + '</div>';
    }).join('');

    shell('Take attendance',
      '<h1>Attendance this week</h1>' +
      (offline ? '<div class="offlinebanner">No internet. Showing the last loaded list. Marks you take now are saved on this device and sync automatically when you are back online.</div>' : '') +
      '<div class="sub">This week, ending ' + w.weekEnd + '. <span id="mk">' + w.marked + '</span> of ' + w.total + ' marked.</div>' +
      '<div class="weeknav">' +
        '<button class="btn" id="prevW">' + I.left + '</button>' +
        '<button class="btn" id="nextW" ' + (w.isCurrent ? 'disabled' : '') + '>' + I.right + '</button>' +
        (w.isCurrent ? '' : '<button class="btn" id="nowW">Back to this week</button>') +
      '</div>' +
      '<div class="btnrow">' +
        '<button class="btn" id="weekOff">Mark week off</button>' +
        '<button class="btn" id="allP">Mark all present</button>' +
      '</div>' +
      '<select class="input" id="fteam" style="max-width:280px">' + opts + '</select>' +
      (body || '<div class="card empty"><div class="t">No members here yet</div></div>'),
      'attendance');

    $('#fteam').onchange = function () { attendanceView._team = this.value; attendanceView(); };
    $('#prevW').onclick = function () { state.weekOffset--; attendanceView(); };
    var next = $('#nextW');
    if (next) next.onclick = function () { state.weekOffset++; attendanceView(); };
    var now = $('#nowW');
    if (now) now.onclick = function () { state.weekOffset = 0; attendanceView(); };

    $$('.seg .opt').forEach(function (btn) {
      btn.onclick = function () {
        if (state.busy) return;
        setBusy(true);
        callMut({ action: 'mark', memberId: btn.getAttribute('data-id'), date: w.markDate, status: btn.getAttribute('data-st') })
          .then(function (r) {
            setBusy(false);
            if (r && r.queued) toast('No internet - mark saved on this device, will sync automatically.');
            attendanceView();
          })
          .catch(handleErr);
      };
    });
    $('#allP').onclick = function () {
      if (!confirm('Mark everyone' + (cur ? ' in ' + cur : '') + ' as Present for this week?')) return;
      setBusy(true);
      callMut({ action: 'markAll', date: w.markDate, status: 'Present', team: cur })
        .then(function (r) {
          if (r && r.queued) { toast('No internet - saved on this device, will sync automatically.'); return; }
          toast('Marked ' + r.count + ' members present.');
          return refreshBoot();
        })
        .then(function () { setBusy(false); attendanceView(); })
        .catch(handleErr);
    };
    $('#weekOff').onclick = function () {
      if (!confirm('Mark this week as off (no meeting)? Everyone gets a "Week off" mark.')) return;
      setBusy(true);
      callMut({ action: 'markAll', date: w.markDate, status: 'Week off', team: cur })
        .then(function (r) {
          if (r && r.queued) { toast('No internet - saved on this device, will sync automatically.'); return; }
          toast('Week marked as off.');
          return refreshBoot();
        })
        .then(function () { setBusy(false); attendanceView(); })
        .catch(handleErr);
    };
  }
}

/* ---------------- history ---------------- */

var histFilters = { date: '', status: '', member: '', team: '' };

function historyView(loadAll) {
  shell('Attendance', '<div class="center"><span class="spinner"></span></div>', 'history');
  var params = { action: 'history', page: loadAll ? 1 : state.histPage, limit: loadAll ? 2000 : 100 };
  Object.keys(histFilters).forEach(function (k) { if (histFilters[k]) params[k] = histFilters[k]; });
  call(params).then(function (r) {
    if (loadAll) return downloadExcel(r.rows);
    state.hist = r;
    var b = state.boot;
    var memberOpts = ['<option value="">Any member</option>'].concat(b.members.slice().sort(function (a, z) { return a.name < z.name ? -1 : 1; }).map(function (m) {
      return '<option value="' + esc(m.id) + '" ' + (histFilters.member === m.id ? 'selected' : '') + '>' + esc(m.name) + ' (' + esc(m.id) + ')</option>';
    })).join('');
    var teams = {};
    b.members.forEach(function (m) { teams[m.team] = 1; });
    var teamOpts = ['<option value="">Any team</option>'].concat(Object.keys(teams).sort().map(function (t) {
      return '<option value="' + esc(t) + '" ' + (histFilters.team === t ? 'selected' : '') + '>' + esc(t) + '</option>';
    })).join('');
    var cards = r.rows.map(function (k) {
      var sOpts = ['Present', 'Absent', 'Excused', 'Week off'].map(function (s) {
        return '<option ' + (k.status === s ? 'selected' : '') + '>' + s + '</option>';
      }).join('');
      return '<div class="card histcard"><div class="top"><span class="nm">' + da(k.name) + '</span>' + statusBadge(k.status) + '</div>' +
        '<div class="meta">' + k.date + ' &middot; ' + da(k.team) + '</div>' +
        '<div class="taker">' + esc(k.taker || '') + '</div>' +
        '<div class="ctl"><select class="input" data-rid="' + esc(k.recordId) + '" data-mid="' + esc(k.memberId) + '" data-date="' + k.date + '">' + sOpts + '</select>' +
        '<button class="btn danger-text" data-del="' + esc(k.recordId) + '">Delete</button></div></div>';
    }).join('');
    var pages = Math.max(1, Math.ceil(r.total / r.limit));
    shell('Attendance',
      '<div class="pagehead"><div><h1>Attendance</h1><div class="sub" style="margin-bottom:0">Every mark, newest first.</div></div>' +
      '<button class="btn" id="xls">' + I.check + ' Download Excel</button></div>' +
      '<div style="height:12px"></div>' +
      '<input class="input" id="fdate" placeholder="Date YYYY-MM-DD" value="' + esc(histFilters.date) + '" dir="ltr">' +
      '<select class="input" id="fstatus">' +
        ['', 'Present', 'Absent', 'Excused', 'Week off'].map(function (s) {
          return '<option value="' + s + '" ' + (histFilters.status === s ? 'selected' : '') + '>' + (s || 'Any status') + '</option>';
        }).join('') + '</select>' +
      '<select class="input" id="fmember">' + memberOpts + '</select>' +
      '<select class="input" id="fteam">' + teamOpts + '</select>' +
      (cards || '<div class="card empty"><div class="t">No marks match</div><div class="d">Try clearing the filters.</div></div>') +
      (pages > 1 ? '<div class="btnrow" style="justify-content:center"><button class="btn" id="pP" ' + (r.page <= 1 ? 'disabled' : '') + '>&larr; Newer</button>' +
        '<span class="sub" style="align-self:center;margin:0">' + r.page + ' / ' + pages + '</span>' +
        '<button class="btn" id="pN" ' + (r.page >= pages ? 'disabled' : '') + '>Older &rarr;</button></div>' : ''),
      'history');

    var apply = function () { state.histPage = 1; historyView(); };
    $('#fdate').onchange = function () { histFilters.date = this.value.trim(); apply(); };
    $('#fstatus').onchange = function () { histFilters.status = this.value; apply(); };
    $('#fmember').onchange = function () { histFilters.member = this.value; apply(); };
    $('#fteam').onchange = function () { histFilters.team = this.value; apply(); };
    var pP = $('#pP'); if (pP) pP.onclick = function () { state.histPage--; historyView(); };
    var pN = $('#pN'); if (pN) pN.onclick = function () { state.histPage++; historyView(); };
    $('#xls').onclick = function () { historyView(true); };
    $$('select[data-rid]').forEach(function (sel) {
      sel.onchange = function () {
        setBusy(true);
        call({ action: 'mark', memberId: sel.getAttribute('data-mid'), date: sel.getAttribute('data-date'), status: sel.value })
          .then(function () { return refreshBoot(); })
          .then(function () { setBusy(false); historyView(); })
          .catch(handleErr);
      };
    });
    $$('button[data-del]').forEach(function (btn) {
      btn.onclick = function () {
        if (!confirm('Delete this mark?')) return;
        setBusy(true);
        call({ action: 'unmark', recordId: btn.getAttribute('data-del') })
          .then(function () { return refreshBoot(); })
          .then(function () { setBusy(false); historyView(); })
          .catch(handleErr);
      };
    });
  }).catch(function (e) {
    if (loadAll) return handleErr(e);
    shell('Attendance', '<div class="err">' + esc(e.message) + '</div>', 'history');
  });
}

function downloadExcel(rows) {
  var data = rows.map(function (k) {
    return { 'Record_ID': k.recordId, 'Member_ID': k.memberId, 'Member': k.name, 'Team': k.team,
             'Date': k.date, 'Status': k.status, 'Taker_Email': k.taker };
  });
  var stamp = new Date().toISOString().slice(0, 10);
  if (window.XLSX) {
    var ws = XLSX.utils.json_to_sheet(data);
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Attendance');
    XLSX.writeFile(wb, 'attendance-' + stamp + '.xlsx');
    toast('Excel downloaded.');
  } else {
    // offline fallback: CSV that Excel opens
    var head = ['Record_ID', 'Member_ID', 'Member', 'Team', 'Date', 'Status', 'Taker_Email'];
    var csv = '﻿' + [head.join(',')].concat(data.map(function (r) {
      return head.map(function (h) { return '"' + String(r[h] == null ? '' : r[h]).replace(/"/g, '""') + '"'; }).join(',');
    })).join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'attendance-' + stamp + '.csv';
    a.click();
    toast('CSV downloaded (opens in Excel).');
  }
  historyView();
}

/* ---------------- follow-up ---------------- */

function followupView() {
  var b = state.boot;
  var rows = b.flagged.map(function (f) {
    return '<div class="card"><div class="top" style="display:flex;justify-content:space-between;align-items:center">' +
      '<span class="nm" style="font-weight:700">' + da(f.name) + '</span>' +
      (f.status === 'flagged' ? '<span class="badge red">Inactive</span>' : '<span class="badge orange">New flag</span>') + '</div>' +
      '<div class="meta" style="color:var(--muted);font-size:13px;margin-top:4px">' + da(f.team) + '</div>' +
      '<div style="margin-top:8px">' + f.reasons.map(function (r) { return '<span class="badge red" style="margin-right:6px">' + esc(r) + '</span>'; }).join('') + '</div>' +
      '<div class="btnrow" style="margin-top:12px">' +
      '<button class="btn" data-react="' + esc(f.id) + '">Reactivate (followed up)</button></div></div>';
  }).join('');
  shell('Follow-up',
    '<h1>Follow-up</h1>' +
    '<div class="sub">Members flagged by the absence rules. Reactivate a member once you have followed up.</div>' +
    '<div class="btnrow"><button class="btn" id="recalc">Recalculate all</button></div>' +
    (rows || '<div class="card empty"><div class="t">No members are flagged</div>' +
      '<div class="d">Flags appear here when a member reaches the absence limits: absent 3 weeks in a row, or 5 times in total.</div></div>'),
    'followup');
  $('#recalc').onclick = function () {
    setBusy(true);
    call({ action: 'recalc' }).then(function (r) {
      toast(r.flagged ? r.flagged + ' member(s) flagged as inactive.' : 'No one is over the absence limits.');
      return refreshBoot();
    }).then(function () { setBusy(false); followupView(); }).catch(handleErr);
  };
  $$('button[data-react]').forEach(function (btn) {
    btn.onclick = function () {
      setBusy(true);
      call({ action: 'reactivate', memberId: btn.getAttribute('data-react') })
        .then(function () { toast('Member reactivated.'); return refreshBoot(); })
        .then(function () { setBusy(false); followupView(); })
        .catch(handleErr);
    };
  });
}

/* ---------------- admins & leaders ---------------- */

function adminsView() {
  var b = state.boot;
  var me = state.me;
  var leaders = b.leaders || [];
  var teamsSet = {};
  b.members.forEach(function (m) { teamsSet[m.team] = (teamsSet[m.team] || 0) + 1; });
  leaders.forEach(function (l) { if (!(l.team in teamsSet)) teamsSet[l.team] = 0; });
  var teamCards = Object.keys(teamsSet).sort().map(function (t) {
    var ls = leaders.filter(function (l) { return l.team === t; });
    var lrows = ls.map(function (l) {
      var nm = l.email.split('@')[0];
      return '<div class="listrow" style="cursor:default"><div><div class="nm" style="font-size:14.5px">' + esc(nm) + '</div>' +
        '<div class="tm" dir="ltr">' + esc(l.email) + '</div></div>' +
        '<button class="iconbtn" data-rleader data-team="' + esc(t) + '" data-email="' + esc(l.email) + '" aria-label="Remove">' + I.trash + '</button></div>';
    }).join('');
    return '<div class="card"><h3>' + da(t) + '</h3><span class="countpill">' + teamsSet[t] + ' members</span>' +
      (lrows || '<div class="sub" style="margin:4px 0 10px">No leader yet. Only master admins can see this team.</div>') +
      '<input class="input" type="email" placeholder="Email" dir="ltr" data-leader-email="' + esc(t) + '">' +
      '<button class="btn green block" data-addleader="' + esc(t) + '">' + I.userplus + ' Add</button></div>';
  }).join('');
  var adminRows = (b.admins || []).map(function (a) {
    var you = a.email === me.email;
    return '<div class="listrow" style="cursor:default"><div><div class="nm" style="font-size:14.5px">' + da(a.name || a.email) + (you ? ' (you)' : '') + '</div>' +
      '<div class="tm" dir="ltr">' + esc(a.email) + '</div></div>' +
      (you ? '' : '<button class="iconbtn" data-radmin="' + esc(a.email) + '" aria-label="Remove">' + I.trash + '</button>') + '</div>';
  }).join('');
  shell('Admins',
    '<h1>Admins, teams and leaders</h1>' +
    '<div class="sub">Each leader sees and takes attendance only for the members of their team. Add as many leaders to a team as you like.</div>' +
    '<div class="card"><h3>Add a leader to a team that has no members yet</h3>' +
      '<input class="input" id="newteam" placeholder="Team name, exactly as in the sign-up form" dir="auto">' +
      '<input class="input" id="newteamemail" type="email" placeholder="Leader email" dir="ltr">' +
      '<button class="btn green block" id="addNewTeam">' + I.userplus + ' Add</button></div>' +
    teamCards +
    ((b.duplicates && b.duplicates.length)
      ? '<div class="card"><h3>Possible duplicates</h3><p class="hint">These look like the same person (same valid ID in the sign-up form). Open the extra one and use Remove from the app. Nothing is removed automatically.</p>' +
        b.duplicates.map(function (g) {
          return g.map(function (x) {
            return '<div class="listrow" data-go="#/person/' + esc(x.id) + '"><div><div class="nm" style="font-size:14.5px">' + da(x.name) + '</div>' +
              '<div class="tm">' + da(x.team) + ' &middot; ' + esc(x.id) + (x.phone ? ' &middot; ' + esc(x.phone) : '') + '</div></div></div>';
          }).join('') + '<div style="height:10px"></div>';
        }).join('') + '</div>'
      : '') +
    ((b.archived && b.archived.length)
      ? '<div class="card"><h3>Removed from the app</h3><p class="hint">Hidden everywhere in the app. Still in your Sheet. Restore brings them back.</p>' +
        b.archived.map(function (a) {
          return '<div class="listrow" style="cursor:default"><div><div class="nm" style="font-size:14.5px">' + da(a.name) + '</div>' +
            '<div class="tm">' + da(a.team) + ' &middot; ' + esc(a.id) + '</div></div>' +
            '<button class="btn" data-restore="' + esc(a.id) + '">Restore</button></div>';
        }).join('') + '</div>'
      : '') +
    '<div class="card"><h3>Admins</h3><p class="hint">Admins see every team and member, and manage admins and leaders.</p>' +
      adminRows +
      '<input class="input" id="newadmin" type="email" placeholder="Email" dir="ltr">' +
      '<input class="input" id="newadminname" placeholder="Name (optional)" dir="auto">' +
      '<button class="btn green block" id="addAdmin">' + I.userplus + ' Add admin</button></div>',
    'admins');

  function after() { return refreshBoot().then(function () { setBusy(false); adminsView(); }); }
  $$('[data-go]').forEach(function (x) { x.onclick = function () { go(x.getAttribute('data-go')); }; });
  $$('button[data-restore]').forEach(function (btn) {
    btn.onclick = function () {
      setBusy(true);
      call({ action: 'restore', memberId: btn.getAttribute('data-restore') })
        .then(function () { toast('Restored.'); }).then(after).catch(handleErr);
    };
  });
  $$('button[data-addleader]').forEach(function (btn) {
    btn.onclick = function () {
      var t = btn.getAttribute('data-addleader');
      var inp = $('input[data-leader-email="' + t.replace(/"/g, '\\"') + '"]') || $$('input[data-leader-email]').filter(function (x) { return x.getAttribute('data-leader-email') === t; })[0];
      var em = inp ? inp.value.trim() : '';
      if (!em) return toast('Type the leader email first.', true);
      setBusy(true);
      call({ action: 'addLeader', team: t, email: em }).then(function () { toast('Leader added.'); }).then(after).catch(handleErr);
    };
  });
  $$('button[data-rleader]').forEach(function (btn) {
    btn.onclick = function () {
      if (!confirm('Remove this leader?')) return;
      setBusy(true);
      call({ action: 'removeLeader', team: btn.getAttribute('data-team'), email: btn.getAttribute('data-email') })
        .then(function () { toast('Leader removed.'); }).then(after).catch(handleErr);
    };
  });
  $('#addNewTeam').onclick = function () {
    var t = $('#newteam').value.trim(), em = $('#newteamemail').value.trim();
    if (!t || !em) return toast('Type the team name and the leader email.', true);
    setBusy(true);
    call({ action: 'addLeader', team: t, email: em }).then(function () { toast('Leader added.'); }).then(after).catch(handleErr);
  };
  $('#addAdmin').onclick = function () {
    var em = $('#newadmin').value.trim();
    if (!em) return toast('Type the admin email first.', true);
    setBusy(true);
    call({ action: 'addAdmin', email: em, name: $('#newadminname').value.trim() })
      .then(function () { toast('Admin added.'); }).then(after).catch(handleErr);
  };
  $$('button[data-radmin]').forEach(function (btn) {
    btn.onclick = function () {
      if (!confirm('Remove this admin?')) return;
      setBusy(true);
      call({ action: 'removeAdmin', email: btn.getAttribute('data-radmin') })
        .then(function () { toast('Admin removed.'); }).then(after).catch(handleErr);
    };
  });
}

/* ---------------- halls (places and bookings) ---------------- */

var hallDraft = {};          // per place: remembered date / times / team so back-to-back bookings are quick
var hallsCache = null;

function localYmd(d) {
  var p = function (n) { return ('0' + n).slice(-2); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function nextSaturday() {            // the coming Saturday (today if it is Saturday)
  var d = new Date();
  d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7));
  return localYmd(d);
}
function fmtTime(t) {
  var m = /^(\d{1,2}):(\d{2})$/.exec(t || '');
  if (!m) return esc(t || '');
  var h = parseInt(m[1], 10), ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return h + ':' + m[2] + ' ' + ap;
}
function addHour(t) {
  var m = /^(\d{2}):(\d{2})$/.exec(t || '');
  if (!m) return '';
  var h = parseInt(m[1], 10) + 1;
  return h > 23 ? '23:59' : ('0' + h).slice(-2) + ':' + m[2];
}
function fmtDay(d) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || '');
  if (!m) return esc(d || '');
  var days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  return days[new Date(+m[1], +m[2] - 1, +m[3]).getDay()] + ' ' + fmtDate(d);
}

function hallsView() {
  shell('Halls', '<div class="center"><span class="spinner"></span></div>', 'halls');
  call({ action: 'halls' }).then(function (r) {
    hallsCache = r;
    var edit = !!r.canEdit;
    var b = state.boot, teamSet = {};
    (b.members || []).forEach(function (m) { if (m.team) teamSet[m.team] = 1; });
    var teamList = '<datalist id="teamlist">' + Object.keys(teamSet).sort().map(function (t) { return '<option value="' + esc(t) + '">'; }).join('') + '</datalist>';

    var cards = r.halls.map(function (h) {
      var dr = hallDraft[h.id] || (hallDraft[h.id] = { date: nextSaturday(), start: '', end: '', team: '' });
      var byDate = {}, dates = [];
      h.slots.forEach(function (sl) { if (!byDate[sl.date]) { byDate[sl.date] = []; dates.push(sl.date); } byDate[sl.date].push(sl); });
      var list = dates.map(function (d) {
        return '<div class="teamhead" style="margin:10px 0 2px">' + fmtDay(d) + '</div>' +
          byDate[d].map(function (sl) {
            return '<div class="listrow" style="cursor:default"><div><div class="nm" style="font-size:14.5px" dir="ltr">' +
              fmtTime(sl.start) + ' &ndash; ' + fmtTime(sl.end) + '</div><div class="tm">' + da(sl.team) + '</div></div>' +
              (edit ? '<button class="iconbtn" data-rslot="' + esc(sl.id) + '" aria-label="Remove booking">' + I.trash + '</button>' : '') + '</div>';
          }).join('');
      }).join('');
      var form = edit
        ? '<div style="margin-top:12px;border-top:1px solid var(--line);padding-top:12px">' +
            '<label class="f">Date</label><input class="input" type="date" data-f="date" data-h="' + esc(h.id) + '" value="' + esc(dr.date) + '">' +
            '<div class="filterrow"><div><label class="f">From</label><input class="input" type="time" data-f="start" data-h="' + esc(h.id) + '" value="' + esc(dr.start) + '"></div>' +
            '<div><label class="f">To</label><input class="input" type="time" data-f="end" data-h="' + esc(h.id) + '" value="' + esc(dr.end) + '"></div></div>' +
            '<label class="f">Team</label><input class="input" list="teamlist" dir="auto" placeholder="Team name" data-f="team" data-h="' + esc(h.id) + '" value="' + esc(dr.team) + '">' +
            '<button class="btn green block" data-addslot="' + esc(h.id) + '">' + I.plus + ' Add booking</button></div>'
        : '';
      return '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><h3>' + da(h.name) + '</h3>' +
        (edit ? '<button class="iconbtn" data-rhall="' + esc(h.id) + '" data-name="' + esc(h.name) + '" aria-label="Remove place">' + I.trash + '</button>' : '') + '</div>' +
        (list || '<div class="sub" style="margin:6px 0 0">No upcoming bookings.</div>') + form + '</div>';
    }).join('');

    shell('Halls',
      '<h1>Halls &middot; &#1602;&#1575;&#1593;&#1575;&#1578;</h1>' +
      '<div class="sub">Which team has which place, and when. ' + (edit ? 'Only admins can change this.' : 'Only admins can change this. You can view it.') + '</div>' +
      (edit
        ? '<div class="card"><h3>Add place</h3><input class="input" id="newhall" dir="auto" placeholder="Place name (for example Hall 1)">' +
          '<button class="btn green block" id="addHall">' + I.plus + ' Add place</button></div>'
        : '') +
      (cards || '<div class="card"><div class="empty"><div class="t">No places yet</div></div></div>') + teamList,
      'halls');

    function reload() { setBusy(false); hallsView(); }
    function readDraft(hid) {
      var o = {};
      $$('[data-h="' + hid + '"]').forEach(function (x) { o[x.getAttribute('data-f')] = x.value.trim(); });
      return o;
    }
    $$('[data-h]').forEach(function (x) {      // remember what he typed if the page re-renders
      x.onchange = function () { hallDraft[x.getAttribute('data-h')] = readDraft(x.getAttribute('data-h')); };
    });
    var addHall = $('#addHall');
    if (addHall) addHall.onclick = function () {
      var name = $('#newhall').value.trim();
      if (!name) return toast('Type the place name first.', true);
      setBusy(true);
      call({ action: 'addHall', name: name }).then(function () { toast('Place added.'); }).then(reload).catch(handleErr);
    };
    $$('button[data-addslot]').forEach(function (btn) {
      btn.onclick = function () {
        var hid = btn.getAttribute('data-addslot'), d = readDraft(hid);
        if (!d.date || !d.start || !d.end || !d.team) return toast('Fill the date, both times and the team.', true);
        setBusy(true);
        call({ action: 'addSlot', hallId: hid, date: d.date, start: d.start, end: d.end, team: d.team })
          .then(function () {
            toast('Booking added.');
            // back-to-back: next booking starts when this one ends, same date
            hallDraft[hid] = { date: d.date, start: d.end, end: addHour(d.end), team: '' };
          }).then(reload).catch(handleErr);
      };
    });
    $$('button[data-rslot]').forEach(function (btn) {
      btn.onclick = function () {
        if (!window.confirm('Remove this booking?')) return;
        setBusy(true);
        call({ action: 'deleteSlot', slotId: btn.getAttribute('data-rslot') })
          .then(function () { toast('Booking removed.'); }).then(reload).catch(handleErr);
      };
    });
    $$('button[data-rhall]').forEach(function (btn) {
      btn.onclick = function () {
        if (!window.confirm('Remove "' + btn.getAttribute('data-name') + '" and all its bookings?')) return;
        setBusy(true);
        call({ action: 'deleteHall', hallId: btn.getAttribute('data-rhall') })
          .then(function () { toast('Place removed.'); }).then(reload).catch(handleErr);
      };
    });
  }).catch(function (e) {
    shell('Halls', '<div class="err">' + esc(e.message) + '</div>', 'halls');
  });
}

/* ---------------- boot + router ---------------- */

function refreshBoot() {
  return call({ action: 'bootstrap' }).then(function (b) {
    state.boot = b; state.me = b.me;
  });
}

function render() {
  if (!state.token) { loginView('email'); return; }
  var h = location.hash || '#/home';
  var m;
  if (h === '#/login') { logoutLocal(); loginView('email'); return; }
  var goWith = function (fn) {
    if (state.boot) return fn();
    shell('', '<div class="center"><span class="spinner"></span></div>', '');
    refreshBoot().then(fn).catch(function (e) {
      if (!state.token) { loginView('email'); return; }
      shell('', '<div class="err">' + esc(e.message) + '</div><button class="btn block" onclick="location.reload()">Try again</button>', '');
    });
  };
  if (h === '#/home') return goWith(homeView);
  if (h === '#/members') return goWith(membersView);
  if ((m = /^#\/person\/(.+)$/.exec(h))) return goWith(function () { personView(decodeURIComponent(m[1])); });
  if (h === '#/attendance') return goWith(attendanceView);
  if (h === '#/history') return goWith(historyView);
  if (h === '#/followup') return goWith(followupView);
  if (h === '#/halls') return goWith(hallsView);
  if (h === '#/admins') return goWith(function () {
    if (state.me.role !== 'admin') { go('#/home'); return render(); }
    adminsView();
  });
  go('#/home');
}

window.addEventListener('hashchange', render);

if (DEMO && !state.token) state.token = 'demo';

if ('serviceWorker' in navigator && !DEMO && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(function () {});
}

render();

/* ---------------- demo data (only with ?demo=1, for previews) ---------------- */

var demoArchived = [{ id: 'M-0099', name: 'Demo Removed Person', team: 'براعم', phone: '', by: 'demo@example.com', at: '2026-11-25' }];
var demoHalls = (function () {
  var d = new Date(); d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7));
  var p = function (n) { return ('0' + n).slice(-2); };
  var sat = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  return [{ id: 'H-1', name: 'Demo Hall 1', slots: [
    { id: 'S-1', date: sat, start: '17:00', end: '18:00', team: '\u0628\u0631\u0627\u0639\u0645' },
    { id: 'S-2', date: sat, start: '18:00', end: '19:00', team: '\u0643\u0634\u0627\u0641\u064a\u0646' }] },
    { id: 'H-2', name: 'Demo Yard', slots: [] }];
})();

function demoApi(p) {
  // Synthetic demo data for screenshots and previews only. No real member data here.
  var members = [
    { id: 'M-0002', name: 'Demo Admin', team: 'قائد', phone: '01000000001', status: 'active', joined: '2026-11-16' },
    { id: 'M-0003', name: 'Demo Leader', team: 'براعم', phone: '01000000002', status: 'active', joined: '2026-11-16' },
    { id: 'M-0004', name: 'عضو تجريبي أول', team: 'قائد', phone: '01000000003', status: 'active', joined: '2026-11-17' },
    { id: 'M-0005', name: 'عضو تجريبي ثاني', team: 'براعم', phone: '', status: 'active', joined: '2026-11-17' },
    { id: 'M-0006', name: 'عضو تجريبي ثالث', team: 'متقدمات', phone: '', status: 'active', joined: '2026-11-17' },
    { id: 'M-0007', name: 'عضو تجريبي رابع', team: 'براعم', phone: '', status: 'active', joined: '2026-11-17' },
    { id: 'M-0008', name: 'عضو تجريبي خامس', team: 'براعم', phone: '', status: 'active', joined: '2026-11-17' },
    { id: 'M-0009', name: 'عضو تجريبي سادس', team: 'كشافين', phone: '', status: 'active', joined: '2026-11-18' },
    { id: 'M-0016', name: 'عضو تجريبي سابع', team: 'براعم', phone: '', status: 'active', joined: '2026-11-18' },
    { id: 'M-0017', name: 'عضو تجريبي ثامن', team: 'مرشدات', phone: '', status: 'active', joined: '2026-11-18' },
    { id: 'M-0022', name: 'Demo Member Nine', team: 'ساعد', phone: '', status: 'active', joined: '2026-11-18' },
    { id: 'M-0024', name: 'عضو تجريبي عاشر', team: 'متقدم', phone: '', status: 'active', joined: '2026-11-18' },
    { id: 'M-0034', name: 'عضو تجريبي حداشر', team: 'براعم', phone: '', status: 'active', joined: '2026-11-18' },
    { id: 'M-0038', name: 'عضو تجريبي اتناشر', team: 'زهرات', phone: '', status: 'active', joined: '2026-11-18' }
  ];
  var me = { email: 'demo@example.com', name: 'Demo Admin', role: 'admin', teams: [] };
  var today = new Date();
  function ws(d) { var t = new Date(d); t.setDate(t.getDate() - ((t.getDay() + 1) % 7)); return t; } // Saturday start
  function f(d) { return d.toISOString().slice(0, 10); }
  var thisWs = f(ws(today));
  var markToday = f(today);
  var marks = {};
  marks['M-0002-' + markToday] = 'Present'; marks['M-0003-' + markToday] = 'Present'; marks['M-0004-' + markToday] = 'Excused';
  return new Promise(function (res) {
    setTimeout(function () {
      var teamCounts = {};
      members.forEach(function (m) { teamCounts[m.team] = (teamCounts[m.team] || 0) + 1; });
      var chart = [];
      for (var i = 13; i >= 0; i--) {
        var d = new Date(); d.setDate(d.getDate() - i);
        var c = { date: f(d), Present: 0, Absent: 0, Excused: 0 };
        if (f(d) === markToday) { c.Present = 2; c.Excused = 1; }
        chart.push(c);
      }
      if (p.action === 'bootstrap') return res({
        ok: true, me: me, weekEnd: f(new Date(ws(today).getTime() + 6 * 864e5)),
        stats: { members: members.length, notMarked: members.length - 3, absent: 0, flagged: 0 },
        chart: chart, teamCounts: teamCounts, flagged: [],
        members: members,
        admins: [{ email: me.email, name: 'Demo Admin' }],
        leaders: [{ team: 'براعم', email: 'leader@example.com' }],
        archived: demoArchived, duplicates: [[{ id: 'M-0004', name: 'Demo Twin', team: 'قائد', phone: '01000000003' }, { id: 'M-0040', name: 'Demo Twin', team: 'قائد', phone: '0100000' }]],
        birthdays: [{ id: 'M-0003', name: 'Demo Leader', team: 'براعم', inDays: 0, date: f(today), turns: 12 }, { id: 'M-0005', name: 'عضو تجريبي ثاني', team: 'براعم', inDays: 3, date: f(new Date(today.getTime() + 3 * 864e5)), turns: 10 }]
      });
      if (p.action === 'week') {
        var w = new Date(ws(new Date())); w.setDate(w.getDate() + (parseInt(p.offset, 10) || 0) * 7);
        var wsStr = f(w), weStr = f(new Date(w.getTime() + 6 * 864e5));
        var isCur = wsStr === thisWs;
        var tm = {};
        members.forEach(function (m) { (tm[m.team] = tm[m.team] || []).push({ id: m.id, name: m.name, phone: m.phone, mark: marks[m.id + '-' + (isCur ? markToday : wsStr)] || null }); });
        var markedCount = Object.keys(marks).filter(function (k) {
          var d = k.split('-').slice(2).join('-');
          return d >= wsStr && d <= weStr;
        }).length;
        return res({ ok: true, weekStart: wsStr, weekEnd: weStr, isCurrent: isCur,
          markDate: isCur ? markToday : wsStr,
          total: members.length, marked: markedCount,
          teams: Object.keys(tm).sort().map(function (t) { return { team: t, members: tm[t] }; }) });
      }
      if (p.action === 'mark') { marks[p.memberId + '-' + p.date] = p.status; return res({ ok: true, recordId: p.memberId + '-' + p.date }); }
      if (p.action === 'markAll') { members.forEach(function (m) { marks[m.id + '-' + p.date] = p.status; }); return res({ ok: true, count: members.length }); }
      if (p.action === 'history') {
        var rows = Object.keys(marks).map(function (k) {
          var parts = k.split('-'); var mid = parts.slice(0, 2).join('-');
          var mm = members.filter(function (x) { return x.id === mid; })[0];
          return { recordId: k, memberId: mid, name: mm.name, team: mm.team, date: parts.slice(2).join('-'), status: marks[k], taker: me.email };
        }).sort(function (a, b) { return a.date < b.date ? 1 : -1; });
        return res({ ok: true, total: rows.length, page: 1, limit: 2000, rows: rows });
      }
      if (p.action === 'person') {
        var m2 = members.filter(function (x) { return x.id === p.id; })[0];
        return res({ ok: true, member: m2, detail: { email: 'demo@example.com', address: 'Demo address', nationalId: '00000000000000', birthdate: '2010-01-01', church: 'Demo church', school: 'Demo school', schoolYear: 'Demo year', medical: 'لا', uniformShirt: 'نعم', uniformTshirt: 'نعم', fatherPhone: '01000000000', motherPhone: '01000000000', area: 'Demo area' }, marks: [] });
      }
      if (p.action === 'restore') { demoArchived.length = 0; return res({ ok: true }); }
      if (p.action === 'archive') {
        var ix = -1; members.forEach(function (x, i) { if (x.id === p.memberId) ix = i; });
        if (ix > -1) members.splice(ix, 1);
        return res({ ok: true });
      }
      if (p.action === 'halls') return res({ ok: true, canEdit: true, today: f(today), halls: demoHalls });
      if (p.action === 'addHall') { demoHalls.push({ id: 'H-' + demoHalls.length, name: p.name, slots: [] }); return res({ ok: true }); }
      if (p.action === 'addSlot') {
        demoHalls.forEach(function (h) { if (h.id === p.hallId) h.slots.push({ id: 'S-' + Math.random(), date: p.date, start: p.start, end: p.end, team: p.team }); });
        return res({ ok: true });
      }
      return res({ ok: true });
    }, 60);
  });
}

})();
