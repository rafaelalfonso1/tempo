// Tempo server: REST API + Server-Sent Events + static SPA.
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { db, tx, audit, hashPassword, verifyPassword, getSetting, setSetting } = require('./db');
const L = require('./lib');
const connectors = require('./connectors');

db.exec(`CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL)`);

const app = express();
app.use(express.json({ limit: '20mb' }));

// ---------------- helpers ----------------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (msg) => { throw new HttpError(400, msg); };
const parseCookies = (h = '') => Object.fromEntries(h.split(';').map((p) => p.trim().split('=').map(decodeURIComponent)).filter((p) => p[0]));
const nz = (v) => (v === '' || v === undefined ? null : v);

// ---------------- realtime (SSE) ----------------
const clients = new Set();
function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const c of clients) c.res.write(data);
}
setInterval(() => { for (const c of clients) c.res.write(': ping\n\n'); }, 25000).unref();

// ---------------- auth ----------------
function auth(req, res, next) {
  const token = parseCookies(req.headers.cookie).tna_session;
  if (token) {
    const row = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > datetime('now') AND u.active = 1`).get(token);
    if (row) { delete row.password_hash; req.user = row; return next(); }
  }
  res.status(401).json({ error: 'Not signed in' });
}
const role = (...roles) => (req, res, next) => roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Not allowed for your role' });
const MANAGERS = ['admin', 'operations'];

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(String(username || '').toLowerCase());
  if (!u || !verifyPassword(String(password || ''), u.password_hash)) return res.status(401).json({ error: 'Invalid username or password' });
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES (?,?,datetime('now','+12 hours'))").run(token, u.id);
  db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
  res.setHeader('Set-Cookie', `tna_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''}`);
  audit(u.id, 'session', u.id, 'login');
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie).tna_session;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.setHeader('Set-Cookie', 'tna_session=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

// ---------------- data ingestion (machine-to-machine, API key) ----------------
// POST /api/ingest/hours   Header: X-API-Key: <key>
// { "source": "phone", "key_type": "phone_system_id", "rows": [ { "employee_key": "PH1001", "work_date": "2026-11-20", "hours": 8.12, "first_login": "08:01", "last_logout": "16:40" } ] }
function ingestRows({ source = 'phone', key_type = 'phone_system_id', rows }, userId) {
  const keyCols = { phone_system_id: 'phone_system_id', employee_id: 'employee_id', wfm_system_id: 'wfm_system_id', crm_system_id: 'crm_system_id' };
  const col = keyCols[key_type];
  if (!col) bad('key_type must be one of ' + Object.keys(keyCols).join(', '));
  if (!Array.isArray(rows)) bad('rows must be an array');
  const findEmp = db.prepare(`SELECT id, campaign_id FROM employees WHERE ${col} = ?`);
  const upsert = db.prepare(`INSERT INTO time_raw(employee_id,work_date,source,hours,first_login,last_logout,batch_id)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(employee_id,work_date,source) DO UPDATE SET hours=excluded.hours,
    first_login=excluded.first_login, last_logout=excluded.last_logout, batch_id=excluded.batch_id, ingested_at=datetime('now')`);
  const errors = [];
  let applied = 0;
  const touched = new Set();
  const batchId = tx(() => {
    const id = db.prepare('INSERT INTO ingest_batches(source, rows_received) VALUES (?,?)').run(String(source), rows.length).lastInsertRowid;
    rows.forEach((r, i) => {
      const key = String(r.employee_key ?? r[key_type] ?? '').trim();
      const date = String(r.work_date || '').slice(0, 10);
      const hours = Number(r.hours);
      const emp = key && findEmp.get(key);
      if (!emp) return errors.push({ row: i, key, error: 'Unknown employee' });
      if (!L.isIsoDate(date)) return errors.push({ row: i, key, error: 'Invalid work_date' });
      if (!Number.isFinite(hours) || hours < 0 || hours > 24) return errors.push({ row: i, key, error: 'hours must be 0-24' });
      if (L.isLocked(emp.campaign_id, date)) return errors.push({ row: i, key, error: 'Week already approved (locked)' });
      upsert.run(emp.id, date, String(source), Math.round(hours * 100) / 100, nz(r.first_login), nz(r.last_logout), id);
      applied++; touched.add(date);
    });
    db.prepare('UPDATE ingest_batches SET rows_applied=?, rows_rejected=?, errors=? WHERE id=?')
      .run(applied, errors.length, errors.length ? JSON.stringify(errors.slice(0, 500)) : null, id);
    return id;
  });
  audit(userId, 'ingest_batch', batchId, 'ingest', { source, applied, rejected: errors.length });
  broadcast({ type: 'hours', dates: [...touched] });
  return { batch_id: Number(batchId), received: rows.length, applied, rejected: errors.length, errors: errors.slice(0, 50) };
}

app.post('/api/ingest/hours', (req, res, next) => {
  const key = req.get('X-API-Key');
  const expected = getSetting('ingest_api_key');
  if (!key || !expected || key.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(expected)))
    return res.status(401).json({ error: 'Invalid API key' });
  try { res.json(ingestRows(req.body || {}, null)); } catch (e) { next(e); }
});

// Everything below requires a signed-in user.
app.use('/api', auth);

app.get('/api/me', (req, res) => res.json(req.user));

app.get('/api/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  const c = { res, user: req.user.id };
  clients.add(c);
  req.on('close', () => clients.delete(c));
});

// ---------------- metadata ----------------
app.get('/api/meta', (req, res) => {
  res.json({
    campaigns: db.prepare('SELECT * FROM campaigns ORDER BY name').all(),
    supervisors: db.prepare("SELECT id, display_name, supervisor_code FROM users WHERE role='supervisor' AND active=1 ORDER BY display_name").all(),
    attendance_codes: db.prepare('SELECT * FROM attendance_codes WHERE active=1 ORDER BY sort, code').all(),
    dispositions: db.prepare('SELECT * FROM dispositions WHERE active=1 ORDER BY label').all(),
    week_start_day: L.weekStartDay(),
    today: L.toIso(new Date()),
  });
});

// ---------------- roster ----------------
const EMP_FIELDS = ['employee_id', 'first_name', 'last_name', 'campaign_id', 'supervisor_id', 'hire_date', 'production_start_date',
  'phone_system_id', 'crm_system_id', 'ris_emr_system_id', 'wfm_system_id', 'qa_system_id', 'status', 'termination_date'];

function cleanEmployee(b, partial = false) {
  const e = {};
  for (const f of EMP_FIELDS) if (b[f] !== undefined || !partial) e[f] = nz(typeof b[f] === 'string' ? b[f].trim() : b[f]);
  if (!partial || 'employee_id' in b) { if (!e.employee_id) bad('Employee ID is required'); }
  if (!partial || 'first_name' in b) { if (!e.first_name) bad('First name is required'); }
  if (!partial || 'last_name' in b) { if (!e.last_name) bad('Last name is required'); }
  for (const d of ['hire_date', 'production_start_date', 'termination_date']) if (e[d] && !L.isIsoDate(e[d])) bad(`${d} must be YYYY-MM-DD`);
  if (e.hire_date && e.production_start_date && e.production_start_date < e.hire_date) bad('Production start date cannot be before hire date');
  if (e.campaign_id) e.campaign_id = Number(e.campaign_id);
  if (!partial && !e.status) e.status = 'active';
  return e;
}
function uniqueErr(e) {
  if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'Employee ID already exists');
  throw e;
}

app.get('/api/employees', (req, res) => {
  const { campaign_id, supervisor_id, include_inactive, search } = req.query;
  res.json(L.scopedEmployees(req.user, { campaignId: campaign_id, supervisorId: supervisor_id, includeInactive: include_inactive === '1', search }));
});

app.get('/api/employees/export.csv', (req, res) => {
  const rows = L.scopedEmployees(req.user, { includeInactive: true }).map((e) => {
    const o = {}; for (const f of EMP_FIELDS) o[f === 'campaign_id' ? 'campaign_code' : f] = f === 'campaign_id' ? e.campaign_code : e[f]; return o;
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="roster.csv"');
  res.send(L.toCsv(rows));
});

app.post('/api/employees', role(...MANAGERS), (req, res) => {
  const e = cleanEmployee(req.body);
  let id;
  try { id = db.prepare(`INSERT INTO employees(${EMP_FIELDS.join(',')}) VALUES (${EMP_FIELDS.map(() => '?').join(',')})`).run(...EMP_FIELDS.map((f) => e[f])).lastInsertRowid; }
  catch (err) { uniqueErr(err); }
  audit(req.user.id, 'employee', id, 'create', e);
  broadcast({ type: 'roster' });
  res.json({ id: Number(id) });
});

app.put('/api/employees/:id', role(...MANAGERS), (req, res) => {
  const before = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
  if (!before) throw new HttpError(404, 'Employee not found');
  const e = cleanEmployee(req.body, true);
  const cols = Object.keys(e);
  if (!cols.length) bad('Nothing to update');
  try { db.prepare(`UPDATE employees SET ${cols.map((c) => c + '=?').join(',')}, updated_at=datetime('now') WHERE id=?`).run(...cols.map((c) => e[c]), before.id); }
  catch (err) { uniqueErr(err); }
  const changes = {}; for (const c of cols) if (String(before[c] ?? '') !== String(e[c] ?? '')) changes[c] = [before[c], e[c]];
  audit(req.user.id, 'employee', before.id, 'update', changes);
  broadcast({ type: 'roster' });
  res.json({ ok: true });
});

app.get('/api/employees/:id/history', (req, res) => {
  res.json(db.prepare(`SELECT a.*, u.display_name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.entity='employee' AND a.entity_id = ? ORDER BY a.id DESC LIMIT 100`).all(String(req.params.id)));
});

// Bulk import: CSV text with header row using the field names (campaign_code instead of campaign_id).
app.post('/api/employees/import', role(...MANAGERS), (req, res) => {
  const rows = parseCsv(String(req.body.csv || ''));
  if (!rows.length) bad('CSV is empty');
  const camps = Object.fromEntries(db.prepare('SELECT id, code FROM campaigns').all().map((c) => [c.code.toUpperCase(), c.id]));
  const results = { created: 0, updated: 0, errors: [] };
  tx(() => rows.forEach((r, i) => {
    try {
      if (r.campaign_code !== undefined) { r.campaign_id = r.campaign_code ? camps[r.campaign_code.toUpperCase()] : null; if (r.campaign_code && !r.campaign_id) bad(`Unknown campaign ${r.campaign_code}`); }
      const existing = db.prepare('SELECT id FROM employees WHERE employee_id = ?').get(String(r.employee_id || '').trim());
      if (existing) {
        const e = cleanEmployee(r, true); delete e.employee_id;
        const cols = Object.keys(e);
        if (cols.length) db.prepare(`UPDATE employees SET ${cols.map((c) => c + '=?').join(',')}, updated_at=datetime('now') WHERE id=?`).run(...cols.map((c) => e[c]), existing.id);
        results.updated++;
      } else {
        const e = cleanEmployee(r);
        db.prepare(`INSERT INTO employees(${EMP_FIELDS.join(',')}) VALUES (${EMP_FIELDS.map(() => '?').join(',')})`).run(...EMP_FIELDS.map((f) => e[f]));
        results.created++;
      }
    } catch (e) { results.errors.push({ line: i + 2, error: e.message }); }
  }));
  audit(req.user.id, 'employee', null, 'import', { created: results.created, updated: results.updated, errors: results.errors.length });
  broadcast({ type: 'roster' });
  res.json(results);
});

function parseCsv(text) {
  const lines = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') q = false; else field += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(field); lines.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field || row.length) { row.push(field); lines.push(row); }
  const nonEmpty = lines.filter((l) => l.some((v) => v.trim()));
  if (nonEmpty.length < 2) return [];
  const head = nonEmpty[0].map((h) => h.trim().toLowerCase());
  return nonEmpty.slice(1).map((l) => Object.fromEntries(head.map((h, i) => [h, (l[i] ?? '').trim()])));
}

// ---------------- attendance ----------------
function rangeFromQuery(q) {
  const { from, to } = q;
  if (!L.isIsoDate(from) || !L.isIsoDate(to) || from > to) bad('from/to must be valid YYYY-MM-DD dates');
  if (L.daysBetween(from, to).length > 62) bad('Range too large (max 62 days)');
  return { from, to };
}
function lockMap(campaignIds, from, to) {
  const out = {};
  if (!campaignIds.length) return out;
  const rows = db.prepare(`SELECT campaign_id, week_start FROM week_approvals WHERE status='approved' AND week_start BETWEEN ? AND ?
    AND campaign_id IN (${campaignIds.map(() => '?').join(',')})`).all(L.weekStartOf(from), to, ...campaignIds);
  for (const r of rows) (out[r.campaign_id] ??= []).push(r.week_start);
  return out;
}

app.get('/api/attendance', (req, res) => {
  const { from, to } = rangeFromQuery(req.query);
  const emps = L.scopedEmployees(req.user, { campaignId: req.query.campaign_id, supervisorId: req.query.supervisor_id });
  const marks = {};
  if (emps.length) {
    db.prepare(`SELECT employee_id, work_date, code_id, note FROM attendance WHERE work_date BETWEEN ? AND ?
      AND employee_id IN (${emps.map(() => '?').join(',')})`).all(from, to, ...emps.map((e) => e.id))
      .forEach((r) => { (marks[r.employee_id] ??= {})[r.work_date] = { code_id: r.code_id, note: r.note }; });
  }
  const hours = L.computeHours(emps.map((e) => e.id), from, to);
  res.json({ days: L.daysBetween(from, to), employees: emps, marks, hours, locks: lockMap([...new Set(emps.map((e) => e.campaign_id).filter(Boolean))], from, to) });
});

function setAttendance(user, { employee_id, work_date, code_id, note }) {
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(employee_id);
  if (!L.canAccessEmployee(user, emp)) throw new HttpError(403, 'Employee not in your roster');
  if (!L.isIsoDate(work_date)) bad('Invalid date');
  if (L.isLocked(emp.campaign_id, work_date)) throw new HttpError(423, 'This week is approved and locked');
  if (code_id == null || code_id === '') {
    db.prepare('DELETE FROM attendance WHERE employee_id=? AND work_date=?').run(emp.id, work_date);
  } else {
    const code = db.prepare('SELECT * FROM attendance_codes WHERE id = ? AND active = 1').get(code_id);
    if (!code || (code.campaign_id && code.campaign_id !== emp.campaign_id)) bad('Invalid attendance code for this campaign');
    db.prepare(`INSERT INTO attendance(employee_id,work_date,code_id,note,updated_by,updated_at) VALUES (?,?,?,?,?,datetime('now'))
      ON CONFLICT(employee_id,work_date) DO UPDATE SET code_id=excluded.code_id, note=excluded.note, updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
      .run(emp.id, work_date, code.id, nz(note), user.id);
  }
  audit(user.id, 'attendance', `${emp.id}:${work_date}`, 'set', { code_id: code_id ?? null, note: nz(note) });
  return { employee_id: emp.id, work_date, code_id: code_id == null || code_id === '' ? null : Number(code_id), note: nz(note) };
}

