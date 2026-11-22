// Outbound connectors: Billing, Acon (SQL Server) and SPN (REST API).
// Secrets come from environment variables, never from the database.
// When a connector is not configured it runs in "dry run" mode: the batch is
// recorded with its full payload so it can be downloaded and loaded manually.
const { getSetting } = require('./db');

function aconConfig() {
  const c = {
    server: process.env.ACON_SQL_SERVER, database: process.env.ACON_SQL_DATABASE,
    user: process.env.ACON_SQL_USER, password: process.env.ACON_SQL_PASSWORD,
    table: process.env.ACON_SQL_TABLE || 'dbo.TNA_PayrollImport',
    port: Number(process.env.ACON_SQL_PORT || 1433),
  };
  return { ...c, configured: !!(c.server && c.database && c.user && c.password) };
}
function spnConfig() {
  const c = { url: process.env.SPN_API_URL, key: process.env.SPN_API_KEY };
  return { ...c, configured: !!(c.url && c.key) };
}
function billingConfig() {
  const url = process.env.BILLING_WEBHOOK_URL || getSetting('billing_webhook_url');
  return { url, configured: !!url };
}

function status() {
  const a = aconConfig(), s = spnConfig(), b = billingConfig();
  let mssqlInstalled = true;
  try { require.resolve('mssql'); } catch { mssqlInstalled = false; }
  return {
    payroll_target: getSetting('payroll_target', 'acon'),
    acon: { configured: a.configured && mssqlInstalled, server: a.server || null, database: a.database || null, table: a.table, mssqlInstalled },
    spn: { configured: s.configured, url: s.url || null },
    billing: { configured: b.configured, url: b.url || null },
  };
}

const sqlStr = (v) => v == null ? 'NULL' : "N'" + String(v).replace(/'/g, "''") + "'";

function aconInsertScript(lines, batchRef) {
  const { table } = aconConfig();
  return [
    `-- TNA payroll export ${batchRef}`,
    'BEGIN TRANSACTION;',
    ...lines.map((l) => `INSERT INTO ${table} (BatchRef, EmployeeId, EarningCode, Hours, PeriodStart, PeriodEnd) VALUES (${sqlStr(batchRef)}, ${sqlStr(l.employee_id)}, ${sqlStr(l.earning_code)}, ${Number(l.hours)}, '${l.week_start}', '${l.week_end}');`),
    'COMMIT;',
  ].join('\n');
}

async function sendToAcon(lines, batchRef) {
  const cfg = aconConfig();
  const script = aconInsertScript(lines, batchRef);
  if (!status().acon.configured) return { status: 'dry_run', message: 'Acon connection not configured; SQL script generated for manual load.', artifact: script };
  const sql = require('mssql');
  const pool = await sql.connect({ server: cfg.server, port: cfg.port, database: cfg.database, user: cfg.user, password: cfg.password, options: { encrypt: true, trustServerCertificate: process.env.ACON_SQL_TRUST_CERT === 'true' } });
  const t = new sql.Transaction(pool);
  await t.begin();
  try {
    for (const l of lines) {
      await new sql.Request(t)
        .input('b', sql.NVarChar(64), batchRef).input('e', sql.NVarChar(64), l.employee_id).input('c', sql.NVarChar(32), l.earning_code)
        .input('h', sql.Decimal(9, 2), l.hours).input('s', sql.Date, l.week_start).input('f', sql.Date, l.week_end)
        .query(`INSERT INTO ${cfg.table} (BatchRef, EmployeeId, EarningCode, Hours, PeriodStart, PeriodEnd) VALUES (@b,@e,@c,@h,@s,@f)`);
    }
    await t.commit();
  } catch (e) { await t.rollback(); throw e; } finally { await pool.close(); }
  return { status: 'sent', message: `Inserted ${lines.length} rows into ${cfg.table}.`, artifact: script };
}

async function sendToSpn(lines, batchRef) {
  const cfg = spnConfig();
  const body = { batchRef, entries: lines.map((l) => ({ employeeId: l.employee_id, earningCode: l.earning_code, hours: l.hours, periodStart: l.week_start, periodEnd: l.week_end })) };
  if (!cfg.configured) return { status: 'dry_run', message: 'SPN API not configured; JSON payload generated.', artifact: JSON.stringify(body, null, 2) };
  const res = await fetch(cfg.url.replace(/\/$/, '') + '/timecards/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`SPN API responded ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return { status: 'sent', message: `SPN accepted ${lines.length} entries.`, artifact: JSON.stringify(body, null, 2) };
}

async function sendToBilling(lines, batchRef, csv) {
  const cfg = billingConfig();
  if (!cfg.configured) return { status: 'dry_run', message: 'Billing webhook not configured; CSV ready for download.', artifact: csv };
  const res = await fetch(cfg.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ batchRef, lines }) });
  if (!res.ok) throw new Error(`Billing endpoint responded ${res.status}`);
  return { status: 'sent', message: `Billing accepted ${lines.length} lines.`, artifact: csv };
}

module.exports = { status, sendToAcon, sendToSpn, sendToBilling };
