// End-to-end API tests against a throwaway database.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tna-test-'));
process.env.DB_PATH = path.join(dir, 'test.db');
const app = require('../server/index.js');
const { getSetting } = require('../server/db');
const L = require('../server/lib');

let server, base;
before(async () => { server = app.listen(0); await new Promise((r) => server.on('listening', r)); base = `http://localhost:${server.address().port}`; });
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function login(username, password) {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  assert.strictEqual(r.status, 200);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}
const ingest = (rows, key = getSetting('ingest_api_key')) => fetch(base + '/api/ingest/hours', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': key }, body: JSON.stringify({ source: 'phone', rows }),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

// A completed week well in the past, so it can be approved.
const WEEK = L.weekStartOf(L.addDays(L.toIso(new Date()), -35));
const DAY = L.addDays(WEEK, 1);

test('rejects bad login and unauthenticated access', async () => {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"username":"admin","password":"x"}' });
  assert.strictEqual(r.status, 401);
  assert.strictEqual((await fetch(base + '/api/employees')).status, 401);
});

test('supervisors only see and edit their own roster', async () => {
  const sup = await login('msantos', 'super123');
  const { body: emps } = await sup('GET', '/api/employees');
  assert.ok(emps.length > 0 && emps.every((e) => e.supervisor_id === 'SUP001'));
  const { body: all } = await (await login('ops', 'ops123'))('GET', '/api/employees');
  const other = all.find((e) => e.supervisor_id === 'SUP002');
  assert.strictEqual((await sup('PUT', '/api/attendance', { employee_id: other.id, work_date: DAY, code_id: 1 })).status, 403);
  assert.strictEqual((await sup('POST', '/api/employees', { employee_id: 'X', first_name: 'a', last_name: 'b' })).status, 403);
});

test('roster validation', async () => {
  const ops = await login('ops', 'ops123');
  assert.strictEqual((await ops('POST', '/api/employees', { employee_id: 'E1001', first_name: 'Dup', last_name: 'X' })).status, 409);
  assert.strictEqual((await ops('POST', '/api/employees', { employee_id: 'E9', first_name: 'A', last_name: 'B', hire_date: '2026-05-01', production_start_date: '2026-04-01' })).status, 400);
  const ok = await ops('POST', '/api/employees', { employee_id: 'E9000', first_name: 'Test', last_name: 'Agent', campaign_id: 1, supervisor_id: 'SUP001', phone_system_id: 'PH9000' });
  assert.strictEqual(ok.status, 200);
});

test('ingestion validates key and rows, and is idempotent', async () => {
  assert.strictEqual((await ingest([], 'wrong')).status, 401);
  const r = await ingest([{ employee_key: 'PH9000', work_date: DAY, hours: 8 }, { employee_key: 'nope', work_date: DAY, hours: 8 }, { employee_key: 'PH9000', work_date: 'bad', hours: 8 }]);
  assert.deepStrictEqual([r.body.applied, r.body.rejected], [1, 2]);
  await ingest([{ employee_key: 'PH9000', work_date: DAY, hours: 7.5 }]);
  const ops = await login('ops', 'ops123');
  const { body } = await ops('GET', `/api/time?from=${DAY}&to=${DAY}`);
  const emp = body.employees.find((e) => e.employee_id === 'E9000');
  assert.strictEqual(body.hours[emp.id][DAY].raw, 7.5);
});

test('adjustments respect disposition rules and paid/billable math', async () => {
  const sup = await login('msantos', 'super123');
  const { body: emps } = await sup('GET', '/api/employees');
  const emp = emps.find((e) => e.employee_id === 'E9000');
  const { body: meta } = await sup('GET', '/api/meta');
  const disp = (code) => meta.dispositions.find((d) => d.code === code).id;
  // add-only disposition cannot subtract
  assert.strictEqual((await sup('POST', '/api/time/adjustments', { employee_id: emp.id, work_date: DAY, hours: -1, disposition_id: disp('TRAINING') })).status, 400);
  // note required
  assert.strictEqual((await sup('POST', '/api/time/adjustments', { employee_id: emp.id, work_date: DAY, hours: -1, disposition_id: disp('LONG_BREAK') })).status, 400);
  // cannot go negative
  assert.strictEqual((await sup('POST', '/api/time/adjustments', { employee_id: emp.id, work_date: DAY, hours: -9, disposition_id: disp('CORRECTION'), note: 'x' })).status, 400);
  // Training: paid, not billable. Long break: -0.5 from everything.
  assert.strictEqual((await sup('POST', '/api/time/adjustments', { employee_id: emp.id, work_date: DAY, hours: 1, disposition_id: disp('TRAINING') })).status, 200);
  assert.strictEqual((await sup('POST', '/api/time/adjustments', { employee_id: emp.id, work_date: DAY, hours: -0.5, disposition_id: disp('LONG_BREAK'), note: 'long lunch' })).status, 200);
  const c = L.computeHours([emp.id], DAY, DAY)[emp.id][DAY];
  assert.deepStrictEqual({ raw: c.raw, total: c.total, paid: c.paid, billable: c.billable }, { raw: 7.5, total: 8, paid: 8, billable: 7 });
});