app.put('/api/attendance', (req, res) => {
  const r = setAttendance(req.user, req.body || {});
  broadcast({ type: 'attendance', changes: [r], by: req.user.id });
  res.json(r);
});

app.post('/api/attendance/bulk', (req, res) => {
  const entries = Array.isArray(req.body?.entries) ? req.body.entries : bad('entries required');
  const changes = [], errors = [];
  tx(() => entries.forEach((e) => { try { changes.push(setAttendance(req.user, e)); } catch (err) { errors.push({ ...e, error: err.message }); } }));
  broadcast({ type: 'attendance', changes, by: req.user.id });
  res.json({ applied: changes.length, errors });
});

// ---------------- time ----------------
app.get('/api/time', (req, res) => {
  const { from, to } = rangeFromQuery(req.query);
  const emps = L.scopedEmployees(req.user, { campaignId: req.query.campaign_id, supervisorId: req.query.supervisor_id });
  const marks = {};
  if (emps.length) {
    db.prepare(`SELECT employee_id, work_date, code_id FROM attendance WHERE work_date BETWEEN ? AND ?
      AND employee_id IN (${emps.map(() => '?').join(',')})`).all(from, to, ...emps.map((e) => e.id))
      .forEach((r) => { (marks[r.employee_id] ??= {})[r.work_date] = { code_id: r.code_id }; });
  }
  res.json({ days: L.daysBetween(from, to), employees: emps, hours: L.computeHours(emps.map((e) => e.id), from, to), marks,
    locks: lockMap([...new Set(emps.map((e) => e.campaign_id).filter(Boolean))], from, to) });
});

