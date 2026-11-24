// Database layer: schema, migrations and seed data.
// Uses Node's built-in SQLite (node:sqlite) so the app runs with zero native deps.
// Schema is intentionally plain SQL so it ports cleanly to SQL Server later.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'tna.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','operations','supervisor')),
  supervisor_code TEXT UNIQUE,          -- matches employees.supervisor_id
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  client TEXT,
  billing_code TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id TEXT NOT NULL UNIQUE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  campaign_id INTEGER REFERENCES campaigns(id),
  supervisor_id TEXT,
  hire_date TEXT,
  production_start_date TEXT,
  phone_system_id TEXT,
  crm_system_id TEXT,
  ris_emr_system_id TEXT,
  wfm_system_id TEXT,
  qa_system_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','leave','terminated')),
  termination_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_emp_sup ON employees(supervisor_id);
CREATE INDEX IF NOT EXISTS ix_emp_phone ON employees(phone_system_id);

CREATE TABLE IF NOT EXISTS attendance_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#64748b',
  counts_present INTEGER NOT NULL DEFAULT 0,
  is_paid INTEGER NOT NULL DEFAULT 0,
  campaign_id INTEGER REFERENCES campaigns(id),   -- NULL = available to all campaigns
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS attendance (
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  work_date TEXT NOT NULL,
  code_id INTEGER NOT NULL REFERENCES attendance_codes(id),
  note TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (employee_id, work_date)
);

CREATE TABLE IF NOT EXISTS dispositions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER REFERENCES campaigns(id),   -- NULL = available to all campaigns
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  direction TEXT NOT NULL DEFAULT 'any' CHECK (direction IN ('add','subtract','any')),
  is_paid INTEGER NOT NULL DEFAULT 1,
  is_billable INTEGER NOT NULL DEFAULT 1,
  payroll_code TEXT,                               -- earning code sent to payroll (Acon/SPN)
  requires_note INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS ingest_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  rows_received INTEGER NOT NULL DEFAULT 0,
  rows_applied INTEGER NOT NULL DEFAULT 0,
  rows_rejected INTEGER NOT NULL DEFAULT 0,
  errors TEXT
);

CREATE TABLE IF NOT EXISTS time_raw (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  work_date TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'phone',
  hours REAL NOT NULL,
  first_login TEXT,
  last_logout TEXT,
  batch_id INTEGER REFERENCES ingest_batches(id),
  ingested_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (employee_id, work_date, source)
);

CREATE TABLE IF NOT EXISTS time_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  work_date TEXT NOT NULL,
  hours REAL NOT NULL,                  -- signed delta
  disposition_id INTEGER NOT NULL REFERENCES dispositions(id),
  note TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  voided_by INTEGER REFERENCES users(id),
  voided_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_adj_emp_date ON time_adjustments(employee_id, work_date);

CREATE TABLE IF NOT EXISTS week_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start TEXT NOT NULL,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
  status TEXT NOT NULL CHECK (status IN ('approved','reopened')),
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  reopened_by INTEGER REFERENCES users(id),
  reopened_at TEXT,
  totals TEXT,
  UNIQUE (week_start, campaign_id)
);