test('approval locks the week, then exports payroll and billing', async () => {
  const ops = await login('ops', 'ops123');
  const sup = await login('msantos', 'super123');
  assert.strictEqual((await ops('POST', '/api/exports', { week_start: WEEK, campaign_id: 1, target: 'payroll' })).status, 400); // not approved yet
  assert.strictEqual((await sup('POST', '/api/approvals', { week_start: WEEK, campaign_id: 1 })).status, 403);
  assert.strictEqual((await ops('POST', '/api/approvals', { week_start: WEEK, campaign_id: 1 })).status, 200);

  const { body: emps } = await sup('GET', '/api/employees');
  const emp = emps.find((e) => e.employee_id === 'E9000');
  assert.strictEqual((await sup('PUT', '/api/attendance', { employee_id: emp.id, work_date: DAY, code_id: 1 })).status, 423);
  assert.strictEqual((await ingest([{ employee_key: 'PH9000', work_date: DAY, hours: 3 }])).body.rejected, 1);

  const pay = await ops('POST', '/api/exports', { week_start: WEEK, campaign_id: 1, target: 'payroll' });
  assert.strictEqual(pay.body.status, 'dry_run');
  const lines = L.payrollLines(1, WEEK).filter((l) => l.employee_id === 'E9000');
  assert.deepStrictEqual(lines.map((l) => [l.earning_code, l.hours]).sort(), [['REG', 7], ['TRN', 1]]);
  const bill = L.billingLines(1, WEEK).filter((l) => l.employee_id === 'E9000');
  assert.deepStrictEqual(bill.map((l) => l.billable_hours), [7]);

  assert.strictEqual((await ops('POST', '/api/approvals', { week_start: WEEK, campaign_id: 1, action: 'reopen' })).status, 200);
  assert.strictEqual((await sup('PUT', '/api/attendance', { employee_id: emp.id, work_date: DAY, code_id: 1 })).status, 200);
});

test('report facts are scoped and saved reports are owner-protected', async () => {
  const sup = await login('msantos', 'super123');
  const ops = await login('ops', 'ops123');
  const from = WEEK, to = L.addDays(WEEK, 6);
  const supFacts = (await sup('GET', `/api/reports/facts?from=${from}&to=${to}`)).body;
  assert.ok(supFacts.employees.every((e) => e.supervisor_id === 'SUP001'));
  const opsFacts = (await ops('GET', `/api/reports/facts?from=${from}&to=${to}`)).body;
  assert.ok(opsFacts.employees.length > supFacts.employees.length);
  const emp = opsFacts.employees.find((e) => e.employee_id === 'E9000');
  const row = opsFacts.rows.find((r) => r[0] === emp.id && r[1] === DAY);
  assert.deepStrictEqual(row.slice(3, 8), [7.5, 0.5, 8, 8, 7]); // raw, adj, total, paid, billable
  assert.strictEqual((await ops('GET', '/api/reports/facts?from=2025-01-01&to=2026-12-31')).status, 400);

  const saved = await ops('POST', '/api/reports/saved', { name: 'Ops view', config: { rows: ['campaign'] }, shared: 1 });
  assert.strictEqual(saved.status, 200);
  assert.ok((await sup('GET', '/api/reports/saved')).body.some((r) => r.name === 'Ops view'));
  assert.strictEqual((await sup('DELETE', `/api/reports/saved/${saved.body.id}`)).status, 403);
  assert.strictEqual((await ops('DELETE', `/api/reports/saved/${saved.body.id}`)).status, 200);
});

test('attendance codes match the company list', async () => {
  const ops = await login('ops', 'ops123');
  const { body: meta } = await ops('GET', '/api/meta');
  const active = meta.attendance_codes.filter((c) => c.active).map((c) => c.code);
  assert.deepStrictEqual(active, ['P', 'LT', 'NCNS', 'A', 'LOA', 'MLP', 'MLUP', 'V', 'VTO', 'OFF', 'PTO']);
  const absent = meta.attendance_codes.filter((c) => c.active && c.counts_absent).map((c) => c.code).sort();
  assert.deepStrictEqual(absent, ['A', 'MLUP', 'NCNS']);
});