app.get('/api/time/detail', (req, res) => {
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.query.employee_id);
  if (!L.canAccessEmployee(req.user, emp)) throw new HttpError(403, 'Employee not in your roster');
  const date = req.query.date;
  if (!L.isIsoDate(date)) bad('Invalid date');
  res.json({
    employee: emp,
    locked: L.isLocked(emp.campaign_id, date),
    raw: db.prepare(`SELECT t.*, b.received_at FROM time_raw t LEFT JOIN ingest_batches b ON b.id=t.batch_id WHERE t.employee_id=? AND t.work_date=?`).all(emp.id, date),
    adjustments: db.prepare(`SELECT a.*, d.code AS disposition_code, d.label AS disposition_label, d.is_paid, d.is_billable,
      u.display_name AS created_by_name, v.display_name AS voided_by_name FROM time_adjustments a
      JOIN dispositions d ON d.id=a.disposition_id LEFT JOIN users u ON u.id=a.created_by LEFT JOIN users v ON v.id=a.voided_by
      WHERE a.employee_id=? AND a.work_date=? ORDER BY a.id`).all(emp.id, date),
    summary: (L.computeHours([emp.id], date, date)[emp.id] || {})[date] || null,
    dispositions: db.prepare('SELECT * FROM dispositions WHERE active=1 AND (campaign_id IS NULL OR campaign_id = ?) ORDER BY label').all(emp.campaign_id),
  });
});

