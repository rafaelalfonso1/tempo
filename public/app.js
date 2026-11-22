/* Time & Attendance — single-page client (vanilla JS, no build step). */
'use strict';

// ---------------------------------------------------------------- utilities
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtH = (n) => (n == null ? '' : (Math.round(n * 100) / 100).toFixed(2));
const toD = (iso) => new Date(iso + 'T00:00:00Z');
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = toD(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dow = (s) => toD(s).getUTCDay();
const prettyDate = (s) => `${DOW[dow(s)]} ${MON[toD(s).getUTCMonth()]} ${toD(s).getUTCDate()}, ${toD(s).getUTCFullYear()}`;
const shortDate = (s) => `${MON[toD(s).getUTCMonth()]} ${toD(s).getUTCDate()}`;

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (res.status === 401 && url !== '/api/login') { S.me = null; renderLogin(); throw new Error('Session expired'); }
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}
function toast(msg, err = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), err ? 5000 : 2500);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function closeLayers() { $$('.pop, .overlay, .drawer, .modal').forEach((e) => e.remove()); }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLayers(); });

// ---------------------------------------------------------------- state
const S = {
  me: null, meta: null, data: null,
  view: { mode: 'week', anchor: null, campaign: '', supervisor: '', search: '' },
};
const isManager = () => S.me && ['admin', 'operations'].includes(S.me.role);
const codeById = (id) => S.meta.attendance_codes.find((c) => c.id === id);

function weekStartOf(s) { const diff = (dow(s) - S.meta.week_start_day + 7) % 7; return addDays(s, -diff); }
function currentRange() {
  const a = S.view.anchor;
  if (S.view.mode === 'week') { const f = weekStartOf(a); return { from: f, to: addDays(f, 6) }; }
  const d = toD(a); const f = iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)));
  return { from: f, to: iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))) };
}
function rangeLabel() {
  const { from, to } = currentRange();
  if (S.view.mode === 'month') return `${MON[toD(from).getUTCMonth()]} ${toD(from).getUTCFullYear()}`;
  return `${shortDate(from)} – ${shortDate(to)}, ${toD(to).getUTCFullYear()}`;
}
function shift(dir) {
  const a = S.view.anchor;
  if (S.view.mode === 'week') S.view.anchor = addDays(a, 7 * dir);
  else { const d = toD(a); S.view.anchor = iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + dir, 1))); }
}
const isLockedDay = (emp, day) => (S.data.locks[emp.campaign_id] || []).includes(weekStartOf(day));

// ---------------------------------------------------------------- realtime
let es;
function connectRealtime() {
  if (es) es.close();
  es = new EventSource('/api/events');
  es.onopen = () => $('.live')?.classList.add('on');
  es.onerror = () => $('.live')?.classList.remove('on');
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    const route = currentRoute();
    if (ev.type === 'meta') return reloadMeta();
    if (ev.type === 'attendance' && route === 'attendance' && S.data) {
      for (const c of ev.changes) {
        if (!S.data.employees.some((e) => e.id === c.employee_id) || !S.data.days.includes(c.work_date)) continue;
        S.data.marks[c.employee_id] ??= {};
        if (c.code_id == null) delete S.data.marks[c.employee_id][c.work_date];
        else S.data.marks[c.employee_id][c.work_date] = { code_id: c.code_id, note: c.note };
      }
      renderAttendanceGrid();
      if (ev.by !== S.me.id) ev.changes.forEach((c) => $(`td.cell[data-e="${c.employee_id}"][data-d="${c.work_date}"]`)?.classList.add('flash'));
      return;
    }
    if (ev.type === 'attendance' && route === 'time') return softReload();
    if (['hours', 'roster', 'approval'].includes(ev.type)) softReload();
  };
}
const softReload = debounce(() => { if (!$('.drawer, .modal, .pop')) route(); }, 400);
async function reloadMeta() { S.meta = await api('GET', '/api/meta'); }

// ---------------------------------------------------------------- shell & router
const ROUTES = [
  { id: 'attendance', label: 'Attendance', icon: '☑' },
  { id: 'time', label: 'Time & Hours', icon: '⏱' },
  { id: 'roster', label: 'Roster', icon: '👥' },
  { id: 'approvals', label: 'Weekly Approval', icon: '✔', managers: true },
  { id: 'settings', label: 'Settings', icon: '⚙', managers: true },
];
const currentRoute = () => (location.hash.replace(/^#\/?/, '').split('/')[0] || 'attendance');

function renderShell() {
  $('#root').innerHTML = `
  <div class="app">
    <aside class="side">
      <div class="brand"><span class="brand-mark">TA</span>Time &amp; Attendance</div>
      <nav class="nav">${ROUTES.filter((r) => !r.managers || isManager()).map((r) => `<a href="#/${r.id}" data-r="${r.id}"><span>${r.icon}</span>${r.label}</a>`).join('')}</nav>
      <div class="side-foot"><b>${esc(S.me.display_name)}</b>${esc(S.me.role)}${S.me.supervisor_code ? ' · ' + esc(S.me.supervisor_code) : ''}
        <div class="live">Live updates</div>
        <div style="margin-top:8px"><a href="#" id="logout">Sign out</a></div></div>
    </aside>
    <main id="main"></main>
  </div>`;
  $('#logout').onclick = guard(async (e) => { e.preventDefault(); await api('POST', '/api/logout'); es?.close(); S.me = null; renderLogin(); });
}

async function route() {
  if (!S.me) return;
  const r = currentRoute();
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.r === r));
  const fn = { attendance: viewAttendance, time: viewTime, roster: viewRoster, approvals: viewApprovals, settings: viewSettings }[r] || viewAttendance;
  try { await fn(); } catch (e) { toast(e.message, true); }
}
window.addEventListener('hashchange', () => { closeLayers(); route(); });

function renderLogin() {
  $('#root').innerHTML = `
  <div class="login"><form class="panel" id="lf">
    <div class="brand"><span class="brand-mark">TA</span>Time &amp; Attendance</div>
    <label class="f">Username<input type="text" name="u" autocomplete="username" required autofocus></label>
    <label class="f">Password<input type="password" name="p" autocomplete="current-password" required></label>
    <button class="btn primary">Sign in</button>
    <div class="hint">Demo accounts: <b>admin</b>/admin123 · <b>ops</b>/ops123 · <b>msantos</b>/super123 · <b>jperez</b>/super123</div>
  </form></div>`;
  $('#lf').onsubmit = guard(async (e) => {
    e.preventDefault();
    await api('POST', '/api/login', { username: e.target.u.value, password: e.target.p.value });
    await boot();
  });
}

async function boot() {
  try { S.me = await api('GET', '/api/me'); } catch { return renderLogin(); }
  await reloadMeta();
  S.view.anchor ??= S.meta.today;
  renderShell(); connectRealtime(); route();
}