test('modality is validated and saved on the roster', async () => {
  const ops = await login('ops', 'ops123');
  const { body: emps } = await ops('GET', '/api/employees?search=E9000');
  assert.strictEqual((await ops('PUT', `/api/employees/${emps[0].id}`, { modality: 'remote' })).status, 400);
  assert.strictEqual((await ops('PUT', `/api/employees/${emps[0].id}`, { modality: 'wfh' })).status, 200);
  assert.strictEqual((await ops('GET', '/api/employees?search=E9000')).body[0].modality, 'WFH');
});

test('schedule text parser', () => {
  const P = require('../public/schedule-parse.js');
  const s = (t) => { const r = P.parseShift(t); return r.off ? 'off' : r.error ? 'error' : `${r.start}-${r.end}/${r.break_minutes}`; };
  assert.strictEqual(s('8-5'), '08:00-17:00/0');
  assert.strictEqual(s('5-3'), '05:00-15:00/0');
  assert.strictEqual(s('2-11'), '14:00-23:00/0');
  assert.strictEqual(s('10p-6'), '22:00-06:00/0');
  assert.strictEqual(s('0800-1700'), '08:00-17:00/0');
  assert.strictEqual(s('8:30am - 5:15pm 30m'), '08:30-17:15/30');
  assert.strictEqual(s('OFF'), 'off');
  assert.strictEqual(s('banana'), 'error');
  const w = P.parseWeek('Mon 5-3, Tue 8-5, Wed-Fri 9-6; Sat 9-1; Sun off').days;
  assert.deepStrictEqual([0, 1, 2, 3, 4, 5, 6].map((d) => P.label(w[d])), ['OFF', '5a–3p', '8a–5p', '9a–6p', '9a–6p', '9a–6p', '9a–1p']);
});

test('weekly schedules are effective-dated and day overrides win', async () => {
  const sup = await login('msantos', 'super123');
  const { body: emps } = await sup('GET', '/api/employees?search=E9000');
  const id = emps[0].id;
  const mon = L.weekStartOf('2027-01-06'); // a Monday-based week in the future
  const days = { 0: { off: true }, 1: { start: '05:00', end: '15:00', break_minutes: 60 }, 2: { start: '08:00', end: '17:00', break_minutes: 60 }, 3: { start: '22:00', end: '06:00' }, 4: { off: true }, 5: { off: true }, 6: { off: true } };
  assert.strictEqual((await sup('POST', '/api/schedules/templates', { effective_from: mon, items: [{ employee_id: id, days }] })).body.applied, 1);
  // a new pattern two weeks later only affects dates from then on
  const later = L.addDays(mon, 14);
  await sup('POST', '/api/schedules/templates', { effective_from: later, items: [{ employee_id: id, days: { ...days, 1: { start: '09:00', end: '18:00', break_minutes: 60 } } }] });
  let r = (await sup('GET', `/api/schedules?from=${mon}&to=${L.addDays(mon, 20)}`)).body.schedule[id];
  assert.strictEqual(r[mon].start, '05:00'); assert.strictEqual(r[mon].hours, 9);
  assert.strictEqual(r[L.addDays(mon, 2)].hours, 8); // overnight 22:00-06:00
  assert.strictEqual(r[later].start, '09:00');
  // one-off override, then revert
  await sup('POST', '/api/schedules/days', { entries: [{ employee_id: id, work_date: mon, shift: { off: true }, note: 'swap' }] });
  r = (await sup('GET', `/api/schedules?from=${mon}&to=${mon}`)).body.schedule[id];
  assert.ok(r[mon].off && r[mon].source === 'override');
  await sup('POST', '/api/schedules/days', { entries: [{ employee_id: id, work_date: mon, shift: null }] });
  r = (await sup('GET', `/api/schedules?from=${mon}&to=${mon}`)).body.schedule[id];
  assert.strictEqual(r[mon].source, 'template');
  // validation + scoping
  assert.strictEqual((await sup('POST', '/api/schedules/days', { entries: [{ employee_id: id, work_date: mon, shift: { start: '08:00', end: '08:30' } }] })).status, 200);
  assert.strictEqual((await sup('POST', '/api/schedules/days', { entries: [{ employee_id: id, work_date: mon, shift: { start: '8am', end: '5pm' } }] })).status, 400);
  const other = (await (await login('ops', 'ops123'))('GET', '/api/employees')).body.find((e) => e.supervisor_id === 'SUP002');
  assert.strictEqual((await sup('POST', '/api/schedules/days', { entries: [{ employee_id: other.id, work_date: mon, shift: { off: true } }] })).status, 403);
  // scheduled days appear in report facts
  const facts = (await sup('GET', `/api/reports/facts?from=${L.addDays(mon, 1)}&to=${L.addDays(mon, 1)}`)).body;
  const row = facts.rows.find((x) => x[0] === id);
  assert.deepStrictEqual(row.slice(8), [8, 1]);
});