app.post('/api/time/adjustments', (req, res) => {
  const { employee_id, work_date, hours, disposition_id, note } = req.body || {};
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(employee_id);
  if (!L.canAccessEmployee(req.user, emp)) throw new HttpError(403, 'Employee not in your roster');
  if (!L.isIsoDate(work_date)) bad('Invalid date');
  if (work_date > L.toIso(new Date())) bad('Cannot adjust future dates');
  if (L.isLocked(emp.campaign_id, work_date)) throw new HttpError(423, 'This week is approved and locked');
  const h = Math.round(Number(hours) * 100) / 100;
  if (!Number.isFinite(h) || h === 0 || Math.abs(h) > 24) bad('Hours must be a non-zero number between -24 and 24');
  const d = db.prepare('SELECT * FROM dispositions WHERE id = ? AND active = 1').get(disposition_id);
  if (!d || (d.campaign_id && d.campaign_id !== emp.campaign_id)) bad('Invalid disposition for this campaign');
  if (d.direction === 'add' && h < 0) bad(`${d.label} only allows adding time`);
  if (d.direction === 'subtract' && h > 0) bad(`${d.label} only allows removing time`);
  if (d.requires_note && !String(note || '').trim()) bad(`${d.label} requires a note`);
  const current = (L.computeHours([emp.id], work_date, work_date)[emp.id] || {})[work_date];
  if ((current?.total || 0) + h < 0) bad('Resulting hours cannot be negative');
  if ((current?.total || 0) + h > 24) bad('Resulting hours cannot exceed 24');
  const id = db.prepare('INSERT INTO time_adjustments(employee_id,work_date,hours,disposition_id,note,created_by) VALUES (?,?,?,?,?,?)')
    .run(emp.id, work_date, h, d.id, nz(note), req.user.id).lastInsertRowid;
  audit(req.user.id, 'time_adjustment', id, 'create', { employee_id: emp.id, work_date, hours: h, disposition: d.code, note });
  broadcast({ type: 'hours', dates: [work_date] });
  res.json({ id: Number(id) });
});