// ---------------------------------------------------------------- shared toolbar for matrix views
function matrixToolbar(onChange) {
  const m = S.meta;
  const html = `
  <div class="toolbar">
    <div class="seg"><button data-mode="week" class="${S.view.mode === 'week' ? 'on' : ''}">Week</button><button data-mode="month" class="${S.view.mode === 'month' ? 'on' : ''}">Month</button></div>
    <button class="btn" data-nav="-1" title="Previous">‹</button>
    <span class="range-label">${rangeLabel()}</span>
    <button class="btn" data-nav="1" title="Next">›</button>
    <button class="btn" data-nav="0">Today</button>
    <span class="grow"></span>
    <select id="f-camp"><option value="">All campaigns</option>${m.campaigns.map((c) => `<option value="${c.id}" ${String(c.id) === S.view.campaign ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
    ${isManager() ? `<select id="f-sup"><option value="">All supervisors</option>${m.supervisors.map((s) => `<option value="${esc(s.supervisor_code)}" ${s.supervisor_code === S.view.supervisor ? 'selected' : ''}>${esc(s.display_name)}</option>`).join('')}</select>` : ''}
    <input type="search" id="f-search" placeholder="Search agent…" value="${esc(S.view.search)}">
  </div>`;
  const bind = (root) => {
    $$('[data-mode]', root).forEach((b) => b.onclick = () => { S.view.mode = b.dataset.mode; onChange(); });
    $$('[data-nav]', root).forEach((b) => b.onclick = () => { const n = Number(b.dataset.nav); if (n === 0) S.view.anchor = S.meta.today; else shift(n); onChange(); });
    $('#f-camp', root).onchange = (e) => { S.view.campaign = e.target.value; onChange(); };
    if ($('#f-sup', root)) $('#f-sup', root).onchange = (e) => { S.view.supervisor = e.target.value; onChange(); };
    $('#f-search', root).oninput = debounce((e) => { S.view.search = e.target.value; onChange(true); }, 200);
  };
  return { html, bind };
}
function matrixQuery() {
  const { from, to } = currentRange();
  const p = new URLSearchParams({ from, to });
  if (S.view.campaign) p.set('campaign_id', S.view.campaign);
  if (S.view.supervisor && isManager()) p.set('supervisor_id', S.view.supervisor);
  return p.toString();
}
const visibleEmployees = () => {
  const q = S.view.search.trim().toLowerCase();
  return q ? S.data.employees.filter((e) => `${e.first_name} ${e.last_name} ${e.employee_id}`.toLowerCase().includes(q)) : S.data.employees;
};
function dayHeader(d, extra = '') {
  const cls = [dow(d) === 0 || dow(d) === 6 ? 'wknd' : '', d === S.meta.today ? 'today' : ''].join(' ');
  return `<th class="${cls}" data-day="${d}" ${extra}>${S.view.mode === 'week' ? `<span class="dow">${DOW[dow(d)]}</span>${shortDate(d)}` : `<span class="dow">${DOW[dow(d)][0]}</span>${toD(d).getUTCDate()}`}</th>`;
}
const dayCls = (d) => [dow(d) === 0 || dow(d) === 6 ? 'wknd' : '', d === S.meta.today ? 'today' : ''].join(' ');
const empCell = (e) => `<td class="emp" title="${esc(e.first_name + ' ' + e.last_name)}">${esc(e.last_name)}, ${esc(e.first_name)}<small>${esc(e.employee_id)} · ${esc(e.campaign_code || '—')}</small></td>`;

// ---------------------------------------------------------------- ATTENDANCE
async function viewAttendance(searchOnly) {
  const main = $('#main');
  if (!searchOnly || !S.data) {
    const tb = matrixToolbar((s) => viewAttendance(s));
    main.innerHTML = `<h1>Attendance</h1><p class="sub">Click a cell to mark attendance. Click a day header to mark every unmarked agent present. Changes appear for everyone in real time.</p>
      ${tb.html}<div class="panel"><div class="table-wrap" id="grid"></div></div><div class="legend" id="legend"></div>`;
    tb.bind(main);
    S.data = await api('GET', '/api/attendance?' + matrixQuery());
    S.data.kind = 'attendance';
  }
  renderAttendanceGrid();
  $('#legend').innerHTML = S.meta.attendance_codes.map((c) => `<span><span class="code" style="background:${esc(c.color)}">${esc(c.code)}</span> ${esc(c.label)}</span>`).join('') + '<span>🔒 / hatched = approved week (locked)</span>';
}

function renderAttendanceGrid() {
  const grid = $('#grid'); if (!grid || S.data?.kind !== 'attendance') return;
  const { days, marks, hours } = S.data;
  const emps = visibleEmployees();
  const month = S.view.mode === 'month';
  // Which codes appear (for monthly totals columns)
  const used = new Set();
  emps.forEach((e) => days.forEach((d) => { const m = marks[e.id]?.[d]; if (m) used.add(m.code_id); }));
  const totCodes = month ? S.meta.attendance_codes.filter((c) => used.has(c.id)) : [];
  const head = `<tr><th class="emp">Agent (${emps.length})</th>${days.map((d) => dayHeader(d, 'title="Mark all unmarked as present" style="cursor:pointer"')).join('')}
    ${month ? totCodes.map((c) => `<th title="${esc(c.label)}">${esc(c.code)}</th>`).join('') : '<th>Present</th><th>Absent</th>'}<th>Hours</th></tr>`;
  const body = emps.map((e) => {
    let present = 0, absent = 0, hrs = 0; const counts = {};
    const cells = days.map((d) => {
      const m = marks[e.id]?.[d]; const c = m && codeById(m.code_id); const h = hours[e.id]?.[d];
      if (c) { counts[c.id] = (counts[c.id] || 0) + 1; if (c.counts_present) present++; else if (c.code !== 'O' && c.code !== 'H') absent++; }
      if (h) hrs += h.total;
      const locked = isLockedDay(e, d);
      return `<td class="cell ${dayCls(d)} ${locked ? 'locked' : ''}" data-e="${e.id}" data-d="${d}" title="${esc(c ? c.label + (m.note ? ' — ' + m.note : '') : 'Not marked')}">
        ${c ? `<span class="code" style="background:${esc(c.color)}">${esc(c.code)}</span>` : ''}
        ${!month && h ? `<span class="hrs-mini">${fmtH(h.total)}h</span>` : ''}</td>`;
    }).join('');
    const tots = month ? totCodes.map((c) => `<td class="tot">${counts[c.id] || ''}</td>`).join('') : `<td class="tot">${present}</td><td class="tot">${absent}</td>`;
    return `<tr>${empCell(e)}${cells}${tots}<td class="tot">${fmtH(hrs)}</td></tr>`;
  }).join('');
  const foot = `<tr><td class="emp">Present / roster</td>${days.map((d) => {
    const p = emps.filter((e) => { const m = marks[e.id]?.[d]; return m && codeById(m.code_id)?.counts_present; }).length;
    return `<td class="${dayCls(d)}">${month ? p : `${p}/${emps.length}`}</td>`;
  }).join('')}<td colspan="${(month ? totCodes.length : 2) + 1}"></td></tr>`;
  grid.innerHTML = emps.length ? `<table class="matrix ${month ? 'month' : ''}"><thead>${head}</thead><tbody>${body}</tbody><tfoot>${foot}</tfoot></table>`
    : '<p class="muted" style="padding:20px">No agents in this view.</p>';

  $$('td.cell', grid).forEach((td) => td.onclick = (ev) => {
    const emp = S.data.employees.find((x) => x.id === Number(td.dataset.e));
    if (isLockedDay(emp, td.dataset.d)) return toast('This week has been approved and is locked.', true);
    openAttendancePop(td, emp, td.dataset.d);
  });
  $$('th[data-day]', grid).forEach((th) => th.onclick = guard(async () => {
    const d = th.dataset.day;
    const present = S.meta.attendance_codes.find((c) => c.code === 'P') || S.meta.attendance_codes[0];
    const targets = emps.filter((e) => !marks[e.id]?.[d] && !isLockedDay(e, d));
    if (!targets.length) return toast('Everyone is already marked for ' + shortDate(d));
    if (!confirm(`Mark ${targets.length} unmarked agent(s) as "${present.label}" on ${prettyDate(d)}?`)) return;
    const r = await api('POST', '/api/attendance/bulk', { entries: targets.map((e) => ({ employee_id: e.id, work_date: d, code_id: present.id })) });
    toast(`Marked ${r.applied} agent(s)` + (r.errors.length ? `, ${r.errors.length} failed` : ''));
  }));
}

function openAttendancePop(td, emp, day) {
  closeLayers();
  const cur = S.data.marks[emp.id]?.[day];
  const codes = S.meta.attendance_codes.filter((c) => !c.campaign_id || c.campaign_id === emp.campaign_id);
  const pop = document.createElement('div');
  pop.className = 'pop';
  pop.innerHTML = `<div style="font-weight:600">${esc(emp.first_name)} ${esc(emp.last_name)}</div>
    <div class="muted" style="font-size:12px;margin-bottom:8px">${prettyDate(day)}</div>
    <div class="codes">${codes.map((c) => `<button data-id="${c.id}" class="${cur?.code_id === c.id ? 'sel' : ''}"><span class="code" style="background:${esc(c.color)}">${esc(c.code)}</span>${esc(c.label)}</button>`).join('')}</div>
    <input type="text" id="pop-note" placeholder="Note (optional)" value="${esc(cur?.note || '')}" style="width:100%;margin-bottom:8px">
    <div style="display:flex;justify-content:space-between"><button class="btn sm danger" id="pop-clear" ${cur ? '' : 'disabled'}>Clear</button><span class="muted" style="font-size:11px">Tip: type a code letter</span></div>`;
  document.body.appendChild(pop);
  const r = td.getBoundingClientRect();
  pop.style.left = Math.min(r.left, innerWidth - 275) + 'px';
  pop.style.top = (r.bottom + 4 + 330 > innerHeight ? Math.max(8, r.top - pop.offsetHeight - 4) : r.bottom + 4) + 'px';
  const save = guard(async (codeId) => {
    await api('PUT', '/api/attendance', { employee_id: emp.id, work_date: day, code_id: codeId, note: $('#pop-note').value });
    closeLayers();
  });
  $$('.codes button', pop).forEach((b) => b.onclick = () => save(Number(b.dataset.id)));
  $('#pop-clear', pop).onclick = () => save(null);
  let typed = '';
  pop.addEventListener('keydown', (e) => {
    if (e.target.id === 'pop-note') { if (e.key === 'Enter' && cur) save(cur.code_id); return; }
    if (e.key.length === 1) {
      typed = (typed + e.key).toUpperCase().slice(-2);
      const exact = codes.find((c) => c.code === typed) || codes.find((c) => c.code === e.key.toUpperCase());
      const longer = codes.some((c) => c.code.length > typed.length && c.code.startsWith(typed));
      if (exact && !longer) save(exact.id);
    }
  });
  pop.tabIndex = -1; pop.focus();
  setTimeout(() => document.addEventListener('mousedown', function off(e) { if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('mousedown', off); } }), 0);
}

// ---------------------------------------------------------------- TIME
async function viewTime(searchOnly) {
  const main = $('#main');
  if (!searchOnly || S.data?.kind !== 'time') {
    const tb = matrixToolbar((s) => viewTime(s));
    main.innerHTML = `<h1>Time &amp; Hours</h1><p class="sub">Hours ingested from the phone system, plus supervisor adjustments. Click a cell to review or adjust.</p>
      ${tb.html}<div class="panel"><div class="table-wrap" id="grid"></div></div>
      <div class="legend"><span><span class="dot" style="position:static;display:inline-block"></span> adjusted</span>
      <span><span class="tag warn">amber</span> marked present but no hours</span><span><span class="tag danger">red</span> marked absent but has hours</span><span>🔒 / hatched = approved week (locked)</span></div>`;
    tb.bind(main);
    S.data = await api('GET', '/api/time?' + matrixQuery());
    S.data.kind = 'time';
  }
  const { days, hours, marks } = S.data;
  const emps = visibleEmployees();
  const month = S.view.mode === 'month';
  const dayTot = Object.fromEntries(days.map((d) => [d, 0]));
  const body = emps.map((e) => {
    let t = 0, p = 0, b = 0;
    const cells = days.map((d) => {
      const h = hours[e.id]?.[d]; const m = marks[e.id]?.[d]; const c = m && codeById(m.code_id);
      if (h) { t += h.total; p += h.paid; b += h.billable; dayTot[d] += h.total; }
      let flag = '';
      if (c?.counts_present && !(h?.total > 0) && d < S.meta.today) flag = 'warn-cell';
      if (c && !c.counts_present && h?.total > 0) flag = 'err-cell';
      const tip = [c ? 'Attendance: ' + c.label : 'No attendance mark', h ? `Raw ${fmtH(h.raw)}h, adjustments ${fmtH(h.adj)}h, paid ${fmtH(h.paid)}h, billable ${fmtH(h.billable)}h` : 'No hours'].join('\n');
      return `<td class="cell ${dayCls(d)} ${flag} ${isLockedDay(e, d) ? 'locked' : ''}" data-e="${e.id}" data-d="${d}" title="${esc(tip)}">
        ${h?.adjCount ? '<span class="dot"></span>' : ''}<span class="hcell ${h?.adjCount ? 'adj' : ''} ${h ? '' : 'none'}">${h ? fmtH(h.total) : '–'}</span></td>`;
    }).join('');
    return `<tr>${empCell(e)}${cells}<td class="tot">${fmtH(t)}</td>${month ? '' : `<td class="tot">${fmtH(p)}</td><td class="tot">${fmtH(b)}</td>`}</tr>`;
  }).join('');
  const grand = Object.values(dayTot).reduce((a, b) => a + b, 0);
  $('#grid').innerHTML = emps.length ? `<table class="matrix ${month ? 'month' : ''}">
    <thead><tr><th class="emp">Agent (${emps.length})</th>${days.map((d) => dayHeader(d)).join('')}<th>Total</th>${month ? '' : '<th>Paid</th><th>Billable</th>'}</tr></thead>
    <tbody>${body}</tbody>
    <tfoot><tr><td class="emp">Daily total</td>${days.map((d) => `<td class="${dayCls(d)}">${dayTot[d] ? fmtH(dayTot[d]) : ''}</td>`).join('')}<td>${fmtH(grand)}</td>${month ? '' : '<td></td><td></td>'}</tr></tfoot></table>`
    : '<p class="muted" style="padding:20px">No agents in this view.</p>';
  $$('#grid td.cell').forEach((td) => td.onclick = () => openTimeDrawer(Number(td.dataset.e), td.dataset.d));
}

async function openTimeDrawer(empId, day) {
  const d = await api('GET', `/api/time/detail?employee_id=${empId}&date=${day}`).catch((e) => toast(e.message, true));
  if (!d) return;
  closeLayers();
  const ov = document.createElement('div'); ov.className = 'overlay'; ov.onclick = closeLayers;
  const dr = document.createElement('div'); dr.className = 'drawer';
  const s = d.summary || { raw: 0, adj: 0, total: 0, paid: 0, billable: 0 };
  const future = day > S.meta.today;
  dr.innerHTML = `
    <div class="head-row"><div><h2>${esc(d.employee.first_name)} ${esc(d.employee.last_name)}</h2><div class="muted">${esc(d.employee.employee_id)} · ${prettyDate(day)}</div></div><button class="x">×</button></div>
    ${d.locked ? '<div class="tag ok">🔒 Week approved — read only</div>' : ''}
    <div class="stats">
      <div class="stat"><span>Raw</span><b>${fmtH(s.raw)}</b></div><div class="stat"><span>Adjust.</span><b>${s.adj > 0 ? '+' : ''}${fmtH(s.adj)}</b></div>
      <div class="stat"><span>Total</span><b>${fmtH(s.total)}</b></div><div class="stat"><span>Paid</span><b>${fmtH(s.paid)}</b></div><div class="stat"><span>Billable</span><b>${fmtH(s.billable)}</b></div>
    </div>
    <h3 style="font-size:14px">Ingested time</h3>
    ${d.raw.length ? d.raw.map((r) => `<div class="list-item"><div><b>${fmtH(r.hours)}h</b> <span class="tag">${esc(r.source)}</span><div class="muted" style="font-size:12px">Login ${esc(r.first_login || '—')} · Logout ${esc(r.last_logout || '—')}</div></div><div class="muted" style="font-size:11px">batch #${r.batch_id ?? '—'}<br>${esc(r.ingested_at)}</div></div>`).join('') : '<p class="muted">No hours received from the phone system for this day.</p>'}
    <h3 style="font-size:14px">Adjustments</h3>
    ${d.adjustments.length ? d.adjustments.map((a) => `<div class="list-item ${a.voided_at ? 'void' : ''}"><div><b>${a.hours > 0 ? '+' : ''}${fmtH(a.hours)}h</b> · ${esc(a.disposition_label)}
      <div class="muted" style="font-size:12px">${esc(a.note || '')}</div><div class="muted" style="font-size:11px">by ${esc(a.created_by_name)} · ${esc(a.created_at)}${a.voided_at ? ` · voided by ${esc(a.voided_by_name)}` : ''}</div></div>
      ${!a.voided_at && !d.locked ? `<button class="btn sm danger" data-void="${a.id}">Void</button>` : ''}</div>`).join('') : '<p class="muted">No adjustments.</p>'}
    ${d.locked || future ? (future ? '<p class="muted">Future dates cannot be adjusted.</p>' : '') : `
    <form id="adj" class="panel pad" style="margin-top:12px">
      <h3 style="font-size:14px;margin-top:0">New adjustment</h3>
      <label class="f">Disposition<select name="disp" required><option value="">Choose…</option>${d.dispositions.map((x) => `<option value="${x.id}">${esc(x.label)}${x.campaign_id ? ' (campaign)' : ''}</option>`).join('')}</select></label>
      <div class="muted" id="disp-desc" style="font-size:12px;margin:6px 0 10px"></div>
      <div class="grid2">
        <label class="f">Type<select name="mode"><option value="delta">Add / remove hours</option><option value="set">Set day total to</option></select></label>
        <label class="f"><span id="hlabel">Hours (use − to remove)</span><input type="number" name="hours" step="0.01" required></label>
      </div>
      <label class="f" style="margin-top:10px">Note<textarea name="note" placeholder="Reason, ticket #, etc."></textarea></label>
      <div style="margin-top:10px;display:flex;gap:8px;justify-content:flex-end"><button class="btn primary">Save adjustment</button></div>
    </form>`}`;
  document.body.append(ov, dr);
  $('.x', dr).onclick = closeLayers;
  $$('[data-void]', dr).forEach((b) => b.onclick = guard(async () => {
    if (!confirm('Void this adjustment? It stays in the history.')) return;
    await api('DELETE', '/api/time/adjustments/' + b.dataset.void); toast('Adjustment voided'); openTimeDrawer(empId, day); refreshTimeGrid();
  }));
  const f = $('#adj', dr);
  if (f) {
    f.disp.onchange = () => {
      const x = d.dispositions.find((y) => y.id === Number(f.disp.value));
      $('#disp-desc', dr).textContent = x ? `${x.description || ''} · ${x.direction === 'add' ? 'adds time only' : x.direction === 'subtract' ? 'removes time only' : 'add or remove'} · ${x.is_paid ? 'paid' : 'unpaid'} · ${x.is_billable ? 'billable' : 'non-billable'}${x.requires_note ? ' · note required' : ''}` : '';
    };
    f.mode.onchange = () => { $('#hlabel', dr).textContent = f.mode.value === 'set' ? `New total (currently ${fmtH(s.total)})` : 'Hours (use − to remove)'; };
    f.onsubmit = guard(async (e) => {
      e.preventDefault();
      let h = Number(f.hours.value);
      if (f.mode.value === 'set') h = Math.round((h - s.total) * 100) / 100;
      if (!h) return toast('That would not change the hours', true);
      await api('POST', '/api/time/adjustments', { employee_id: empId, work_date: day, hours: h, disposition_id: Number(f.disp.value), note: f.note.value });
      toast('Adjustment saved'); openTimeDrawer(empId, day); refreshTimeGrid();
    });
  }
}
async function refreshTimeGrid() { if (currentRoute() === 'time') { S.data = await api('GET', '/api/time?' + matrixQuery()); S.data.kind = 'time'; viewTime(true); } }

// ---------------------------------------------------------------- ROSTER
const EMP_FORM = [
  ['Identity', [['employee_id', 'Employee ID', 'text', true], ['first_name', 'First name', 'text', true], ['last_name', 'Last name', 'text', true], ['status', 'Status', 'status']]],
  ['Assignment', [['campaign_id', 'Campaign', 'campaign'], ['supervisor_id', 'Supervisor ID', 'supervisor']]],
  ['Dates', [['hire_date', 'Hire date', 'date'], ['production_start_date', 'Production start date', 'date'], ['termination_date', 'Termination date', 'date']]],
  ['System IDs', [['phone_system_id', 'Phone system ID', 'text'], ['crm_system_id', 'CRM system ID', 'text'], ['ris_emr_system_id', 'RIS / EMR system ID', 'text'], ['wfm_system_id', 'WFM system ID', 'text'], ['qa_system_id', 'QA system ID', 'text']]],
];
let rosterFilter = { campaign: '', supervisor: '', status: 'current', search: '' };

async function viewRoster() {
  const main = $('#main');
  const m = S.meta;
  main.innerHTML = `<h1>Roster</h1><p class="sub">${isManager() ? 'Master employee roster. Changes are audited and pushed to every supervisor instantly.' : 'Your assigned agents (read only — contact operations for changes).'}</p>
  <div class="toolbar">
    <input type="search" id="r-search" placeholder="Search ID, name, phone ID…" value="${esc(rosterFilter.search)}">
    <select id="r-camp"><option value="">All campaigns</option>${m.campaigns.map((c) => `<option value="${c.id}" ${String(c.id) === rosterFilter.campaign ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
    ${isManager() ? `<select id="r-sup"><option value="">All supervisors</option>${m.supervisors.map((s) => `<option value="${esc(s.supervisor_code)}" ${s.supervisor_code === rosterFilter.supervisor ? 'selected' : ''}>${esc(s.display_name)} (${esc(s.supervisor_code)})</option>`).join('')}</select>` : ''}
    <select id="r-status"><option value="current">Active &amp; on leave</option><option value="all" ${rosterFilter.status === 'all' ? 'selected' : ''}>Include terminated</option></select>
    <span class="grow"></span>
    <a class="btn" href="/api/employees/export.csv">Export CSV</a>
    ${isManager() ? '<label class="btn">Import CSV<input type="file" id="r-import" accept=".csv,text/csv" hidden></label><button class="btn primary" id="r-add">+ Add employee</button>' : ''}
  </div>
  <div class="panel"><div class="table-wrap" id="r-table"></div></div>`;
  const load = guard(async () => {
    const p = new URLSearchParams();
    if (rosterFilter.campaign) p.set('campaign_id', rosterFilter.campaign);
    if (rosterFilter.supervisor) p.set('supervisor_id', rosterFilter.supervisor);
    if (rosterFilter.status === 'all') p.set('include_inactive', '1');
    if (rosterFilter.search) p.set('search', rosterFilter.search);
    const rows = await api('GET', '/api/employees?' + p);
    $('#r-table').innerHTML = `<table><thead><tr><th>Employee ID</th><th>Name</th><th>Campaign</th><th>Supervisor</th><th>Hire</th><th>Prod. start</th><th>Phone</th><th>CRM</th><th>RIS/EMR</th><th>WFM</th><th>QA</th><th>Status</th></tr></thead>
      <tbody>${rows.map((e) => `<tr class="click" data-id="${e.id}"><td><b>${esc(e.employee_id)}</b></td><td>${esc(e.last_name)}, ${esc(e.first_name)}</td><td>${esc(e.campaign_name || '—')}</td>
      <td>${esc(e.supervisor_name || '')} <span class="muted">${esc(e.supervisor_id || '')}</span></td><td>${esc(e.hire_date || '')}</td><td>${esc(e.production_start_date || '')}</td>
      <td>${esc(e.phone_system_id || '')}</td><td>${esc(e.crm_system_id || '')}</td><td>${esc(e.ris_emr_system_id || '')}</td><td>${esc(e.wfm_system_id || '')}</td><td>${esc(e.qa_system_id || '')}</td>
      <td><span class="tag ${e.status === 'active' ? 'ok' : e.status === 'leave' ? 'warn' : 'danger'}">${esc(e.status)}</span></td></tr>`).join('') || '<tr><td colspan="12" class="muted">No employees match.</td></tr>'}</tbody></table>`;
    $$('#r-table tr[data-id]').forEach((tr) => tr.onclick = () => openEmployeeModal(rows.find((r) => r.id === Number(tr.dataset.id)), load));
  });
  $('#r-search').oninput = debounce((e) => { rosterFilter.search = e.target.value; load(); }, 250);
  $('#r-camp').onchange = (e) => { rosterFilter.campaign = e.target.value; load(); };
  if ($('#r-sup')) $('#r-sup').onchange = (e) => { rosterFilter.supervisor = e.target.value; load(); };
  $('#r-status').onchange = (e) => { rosterFilter.status = e.target.value; load(); };
  if ($('#r-add')) $('#r-add').onclick = () => openEmployeeModal(null, load);
  if ($('#r-import')) $('#r-import').onchange = guard(async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const r = await api('POST', '/api/employees/import', { csv: await file.text() });
    alert(`Import finished.\nCreated: ${r.created}\nUpdated: ${r.updated}\nErrors: ${r.errors.length}${r.errors.length ? '\n\n' + r.errors.slice(0, 15).map((x) => `Line ${x.line}: ${x.error}`).join('\n') : ''}`);
    e.target.value = ''; load();
  });
  load();
}

function openEmployeeModal(emp, onSaved) {
  closeLayers();
  const ro = !isManager();
  const ov = document.createElement('div'); ov.className = 'overlay'; ov.onclick = closeLayers;
  const md = document.createElement('div'); md.className = 'modal';
  const input = ([k, label, type, req]) => {
    const v = emp?.[k] ?? '';
    let ctl;
    if (type === 'campaign') ctl = `<select name="${k}"><option value="">—</option>${S.meta.campaigns.map((c) => `<option value="${c.id}" ${c.id === v ? 'selected' : ''}>${esc(c.name)} (${esc(c.code)})</option>`).join('')}</select>`;
    else if (type === 'supervisor') ctl = `<select name="${k}"><option value="">—</option>${S.meta.supervisors.map((s) => `<option value="${esc(s.supervisor_code)}" ${s.supervisor_code === v ? 'selected' : ''}>${esc(s.supervisor_code)} — ${esc(s.display_name)}</option>`).join('')}${v && !S.meta.supervisors.some((s) => s.supervisor_code === v) ? `<option selected value="${esc(v)}">${esc(v)}</option>` : ''}</select>`;
    else if (type === 'status') ctl = `<select name="${k}">${['active', 'leave', 'terminated'].map((s) => `<option ${s === (v || 'active') ? 'selected' : ''}>${s}</option>`).join('')}</select>`;
    else ctl = `<input type="${type}" name="${k}" value="${esc(v)}" ${req ? 'required' : ''}>`;
    return `<label class="f">${label}${req ? ' *' : ''}${ctl}</label>`;
  };
  md.innerHTML = `<form id="ef"><div class="head-row"><h2>${emp ? esc(emp.first_name + ' ' + emp.last_name) : 'New employee'}</h2><button type="button" class="x">×</button></div>
    <fieldset ${ro ? 'disabled' : ''} style="border:0;padding:0;margin:0">${EMP_FORM.map(([g, fields]) => `<fieldset><legend>${g}</legend><div class="grid3">${fields.map(input).join('')}</div></fieldset>`).join('')}</fieldset>
    <div style="display:flex;gap:8px;justify-content:space-between;align-items:center">
      <span>${emp ? '<a href="#" id="hist">View change history</a>' : ''}</span>
      <span><button type="button" class="btn" id="cancel">Close</button> ${ro ? '' : '<button class="btn primary">Save</button>'}</span></div>
    <div id="hist-box"></div></form>`;
  document.body.append(ov, md);
  $('.x', md).onclick = closeLayers; $('#cancel', md).onclick = closeLayers;
  if ($('#hist', md)) $('#hist', md).onclick = guard(async (e) => {
    e.preventDefault();
    const h = await api('GET', `/api/employees/${emp.id}/history`);
    $('#hist-box', md).innerHTML = `<table style="margin-top:12px"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Changes</th></tr></thead><tbody>${h.map((r) => {
      const det = r.details ? JSON.parse(r.details) : {};
      const txt = r.action === 'update' ? Object.entries(det).map(([k, [a, b]]) => `${k}: ${a ?? '∅'} → ${b ?? '∅'}`).join('; ') : '';
      return `<tr><td>${esc(r.ts)}</td><td>${esc(r.user_name || 'system')}</td><td>${esc(r.action)}</td><td style="white-space:normal">${esc(txt)}</td></tr>`;
    }).join('')}</tbody></table>`;
  });
  $('#ef', md).onsubmit = guard(async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    if (emp) await api('PUT', '/api/employees/' + emp.id, body); else await api('POST', '/api/employees', body);
    toast('Employee saved'); closeLayers(); onSaved();
  });
}

// ---------------------------------------------------------------- APPROVALS
let approvalWeek = null;
async function viewApprovals() {
  approvalWeek ??= addDays(weekStartOf(S.meta.today), -7);
  const d = await api('GET', '/api/approvals?week_start=' + approvalWeek);
  const settings = await api('GET', '/api/admin/settings');
  const payrollName = settings.payroll_target === 'spn' ? 'SPN' : 'Acon';
  const ended = d.week_end < S.meta.today;
  $('#main').innerHTML = `<h1>Weekly Approval</h1><p class="sub">Operations reviews each campaign's week, approves it (locking attendance &amp; hours), then sends hours to Billing and Payroll (${payrollName}).</p>
    <div class="toolbar"><button class="btn" data-w="-1">‹</button><span class="range-label">Week of ${shortDate(d.week_start)} – ${shortDate(d.week_end)}, ${toD(d.week_end).getUTCFullYear()}</span><button class="btn" data-w="1">›</button></div>
    <div class="cards">${d.campaigns.map((c) => {
      const ap = c.approval?.status === 'approved';
      return `<div class="panel pad camp-card" data-c="${c.campaign.id}">
        <div class="head-row"><div><h2>${esc(c.campaign.name)} <span class="muted" style="font-weight:400">${esc(c.campaign.code)}</span></h2>
          <div class="muted" style="font-size:12px">${ap ? `Approved by ${esc(c.approval.approved_by_name)} on ${esc(c.approval.approved_at)}` : ended ? 'Pending approval' : 'Week still in progress'}</div></div>
          <span class="tag ${ap ? 'ok' : 'warn'}">${ap ? 'APPROVED' : 'OPEN'}</span></div>
        <div class="stats">
          <div class="stat"><span>Agents</span><b>${c.totals.employees}</b></div><div class="stat"><span>Raw hrs</span><b>${fmtH(c.totals.raw)}</b></div>
          <div class="stat"><span>Adjust.</span><b>${fmtH(c.totals.adj)}</b></div><div class="stat"><span>Total</span><b>${fmtH(c.totals.total)}</b></div>
          <div class="stat"><span>Paid</span><b>${fmtH(c.totals.paid)}</b></div><div class="stat"><span>Billable</span><b>${fmtH(c.totals.billable)}</b></div>
          <div class="stat"><span>Exceptions</span><b style="color:${c.exceptions.length ? 'var(--warn)' : 'var(--ok)'}">${c.exceptions.length}</b></div>
        </div>
        ${c.exceptions.length ? `<details><summary>Review ${c.exceptions.length} exception(s)</summary><table><thead><tr><th>Agent</th><th>Date</th><th>Issue</th></tr></thead><tbody>
          ${c.exceptions.map((x) => `<tr><td>${esc(x.employee)}</td><td>${prettyDate(x.date)}</td><td>${esc(x.issue)}</td></tr>`).join('')}</tbody></table></details>` : ''}
        <div class="toolbar" style="margin:10px 0 0">
          ${ap ? `<button class="btn" data-act="reopen">Reopen week</button>
                  <button class="btn primary" data-exp="billing">Send to Billing</button>
                  <button class="btn primary" data-exp="payroll">Send to Payroll (${payrollName})</button>`
               : `<button class="btn primary" data-act="approve" ${ended ? '' : 'disabled title="The week has not ended yet"'}>Approve week</button>`}
        </div>
        ${c.exports.length ? `<details ${ap ? 'open' : ''}><summary>Export history (${c.exports.length})</summary><table><thead><tr><th>When</th><th>Target</th><th>Status</th><th class="num">Rows</th><th class="num">Hours</th><th>Message</th><th></th></tr></thead><tbody>
          ${c.exports.map((x) => `<tr><td>${esc(x.created_at)}</td><td>${esc(x.target)}</td><td><span class="tag ${x.status === 'sent' ? 'ok' : x.status === 'failed' ? 'danger' : 'warn'}">${esc(x.status)}</span></td>
          <td class="num">${x.row_count}</td><td class="num">${fmtH(x.total_hours)}</td><td style="white-space:normal;font-size:12px">${esc(x.message)}</td>
          <td><a href="/api/exports/${x.id}/download">CSV</a>${x.target !== 'billing' ? ` · <a href="/api/exports/${x.id}/download?format=artifact">${x.target === 'acon' ? 'SQL' : 'JSON'}</a>` : ''}</td></tr>`).join('')}</tbody></table></details>` : ''}
      </div>`;
    }).join('')}</div>`;
  $$('[data-w]').forEach((b) => b.onclick = () => { approvalWeek = addDays(approvalWeek, 7 * Number(b.dataset.w)); viewApprovals(); });
  $$('.camp-card').forEach((card) => {
    const cid = Number(card.dataset.c);
    $$('[data-act]', card).forEach((b) => b.onclick = guard(async () => {
      const c = d.campaigns.find((x) => x.campaign.id === cid);
      if (b.dataset.act === 'approve' && c.exceptions.length && !confirm(`${c.exceptions.length} exception(s) are unresolved. Approve anyway?`)) return;
      if (b.dataset.act === 'reopen' && !confirm('Reopen this week? Supervisors will be able to edit again. Already-exported batches are not recalled.')) return;
      await api('POST', '/api/approvals', { week_start: d.week_start, campaign_id: cid, action: b.dataset.act });
      toast(b.dataset.act === 'approve' ? 'Week approved and locked' : 'Week reopened'); viewApprovals();
    }));
    $$('[data-exp]', card).forEach((b) => b.onclick = guard(async () => {
      b.disabled = true;
      const r = await api('POST', '/api/exports', { week_start: d.week_start, campaign_id: cid, target: b.dataset.exp }).finally(() => { b.disabled = false; });
      toast(`${r.status.toUpperCase()}: ${r.message}`, r.status === 'failed'); viewApprovals();
    }));
  });
}

// ---------------------------------------------------------------- SETTINGS
const CONFIG = {
  campaigns: { title: 'Campaigns', fields: [['code', 'Code', 'text', true], ['name', 'Name', 'text', true], ['client', 'Client', 'text'], ['billing_code', 'Billing code', 'text'], ['active', 'Active', 'bool']] },
  attendance_codes: { title: 'Attendance codes', fields: [['code', 'Code', 'text', true], ['label', 'Label', 'text', true], ['color', 'Color', 'color'], ['counts_present', 'Counts as present', 'bool'], ['is_paid', 'Paid', 'bool'], ['campaign_id', 'Campaign (blank = all)', 'campaign'], ['sort', 'Sort order', 'number'], ['active', 'Active', 'bool']] },
  dispositions: { title: 'Dispositions', fields: [['code', 'Code', 'text', true], ['label', 'Label', 'text', true], ['campaign_id', 'Campaign (blank = all)', 'campaign'], ['description', 'Description', 'text'], ['direction', 'Direction', 'direction'], ['payroll_code', 'Payroll earning code', 'text'], ['is_paid', 'Paid', 'bool'], ['is_billable', 'Billable', 'bool'], ['requires_note', 'Requires note', 'bool'], ['active', 'Active', 'bool']] },
};
async function viewSettings() {
  const tab = location.hash.split('/')[2] || 'campaigns';
  const tabs = [['campaigns', 'Campaigns'], ['users', 'Users & supervisors'], ['attendance_codes', 'Attendance codes'], ['dispositions', 'Dispositions'], ['integrations', 'Integrations'], ['audit', 'Audit log']];
  $('#main').innerHTML = `<h1>Settings</h1><p class="sub">Configuration for campaigns, users, codes and integrations.</p>
    <div class="tabs">${tabs.map(([k, l]) => `<a href="#/settings/${k}" class="${k === tab ? 'on' : ''}">${l}</a>`).join('')}</div><div id="set-body"></div>`;
  if (CONFIG[tab]) return configTable(tab);
  if (tab === 'users') return usersTab();
  if (tab === 'integrations') return integrationsTab();
  if (tab === 'audit') return auditTab();
}

async function configTable(key) {
  const cfg = CONFIG[key];
  const rows = await api('GET', '/api/admin/' + key);
  const campName = (id) => S.meta.campaigns.find((c) => c.id === id)?.code || 'All';
  const show = (r, [k, , t]) => t === 'bool' ? (r[k] ? '✓' : '') : t === 'campaign' ? esc(campName(r[k])) : t === 'color' ? `<span class="code" style="background:${esc(r[k])}">&nbsp;</span>` : esc(r[k] ?? '');
  $('#set-body').innerHTML = `<div class="toolbar">${key === 'dispositions' ? '<span class="muted">Dispositions with a campaign are only offered for that campaign\'s agents. Negative adjustments always reduce paid and billable hours.</span>' : ''}<span class="grow"></span><button class="btn primary" id="add">+ Add</button></div>
    <div class="panel"><div class="table-wrap"><table><thead><tr>${cfg.fields.map(([, l]) => `<th>${l}</th>`).join('')}</tr></thead><tbody>
    ${rows.map((r) => `<tr class="click" data-id="${r.id}" style="${r.active ? '' : 'opacity:.5'}">${cfg.fields.map((f) => `<td>${show(r, f)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>`;
  const edit = (row) => formModal(cfg.title, cfg.fields, row, async (body) => {
    if (row) await api('PUT', `/api/admin/${key}/${row.id}`, body); else await api('POST', `/api/admin/${key}`, body);
    await reloadMeta(); configTable(key);
  });
  $('#add').onclick = () => edit(null);
  $$('#set-body tr[data-id]').forEach((tr) => tr.onclick = () => edit(rows.find((r) => r.id === Number(tr.dataset.id))));
}

function formModal(title, fields, row, onSave) {
  closeLayers();
  const ov = document.createElement('div'); ov.className = 'overlay'; ov.onclick = closeLayers;
  const md = document.createElement('div'); md.className = 'modal'; md.style.width = 'min(560px, calc(100vw - 32px))';
  const ctl = ([k, l, t, req]) => {
    const v = row ? row[k] : (t === 'bool' ? (k === 'active' || k === 'is_paid' || k === 'is_billable' ? 1 : 0) : t === 'color' ? '#64748b' : t === 'direction' ? 'any' : '');
    if (t === 'bool') return `<label class="chk"><input type="checkbox" name="${k}" ${v ? 'checked' : ''}> ${l}</label>`;
    if (t === 'campaign') return `<label class="f">${l}<select name="${k}"><option value="">All campaigns</option>${S.meta.campaigns.map((c) => `<option value="${c.id}" ${c.id === v ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>`;
    if (t === 'direction') return `<label class="f">${l}<select name="${k}">${[['any', 'Add or remove'], ['add', 'Add time only'], ['subtract', 'Remove time only']].map(([a, b]) => `<option value="${a}" ${a === v ? 'selected' : ''}>${b}</option>`).join('')}</select></label>`;
    if (t === 'role') return `<label class="f">${l}<select name="${k}">${['supervisor', 'operations', 'admin'].map((a) => `<option ${a === v ? 'selected' : ''}>${a}</option>`).join('')}</select></label>`;
    return `<label class="f">${l}${req ? ' *' : ''}<input type="${t}" name="${k}" value="${esc(v ?? '')}" ${req ? 'required' : ''} ${row && k === 'username' ? 'disabled' : ''}></label>`;
  };
  md.innerHTML = `<form><div class="head-row"><h2>${row ? 'Edit' : 'New'} — ${esc(title)}</h2><button type="button" class="x">×</button></div>
    <div class="grid2">${fields.filter((f) => f[2] !== 'bool').map(ctl).join('')}</div>
    <div style="display:flex;flex-wrap:wrap;gap:16px;margin:14px 0">${fields.filter((f) => f[2] === 'bool').map(ctl).join('')}</div>
    <div style="text-align:right"><button type="button" class="btn" id="cancel">Cancel</button> <button class="btn primary">Save</button></div></form>`;
  document.body.append(ov, md);
  $('.x', md).onclick = closeLayers; $('#cancel', md).onclick = closeLayers;
  $('form', md).onsubmit = guard(async (e) => {
    e.preventDefault();
    const body = {};
    for (const [k, , t] of fields) {
      const el = e.target.elements[k]; if (!el || el.disabled) continue;
      body[k] = t === 'bool' ? (el.checked ? 1 : 0) : t === 'number' ? (el.value === '' ? null : Number(el.value)) : el.value;
      if (t === 'campaign') body[k] = el.value ? Number(el.value) : null;
    }
    if (body.password === '') delete body.password;
    await onSave(body); toast('Saved'); closeLayers();
  });
}

async function usersTab() {
  const rows = await api('GET', '/api/admin/users');
  const admin = S.me.role === 'admin';
  $('#set-body').innerHTML = `<div class="toolbar"><span class="muted">A supervisor's <b>supervisor code</b> must match the <b>Supervisor ID</b> on the roster; that's how each supervisor sees their agents.</span><span class="grow"></span>${admin ? '<button class="btn primary" id="add">+ Add user</button>' : ''}</div>
    <div class="panel"><div class="table-wrap"><table><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Supervisor code</th><th>Active</th><th>Created</th></tr></thead><tbody>
    ${rows.map((r) => `<tr class="${admin ? 'click' : ''}" data-id="${r.id}" style="${r.active ? '' : 'opacity:.5'}"><td>${esc(r.display_name)}</td><td>${esc(r.username)}</td><td>${esc(r.role)}</td><td>${esc(r.supervisor_code || '')}</td><td>${r.active ? '✓' : ''}</td><td>${esc(r.created_at)}</td></tr>`).join('')}</tbody></table></div></div>`;
  if (!admin) return;
  const fields = (isNew) => [['display_name', 'Full name', 'text', true], ['username', 'Username', 'text', true], ['role', 'Role', 'role'], ['supervisor_code', 'Supervisor code', 'text'], ['password', isNew ? 'Password (min 8)' : 'New password (leave blank to keep)', 'password', isNew], ['active', 'Active', 'bool']];
  const edit = (row) => formModal('User', fields(!row), row, async (body) => {
    if (row) { delete body.username; body.active = !!body.active; await api('PUT', '/api/admin/users/' + row.id, body); } else await api('POST', '/api/admin/users', body);
    await reloadMeta(); usersTab();
  });
  $('#add').onclick = () => edit(null);
  $$('#set-body tr[data-id]').forEach((tr) => tr.onclick = () => edit(rows.find((r) => r.id === Number(tr.dataset.id))));
}

async function integrationsTab() {
  const [s, batches] = await Promise.all([api('GET', '/api/admin/settings'), api('GET', '/api/ingest/batches')]);
  const admin = S.me.role === 'admin';
  const c = s.connectors;
  const st = (ok) => `<span class="tag ${ok ? 'ok' : 'warn'}">${ok ? 'connected' : 'dry-run (not configured)'}</span>`;
  $('#set-body').innerHTML = `
  <div class="grid2" style="align-items:start">
    <div class="panel pad">
      <h3 style="margin-top:0">General</h3>
      <form id="gen">
        <div class="grid2">
          <label class="f">Week starts on<select name="week_start_day" ${admin ? '' : 'disabled'}>${[[0, 'Sunday'], [1, 'Monday'], [6, 'Saturday']].map(([v, l]) => `<option value="${v}" ${v === s.week_start_day ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label class="f">Payroll system<select name="payroll_target" ${admin ? '' : 'disabled'}><option value="acon" ${s.payroll_target === 'acon' ? 'selected' : ''}>Acon (SQL Server)</option><option value="spn" ${s.payroll_target === 'spn' ? 'selected' : ''}>SPN (REST API)</option></select></label>
          <label class="f">Regular hours earning code<input type="text" name="regular_payroll_code" value="${esc(s.regular_payroll_code)}" ${admin ? '' : 'disabled'}></label>
          <label class="f">Billing webhook URL (optional)<input type="text" name="billing_webhook_url" value="${esc(s.billing_webhook_url)}" placeholder="https://billing.internal/api/hours" ${admin ? '' : 'disabled'}></label>
        </div>
        ${admin ? '<div style="text-align:right;margin-top:10px"><button class="btn primary">Save</button></div>' : ''}
      </form>
      <h3>Outbound connectors</h3>
      <table><tbody>
        <tr><td>Billing</td><td>${st(c.billing.configured)}</td><td class="muted">${esc(c.billing.url || 'CSV download')}</td></tr>
        <tr><td>Acon (SQL Server)</td><td>${st(c.acon.configured)}</td><td class="muted">${esc(c.acon.server ? `${c.acon.server}/${c.acon.database} → ${c.acon.table}` : 'Set ACON_SQL_* env vars')}</td></tr>
        <tr><td>SPN (API)</td><td>${st(c.spn.configured)}</td><td class="muted">${esc(c.spn.url || 'Set SPN_API_URL / SPN_API_KEY')}</td></tr>
      </tbody></table>
      <p class="muted" style="font-size:12px">Connection secrets are read from server environment variables, never stored in the database. In dry-run mode each export still produces a downloadable SQL / JSON / CSV file.</p>
    </div>
    <div class="panel pad">
      <h3 style="margin-top:0">Hours ingestion (SQL Server → this app)</h3>
      <p>A scheduled job runs your SQL Server query a few times a day and posts the rows here. Re-sending the same day overwrites it (idempotent).</p>
      <label class="f">Ingestion API key<div style="display:flex;gap:6px"><input type="text" readonly value="${esc(s.ingest_api_key)}" style="flex:1;font-family:monospace;font-size:12px">${admin ? '<button class="btn" id="rotate">Rotate</button>' : ''}</div></label>
      <pre class="code-block">curl -X POST ${esc(location.origin)}/api/ingest/hours \\
  -H "X-API-Key: &lt;key&gt;" -H "Content-Type: application/json" \\
  -d '{"source":"phone","key_type":"phone_system_id",
       "rows":[{"employee_key":"PH1001","work_date":"${S.meta.today}",
                "hours":8.05,"first_login":"08:02","last_logout":"16:35"}]}'</pre>
      <p><a href="/integration/hours_query.sql">⬇ SQL Server query template</a> · <a href="/integration/sync_hours.js">⬇ Node sync job</a> · <a href="/integration/sync_hours.ps1">⬇ PowerShell sync job</a> · <a href="/integration/acon_import_table.sql">⬇ Acon staging table</a></p>
      <h3>Manual upload</h3>
      <p class="muted" style="font-size:12px">CSV with columns <code>employee_key,work_date,hours,first_login,last_logout</code>.</p>
      <div class="toolbar"><select id="up-key"><option value="phone_system_id">Key: Phone system ID</option><option value="employee_id">Key: Employee ID</option><option value="wfm_system_id">Key: WFM ID</option></select>
        <label class="btn">Upload CSV<input type="file" id="up" accept=".csv" hidden></label></div>
    </div>
  </div>
  <div class="panel" style="margin-top:14px"><div class="pad" style="padding:12px 16px 0"><h3 style="margin:0">Recent ingestion batches</h3></div><div class="table-wrap" style="max-height:340px"><table><thead><tr><th>#</th><th>Received</th><th>Source</th><th class="num">Rows</th><th class="num">Applied</th><th class="num">Rejected</th><th>Errors</th></tr></thead><tbody>
    ${batches.map((b) => `<tr><td>${b.id}</td><td>${esc(b.received_at)}</td><td>${esc(b.source)}</td><td class="num">${b.rows_received}</td><td class="num">${b.rows_applied}</td><td class="num">${b.rows_rejected ? `<span class="tag danger">${b.rows_rejected}</span>` : 0}</td>
      <td style="white-space:normal;font-size:12px">${b.errors ? esc(JSON.parse(b.errors).slice(0, 3).map((e) => `${e.key}: ${e.error}`).join('; ')) : ''}</td></tr>`).join('')}</tbody></table></div></div>`;
  if (admin) {
    $('#gen').onsubmit = guard(async (e) => {
      e.preventDefault();
      await api('PUT', '/api/admin/settings', Object.fromEntries(new FormData(e.target)));
      await reloadMeta(); toast('Settings saved'); integrationsTab();
    });
    $('#rotate').onclick = guard(async () => { if (!confirm('Rotate the API key? The sync job must be updated with the new key.')) return; await api('POST', '/api/admin/settings/rotate-key'); integrationsTab(); });
  }
  $('#up').onchange = guard(async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const r = await api('POST', '/api/ingest/upload', { csv: await f.text(), key_type: $('#up-key').value });
    alert(`Applied ${r.applied} of ${r.received} rows. Rejected: ${r.rejected}${r.errors.length ? '\n\n' + r.errors.slice(0, 15).map((x) => `${x.key || 'row ' + x.row}: ${x.error}`).join('\n') : ''}`);
    integrationsTab();
  });
}

async function auditTab() {
  const rows = await api('GET', '/api/admin/audit');
  $('#set-body').innerHTML = `<div class="panel"><div class="table-wrap"><table><thead><tr><th>When (UTC)</th><th>User</th><th>Entity</th><th>Action</th><th>Details</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${esc(r.ts)}</td><td>${esc(r.user_name || 'system / API')}</td><td>${esc(r.entity)} ${esc(r.entity_id || '')}</td><td>${esc(r.action)}</td><td style="white-space:normal;font-size:12px;max-width:520px">${esc(r.details || '')}</td></tr>`).join('')}</tbody></table></div></div>`;
}

boot();
