#!/usr/bin/env node
/*
 * Hours sync job: SQL Server -> Time & Attendance app.
 * Runs hours_query.sql against the phone-system database and posts the rows
 * to /api/ingest/hours. Schedule it (cron / Windows Task Scheduler) 2-4x a day.
 *
 *   npm install mssql
 *   SRC_SQL_SERVER=... SRC_SQL_DATABASE=... SRC_SQL_USER=... SRC_SQL_PASSWORD=... \
 *   TNA_URL=https://tna.yourcompany.com TNA_API_KEY=... node sync_hours.js
 *
 * Optional: KEY_TYPE (phone_system_id | employee_id | wfm_system_id), SOURCE (default "phone"),
 *           QUERY_FILE (default ./hours_query.sql), SRC_SQL_TRUST_CERT=true for self-signed certs.
 */
const fs = require('fs');
const path = require('path');
const sql = require('mssql');

const env = (k, d) => { const v = process.env[k] ?? d; if (v === undefined) { console.error(`Missing env var ${k}`); process.exit(2); } return v; };

(async () => {
  const query = fs.readFileSync(env('QUERY_FILE', path.join(__dirname, 'hours_query.sql')), 'utf8');
  const pool = await sql.connect({
    server: env('SRC_SQL_SERVER'), database: env('SRC_SQL_DATABASE'), user: env('SRC_SQL_USER'), password: env('SRC_SQL_PASSWORD'),
    port: Number(env('SRC_SQL_PORT', '1433')), options: { encrypt: true, trustServerCertificate: env('SRC_SQL_TRUST_CERT', 'false') === 'true' },
  });
  const { recordset } = await pool.request().query(query);
  await pool.close();

  const rows = recordset.map((r) => ({
    employee_key: String(r.employee_key).trim(),
    work_date: r.work_date instanceof Date ? r.work_date.toISOString().slice(0, 10) : String(r.work_date).slice(0, 10),
    hours: Number(r.hours),
    first_login: r.first_login ?? null,
    last_logout: r.last_logout ?? null,
  }));
  console.log(`Fetched ${rows.length} rows from SQL Server`);

  // Post in chunks so very large pulls don't hit request limits.
  const CHUNK = 2000;
  let applied = 0, rejected = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const res = await fetch(env('TNA_URL').replace(/\/$/, '') + '/api/ingest/hours', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': env('TNA_API_KEY') },
      body: JSON.stringify({ source: env('SOURCE', 'phone'), key_type: env('KEY_TYPE', 'phone_system_id'), rows: rows.slice(i, i + CHUNK) }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`Ingest failed (${res.status}): ${body.error}`);
    applied += body.applied; rejected += body.rejected;
    body.errors.forEach((e) => console.warn(`  rejected ${e.key}: ${e.error}`));
  }
  console.log(`Done. Applied ${applied}, rejected ${rejected}.`);
  process.exit(rejected ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