app.delete('/api/time/adjustments/:id', (req, res) => {
  const a = db.prepare('SELECT a.*, e.campaign_id, e.supervisor_id FROM time_adjustments a JOIN employees e ON e.id=a.employee_id WHERE a.id=?').get(req.params.id);
  if (!a || a.voided_at) throw new HttpError(404, 'Adjustment not found');
  if (!L.canAccessEmployee(req.user, a)) throw new HttpError(403, 'Employee not in your roster');
  if (L.isLocked(a.campaign_id, a.work_date)) throw new HttpError(423, 'This week is approved and locked');
  db.prepare("UPDATE time_adjustments SET voided_at=datetime('now'), voided_by=? WHERE id=?").run(req.user.id, a.id);
  audit(req.user.id, 'time_adjustment', a.id, 'void');
  broadcast({ type: 'hours', dates: [a.work_date] });
  res.json({ ok: true });
});

// ---------------- weekly approval & exports ----------------
function weekSummary(campaign, weekStart) {
  const weekEnd = L.addDays(weekStart, 6);
  const emps = db.prepare("SELECT id, employee_id, first_name, last_name, status FROM employees WHERE campaign_id = ?").all(campaign.id);
  const ids = emps.map((e) => e.id);
  const hours = L.computeHours(ids, weekStart, weekEnd);
  const codes = Object.fromEntries(db.prepare('SELECT id, code, counts_present FROM attendance_codes').all().map((c) => [c.id, c]));
  const marks = {};
  if (ids.length) db.prepare(`SELECT employee_id, work_date, code_id FROM attendance WHERE work_date BETWEEN ? AND ? AND employee_id IN (${ids.map(() => '?').join(',')})`)
    .all(weekStart, weekEnd, ...ids).forEach((r) => { (marks[r.employee_id] ??= {})[r.work_date] = codes[r.code_id]; });
  const t = { employees: 0, raw: 0, adj: 0, total: 0, paid: 0, billable: 0 };
  const exceptions = [];
  for (const e of emps) {
    let any = false;
    for (const d of L.daysBetween(weekStart, weekEnd)) {
      const c = hours[e.id]?.[d]; const m = marks[e.id]?.[d];
      if (c) { any = true; t.raw += c.raw; t.adj += c.adj; t.total += c.total; t.paid += c.paid; t.billable += c.billable; }
      const name = `${e.first_name} ${e.last_name}`;
      if (m && m.counts_present && !(c?.total > 0)) exceptions.push({ employee: name, employee_id: e.id, date: d, issue: `Marked ${m.code} but no hours` });
      if (m && !m.counts_present && c?.total > 0) exceptions.push({ employee: name, employee_id: e.id, date: d, issue: `Marked ${m.code} but has ${c.total}h` });
      if (!m && c?.total > 0) exceptions.push({ employee: name, employee_id: e.id, date: d, issue: 'Hours with no attendance mark' });
      if (c?.total > 12) exceptions.push({ employee: name, employee_id: e.id, date: d, issue: `Unusually high: ${c.total}h` });
    }
    if (any) t.employees++;
  }
  for (const k of ['raw', 'adj', 'total', 'paid', 'billable']) t[k] = L.round(t[k]);
  const approval = db.prepare(`SELECT w.*, u.display_name AS approved_by_name FROM week_approvals w LEFT JOIN users u ON u.id=w.approved_by
    WHERE w.campaign_id=? AND w.week_start=?`).get(campaign.id, weekStart) || null;
  const exports = db.prepare(`SELECT x.id, x.target, x.status, x.row_count, x.total_hours, x.message, x.created_at, u.display_name AS created_by_name
    FROM export_batches x LEFT JOIN users u ON u.id=x.created_by WHERE x.campaign_id=? AND x.week_start=? ORDER BY x.id DESC`).all(campaign.id, weekStart);
  return { campaign, week_start: weekStart, week_end: weekEnd, totals: t, exceptions, approval, exports };
}

