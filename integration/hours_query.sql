/* =====================================================================
   Tempo - daily hours extract (SQL Server)
   ---------------------------------------------------------------------
   Run by sync_hours.js / sync_hours.ps1 a few times a day.
   Returns ONE row per agent per day. Re-sending a day overwrites it in
   the Tempo, so it is safe to re-pull the last few days every run.

   Required output columns (names matter):
     employee_key  - the agent's Phone System ID (or Employee ID; set
                     KEY_TYPE in the sync job to match)
     work_date     - DATE of the shift
     hours         - decimal hours logged in (e.g. 8.25)
   Optional:
     first_login, last_logout - 'HH:MM' strings, shown to supervisors

   >>> Replace the table/column names below with your phone system's. <<<
   ===================================================================== */
DECLARE @DaysBack INT = 3;   -- how many days to re-send each run

SELECT
    s.AgentLoginId                                        AS employee_key,
    CAST(s.LoginTime AS DATE)                             AS work_date,
    CAST(SUM(DATEDIFF(SECOND, s.LoginTime, ISNULL(s.LogoutTime, GETDATE()))) / 3600.0
         AS DECIMAL(6,2))                                 AS hours,
    CONVERT(VARCHAR(5), MIN(s.LoginTime), 108)            AS first_login,
    CONVERT(VARCHAR(5), MAX(s.LogoutTime), 108)           AS last_logout
FROM dbo.AgentSessions AS s                -- <== your agent login/state table
WHERE s.LoginTime >= DATEADD(DAY, -@DaysBack, CAST(GETDATE() AS DATE))
  AND s.LoginTime <  CAST(GETDATE() AS DATE)  -- completed days only; remove to include today
GROUP BY s.AgentLoginId, CAST(s.LoginTime AS DATE)
ORDER BY work_date, employee_key;
