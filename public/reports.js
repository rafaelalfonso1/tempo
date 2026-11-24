/* Tempo — Reports: an Excel-style pivot table over agent-day facts.
 * Loaded before app.js; uses its helpers ($, api, esc, S, toast, guard…) at call time. */
'use strict';

// ------------------------------------------------------------------ field catalogue
// Dimensions group rows/columns; measures are aggregated in Values.
// Every fact is one agent-day that has an attendance mark and/or hours.
const R_DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const R_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TENURE = ['Pre-production', '0–3 months', '3–6 months', '6–12 months', '12+ months', 'Unknown'];
const isoLabel = (s) => { const d = new Date(s + 'T00:00:00Z'); return `${R_MON[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`; };

const R_FIELDS = [
  // Date
  { id: 'date', label: 'Date', group: 'Date', type: 'dim', key: (f) => f.date, fmt: (v) => `${R_DOW[new Date(v + 'T00:00:00Z').getUTCDay()].slice(0, 3)} ${isoLabel(v)}` },
  { id: 'week', label: 'Week', group: 'Date', type: 'dim', key: (f) => f.week, fmt: (v) => 'Week of ' + isoLabel(v) },
  { id: 'month', label: 'Month', group: 'Date', type: 'dim', key: (f) => f.date.slice(0, 7), fmt: (v) => `${R_MON[Number(v.slice(5)) - 1]} ${v.slice(0, 4)}` },
  { id: 'year', label: 'Year', group: 'Date', type: 'dim', key: (f) => f.date.slice(0, 4) },
  { id: 'weekday', label: 'Weekday', group: 'Date', type: 'dim', key: (f) => String(f.dow), fmt: (v) => R_DOW[v], sort: (v) => (Number(v) - RPT.weekStart + 7) % 7 },
  // Organization
  { id: 'client', label: 'Client', group: 'Organization', type: 'dim', key: (f) => f.client },
  { id: 'campaign', label: 'Campaign', group: 'Organization', type: 'dim', key: (f) => f.campaign },
  { id: 'supervisor', label: 'Supervisor', group: 'Organization', type: 'dim', key: (f) => f.supervisor },
  { id: 'agent', label: 'Agent', group: 'Organization', type: 'dim', key: (f) => f.agent },
  { id: 'employee_id', label: 'Employee ID', group: 'Organization', type: 'dim', key: (f) => f.employee_id },
  { id: 'modality', label: 'Modality (WFH / ONS)', group: 'Organization', type: 'dim', key: (f) => f.modality },
  { id: 'emp_status', label: 'Employee status', group: 'Organization', type: 'dim', key: (f) => f.status },
  { id: 'tenure', label: 'Tenure (from production start)', group: 'Organization', type: 'dim', key: (f) => f.tenure, sort: (v) => TENURE.indexOf(v) },
  // Attendance
  { id: 'att_code', label: 'Attendance code', group: 'Attendance', type: 'dim', key: (f) => f.code },
  { id: 'present', label: 'Days present', group: 'Attendance', type: 'measure', base: 'present', fmt: 'int' },
  { id: 'absent', label: 'Days absent', group: 'Attendance', type: 'measure', base: 'absent', fmt: 'int' },
  { id: 'worked', label: 'Days worked', group: 'Attendance', type: 'measure', base: 'worked', fmt: 'int', help: 'Days marked present or with hours > 0' },
  { id: 'att_rate', label: 'Attendance %', group: 'Attendance', type: 'measure', kind: 'ratio', num: 'present', den: 'marked', fmt: 'pct', help: 'Present ÷ (present + absent). Days off, vacation and holidays are excluded.' },
  { id: 'abs_rate', label: 'Absenteeism %', group: 'Attendance', type: 'measure', kind: 'ratio', num: 'absent', den: 'marked', fmt: 'pct', help: 'Absent ÷ (present + absent)' },
  // Time
  { id: 'total', label: 'Total hours', group: 'Time', type: 'measure', base: 'total', fmt: 'h' },
  { id: 'raw', label: 'Raw hours (phone system)', group: 'Time', type: 'measure', base: 'raw', fmt: 'h' },
  { id: 'adj', label: 'Adjustment hours', group: 'Time', type: 'measure', base: 'adj', fmt: 'h' },
  { id: 'paid', label: 'Paid hours', group: 'Time', type: 'measure', base: 'paid', fmt: 'h' },
  { id: 'billable', label: 'Billable hours', group: 'Time', type: 'measure', base: 'billable', fmt: 'h' },
  { id: 'bill_pct', label: 'Billable %', group: 'Time', type: 'measure', kind: 'ratio', num: 'billable', den: 'total', fmt: 'pct' },
  // Schedule
  { id: 'sched_hours', label: 'Scheduled hours', group: 'Schedule', type: 'measure', base: 'sched_hours', fmt: 'h' },
  { id: 'sched_days', label: 'Days scheduled', group: 'Schedule', type: 'measure', base: 'scheduled', fmt: 'int' },
  { id: 'sched_adh', label: 'Hours vs schedule %', group: 'Schedule', type: 'measure', kind: 'ratio', num: 'total', den: 'sched_hours', fmt: 'pct', help: 'Total hours ÷ scheduled hours' },
  { id: 'sched_show', label: 'Scheduled days worked %', group: 'Schedule', type: 'measure', kind: 'ratio', num: 'sched_worked', den: 'scheduled', fmt: 'pct', help: 'Of the days an agent was scheduled to work, the share they actually worked (present or with hours)' },
  { id: 'sched_missing', label: 'Scheduled days not marked', group: 'Schedule', type: 'measure', base: 'sched_unmarked', fmt: 'int', help: 'Scheduled working days with no attendance mark' },
  // Productivity
  { id: 'productivity', label: 'Productivity (hrs / day worked)', group: 'Productivity', type: 'measure', kind: 'ratio', num: 'total', den: 'worked', fmt: 'h', help: 'Total hours ÷ days worked, for whatever group and period the cell covers' },
  { id: 'hrs_agent', label: 'Hours per agent', group: 'Productivity', type: 'measure', kind: 'ratio', num: 'total', den: '@agents', fmt: 'h' },
  { id: 'agents', label: 'Agents (distinct)', group: 'Productivity', type: 'measure', kind: 'agents', fmt: 'int' },
  { id: 'records', label: 'Agent-days (records)', group: 'Productivity', type: 'measure', kind: 'count', fmt: 'int' },
];
const RF = Object.fromEntries(R_FIELDS.map((f) => [f.id, f]));
const BASES = ['raw', 'adj', 'total', 'paid', 'billable', 'present', 'absent', 'worked', 'marked', 'sched_hours', 'scheduled', 'sched_worked', 'sched_unmarked'];
const AGGS = { sum: 'Sum', avg: 'Average', min: 'Min', max: 'Max', count: 'Count' };
const DIM_AGGS = { distinct: 'Distinct count', count: 'Count' };
const defaultAgg = (f) => (f.type === 'dim' ? 'distinct' : f.kind ? 'value' : 'sum');
function valueLabel(v) {
  const f = RF[v.field];
  if (f.type === 'dim') return `${DIM_AGGS[v.agg]} of ${f.label}`;
  if (f.kind) return f.label;
  return v.agg === 'sum' ? f.label : `${AGGS[v.agg]} of ${f.label}`;
}