app.get('/api/approvals', role(...MANAGERS), (req, res) => {
  const ws = L.weekStartOf(L.isIsoDate(req.query.week_start) ? req.query.week_start : L.toIso(new Date()));
  const camps = db.prepare('SELECT * FROM campaigns WHERE active=1 ORDER BY name').all();
  res.json({ week_start: ws, week_end: L.addDays(ws, 6), campaigns: camps.map((c) => weekSummary(c, ws)) });
});

app.post('/api/approvals', role(...MANAGERS), (req, res) => {
  const { week_start, campaign_id, action } = req.body || {};
  if (!L.isIsoDate(week_start) || L.weekStartOf(week_start) !== week_start) bad('week_start must be the first day of a week');
  const camp = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaign_id);
  if (!camp) bad('Unknown campaign');
  if (action === 'reopen') {
    db.prepare("UPDATE week_approvals SET status='reopened', reopened_by=?, reopened_at=datetime('now') WHERE campaign_id=? AND week_start=?").run(req.user.id, camp.id, week_start);
    audit(req.user.id, 'week_approval', `${camp.id}:${week_start}`, 'reopen');
  } else {
    if (L.addDays(week_start, 6) >= L.toIso(new Date())) bad('A week can only be approved after it has ended');
    const s = weekSummary(camp, week_start);
    db.prepare(`INSERT INTO week_approvals(week_start,campaign_id,status,approved_by,approved_at,totals) VALUES (?,?,'approved',?,datetime('now'),?)
      ON CONFLICT(week_start,campaign_id) DO UPDATE SET status='approved', approved_by=excluded.approved_by, approved_at=excluded.approved_at, totals=excluded.totals`)
      .run(week_start, camp.id, req.user.id, JSON.stringify(s.totals));
    audit(req.user.id, 'week_approval', `${camp.id}:${week_start}`, 'approve', s.totals);
  }
  broadcast({ type: 'approval', campaign_id: camp.id, week_start });
  res.json(weekSummary(camp, week_start));
});

app.post('/api/exports', role(...MANAGERS), wrap(async (req, res) => {
  const { week_start, campaign_id, target } = req.body || {};
  const camp = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaign_id);
  if (!camp) bad('Unknown campaign');
  const ap = db.prepare("SELECT * FROM week_approvals WHERE campaign_id=? AND week_start=? AND status='approved'").get(camp.id, week_start);
  if (!ap) bad('Week must be approved before exporting');
  const batchRef = `TNA-${camp.code}-${week_start}-${Date.now().toString(36).toUpperCase()}`;
  let lines, result, dest;
  try {
    if (target === 'billing') {
      lines = L.billingLines(camp.id, week_start); dest = 'billing';
      result = await connectors.sendToBilling(lines, batchRef, L.toCsv(lines));
    } else if (target === 'payroll') {
      lines = L.payrollLines(camp.id, week_start);
      dest = getSetting('payroll_target', 'acon');
      result = dest === 'spn' ? await connectors.sendToSpn(lines, batchRef) : await connectors.sendToAcon(lines, batchRef);
    } else bad('target must be billing or payroll');
  } catch (e) {
    if (e instanceof HttpError) throw e;
    result = { status: 'failed', message: e.message, artifact: null };
  }
  const total = L.round((lines || []).reduce((s, l) => s + (l.hours ?? l.billable_hours ?? 0), 0));
  const id = db.prepare('INSERT INTO export_batches(week_start,campaign_id,target,status,row_count,total_hours,payload,message,created_by) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(week_start, camp.id, dest || target, result.status, lines?.length || 0, total, JSON.stringify({ batchRef, lines, artifact: result.artifact }), result.message, req.user.id).lastInsertRowid;
  audit(req.user.id, 'export_batch', id, 'export', { target: dest, status: result.status, rows: lines?.length });
  broadcast({ type: 'approval', campaign_id: camp.id, week_start });
  res.json({ id: Number(id), ...result, artifact: undefined });
}));

