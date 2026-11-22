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

function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}

module.exports = { toIso, addDays, isIsoDate, weekStartOf, weekStartDay, daysBetween, scopedEmployees, canAccessEmployee, isLocked, computeHours, payrollLines, billingLines, toCsv, round };