// ------------------------------------------------------------------ presets & date ranges
const RANGE_PRESETS = {
  this_week: 'This week', last_week: 'Last week', this_month: 'This month', last_month: 'Last month',
  last_30: 'Last 30 days', last_90: 'Last 90 days', ytd: 'Year to date', custom: 'Custom range',
};
function resolveRange(cfg) {
  const t = S.meta.today; const d = toD(t); const y = d.getUTCFullYear(), m = d.getUTCMonth();
  const ws = weekStartOf(t);
  switch (cfg.range) {
    case 'this_week': return { from: ws, to: addDays(ws, 6) };
    case 'last_week': return { from: addDays(ws, -7), to: addDays(ws, -1) };
    case 'this_month': return { from: iso(new Date(Date.UTC(y, m, 1))), to: iso(new Date(Date.UTC(y, m + 1, 0))) };
    case 'last_month': return { from: iso(new Date(Date.UTC(y, m - 1, 1))), to: iso(new Date(Date.UTC(y, m, 0))) };
    case 'last_30': return { from: addDays(t, -29), to: t };
    case 'last_90': return { from: addDays(t, -89), to: t };
    case 'ytd': return { from: `${y}-01-01`, to: t };
    default: return { from: cfg.from || addDays(t, -29), to: cfg.to || t };
  }
}
const BUILTIN_REPORTS = [
  { name: 'Productivity by supervisor & agent', config: { range: 'this_month', rows: ['supervisor', 'agent'], cols: [], values: [{ field: 'productivity', agg: 'value' }, { field: 'total', agg: 'sum' }, { field: 'worked', agg: 'sum' }, { field: 'att_rate', agg: 'value' }], filters: [], sort: { by: 'label', dir: 1 }, heat: true } },
  { name: 'Hours by campaign by week', config: { range: 'last_90', rows: ['client', 'campaign'], cols: ['week'], values: [{ field: 'total', agg: 'sum' }], filters: [], sort: { by: 'label', dir: 1 }, heat: false } },
  { name: 'Daily attendance', config: { range: 'this_month', rows: ['date'], cols: [], values: [{ field: 'agents', agg: 'value' }, { field: 'present', agg: 'sum' }, { field: 'absent', agg: 'sum' }, { field: 'att_rate', agg: 'value' }, { field: 'total', agg: 'sum' }], filters: [], sort: { by: 'label', dir: 1 }, heat: false } },
  { name: 'Client billing summary', config: { range: 'last_week', rows: ['client', 'campaign'], cols: [], values: [{ field: 'billable', agg: 'sum' }, { field: 'paid', agg: 'sum' }, { field: 'total', agg: 'sum' }, { field: 'bill_pct', agg: 'value' }], filters: [], sort: { by: 'label', dir: 1 }, heat: false } },
  { name: 'Attendance codes by agent', config: { range: 'this_month', rows: ['agent'], cols: ['att_code'], values: [{ field: 'records', agg: 'value' }], filters: [], sort: { by: 'label', dir: 1 }, heat: true } },
  { name: 'Schedule adherence by supervisor', config: { range: 'last_week', rows: ['supervisor', 'agent'], cols: [], values: [{ field: 'sched_hours', agg: 'sum' }, { field: 'total', agg: 'sum' }, { field: 'sched_adh', agg: 'value' }, { field: 'sched_show', agg: 'value' }, { field: 'sched_missing', agg: 'sum' }], filters: [], sort: { by: 'label', dir: 1 }, heat: true } },
  { name: 'Hours by modality', config: { range: 'this_month', rows: ['modality', 'campaign'], cols: [], values: [{ field: 'agents', agg: 'value' }, { field: 'total', agg: 'sum' }, { field: 'productivity', agg: 'value' }, { field: 'att_rate', agg: 'value' }], filters: [], sort: { by: 'label', dir: 1 }, heat: false } },
  { name: 'Productivity by weekday', config: { range: 'last_90', rows: ['weekday'], cols: ['campaign'], values: [{ field: 'productivity', agg: 'value' }], filters: [], sort: { by: 'label', dir: 1 }, heat: true } },
];

// ------------------------------------------------------------------ state
const RPT = {
  cfg: structuredClone(BUILTIN_REPORTS[0].config),
  reportRef: 'b0',          // 'b<index>' built-in, 's<id>' saved
  saved: [], facts: [], loadedRange: null, weekStart: 1, collapsed: new Set(), pivot: null,
};

// Turn the compact API payload into rich fact objects.
function hydrateFacts(d) {
  RPT.weekStart = d.week_start_day;
  const emps = Object.fromEntries(d.employees.map((e) => [e.id, e]));
  const camps = Object.fromEntries(d.campaigns.map((c) => [c.id, c]));
  const codes = Object.fromEntries(d.codes.map((c) => [c.id, c]));
  return d.rows.map(([eid, date, codeId, raw, adj, total, paid, billable, schedHours = 0, scheduled = 0]) => {
    const e = emps[eid] || {}; const c = camps[e.campaign_id] || {}; const code = codes[codeId];
    const present = code?.counts_present ? 1 : 0, absent = code?.counts_absent ? 1 : 0;
    const dt = new Date(date + 'T00:00:00Z');
    let tenure = 'Unknown';
    if (e.production_start_date) {
      const ps = new Date(e.production_start_date + 'T00:00:00Z');
      const months = (dt - ps) / (86400000 * 30.44);
      tenure = months < 0 ? TENURE[0] : months < 3 ? TENURE[1] : months < 6 ? TENURE[2] : months < 12 ? TENURE[3] : TENURE[4];
    }
    return {
      empId: eid, date, dow: dt.getUTCDay(), week: weekStartOf(date),
      agent: e.name || '(unknown)', employee_id: e.employee_id || '', status: e.status || '',
      campaign: c.name || '(no campaign)', client: c.client || '(no client)',
      supervisor: e.supervisor_name || e.supervisor_id || '(no supervisor)', tenure, modality: e.modality || '(not set)',
      code: code ? `${code.code} — ${code.label}` : '(not marked)',
      raw, adj, total, paid, billable, present, absent,
      worked: present || total > 0 ? 1 : 0, marked: present + absent,
      sched_hours: schedHours, scheduled, sched_worked: scheduled && (present || total > 0) ? 1 : 0, sched_unmarked: scheduled && !code ? 1 : 0,
    };
  });
}