app.get('/api/exports/:id/download', role(...MANAGERS), (req, res) => {
  const x = db.prepare('SELECT * FROM export_batches WHERE id = ?').get(req.params.id);
  if (!x) throw new HttpError(404, 'Not found');
  const p = JSON.parse(x.payload || '{}');
  const fmt = req.query.format;
  let body, type, ext;
  if (fmt === 'artifact' && p.artifact) {
    body = p.artifact; ext = x.target === 'acon' ? 'sql' : x.target === 'spn' ? 'json' : 'csv';
    type = ext === 'json' ? 'application/json' : 'text/plain';
  } else { body = L.toCsv(p.lines || []); type = 'text/csv'; ext = 'csv'; }
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename="${p.batchRef || 'export'}.${ext}"`);
  res.send(body);
});

// ---------------- ingestion admin ----------------
app.get('/api/ingest/batches', role(...MANAGERS), (req, res) => {
  res.json(db.prepare('SELECT * FROM ingest_batches ORDER BY id DESC LIMIT 50').all());
});
app.post('/api/ingest/upload', role(...MANAGERS), (req, res) => {
  const rows = parseCsv(String(req.body.csv || ''));
  res.json(ingestRows({ source: req.body.source || 'manual_upload', key_type: req.body.key_type || 'phone_system_id', rows }, req.user.id));
});

// ---------------- administration ----------------
function crud(table, fields, { roles = ['admin'], validate = () => {}, after = () => {} } = {}) {
  app.get(`/api/admin/${table}`, role(...MANAGERS), (req, res) => res.json(db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()));
  app.post(`/api/admin/${table}`, role(...roles), (req, res) => {
    const v = {}; for (const f of fields) v[f] = nz(req.body[f]); validate(v, true);
    const cols = fields.filter((f) => v[f] !== null);
    try {
      const id = db.prepare(`INSERT INTO ${table}(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => v[c])).lastInsertRowid;
      audit(req.user.id, table, id, 'create', v); after(); broadcast({ type: 'meta' }); res.json({ id: Number(id) });
    } catch (e) { if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'A record with that code already exists'); throw e; }
  });
  app.put(`/api/admin/${table}/:id`, role(...roles), (req, res) => {
    const v = {}; for (const f of fields) if (f in req.body) v[f] = nz(req.body[f]); validate(v, false);
    const cols = Object.keys(v); if (!cols.length) bad('Nothing to update');
    try { db.prepare(`UPDATE ${table} SET ${cols.map((c) => c + '=?').join(',')} WHERE id=?`).run(...cols.map((c) => v[c]), req.params.id); }
    catch (e) { if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'A record with that code already exists'); throw e; }
    audit(req.user.id, table, req.params.id, 'update', v); after(); broadcast({ type: 'meta' }); res.json({ ok: true });
  });
}
const req01 = (v, k) => { if (k in v && v[k] !== null) v[k] = v[k] === true || v[k] === 1 || v[k] === '1' || v[k] === 'true' ? 1 : 0; };
const need = (v, isNew, ...keys) => { for (const k of keys) if ((isNew || k in v) && !v[k]) bad(`${k} is required`); };

crud('campaigns', ['code', 'name', 'client', 'billing_code', 'active'], { roles: MANAGERS, validate: (v, n) => { need(v, n, 'code', 'name'); req01(v, 'active'); } });
crud('attendance_codes', ['code', 'label', 'color', 'counts_present', 'is_paid', 'campaign_id', 'sort', 'active'], {
  roles: MANAGERS, validate: (v, n) => { need(v, n, 'code', 'label'); ['counts_present', 'is_paid', 'active'].forEach((k) => req01(v, k)); },
});
crud('dispositions', ['campaign_id', 'code', 'label', 'description', 'direction', 'is_paid', 'is_billable', 'payroll_code', 'requires_note', 'active'], {
  roles: MANAGERS,
  validate: (v, n) => {
    need(v, n, 'code', 'label');
    if (v.direction && !['add', 'subtract', 'any'].includes(v.direction)) bad('direction must be add, subtract or any');
    ['is_paid', 'is_billable', 'requires_note', 'active'].forEach((k) => req01(v, k));
  },
});

