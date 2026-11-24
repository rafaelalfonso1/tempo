// Shared business logic: dates, scoping, locking and hour calculations.
const { db, getSetting } = require('./db');

// ---------- dates (all ISO yyyy-mm-dd, treated as calendar dates in UTC) ----------
const toDate = (iso) => new Date(iso + 'T00:00:00Z');
const toIso = (d) => d.toISOString().slice(0, 10);
const addDays = (iso, n) => { const d = toDate(iso); d.setUTCDate(d.getUTCDate() + n); return toIso(d); };
const isIsoDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(toDate(s));

function weekStartDay() { return Number(getSetting('week_start_day', '1')) || 0; }
function weekStartOf(iso) {
  const d = toDate(iso);
  const diff = (d.getUTCDay() - weekStartDay() + 7) % 7;
  return addDays(iso, -diff);
}
function daysBetween(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

// ---------- scoping ----------
// Returns employees visible to a user, with optional filters.
function scopedEmployees(user, { campaignId, supervisorId, includeInactive, search } = {}) {
  const where = [];
  const params = [];
  if (user.role === 'supervisor') { where.push('e.supervisor_id = ?'); params.push(user.supervisor_code || '__none__'); }
  else if (supervisorId) { where.push('e.supervisor_id = ?'); params.push(supervisorId); }
  if (campaignId) { where.push('e.campaign_id = ?'); params.push(Number(campaignId)); }
  if (!includeInactive) where.push("e.status != 'terminated'");
  if (search) {
    where.push("(e.employee_id LIKE ? OR e.first_name LIKE ? OR e.last_name LIKE ? OR e.phone_system_id LIKE ?)");
    const s = `%${search}%`; params.push(s, s, s, s);
  }
  const sql = `SELECT e.*, c.code AS campaign_code, c.name AS campaign_name, u.display_name AS supervisor_name
    FROM employees e
    LEFT JOIN campaigns c ON c.id = e.campaign_id
    LEFT JOIN users u ON u.supervisor_code = e.supervisor_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY e.last_name, e.first_name`;
  return db.prepare(sql).all(...params);
}

function canAccessEmployee(user, emp) {
  if (!emp) return false;
  if (user.role === 'supervisor') return emp.supervisor_id === user.supervisor_code;
  return true;
}

// ---------- locking ----------
function isLocked(campaignId, iso) {
  if (!campaignId) return false;
  const row = db.prepare("SELECT status FROM week_approvals WHERE campaign_id = ? AND week_start = ?").get(campaignId, weekStartOf(iso));
  return !!row && row.status === 'approved';
}

// ---------- hours ----------
// Rule set:
//  * Raw (ingested) hours are assumed paid and billable.
//  * Negative adjustments reduce total, paid and billable hours.
//  * Positive adjustments add to total; to paid if the disposition is_paid; to billable if is_billable.
function computeHours(employeeIds, from, to) {
  const result = {};
  if (!employeeIds.length) return result;
  const ph = employeeIds.map(() => '?').join(',');
  const cell = (e, d) => {
    result[e] ??= {};
    return (result[e][d] ??= { raw: 0, hasRaw: false, adj: 0, total: 0, paid: 0, billable: 0, adjCount: 0, sources: [] });
  };
  db.prepare(`SELECT employee_id, work_date, source, hours FROM time_raw
    WHERE employee_id IN (${ph}) AND work_date BETWEEN ? AND ?`).all(...employeeIds, from, to)
    .forEach((r) => { const c = cell(r.employee_id, r.work_date); c.raw += r.hours; c.hasRaw = true; c.sources.push(r.source); });
  db.prepare(`SELECT a.employee_id, a.work_date, a.hours, d.is_paid, d.is_billable FROM time_adjustments a
    JOIN dispositions d ON d.id = a.disposition_id
    WHERE a.voided_at IS NULL AND a.employee_id IN (${ph}) AND a.work_date BETWEEN ? AND ?`).all(...employeeIds, from, to)
    .forEach((r) => {
      const c = cell(r.employee_id, r.work_date);
      c.adj += r.hours; c.adjCount++;
      if (r.hours < 0) { c.paid += r.hours; c.billable += r.hours; }
      else { if (r.is_paid) c.paid += r.hours; if (r.is_billable) c.billable += r.hours; }
    });
  for (const e of Object.keys(result)) for (const d of Object.keys(result[e])) {
    const c = result[e][d];
    c.total = round(c.raw + c.adj); c.paid = round(c.raw + c.paid); c.billable = round(c.raw + c.billable);
    c.raw = round(c.raw); c.adj = round(c.adj);
  }
  return result;
}
const round = (n) => Math.round(n * 100) / 100;

// Payroll lines for a campaign/week, grouped by employee + earning code.
function payrollLines(campaignId, weekStart) {
  const weekEnd = addDays(weekStart, 6);
  const regCode = getSetting('regular_payroll_code', 'REG');
  const emps = db.prepare('SELECT id, employee_id, first_name, last_name FROM employees WHERE campaign_id = ?').all(campaignId);
  const lines = {};
  const add = (emp, code, h) => {
    if (!h) return;
    const k = emp.employee_id + '|' + code;
    lines[k] ??= { employee_id: emp.employee_id, first_name: emp.first_name, last_name: emp.last_name, earning_code: code, hours: 0, week_start: weekStart, week_end: weekEnd };
    lines[k].hours = round(lines[k].hours + h);
  };
  for (const emp of emps) {
    const raw = db.prepare('SELECT COALESCE(SUM(hours),0) h FROM time_raw WHERE employee_id = ? AND work_date BETWEEN ? AND ?').get(emp.id, weekStart, weekEnd).h;
    add(emp, regCode, raw);
    db.prepare(`SELECT a.hours, d.is_paid, d.payroll_code FROM time_adjustments a JOIN dispositions d ON d.id = a.disposition_id
      WHERE a.voided_at IS NULL AND a.employee_id = ? AND a.work_date BETWEEN ? AND ?`).all(emp.id, weekStart, weekEnd)
      .forEach((a) => {
        if (a.hours < 0) add(emp, a.payroll_code || regCode, a.hours);
        else if (a.is_paid) add(emp, a.payroll_code || regCode, a.hours);
      });
  }
  return Object.values(lines).filter((l) => l.hours !== 0);
}

// Billing lines for a campaign/week: one row per employee per day with billable hours.
function billingLines(campaignId, weekStart) {
  const weekEnd = addDays(weekStart, 6);
  const camp = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
  const emps = db.prepare('SELECT id, employee_id, first_name, last_name FROM employees WHERE campaign_id = ?').all(campaignId);
  const hours = computeHours(emps.map((e) => e.id), weekStart, weekEnd);
  const out = [];
  for (const e of emps) for (const [d, c] of Object.entries(hours[e.id] || {})) {
    if (c.billable) out.push({ billing_code: camp.billing_code || camp.code, campaign: camp.code, employee_id: e.employee_id, first_name: e.first_name, last_name: e.last_name, work_date: d, billable_hours: c.billable });
  }
  return out.sort((a, b) => a.employee_id.localeCompare(b.employee_id) || a.work_date.localeCompare(b.work_date));
}

// ---------- schedules ----------
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
// Paid/scheduled hours of a shift; end <= start means it crosses midnight.
function shiftHours(start, end, breakMin = 0) {
  if (!start || !end) return 0;
  let d = toMin(end) - toMin(start); if (d <= 0) d += 1440;
  return round(Math.max(0, d - (breakMin || 0)) / 60);
}
const isTime = (t) => typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
// Validates one day spec {off} or {start,end,break_minutes}. Returns a normalized object or throws via bad().
function cleanShift(x, bad) {
  if (!x || x.off || x.is_off) return { is_off: 1, start_time: null, end_time: null, break_minutes: 0 };
  if (!isTime(x.start) || !isTime(x.end)) bad('Shift times must be HH:MM (24h)');
  const br = Math.round(Number(x.break_minutes || 0));
  if (!(br >= 0 && br <= 240)) bad('Break must be 0–240 minutes');
  const h = shiftHours(x.start, x.end, br);
  if (h <= 0 || h > 16) bad('A shift must be between 0 and 16 hours long');
  return { is_off: 0, start_time: x.start, end_time: x.end, break_minutes: br };
}

// Resolve the effective schedule per employee per date: day override > weekly template in effect.
// Returns { [empId]: { [date]: { off, start, end, break_minutes, hours, source } } }
function resolveSchedules(employeeIds, from, to) {
  const out = {};
  if (!employeeIds.length) return out;
  const ph = employeeIds.map(() => '?').join(',');
  const tpls = db.prepare(`SELECT * FROM schedule_templates WHERE employee_id IN (${ph}) AND effective_from <= ?
    AND (effective_to IS NULL OR effective_to >= ?) ORDER BY employee_id, effective_from`).all(...employeeIds, to, from);
  const days = {};
  if (tpls.length) db.prepare(`SELECT * FROM schedule_template_days WHERE template_id IN (${tpls.map(() => '?').join(',')})`)
    .all(...tpls.map((t) => t.id)).forEach((d) => { (days[d.template_id] ??= {})[d.dow] = d; });
  const byEmp = {};
  for (const t of tpls) (byEmp[t.employee_id] ??= []).push(t);
  const ovr = {};
  db.prepare(`SELECT * FROM schedule_overrides WHERE employee_id IN (${ph}) AND work_date BETWEEN ? AND ?`).all(...employeeIds, from, to)
    .forEach((o) => { (ovr[o.employee_id] ??= {})[o.work_date] = o; });
  const dates = daysBetween(from, to);
  const fmt = (r, source) => r.is_off
    ? { off: true, hours: 0, source }
    : { off: false, start: r.start_time, end: r.end_time, break_minutes: r.break_minutes, hours: shiftHours(r.start_time, r.end_time, r.break_minutes), source };
  for (const e of employeeIds) {
    const list = byEmp[e] || [];
    for (const d of dates) {
      const o = ovr[e]?.[d];
      if (o) { (out[e] ??= {})[d] = { ...fmt(o, 'override'), note: o.note }; continue; }
      let t = null;
      for (const x of list) if (x.effective_from <= d && (!x.effective_to || x.effective_to >= d)) t = x; // latest wins
      const day = t && days[t.id]?.[toDate(d).getUTCDay()];
      if (day) (out[e] ??= {})[d] = fmt(day, 'template');
    }
  }
  return out;
}

// Current weekly template (as of a date) per employee: { [empId]: { effective_from, days: {dow: {...}} } }
function templatesAsOf(employeeIds, date) {
  const out = {};
  if (!employeeIds.length) return out;
  const ph = employeeIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM schedule_templates WHERE employee_id IN (${ph}) AND effective_from <= ?
    AND (effective_to IS NULL OR effective_to >= ?) ORDER BY effective_from`).all(...employeeIds, date, date);
  for (const t of rows) out[t.employee_id] = { id: t.id, effective_from: t.effective_from, days: {} };
  const ids = Object.values(out).map((t) => t.id);
  if (ids.length) db.prepare(`SELECT * FROM schedule_template_days WHERE template_id IN (${ids.map(() => '?').join(',')})`).all(...ids)
    .forEach((d) => { const t = Object.values(out).find((x) => x.id === d.template_id); t.days[d.dow] = d.is_off ? { off: true } : { start: d.start_time, end: d.end_time, break_minutes: d.break_minutes }; });
  return out;
}

function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}

module.exports = { resolveSchedules, templatesAsOf, cleanShift, shiftHours, toIso, addDays, isIsoDate, weekStartOf, weekStartDay, daysBetween, scopedEmployees, canAccessEmployee, isLocked, computeHours, payrollLines, billingLines, toCsv, round };