CREATE TABLE IF NOT EXISTS export_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start TEXT NOT NULL,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
  target TEXT NOT NULL,                 -- billing | acon | spn
  status TEXT NOT NULL,                 -- sent | dry_run | failed
  row_count INTEGER NOT NULL DEFAULT 0,
  total_hours REAL NOT NULL DEFAULT 0,
  payload TEXT,
  message TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER,
  entity TEXT NOT NULL,
  entity_id TEXT,
  action TEXT NOT NULL,
  details TEXT
);
`);

// ---------- migrations (safe to re-run) ----------
const hasCol = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((r) => r.name === c);
if (!hasCol('attendance_codes', 'counts_absent')) {
  db.exec('ALTER TABLE attendance_codes ADD COLUMN counts_absent INTEGER NOT NULL DEFAULT 0');
  db.exec("UPDATE attendance_codes SET counts_absent = 1 WHERE code IN ('A','E','S','NS')");
}
if (!hasCol('employees', 'modality')) db.exec("ALTER TABLE employees ADD COLUMN modality TEXT CHECK (modality IN ('WFH','ONS'))");

// Schedules: effective-dated weekly templates (one row per weekday) + one-off day overrides.
db.exec(`CREATE TABLE IF NOT EXISTS schedule_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_sched_tpl_emp ON schedule_templates(employee_id, effective_from);
CREATE TABLE IF NOT EXISTS schedule_template_days (
  template_id INTEGER NOT NULL REFERENCES schedule_templates(id) ON DELETE CASCADE,
  dow INTEGER NOT NULL CHECK (dow BETWEEN 0 AND 6),
  is_off INTEGER NOT NULL DEFAULT 0,
  start_time TEXT,
  end_time TEXT,
  break_minutes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (template_id, dow)
);
CREATE TABLE IF NOT EXISTS schedule_overrides (
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  work_date TEXT NOT NULL,
  is_off INTEGER NOT NULL DEFAULT 0,
  start_time TEXT,
  end_time TEXT,
  break_minutes INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (employee_id, work_date)
)`);

db.exec(`CREATE TABLE IF NOT EXISTS saved_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  config TEXT NOT NULL,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  shared INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

// ---------- helpers ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(pw, salt, 64);
  const known = Buffer.from(hash, 'hex');
  return known.length === test.length && crypto.timingSafeEqual(known, test);
}

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value == null ? null : String(value));
}

function audit(userId, entity, entityId, action, details) {
  db.prepare('INSERT INTO audit_log(user_id, entity, entity_id, action, details) VALUES (?,?,?,?,?)')
    .run(userId ?? null, entity, entityId == null ? null : String(entityId), action, details ? JSON.stringify(details) : null);
}

