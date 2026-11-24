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
- Fields: Employee ID, first/last name, campaign, Supervisor ID, **modality (WFH = work from home, ONS = on site)**, hire date, production start date, plus the Phone, CRM, RIS/EMR, WFM and QA system IDs. Each employee also has a status (active / leave / terminated).
- Add or edit employees in a form, import a CSV in bulk (it creates new rows or updates existing ones by Employee ID), and export to CSV.
- Every change is audited field by field. Open an employee and click "View change history".
- A supervisor sees an agent when the agent's **Supervisor ID** matches the supervisor user's **supervisor code**.

### 2. Attendance (matrix)
- Rows are agents and columns are days. **Week** view is the default; **Month** view adds totals per attendance code.
- Use ‹ › to move between weeks or months, and **Today** to jump back. You can filter by campaign or supervisor and search for an agent.
- Click a cell to pick a code and add an optional note. You can also type the code letter (P, A, V…).
- Click a day header to fill every unmarked agent in one go: **P**, or **OFF** for agents whose schedule has them off that day.
- **Real time:** changes reach every open screen instantly over Server-Sent Events, and the changed cells flash.
- Attendance codes can be configured (Settings → Attendance codes): color, whether the code counts as present or absent, whether it is paid, and which campaign it applies to. The default list:

  | Code | Reason | Counts as |
  |---|---|---|
  | P | Present | present |
  | LT | Late | present |
  | NCNS | No Call No Show | absent |
  | A | Absent | absent |
  | LOA | Leave of Absence | neither (planned) |
  | MLP | Planned Medical License | neither (planned) |
  | MLUP | Unplanned Medical License | absent |
  | V | Vacation | neither (paid) |
  | VTO | Voluntary Time Off | neither |
  | OFF | Off agents | neither |
  | PTO | Paid Time Off | neither (paid) |

  When an existing database is upgraded, old marks are kept: Tardy becomes LT, No-show becomes NCNS and Day off becomes OFF. Codes that aren't on the list are deactivated but still show on past days.

### Schedules
- **The matrix:** rows are agents and columns are days, in a week or month view, using the same roster, filters and search as Attendance. Each cell shows the shift, its hours and any break; the right column totals scheduled hours, and the footer counts agents scheduled per day.
- **Shift formats:** shifts can be typed in whatever format people already use; a live preview shows how the app read it.
  - `8-5`, `5-3`, `8a-5p`, `8:30am-5:15pm`, `0800-1700`, `9 to 6`, `8 a 5`
  - overnight shifts: `22-6`, `10p-6a`
  - breaks: `8-5 30m`, `8-5 (1h)`, `8-5 lunch 60`
  - days off: `off`, `libre`, `x`
  - When am/pm is missing, the app picks the sensible reading (1–16 hours): `5-3` = 5 a.m.–3 p.m., `2-11` = 2 p.m.–11 p.m.
- **Every day can be different.** A weekly pattern holds a separate shift (or OFF) for each weekday. Examples: Monday 5a–3p, Tuesday 8a–5p, Wednesday–Friday 9a–6p.
- **Ways to enter schedules:**
  1. **Click a cell** and type a shift. *Enter* saves it as a one-off change for that date only (shown with a dot). *Shift+Enter* changes that weekday every week from that date on.
  2. **Click an agent's name**, or tick several agents, and choose **Set weekly schedule**. Type the shift for each day, or describe the whole week in one line, in English or Spanish: `Mon-Fri 8a-5p; Sat 9-1; Sun off`, `Mon 5-3, Tue 8-5, Wed-Fri 9-6 30m`, `Lun a Vie 8-5, Sab libre`.
  3. **Paste from Excel:** copy a block with the Employee ID and one column per day. A header row with day names is optional. The app shows a preview and flags any cell it can't read before importing.
  4. **Export CSV** of the current view.
- **Effective dates:** a weekly pattern applies from its *effective date* until it is changed. Earlier weeks keep their old schedule, so history and reports stay correct. One-off changes always win over the pattern for their date.
- **Where schedules are used:** they feed Attendance (each cell's tooltip and the day-header fill) and Reports (the measures below).

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

### 5. Reports (pivot table)
Reports works like an Excel pivot table over **agent-days**: one record per agent per day that has an attendance mark, hours, or a scheduled shift.

- **Fields:** check a field in the field list to add it, or drag it into **Rows**, **Columns**, **Values** or **Filters**. Drag a chip to reorder it or move it to another area; drag it back to the field list, or click ×, to remove it.
  - **Group by (Aa):**
    - date, week, month, year, weekday
    - client, campaign, supervisor, agent, employee ID, **modality (WFH / ONS)**, employee status
    - tenure since production start
    - attendance code
  - **Measures (Σ / %):**
    - total, raw, adjustment, paid and billable hours
    - days present, days absent, days worked
    - attendance %, absenteeism %, billable %
    - **productivity**, hours per agent, distinct agents, agent-days
    - **schedule:** scheduled hours, days scheduled, hours vs schedule %, scheduled days worked %, scheduled days not marked
- **Summarizing:** switch any measure between Sum, Average, Min, Max and Count. A dimension placed in Values gives a Distinct count or a Count.
- **Productivity** = total hours ÷ days worked, where a *day worked* is a day marked present **or** with hours > 0. It is recalculated for every cell, subtotal and grand total, so it is correct at any level of grouping and for any period.
- **Attendance %** = present ÷ (present + absent). Which codes count as present or absent is set per code in Settings → Attendance codes. Days off, vacation and holidays count as neither.
- **Layout:**
  - **classic pivot layout** (the default, like Excel's *tabular form*): each field in Rows gets its own column, and each group ends with an "*item* Total" row. You can turn subtotals off or repeat item labels on every row. A *compact* layout, with all row fields indented in one column, is also available.
  - groups you can expand or collapse, and a grand total row and column
  - sort by row label or by any value
  - optional color scale, like Excel's conditional formatting
- **Show details:** double-click any cell to see the agent-day records behind it, the same as Excel's "Show Details".
- **Date range:** presets (this week, last month, last 90 days, year to date…) or a custom range of up to 366 days.
- **Saving and exporting:**
  - Six standard reports are included.
  - Users can save their own layouts, and operations/admin can share layouts with everyone.
  - **Export CSV** writes the full pivot in the classic layout, including collapsed groups, with labels repeated on every row so the file sorts and filters cleanly in Excel.
- **Who sees what:** supervisors only see their own agents in reports.
- **Note:** supervisor, campaign and client come from the roster's *current* assignment. If an agent moves teams, their past days move with them.

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
public/                Single-page UI (vanilla JS, no build step); reports.js = pivot engine,
                       schedules.js = schedule screens, schedule-parse.js = flexible shift parser
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