// ------------------------------------------------------------------ pivot engine
function newAcc(distinctDims) {
  const a = { n: 0, sum: {}, min: {}, max: {}, agents: new Set(), distinct: {} };
  for (const b of BASES) { a.sum[b] = 0; a.min[b] = Infinity; a.max[b] = -Infinity; }
  for (const d of distinctDims) a.distinct[d] = new Set();
  return a;
}
function addToAcc(a, f, distinctDims) {
  a.n++; a.agents.add(f.empId);
  for (const b of BASES) { const v = f[b]; a.sum[b] += v; if (v < a.min[b]) a.min[b] = v; if (v > a.max[b]) a.max[b] = v; }
  for (const d of distinctDims) a.distinct[d].add(RF[d].key(f));
}
function valueOf(a, v) {
  if (!a) return null;
  const f = RF[v.field];
  if (f.type === 'dim') return v.agg === 'count' ? a.n : a.distinct[v.field].size;
  if (f.kind === 'ratio') { const den = f.den === '@agents' ? a.agents.size : a.sum[f.den]; return den ? a.sum[f.num] / den : null; }
  if (f.kind === 'agents') return a.agents.size;
  if (f.kind === 'count') return a.n;
  if (v.agg === 'avg') return a.n ? a.sum[f.base] / a.n : null;
  if (v.agg === 'min') return a.n ? a.min[f.base] : null;
  if (v.agg === 'max') return a.n ? a.max[f.base] : null;
  if (v.agg === 'count') return a.n;
  return a.sum[f.base];
}
function fmtValue(x, v) {
  if (x == null || Number.isNaN(x)) return '';
  const f = RF[v.field];
  let kind = f.type === 'dim' || v.agg === 'count' ? 'int' : f.fmt;
  if (v.agg === 'avg' && kind === 'int') kind = 'h';
  if (kind === 'pct') return (x * 100).toFixed(1) + '%';
  if (kind === 'int') return Math.round(x).toLocaleString();
  return x.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
const dimLabel = (id, v) => (RF[id].fmt ? RF[id].fmt(v) : v);
const dimSortKey = (id, v) => (RF[id].sort ? RF[id].sort(v) : v);
const cmpDim = (id) => (a, b) => {
  const x = dimSortKey(id, a), y = dimSortKey(id, b);
  return typeof x === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
};
const SEP = '\u0001';

function buildPivot(facts, cfg) {
  const distinctDims = [...new Set(cfg.values.filter((v) => RF[v.field].type === 'dim').map((v) => v.field))];
  const filters = cfg.filters.filter((x) => x.values).map((x) => ({ key: RF[x.field].key, set: new Set(x.values) }));
  const rows = facts.filter((f) => filters.every((x) => x.set.has(x.key(f))));
  const root = { path: '', label: 'Grand total', depth: -1, children: new Map(), facts: 0 };
  const colKeys = new Map();
  const cells = new Map();
  const add = (rp, ck, f) => { const k = rp + SEP + ck; let a = cells.get(k); if (!a) cells.set(k, (a = newAcc(distinctDims))); addToAcc(a, f, distinctDims); };
  for (const f of rows) {
    const ck = cfg.cols.map((c) => RF[c].key(f));
    const ckStr = ck.join(SEP);
    if (cfg.cols.length && !colKeys.has(ckStr)) colKeys.set(ckStr, ck);
    let node = root; const paths = [''];
    cfg.rows.forEach((r, i) => {
      const val = RF[r].key(f);
      let child = node.children.get(val);
      if (!child) node.children.set(val, (child = { path: node.path + SEP + val, value: val, field: r, depth: i, children: new Map() }));
      node = child; paths.push(node.path);
    });
    for (const p of paths) { add(p, '*', f); if (cfg.cols.length) add(p, ckStr, f); }
  }
  const cols = [...colKeys.values()].sort((a, b) => { for (let i = 0; i < a.length; i++) { const c = cmpDim(cfg.cols[i])(a[i], b[i]); if (c) return c; } return 0; });
  return { root, cols, cells, count: rows.length, filtered: rows };
}

// Flatten the row tree into display order, honouring sort and collapsed groups.
function sortedKids(node, pv, cfg) {
  const sortBy = cfg.sort?.by ?? 'label', dir = cfg.sort?.dir ?? 1;
  const kids = [...node.children.values()];
  if (sortBy === 'label') kids.sort((a, b) => cmpDim(a.field)(a.value, b.value) * dir);
  else {
    const v = cfg.values[sortBy];
    const val = (n) => (v ? valueOf(pv.cells.get(n.path + SEP + '*'), v) ?? -Infinity : 0);
    kids.sort((a, b) => (val(a) - val(b)) * dir || cmpDim(a.field)(a.value, b.value));
  }
  return kids;
}
// Classic (tabular) layout: one column per Rows field, a "<item> Total" row after each group.
// Entries: { kind: 'leaf' | 'collapsed' | 'subtotal', node, trail: [nodes from level 0] }
function tabularRows(pv, cfg, { ignoreCollapsed = false } = {}) {
  const out = [];
  const walk = (node, trail) => {
    for (const k of sortedKids(node, pv, cfg)) {
      const t = [...trail, k];
      if (!k.children.size) { out.push({ kind: 'leaf', node: k, trail: t }); continue; }
      if (!ignoreCollapsed && RPT.collapsed.has(k.path)) { out.push({ kind: 'collapsed', node: k, trail: t }); continue; }
      walk(k, t);
      if (cfg.subtotals !== false) out.push({ kind: 'subtotal', node: k, trail: t });
    }
  };
  walk(pv.root, []);
  return out;
}
function flattenRows(pv, cfg) {
  const out = [];
  const walk = (node) => {
    const kids = sortedKids(node, pv, cfg);
    for (const k of kids) {
      out.push(k);
      if (k.children.size && !RPT.collapsed.has(k.path)) walk(k);
    }
  };
  walk(pv.root);
  return out;
}

// ------------------------------------------------------------------ view
async function viewReports() {
  if (!RPT.saved.length) RPT.saved = await api('GET', '/api/reports/saved').catch(() => []);
  const main = $('#main');
  main.innerHTML = `
  <h1>Reports</h1><p class="sub">Pivot table over attendance, hours and productivity. Drag fields into Rows, Columns, Values and Filters, or tick a field to add it. Double-click a cell to see the agent-days behind it.</p>
  <div class="toolbar">
    <select id="rp-report" title="Report">${reportOptions()}</select>
    <button class="btn" id="rp-save">Save</button><button class="btn" id="rp-saveas">Save as…</button><button class="btn danger" id="rp-del">Delete</button>
    <span class="grow"></span>
    <select id="rp-range">${Object.entries(RANGE_PRESETS).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
    <input type="date" id="rp-from"><span class="muted">to</span><input type="date" id="rp-to">
    <button class="btn" id="rp-export">Export CSV</button>
  </div>
  <div class="pivot-layout">
    <div class="panel pivot-out"><div class="pivot-status muted" id="rp-status"></div><div class="table-wrap" id="rp-table"></div></div>
    <aside class="panel pivot-pane" id="rp-pane"></aside>
  </div>`;
  $('#rp-report').onchange = (e) => loadReport(e.target.value);
  $('#rp-range').onchange = (e) => {
    RPT.cfg.range = e.target.value;
    if (e.target.value === 'custom') { const r = resolveRange({ range: 'last_30' }); RPT.cfg.from = $('#rp-from').value || r.from; RPT.cfg.to = $('#rp-to').value || r.to; }
    refreshReport();
  };
  const custom = () => { RPT.cfg.range = 'custom'; RPT.cfg.from = $('#rp-from').value; RPT.cfg.to = $('#rp-to').value; refreshReport(); };
  $('#rp-from').onchange = custom; $('#rp-to').onchange = custom;
  $('#rp-export').onclick = exportPivotCsv;
  $('#rp-save').onclick = guard(saveReport);
  $('#rp-saveas').onclick = guard(() => saveReport(true));
  $('#rp-del').onclick = guard(deleteReport);
  await refreshReport();
}
function reportOptions() {
  return `<optgroup label="Standard reports">${BUILTIN_REPORTS.map((r, i) => `<option value="b${i}" ${RPT.reportRef === 'b' + i ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</optgroup>
    ${RPT.saved.length ? `<optgroup label="Saved reports">${RPT.saved.map((r) => `<option value="s${r.id}" ${RPT.reportRef === 's' + r.id ? 'selected' : ''}>${esc(r.name)}${r.shared ? ' (shared)' : ''}${r.owner_id !== S.me.id ? ' — ' + esc(r.owner_name) : ''}</option>`).join('')}</optgroup>` : ''}`;
}
function loadReport(ref) {
  RPT.reportRef = ref;
  const src = ref[0] === 'b' ? BUILTIN_REPORTS[Number(ref.slice(1))] : RPT.saved.find((r) => 's' + r.id === ref);
  if (!src) return;
  RPT.cfg = { sort: { by: 'label', dir: 1 }, filters: [], heat: false, ...structuredClone(src.config) };
  RPT.collapsed.clear();
  refreshReport();
}

async function refreshReport() {
  const { from, to } = resolveRange(RPT.cfg);
  $('#rp-range').value = RPT.cfg.range; $('#rp-from').value = from; $('#rp-to').value = to;
  const key = from + '|' + to;
  if (RPT.loadedRange !== key) {
    $('#rp-status').textContent = 'Loading…';
    try {
      const d = await api('GET', `/api/reports/facts?from=${from}&to=${to}`);
      RPT.facts = hydrateFacts(d); RPT.loadedRange = key;
    } catch (e) { $('#rp-status').textContent = ''; return toast(e.message, true); }
  }
  renderPane(); renderPivot();
}

// ------------------------------------------------------------------ field pane (drag & drop)
const ZONES = [['filters', 'Filters'], ['cols', 'Columns'], ['rows', 'Rows'], ['values', 'Values']];
function renderPane() {
  const cfg = RPT.cfg;
  const used = new Set([...cfg.rows, ...cfg.cols, ...cfg.values.map((v) => v.field), ...cfg.filters.map((f) => f.field)]);
  const groups = [...new Set(R_FIELDS.map((f) => f.group))];
  const pane = $('#rp-pane');
  pane.innerHTML = `
    <div class="pane-title">Fields</div>
    <div class="field-list" data-zone="list">${groups.map((g) => `<div class="fgroup">${g}</div>${R_FIELDS.filter((f) => f.group === g).map((f) => `
      <label class="fitem" draggable="true" data-field="${f.id}" title="${esc(f.help || '')}"><input type="checkbox" ${used.has(f.id) ? 'checked' : ''}>
      <span class="ficon ${f.type}">${f.type === 'dim' ? 'Aa' : f.kind === 'ratio' ? '%' : 'Σ'}</span>${esc(f.label)}</label>`).join('')}`).join('')}</div>
    <div class="zones">${ZONES.map(([z, l]) => `<div class="zone-wrap"><div class="zone-label">${l}</div><div class="zone" data-zone="${z}">${zoneChips(z)}</div></div>`).join('')}</div>
    <div class="pane-opts">
      <label class="f">Layout<select id="rp-layout"><option value="tabular">Classic: one column per row field</option><option value="compact" ${cfg.layout === 'compact' ? 'selected' : ''}>Compact: indented in one column</option></select></label>
      <div class="opt-row"><label class="chk"><input type="checkbox" id="rp-subtot" ${cfg.subtotals !== false ? 'checked' : ''}> Subtotals</label>
      <label class="chk" ${cfg.layout === 'compact' ? 'hidden' : ''}><input type="checkbox" id="rp-repeat" ${cfg.repeat ? 'checked' : ''}> Repeat item labels</label></div>
      <label class="f">Sort rows by<select id="rp-sort"><option value="label">Row label</option>${cfg.values.map((v, i) => `<option value="${i}" ${String(cfg.sort?.by) === String(i) ? 'selected' : ''}>${esc(valueLabel(v))}</option>`).join('')}</select></label>
      <select id="rp-dir" title="Direction"><option value="1">Ascending</option><option value="-1" ${cfg.sort?.dir === -1 ? 'selected' : ''}>Descending</option></select>
      <label class="chk"><input type="checkbox" id="rp-heat" ${cfg.heat ? 'checked' : ''}> Color scale</label>
      <span><a href="#" id="rp-expand">Expand all</a> · <a href="#" id="rp-collapse">Collapse all</a> · <a href="#" id="rp-clear">Clear layout</a></span>
    </div>`;

  // Tick = quick add / remove (dimensions → Rows, measures → Values)
  $$('.fitem input', pane).forEach((cb) => cb.onchange = () => {
    const id = cb.closest('.fitem').dataset.field; const f = RF[id];
    if (cb.checked) { if (f.type === 'dim') cfg.rows.push(id); else cfg.values.push({ field: id, agg: defaultAgg(f) }); }
    else removeField(id);
    changed();
  });
  // Drag sources: field list items and chips
  $$('[draggable=true]', pane).forEach((el) => el.ondragstart = (e) => {
    e.dataTransfer.setData('text/plain', JSON.stringify({ field: el.dataset.field, from: el.closest('[data-zone]').dataset.zone, index: Number(el.dataset.index ?? -1) }));
    e.dataTransfer.effectAllowed = 'move';
  });
  // Drop targets: zones (and the field list, which removes a chip)
  $$('[data-zone]', pane).forEach((zone) => {
    zone.ondragover = (e) => { e.preventDefault(); zone.classList.add('over'); };
    zone.ondragleave = () => zone.classList.remove('over');
    zone.ondrop = (e) => {
      e.preventDefault(); zone.classList.remove('over');
      let src; try { src = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
      const chip = e.target.closest('.chip');
      dropField(src, zone.dataset.zone, chip ? Number(chip.dataset.index) : null);
    };
  });
  $$('.chip .rm', pane).forEach((b) => b.onclick = () => { const c = b.closest('.chip'); removeFromZone(c.closest('[data-zone]').dataset.zone, Number(c.dataset.index)); changed(); });
  $$('.chip select.agg', pane).forEach((s) => s.onchange = () => { cfg.values[Number(s.closest('.chip').dataset.index)].agg = s.value; changed(); });
  $$('.chip .fbtn', pane).forEach((b) => b.onclick = (e) => openFilterPop(e, Number(b.closest('.chip').dataset.index)));
  $('#rp-sort').onchange = (e) => { cfg.sort = { by: e.target.value === 'label' ? 'label' : Number(e.target.value), dir: cfg.sort?.dir ?? 1 }; renderPivot(); };
  $('#rp-dir').onchange = (e) => { cfg.sort = { by: cfg.sort?.by ?? 'label', dir: Number(e.target.value) }; renderPivot(); };
  $('#rp-heat').onchange = (e) => { cfg.heat = e.target.checked; renderPivot(); };
  $('#rp-layout').onchange = (e) => { cfg.layout = e.target.value; renderPane(); renderPivot(); };
  $('#rp-subtot').onchange = (e) => { cfg.subtotals = e.target.checked; renderPivot(); };
  $('#rp-repeat').onchange = (e) => { cfg.repeat = e.target.checked; renderPivot(); };
  $('#rp-expand').onclick = (e) => { e.preventDefault(); RPT.collapsed.clear(); renderPivot(); };
  $('#rp-collapse').onclick = (e) => { e.preventDefault(); collapseAll(); renderPivot(); };
  $('#rp-clear').onclick = (e) => { e.preventDefault(); Object.assign(cfg, { rows: [], cols: [], values: [], filters: [], sort: { by: 'label', dir: 1 } }); changed(); };
}
function zoneChips(z) {
  const cfg = RPT.cfg;
  if (z === 'values') return cfg.values.map((v, i) => {
    const f = RF[v.field];
    const aggs = f.type === 'dim' ? DIM_AGGS : f.kind ? null : AGGS;
    return `<div class="chip" draggable="true" data-field="${v.field}" data-index="${i}"><span class="chip-l">${aggs ? `<select class="agg">${Object.entries(aggs).map(([k, l]) => `<option value="${k}" ${k === v.agg ? 'selected' : ''}>${l}</option>`).join('')}</select> of ` : ''}${esc(f.label)}</span><button class="rm" title="Remove">×</button></div>`;
  }).join('') || '<div class="zone-hint">Drop measures here</div>';
  if (z === 'filters') return cfg.filters.map((x, i) => `<div class="chip" draggable="true" data-field="${x.field}" data-index="${i}"><span class="chip-l">${esc(RF[x.field].label)}</span>
    <button class="fbtn ${x.values ? 'on' : ''}" title="Choose values">${x.values ? `${x.values.length} selected` : 'All'} ▾</button><button class="rm" title="Remove">×</button></div>`).join('') || '<div class="zone-hint">Drop fields to filter</div>';
  return cfg[z].map((id, i) => `<div class="chip" draggable="true" data-field="${id}" data-index="${i}"><span class="chip-l">${esc(RF[id].label)}</span><button class="rm" title="Remove">×</button></div>`).join('') || `<div class="zone-hint">Drop fields here</div>`;
}
function removeFromZone(z, i) {
  const cfg = RPT.cfg;
  cfg[z].splice(i, 1);
  if (z === 'values' && typeof cfg.sort?.by === 'number') cfg.sort = { by: 'label', dir: 1 };
}
function removeField(id) {
  const cfg = RPT.cfg;
  cfg.rows = cfg.rows.filter((x) => x !== id); cfg.cols = cfg.cols.filter((x) => x !== id);
  cfg.values = cfg.values.filter((v) => v.field !== id); cfg.filters = cfg.filters.filter((x) => x.field !== id);
  cfg.sort = { by: 'label', dir: 1 };
}
function dropField(src, to, beforeIndex) {
  const cfg = RPT.cfg; const f = RF[src.field];
  if (!f) return;
  if (to === 'list') { if (src.from !== 'list') { removeFromZone(src.from, src.index); changed(); } return; }
  if (f.type === 'measure' && to !== 'values') return toast('Measures can only go in Values', true);
  // Take the item out of its source zone (keeping value settings when moving within Values)
  let item;
  if (src.from === 'values') item = cfg.values[src.index];
  if (src.from !== 'list') {
    cfg[src.from].splice(src.index, 1);
    if (src.from === to && beforeIndex != null && src.index < beforeIndex) beforeIndex--;
  }
  if (to === 'values') item = item && item.field === src.field ? item : { field: src.field, agg: defaultAgg(f) };
  else if (to === 'filters') {
    const existing = src.from === 'filters' ? null : cfg.filters.find((x) => x.field === src.field);
    if (existing) return changed();
    item = { field: src.field, values: null };
    cfg.rows = cfg.rows.filter((x) => x !== src.field); cfg.cols = cfg.cols.filter((x) => x !== src.field);
  } else {
    // A dimension lives in only one of Rows / Columns at a time (like Excel)
    cfg.rows = cfg.rows.filter((x) => x !== src.field); cfg.cols = cfg.cols.filter((x) => x !== src.field);
    item = src.field;
  }
  const arr = cfg[to];
  if (beforeIndex == null || beforeIndex > arr.length) arr.push(item); else arr.splice(beforeIndex, 0, item);
  changed();
}
function changed() { RPT.collapsed.clear(); renderPane(); renderPivot(); }
function collapseAll() {
  const walk = (n) => { for (const c of n.children.values()) if (c.children.size) { RPT.collapsed.add(c.path); walk(c); } };
  if (RPT.pivot) walk(RPT.pivot.root);
}

function openFilterPop(ev, idx) {
  ev.stopPropagation();
  closeLayers();
  const flt = RPT.cfg.filters[idx]; const f = RF[flt.field];
  const vals = [...new Set(RPT.facts.map((x) => f.key(x)))].sort(cmpDim(flt.field));
  const sel = new Set(flt.values ?? vals);
  const pop = document.createElement('div'); pop.className = 'pop filter-pop';
  pop.innerHTML = `<div style="font-weight:600;margin-bottom:6px">${esc(f.label)}</div>
    <input type="search" placeholder="Search…" style="width:100%;margin-bottom:6px">
    <div style="font-size:12px;margin-bottom:6px"><a href="#" data-a="all">Select all</a> · <a href="#" data-a="none">Clear</a></div>
    <div class="fvals">${vals.map((v) => `<label class="chk"><input type="checkbox" value="${esc(v)}" ${sel.has(v) ? 'checked' : ''}> ${esc(dimLabel(flt.field, v))}</label>`).join('') || '<span class="muted">No values in this date range</span>'}</div>
    <div style="text-align:right;margin-top:8px"><button class="btn sm primary">Apply</button></div>`;
  document.body.appendChild(pop);
  const r = ev.target.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(r.left - 150, innerWidth - 280)) + 'px';
  pop.style.top = Math.min(r.bottom + 4, innerHeight - 380) + 'px';
  $('input[type=search]', pop).oninput = (e) => { const q = e.target.value.toLowerCase(); $$('.fvals label', pop).forEach((l) => l.classList.toggle('hidden', !l.textContent.toLowerCase().includes(q))); };
  $$('[data-a]', pop).forEach((a) => a.onclick = (e) => { e.preventDefault(); $$('.fvals label:not(.hidden) input', pop).forEach((c) => { c.checked = a.dataset.a === 'all'; }); });
  $('.btn', pop).onclick = () => {
    const chosen = $$('.fvals input', pop).filter((c) => c.checked).map((c) => c.value);
    flt.values = chosen.length === vals.length ? null : chosen;
    closeLayers(); changed();
  };
  setTimeout(() => document.addEventListener('mousedown', function off(e) { if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('mousedown', off); } }), 0);
}

// ------------------------------------------------------------------ pivot rendering
const MAX_ROWS = 3000, MAX_COLS = 200;
function pivotModel() {
  const cfg = RPT.cfg;
  const pv = buildPivot(RPT.facts, cfg); RPT.pivot = pv;
  const rows = flattenRows(pv, cfg);
  return { cfg, pv, rows, cols: pv.cols };
}
function renderPivot() {
  const box = $('#rp-table'); if (!box) return;
  const { cfg, pv, rows, cols } = pivotModel();
  const { from, to } = resolveRange(cfg);
  $('#rp-status').textContent = `${pv.count.toLocaleString()} agent-day records · ${isoLabel(from)} – ${isoLabel(to)}${cfg.filters.some((x) => x.values) ? ' · filtered' : ''}`;
  if (!cfg.values.length) { box.innerHTML = '<div class="pivot-empty">Tick or drag a measure (Σ) into <b>Values</b> to build the report.</div>'; return; }
  if (!pv.count) { box.innerHTML = '<div class="pivot-empty">No records match this date range and filters.</div>'; return; }
  if (cols.length > MAX_COLS) { box.innerHTML = `<div class="pivot-empty">Too many columns (${cols.length}). Move a field from Columns to Rows or add a filter.</div>`; return; }
  if (cfg.layout !== 'compact') return renderTabular(box, cfg, pv, cols);
  const V = cfg.values; const nv = V.length;
  const colSpecs = [...cols.map((ck) => ({ ck: ck.join(SEP), label: ck.map((v, i) => dimLabel(cfg.cols[i], v)).join(' · ') })), ...(cols.length ? [{ ck: '*', label: 'Grand total', total: true }] : [{ ck: '*', label: '' }])];

  // Colour scale per value index over body (non-total) cells
  const scale = V.map(() => ({ min: Infinity, max: -Infinity }));
  if (cfg.heat) for (const r of rows) for (const c of colSpecs) if (!c.total) V.forEach((v, i) => {
    const x = valueOf(pv.cells.get(r.path + SEP + c.ck), v); if (x != null) { scale[i].min = Math.min(scale[i].min, x); scale[i].max = Math.max(scale[i].max, x); }
  });
  const heat = (x, i) => {
    if (!cfg.heat || x == null) return '';
    const s = scale[i]; if (!(s.max > s.min)) return '';
    return `background:color-mix(in srgb, var(--accent) ${Math.round(((x - s.min) / (s.max - s.min)) * 38)}%, transparent)`;
  };
  const corner = cfg.rows.length ? cfg.rows.map((r) => RF[r].label).join(' / ') : '';
  let head;
  if (cols.length) {
    head = `<tr><th class="pv-corner" rowspan="${nv > 1 ? 2 : 1}">${esc(corner)}${nv === 1 ? `<div class="muted" style="font-weight:400">${esc(valueLabel(V[0]))}</div>` : ''}</th>${colSpecs.map((c) => `<th class="num ${c.total ? 'pv-total' : ''}" colspan="${nv}">${esc(c.label)}</th>`).join('')}</tr>`;
    if (nv > 1) head += `<tr>${colSpecs.map((c) => V.map((v) => `<th class="num ${c.total ? 'pv-total' : ''}">${esc(valueLabel(v))}</th>`).join('')).join('')}</tr>`;
  } else head = `<tr><th class="pv-corner">${esc(corner)}</th>${V.map((v) => `<th class="num">${esc(valueLabel(v))}</th>`).join('')}</tr>`;

  const cellsFor = (path, isTotalRow) => colSpecs.map((c) => V.map((v, i) => {
    const x = valueOf(pv.cells.get(path + SEP + c.ck), v);
    return `<td class="num ${c.total ? 'pv-total' : ''}" data-p="${encodeURIComponent(path)}" data-c="${encodeURIComponent(c.ck)}" style="${isTotalRow || c.total ? '' : heat(x, i)}">${fmtValue(x, v)}</td>`;
  }).join('')).join('');
  const shown = rows.slice(0, MAX_ROWS);
  const body = shown.map((r) => {
    const parent = r.children.size > 0;
    const open = !RPT.collapsed.has(r.path);
    return `<tr class="${parent ? 'pv-parent' : ''}"><th class="pv-label" style="padding-left:${12 + r.depth * 18}px">${parent ? `<button class="pv-tog" data-path="${encodeURIComponent(r.path)}">${open ? '▾' : '▸'}</button>` : '<span class="pv-sp"></span>'}${esc(dimLabel(r.field, r.value))}</th>${cellsFor(r.path, false)}</tr>`;
  }).join('');
  const grand = `<tr class="pv-grand"><th class="pv-label">Grand total</th>${cellsFor('', true)}</tr>`;
  box.innerHTML = `<table class="pivot"><thead>${head}</thead><tbody>${cfg.rows.length ? body : ''}${grand}</tbody></table>${rows.length > MAX_ROWS ? `<p class="muted" style="padding:8px 12px">Showing first ${MAX_ROWS} of ${rows.length} rows — collapse groups or add a filter.</p>` : ''}`;
  $$('.pv-tog', box).forEach((b) => b.onclick = () => { const p = decodeURIComponent(b.dataset.path); RPT.collapsed.has(p) ? RPT.collapsed.delete(p) : RPT.collapsed.add(p); renderPivot(); });
  $$('td[data-p]', box).forEach((td) => td.ondblclick = () => showDrill(decodeURIComponent(td.dataset.p), decodeURIComponent(td.dataset.c)));
}

function heatScale(cfg, pv, paths, colSpecs) {
  const V = cfg.values;
  const scale = V.map(() => ({ min: Infinity, max: -Infinity }));
  if (cfg.heat) for (const p of paths) for (const c of colSpecs) if (!c.total) V.forEach((v, i) => {
    const x = valueOf(pv.cells.get(p + SEP + c.ck), v); if (x != null) { scale[i].min = Math.min(scale[i].min, x); scale[i].max = Math.max(scale[i].max, x); }
  });
  return (x, i) => {
    if (!cfg.heat || x == null) return '';
    const s = scale[i]; if (!(s.max > s.min)) return '';
    return `background:color-mix(in srgb, var(--accent) ${Math.round(((x - s.min) / (s.max - s.min)) * 38)}%, transparent)`;
  };
}

function renderTabular(box, cfg, pv, cols) {
  const V = cfg.values; const nv = V.length;
  const R = cfg.rows.length ? cfg.rows : [null];      // no row fields → a single "Grand total" label column
  const nR = R.length;
  const colSpecs = [...cols.map((ck) => ({ ck: ck.join(SEP), label: ck.map((v, i) => dimLabel(cfg.cols[i], v)).join(' · ') })), { ck: '*', label: cols.length ? 'Grand total' : '', total: cols.length > 0 }];
  const entries = cfg.rows.length ? tabularRows(pv, cfg) : [];
  const heat = heatScale(cfg, pv, entries.filter((e) => e.kind !== 'subtotal').map((e) => e.node.path), colSpecs);

  // Header: one column per row field (Excel "tabular form"), then the value columns.
  const rowHeads = R.map((r, i) => `<th class="pv-rh ${i === 0 ? 'pv-first' : ''}" ${cols.length && nv > 1 ? 'rowspan="2"' : ''}>${r ? esc(RF[r].label) : ''}</th>`).join('');
  let head;
  if (cols.length) {
    head = `<tr>${rowHeads}${colSpecs.map((c) => `<th class="num ${c.total ? 'pv-total' : ''}" colspan="${nv}">${esc(c.label)}</th>`).join('')}</tr>`;
    if (nv > 1) head += `<tr>${colSpecs.map((c) => V.map((v) => `<th class="num ${c.total ? 'pv-total' : ''}">${esc(valueLabel(v))}</th>`).join('')).join('')}</tr>`;
  } else head = `<tr>${rowHeads}${V.map((v) => `<th class="num">${esc(valueLabel(v))}</th>`).join('')}</tr>`;

  const cellsFor = (path, plain) => colSpecs.map((c) => V.map((v, i) => {
    const x = valueOf(pv.cells.get(path + SEP + c.ck), v);
    return `<td class="num ${c.total ? 'pv-total' : ''}" data-p="${encodeURIComponent(path)}" data-c="${encodeURIComponent(c.ck)}" style="${plain || c.total ? '' : heat(x, i)}">${fmtValue(x, v)}</td>`;
  }).join('')).join('');
  const label = (n, withToggle) => {
    const tog = withToggle && n.children.size ? `<button class="pv-tog" data-path="${encodeURIComponent(n.path)}" title="${RPT.collapsed.has(n.path) ? 'Expand' : 'Collapse'}">${RPT.collapsed.has(n.path) ? '▸' : '▾'}</button>` : '';
    return tog + esc(dimLabel(n.field, n.value));
  };

  const shown = entries.slice(0, MAX_ROWS);
  let prev = [];  // paths shown in each label column on the previous row
  const body = shown.map((e) => {
    const { kind, node, trail } = e;
    const lvl = trail.length - 1;
    const tds = [];
    if (kind === 'subtotal') {
      for (let i = 0; i < lvl; i++) tds.push(`<td class="pv-rl ${i === 0 ? 'pv-first' : ''}">${cfg.repeat ? esc(dimLabel(trail[i].field, trail[i].value)) : ''}</td>`);
      tds.push(`<td class="pv-rl pv-subl ${lvl === 0 ? 'pv-first' : ''}" colspan="${nR - lvl}">${esc(dimLabel(node.field, node.value))} Total</td>`);
      prev = prev.slice(0, lvl); // outer labels stay "already shown" for the rest of their group
      return `<tr class="pv-sub pv-sub-${lvl}">${tds.join('')}${cellsFor(node.path, true)}</tr>`;
    }
    for (let i = 0; i <= lvl; i++) {
      const show = cfg.repeat || prev[i] !== trail[i].path || (i > 0 && prev[i - 1] !== trail[i - 1].path);
      tds.push(`<td class="pv-rl ${i === 0 ? 'pv-first' : ''} ${show ? '' : 'pv-rep'}">${show ? label(trail[i], true) : ''}</td>`);
    }
    if (kind === 'collapsed') tds.push(`<td class="pv-rl" colspan="${nR - lvl - 1}"></td>`.repeat(nR - lvl - 1 > 0 ? 1 : 0));
    prev = trail.map((t) => t.path);
    return `<tr class="${kind === 'collapsed' ? 'pv-coll' : ''}">${tds.join('')}${cellsFor(node.path, kind === 'collapsed')}</tr>`;
  }).join('');
  const grand = `<tr class="pv-grand"><td class="pv-rl pv-first" colspan="${nR}">Grand Total</td>${cellsFor('', true)}</tr>`;
  const valNote = cols.length && nv === 1 ? ` · Values: ${valueLabel(V[0])}` : '';
  if (valNote) $('#rp-status').textContent += valNote;
  box.innerHTML = `<table class="pivot pivot-tab"><thead>${head}</thead><tbody>${body}${grand}</tbody></table>${entries.length > MAX_ROWS ? `<p class="muted" style="padding:8px 12px">Showing first ${MAX_ROWS} of ${entries.length} rows — collapse groups or add a filter.</p>` : ''}`;
  $$('.pv-tog', box).forEach((b) => b.onclick = () => { const p = decodeURIComponent(b.dataset.path); RPT.collapsed.has(p) ? RPT.collapsed.delete(p) : RPT.collapsed.add(p); renderPivot(); });
  $$('td[data-p]', box).forEach((td) => td.ondblclick = () => showDrill(decodeURIComponent(td.dataset.p), decodeURIComponent(td.dataset.c)));
}

// Double-click → underlying agent-day records (Excel "Show Details")
function showDrill(path, ck) {
  const cfg = RPT.cfg;
  const rparts = path ? path.split(SEP).slice(1) : [];
  const cparts = ck === '*' ? null : ck.split(SEP);
  const recs = RPT.pivot.filtered.filter((f) => rparts.every((v, i) => RF[cfg.rows[i]].key(f) === v) && (!cparts || cparts.every((v, i) => RF[cfg.cols[i]].key(f) === v)));
  closeLayers();
  const ov = document.createElement('div'); ov.className = 'overlay'; ov.onclick = closeLayers;
  const md = document.createElement('div'); md.className = 'modal'; md.style.width = 'min(1100px, calc(100vw - 32px))';
  const title = [...rparts.map((v, i) => dimLabel(cfg.rows[i], v)), ...(cparts || []).map((v, i) => dimLabel(cfg.cols[i], v))].join(' · ') || 'All records';
  const shown = recs.slice(0, 1000);
  md.innerHTML = `<div class="head-row"><div><h2>${esc(title)}</h2><div class="muted">${recs.length.toLocaleString()} agent-day record(s)${recs.length > 1000 ? ' — showing first 1,000' : ''}</div></div><button class="x">×</button></div>
    <div class="table-wrap" style="max-height:60vh"><table><thead><tr><th>Date</th><th>Agent</th><th>Employee ID</th><th>Campaign</th><th>Supervisor</th><th>Attendance</th><th class="num">Sched.</th><th class="num">Raw</th><th class="num">Adj.</th><th class="num">Total</th><th class="num">Paid</th><th class="num">Billable</th></tr></thead><tbody>
    ${shown.map((f) => `<tr><td>${esc(f.date)}</td><td>${esc(f.agent)}</td><td>${esc(f.employee_id)}</td><td>${esc(f.campaign)}</td><td>${esc(f.supervisor)}</td><td>${esc(f.code)}</td>
      <td class="num">${f.scheduled ? fmtH(f.sched_hours) : ''}</td><td class="num">${fmtH(f.raw)}</td><td class="num">${fmtH(f.adj)}</td><td class="num">${fmtH(f.total)}</td><td class="num">${fmtH(f.paid)}</td><td class="num">${fmtH(f.billable)}</td></tr>`).join('')}</tbody></table></div>`;
  document.body.append(ov, md);
  $('.x', md).onclick = closeLayers;
}

function exportPivotCsv() {
  const { cfg, pv, cols } = pivotModel();
  if (!cfg.values.length) return toast('Nothing to export yet', true);
  const V = cfg.values;
  const colSpecs = [...cols.map((ck) => ({ ck: ck.join(SEP), label: ck.map((v, i) => dimLabel(cfg.cols[i], v)).join(' · ') })), { ck: '*', label: cols.length ? 'Grand total' : '' }];
  const q = (s) => { s = String(s ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const rowHdrs = cfg.rows.length ? cfg.rows.map((r) => RF[r].label) : [''];
  const head = [...rowHdrs, ...colSpecs.flatMap((c) => V.map((v) => [c.label, valueLabel(v)].filter(Boolean).join(' — ')))];
  const num = (path, v, ck) => {
    const x = valueOf(pv.cells.get(path + SEP + ck), v);
    if (x == null) return '';
    return RF[v.field].type !== 'dim' && RF[v.field].fmt === 'pct' ? (x * 100).toFixed(2) + '%' : Math.round(x * 100) / 100;
  };
  const values = (path) => colSpecs.flatMap((c) => V.map((v) => num(path, v, c.ck)));
  const lines = [head.map(q).join(',')];
  // Classic layout, every group expanded: each row field in its own column with labels repeated on
  // every row (so the file filters and sorts cleanly in Excel), plus "<item> Total" rows when subtotals are on.
  if (cfg.rows.length) for (const e of tabularRows(pv, cfg, { ignoreCollapsed: true })) {
    const labels = e.trail.map((n) => dimLabel(n.field, n.value));
    const cells = rowHdrs.map((_, i) => {
      if (e.kind !== 'subtotal') return labels[i] ?? '';
      const lvl = labels.length - 1;
      return i < lvl ? labels[i] : i === lvl ? labels[i] + ' Total' : '';
    });
    lines.push([...cells, ...values(e.node.path)].map(q).join(','));
  }
  lines.push([...rowHdrs.map((_, i) => (i === 0 ? 'Grand Total' : '')), ...values('')].map(q).join(','));
  const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  const { from, to } = resolveRange(cfg);
  a.download = `tempo-report-${from}-to-${to}.csv`; a.click(); URL.revokeObjectURL(a.href);
}

// ------------------------------------------------------------------ saving
async function saveReport(asNew) {
  const cur = RPT.reportRef[0] === 's' ? RPT.saved.find((r) => 's' + r.id === RPT.reportRef) : null;
  const mine = cur && (cur.owner_id === S.me.id || S.me.role === 'admin');
  const config = structuredClone(RPT.cfg);
  if (config.range !== 'custom') { delete config.from; delete config.to; }
  if (!asNew && mine) {
    await api('PUT', '/api/reports/saved/' + cur.id, { name: cur.name, config, shared: cur.shared });
    toast('Report saved');
  } else {
    const name = prompt('Report name:', cur && !asNew ? cur.name + ' (copy)' : '');
    if (!name) return;
    const shared = isManager() ? confirm('Share this report with all users?\n\nOK = shared, Cancel = only me') : false;
    const r = await api('POST', '/api/reports/saved', { name, config, shared });
    RPT.reportRef = 's' + r.id;
    toast('Report saved');
  }
  RPT.saved = await api('GET', '/api/reports/saved');
  $('#rp-report').innerHTML = reportOptions();
}
async function deleteReport() {
  const cur = RPT.reportRef[0] === 's' ? RPT.saved.find((r) => 's' + r.id === RPT.reportRef) : null;
  if (!cur) return toast('Standard reports cannot be deleted', true);
  if (!confirm(`Delete the report "${cur.name}"?`)) return;
  await api('DELETE', '/api/reports/saved/' + cur.id);
  RPT.saved = await api('GET', '/api/reports/saved');
  loadReport('b0');
  $('#rp-report').innerHTML = reportOptions();
  toast('Report deleted');
}
