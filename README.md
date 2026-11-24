# Tempo

Call center time & attendance platform.

Roster, daily attendance, hours review/adjustment, weekly approval, and payroll/billing export, all in one web app.

```
Phone system (SQL Server) ──sync job 2–4×/day──▶  Tempo  ──weekly, after Ops approval──▶  Billing (CSV / webhook)
                                                   │  ▲                                  └▶  Payroll: Acon (SQL Server) or SPN (API)
                                    Supervisors ───┘  └── Operations
```

## Run it

Requires Node.js 22.13 or newer. The database is Node's built-in SQLite, so nothing needs compiling.

```bash
cd tempo
npm install
npm start            # http://localhost:3000
npm test             # end-to-end API tests
```

The first run creates `data/tna.db` with demo data:

| User | Password | Role |
|---|---|---|
| admin | admin123 | Admin: everything, including users, settings and the API key |
| ops | ops123 | Operations: roster, config, weekly approval, exports |
| msantos | super123 | Supervisor SUP001: only sees their own agents |
| jperez | super123 | Supervisor SUP002 |

**Change these passwords before real use.** You can do it in Settings → Users.

## Modules

### 1. Roster
- Fields: Employee ID, first/last name, campaign, Supervisor ID, hire date, production start date, plus the Phone, CRM, RIS/EMR, WFM and QA system IDs. Each employee also has a status (active / leave / terminated).
- Add or edit employees in a form, import a CSV in bulk (it creates new rows or updates existing ones by Employee ID), and export to CSV.
- Every change is audited field by field. Open an employee and click "View change history".
- A supervisor sees an agent when the agent's **Supervisor ID** matches the supervisor user's **supervisor code**.

### 2. Attendance (matrix)
- Rows are agents and columns are days. **Week** view is the default; **Month** view adds totals per attendance code.
- Use ‹ › to move between weeks or months, and **Today** to jump back. You can filter by campaign or supervisor and search for an agent.
- Click a cell to pick a code and add an optional note. You can also type the code letter (P, A, V…).
- Click a day header to mark every unmarked agent **Present** in one go.
- **Real time:** changes reach every open screen instantly over Server-Sent Events, and the changed cells flash.
- Attendance codes can be configured (Settings → Attendance codes): color, whether the code counts as present, whether it is paid, and which campaign it applies to.

### 3. Time & Hours
- The same matrix layout shows each agent's hours per day, with daily, weekly, paid and billable totals.
- Cells are flagged when attendance and hours disagree: **amber** means marked present but no hours, **red** means marked absent but hours exist.
- Click a cell to see the ingested time (login/logout, which batch it came from) and the adjustment history, and to add an adjustment. You can add or remove hours, or "set the day's total to X".
- Every adjustment needs a **disposition**. Dispositions are managed in Settings → Dispositions:
  - global, or limited to one campaign
  - direction: add only, remove only, or either
  - **paid** and **billable** flags
  - payroll earning code (for example REG or TRN)
  - "note required"
- How the hours are calculated:
  - Raw hours count as paid and billable.
  - Removed hours come off total, paid and billable.
  - Added hours count toward paid or billable according to the disposition's flags.
- Adjustments are never deleted. They are *voided*, and the void is recorded with who did it.

### 4. Weekly approval → Billing & Payroll
- Operations sees one card per campaign for the selected week. Each card shows total, raw, adjusted, paid and billable hours, plus a list of **exceptions** to review.
- **Approve week** locks that campaign's week. After that, supervisors cannot edit it and ingested rows for those dates are rejected. **Reopen** unlocks it.
- After approval, use **Send to Billing** and **Send to Payroll**:
  - **Billing:** one line per agent per day of billable hours, tagged with the campaign's billing code. It is POSTed to a webhook if one is configured; otherwise it is a CSV download.
  - **Payroll:** one line per agent per earning code for the week.
    - **Acon:** rows are inserted into a SQL Server staging table (`integration/acon_import_table.sql`) inside one transaction.
    - **SPN:** a JSON payload is POSTed to its API.
  - You choose the payroll target in Settings → Integrations. Switching from Acon to SPN later is one setting.
- Every export is kept as a batch you can download again (CSV, plus the SQL script or JSON).
- **Dry run:** until a connector is configured, it runs in dry-run mode and produces the file without sending anything.

## Hours ingestion (SQL Server → app)

Files in `integration/` (they can also be downloaded from Settings → Integrations):

| File | Purpose |
|---|---|
| `hours_query.sql` | Query template returning `employee_key, work_date, hours, first_login, last_logout`. Change the table and column names to match your phone system. |
| `sync_hours.js` | Node job: runs the query and posts the results to the app. |
| `sync_hours.ps1` | Same job in PowerShell, for Windows Task Scheduler with no Node needed. |
| `acon_import_table.sql` | Staging table in Acon that payroll exports write to. |

The endpoint is `POST /api/ingest/hours` with an `X-API-Key` header (the key is in Settings → Integrations):

```json
{ "source": "phone", "key_type": "phone_system_id",
  "rows": [ { "employee_key": "PH1001", "work_date": "2026-11-20", "hours": 8.12, "first_login": "08:01", "last_logout": "16:40" } ] }
```

- **Re-sending is safe:** re-sending a day overwrites it, so each run can re-pull the last few days.
- **Rejected rows** are reported back and shown in the ingestion log: unknown agent, bad date, hours outside 0–24, or a locked week.
- **Other keys:** `key_type` can also be `employee_id`, `wfm_system_id` or `crm_system_id`.
- **Manual upload:** a CSV upload is available in the UI as a fallback.

## Configuration (environment variables)

Secrets live in environment variables, never in the database.

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default 3000) |
| `DB_PATH` | SQLite file path (default `data/tna.db`) |
| `COOKIE_SECURE=true` | Set this when serving over HTTPS |
| `ACON_SQL_SERVER`, `ACON_SQL_DATABASE`, `ACON_SQL_USER`, `ACON_SQL_PASSWORD`, `ACON_SQL_PORT`, `ACON_SQL_TABLE`, `ACON_SQL_TRUST_CERT` | Acon payroll connection (uses the `mssql` package, installed as an optional dependency) |
| `SPN_API_URL`, `SPN_API_KEY` | SPN payroll API. The endpoint path in `server/connectors.js` is a placeholder until we have SPN's API docs. |
| `BILLING_WEBHOOK_URL` | Optional billing endpoint (can also be set in the UI) |

## Code layout

```
server/index.js        REST API, auth/roles, SSE real-time, ingestion, approvals, exports
server/lib.js          Date/week logic, roster scoping, locking, hours / payroll / billing calculations
server/connectors.js   Billing, Acon (SQL Server) and SPN (REST) connectors with dry-run fallback
server/db.js           Schema + demo seed (plain SQL, portable to SQL Server)
public/                Single-page UI (vanilla JS, no build step)
integration/           SQL query template, sync jobs, Acon staging table
test/                  End-to-end API tests (node --test)
```

## Suggested next steps
- **Database:** move it to SQL Server for production. The schema is plain SQL, and only `server/db.js` needs a driver swap.
- **Sign-in:** add SSO (Azure AD / Entra ID) instead of local passwords.
- **SPN:** confirm the SPN API contract (endpoints, auth, earning codes) and finish `sendToSpn`.
- **Acon:** confirm the Acon import table layout and earning codes with payroll.
- **Schedules:** pull schedules from WFM so the app can flag missing or late logins automatically.
- **Payroll rules:** handle overtime (for example over 40 hours a week) and holiday pay.