function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ---------- seed ----------
function seed() {
  const hasUsers = db.prepare('SELECT COUNT(*) n FROM users').get().n > 0;
  if (hasUsers) return;

  tx(() => {
    setSetting('week_start_day', '1'); // 0=Sunday, 1=Monday
    setSetting('ingest_api_key', crypto.randomBytes(24).toString('hex'));
    setSetting('regular_payroll_code', 'REG');

    const addUser = db.prepare('INSERT INTO users(username,password_hash,display_name,role,supervisor_code) VALUES (?,?,?,?,?)');
    addUser.run('admin', hashPassword('admin123'), 'System Admin', 'admin', null);
    addUser.run('ops', hashPassword('ops123'), 'Operations Manager', 'operations', null);
    addUser.run('msantos', hashPassword('super123'), 'Maria Santos', 'supervisor', 'SUP001');
    addUser.run('jperez', hashPassword('super123'), 'Juan Perez', 'supervisor', 'SUP002');

    const addCamp = db.prepare('INSERT INTO campaigns(code,name,client,billing_code) VALUES (?,?,?,?)');
    const c1 = addCamp.run('HC-INB', 'Healthcare Inbound', 'Acme Health', 'ACME-INB').lastInsertRowid;
    const c2 = addCamp.run('SCHED', 'Patient Scheduling', 'Acme Health', 'ACME-SCH').lastInsertRowid;


    const addDisp = db.prepare(`INSERT INTO dispositions(campaign_id,code,label,description,direction,is_paid,is_billable,payroll_code,requires_note)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    addDisp.run(null, 'MISSED_PUNCH', 'Missed punch / login', 'Agent worked but phone system did not capture login', 'add', 1, 1, 'REG', 1);
    addDisp.run(null, 'SYS_OUTAGE', 'System outage', 'Time lost due to system outage', 'add', 1, 0, 'REG', 1);
    addDisp.run(null, 'TRAINING', 'Training / coaching', 'Off-phone training time', 'add', 1, 0, 'TRN', 0);
    addDisp.run(null, 'MEETING', 'Team meeting', 'Off-phone meeting', 'add', 1, 0, 'REG', 0);
    addDisp.run(null, 'LONG_BREAK', 'Unapproved break / lunch over', 'Remove unpaid time', 'subtract', 0, 0, null, 1);
    addDisp.run(null, 'CORRECTION', 'Time correction', 'General correction, either direction', 'any', 1, 1, 'REG', 1);
    addDisp.run(c1, 'CLIENT_TRN', 'Client-paid training', 'Training billable to client', 'add', 1, 1, 'TRN', 0);
    addDisp.run(c2, 'EMR_DOWN', 'EMR downtime', 'RIS/EMR system unavailable', 'add', 1, 1, 'REG', 1);

    const addEmp = db.prepare(`INSERT INTO employees(employee_id,first_name,last_name,campaign_id,supervisor_id,hire_date,production_start_date,
      phone_system_id,crm_system_id,ris_emr_system_id,wfm_system_id,qa_system_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    const names = [
      ['Ana', 'Rodriguez'], ['Luis', 'Martinez'], ['Carmen', 'Gomez'], ['Pedro', 'Diaz'], ['Sofia', 'Hernandez'],
      ['Miguel', 'Lopez'], ['Laura', 'Garcia'], ['Jose', 'Ramirez'], ['Elena', 'Torres'], ['Carlos', 'Flores'],
      ['Isabel', 'Rivera'], ['Diego', 'Morales'], ['Lucia', 'Castillo'], ['Andres', 'Ortiz'],
    ];
    names.forEach(([f, l], i) => {
      const n = String(1001 + i);
      const sup = i < 7 ? 'SUP001' : 'SUP002';
      const camp = i < 7 ? c1 : c2;
      addEmp.run(`E${n}`, f, l, camp, sup, '2026-0' + (1 + (i % 8)) + '-05', '2026-0' + (1 + (i % 8)) + '-19',
        `PH${n}`, `CRM${n}`, `EMR${n}`, `WFM${n}`, `QA${n}`);
    });
    db.exec("UPDATE employees SET modality = CASE WHEN id % 3 = 0 THEN 'WFH' ELSE 'ONS' END");

    // Some sample hours for the last ~3 weeks so the time module has data.
    const batch = db.prepare("INSERT INTO ingest_batches(source,rows_received,rows_applied) VALUES ('seed',0,0)").run().lastInsertRowid;
    const emps = db.prepare('SELECT id FROM employees').all();
    const addTime = db.prepare('INSERT INTO time_raw(employee_id,work_date,source,hours,first_login,last_logout,batch_id) VALUES (?,?,?,?,?,?,?)');
    const today = new Date();
    let rows = 0;
    for (let d = 21; d >= 1; d--) {
      const dt = new Date(today); dt.setDate(today.getDate() - d);
      const dow = dt.getDay();
      if (dow === 0 || dow === 6) continue;
      const iso = dt.toISOString().slice(0, 10);
      emps.forEach((e, idx) => {
        if ((idx + d) % 17 === 0) return; // occasional missing day
        const h = Math.round((7.5 + ((idx * 7 + d * 3) % 9) / 10) * 100) / 100;
        addTime.run(e.id, iso, 'phone', h, '08:0' + (idx % 6), '16:3' + (idx % 6), batch);
        rows++;
      });
    }
    db.prepare('UPDATE ingest_batches SET rows_received=?, rows_applied=? WHERE id=?').run(rows, rows, batch);
  });
  console.log('Seeded demo data. Logins: admin/admin123, ops/ops123, msantos/super123, jperez/super123');
}
seed();

// ---------- attendance code set (v2: company code list) ----------
// Upserts by code so existing attendance history is preserved. Old codes are renamed
// where there is a clear equivalent and deactivated otherwise.
function applyCodeSetV2() {
  if (getSetting('codes_version') === '2') return;
  // [code, label, color, counts_present, counts_absent, is_paid]
  const CODES = [
    ['P', 'Present', '#16a34a', 1, 0, 1],
    ['LT', 'Late', '#ca8a04', 1, 0, 1],
    ['NCNS', 'No Call No Show', '#7f1d1d', 0, 1, 0],
    ['A', 'Absent', '#dc2626', 0, 1, 0],
    ['LOA', 'Leave of Absence', '#6b7280', 0, 0, 0],
    ['MLP', 'Planned Medical License', '#7c3aed', 0, 0, 0],
    ['MLUP', 'Unplanned Medical License', '#ea580c', 0, 1, 0],
    ['V', 'Vacation', '#2563eb', 0, 0, 1],
    ['VTO', 'Voluntary Time Off', '#0891b2', 0, 0, 0],
    ['OFF', 'Off agents', '#94a3b8', 0, 0, 0],
    ['PTO', 'Paid Time Off', '#0d9488', 0, 0, 1],
  ];
  const RENAME = { T: 'LT', NS: 'NCNS', O: 'OFF' };
  tx(() => {
    for (const [from, to] of Object.entries(RENAME)) {
      if (!db.prepare('SELECT 1 FROM attendance_codes WHERE code = ?').get(to))
        db.prepare('UPDATE attendance_codes SET code = ? WHERE code = ? AND campaign_id IS NULL').run(to, from);
    }
    const keep = new Set(CODES.map((c) => c[0]));
    CODES.forEach(([code, label, color, pres, abs, paid], i) => {
      const row = db.prepare('SELECT id FROM attendance_codes WHERE code = ? AND campaign_id IS NULL').get(code);
      if (row) db.prepare('UPDATE attendance_codes SET label=?, color=?, counts_present=?, counts_absent=?, is_paid=?, sort=?, active=1 WHERE id=?').run(label, color, pres, abs, paid, i, row.id);
      else db.prepare('INSERT INTO attendance_codes(code,label,color,counts_present,counts_absent,is_paid,sort) VALUES (?,?,?,?,?,?,?)').run(code, label, color, pres, abs, paid, i);
    });
    for (const r of db.prepare('SELECT id, code FROM attendance_codes WHERE campaign_id IS NULL').all())
      if (!keep.has(r.code)) db.prepare('UPDATE attendance_codes SET active = 0, sort = 100 WHERE id = ?').run(r.id);
    setSetting('codes_version', '2');
  });
}
applyCodeSetV2();

// Demo schedules for a fresh database (Mon–Fri, two different shift patterns, one agent with varied days).
function seedSchedules() {
  if (getSetting('schedules_seeded') || db.prepare('SELECT COUNT(*) n FROM schedule_templates').get().n) return;
  if (!db.prepare('SELECT 1 FROM ingest_batches WHERE source = ?').get('seed')) { setSetting('schedules_seeded', '1'); return; }
  const from = new Date(); from.setUTCDate(from.getUTCDate() - 60);
  const eff = from.toISOString().slice(0, 10);
  const tpl = db.prepare('INSERT INTO schedule_templates(employee_id, effective_from) VALUES (?,?)');
  const day = db.prepare('INSERT INTO schedule_template_days(template_id,dow,is_off,start_time,end_time,break_minutes) VALUES (?,?,?,?,?,?)');
  tx(() => {
    db.prepare('SELECT id FROM employees ORDER BY id').all().forEach((e, i) => {
      const id = tpl.run(e.id, eff).lastInsertRowid;
      for (let d = 0; d < 7; d++) {
        if (d === 0 || d === 6) { day.run(id, d, 1, null, null, 0); continue; }
        if (i === 0) { // varied example: Mon 5a-3p, Tue 8a-5p, Wed-Fri 9a-6p
          const [s, f] = d === 1 ? ['05:00', '15:00'] : d === 2 ? ['08:00', '17:00'] : ['09:00', '18:00'];
          day.run(id, d, 0, s, f, 60); continue;
        }
        day.run(id, d, 0, i % 2 ? '08:00' : '09:00', i % 2 ? '17:00' : '18:00', 60);
      }
    });
    setSetting('schedules_seeded', '1');
  });
}
seedSchedules();

module.exports = { db, tx, audit, hashPassword, verifyPassword, getSetting, setSetting, DB_PATH };