// Users are handled separately because of passwords.
app.get('/api/admin/users', role(...MANAGERS), (req, res) => res.json(db.prepare('SELECT id, username, display_name, role, supervisor_code, active, created_at FROM users ORDER BY display_name').all()));
app.post('/api/admin/users', role('admin'), (req, res) => {
  const { username, password, display_name, role: r, supervisor_code } = req.body || {};
  if (!username || !password || !display_name) bad('username, password and display name are required');
  if (!['admin', 'operations', 'supervisor'].includes(r)) bad('Invalid role');
  if (String(password).length < 8) bad('Password must be at least 8 characters');
  if (r === 'supervisor' && !supervisor_code) bad('Supervisors need a supervisor code (matches the roster Supervisor ID)');
  try {
    const id = db.prepare('INSERT INTO users(username,password_hash,display_name,role,supervisor_code) VALUES (?,?,?,?,?)')
      .run(String(username).toLowerCase().trim(), hashPassword(password), display_name, r, nz(supervisor_code)).lastInsertRowid;
    audit(req.user.id, 'user', id, 'create', { username, role: r }); broadcast({ type: 'meta' }); res.json({ id: Number(id) });
  } catch (e) { if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'Username or supervisor code already in use'); throw e; }
});
app.put('/api/admin/users/:id', role('admin'), (req, res) => {
  const b = req.body || {}; const sets = [], vals = [];
  for (const f of ['display_name', 'role', 'supervisor_code', 'active']) if (f in b) { sets.push(f + '=?'); vals.push(f === 'active' ? (b[f] ? 1 : 0) : nz(b[f])); }
  if (b.password) { if (String(b.password).length < 8) bad('Password must be at least 8 characters'); sets.push('password_hash=?'); vals.push(hashPassword(b.password)); }
  if (!sets.length) bad('Nothing to update');
  try { db.prepare(`UPDATE users SET ${sets.join(',')} WHERE id=?`).run(...vals, req.params.id); }
  catch (e) { if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'Supervisor code already in use'); throw e; }
  if (b.active === false || b.active === 0 || b.password) db.prepare('DELETE FROM sessions WHERE user_id=?').run(req.params.id);
  audit(req.user.id, 'user', req.params.id, 'update', { ...b, password: b.password ? '***' : undefined }); broadcast({ type: 'meta' }); res.json({ ok: true });
});

app.get('/api/admin/settings', role(...MANAGERS), (req, res) => {
  res.json({
    week_start_day: L.weekStartDay(),
    payroll_target: getSetting('payroll_target', 'acon'),
    regular_payroll_code: getSetting('regular_payroll_code', 'REG'),
    billing_webhook_url: getSetting('billing_webhook_url', ''),
    ingest_api_key: req.user.role === 'admin' ? getSetting('ingest_api_key') : '(admin only)',
    connectors: connectors.status(),
  });
});
app.put('/api/admin/settings', role('admin'), (req, res) => {
  const b = req.body || {};
  if ('week_start_day' in b) { if (![0, 1, 6].includes(Number(b.week_start_day))) bad('Week can start Sunday, Monday or Saturday'); setSetting('week_start_day', Number(b.week_start_day)); }
  if ('payroll_target' in b) { if (!['acon', 'spn'].includes(b.payroll_target)) bad('payroll_target must be acon or spn'); setSetting('payroll_target', b.payroll_target); }
  if ('regular_payroll_code' in b) setSetting('regular_payroll_code', b.regular_payroll_code || 'REG');
  if ('billing_webhook_url' in b) setSetting('billing_webhook_url', b.billing_webhook_url || '');
  audit(req.user.id, 'settings', null, 'update', b); broadcast({ type: 'meta' }); res.json({ ok: true });
});
app.post('/api/admin/settings/rotate-key', role('admin'), (req, res) => {
  const key = crypto.randomBytes(24).toString('hex'); setSetting('ingest_api_key', key);
  audit(req.user.id, 'settings', 'ingest_api_key', 'rotate'); res.json({ ingest_api_key: key });
});
app.get('/api/admin/audit', role(...MANAGERS), (req, res) => {
  res.json(db.prepare(`SELECT a.*, u.display_name AS user_name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 300`).all());
});

// ---------------- static & errors ----------------
app.use('/integration', express.static(path.join(__dirname, '..', 'integration'), { setHeaders: (res) => res.setHeader('Content-Disposition', 'attachment') }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Server error: ' + err.message : err.message });
});

const PORT = Number(process.env.PORT || 3000);
if (require.main === module) app.listen(PORT, () => console.log(`Tempo running on http://localhost:${PORT}`));
module.exports = app;
