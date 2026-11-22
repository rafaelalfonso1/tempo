/* Staging table in the Acon SQL Server database that the T&A app writes
   approved payroll hours into (one row per employee per earning code per
   week). A downstream Acon job / stored procedure can load it into payroll.
   Table name is configurable with ACON_SQL_TABLE. */
CREATE TABLE dbo.TNA_PayrollImport (
    Id           BIGINT IDENTITY(1,1) PRIMARY KEY,
    BatchRef     NVARCHAR(64)  NOT NULL,
    EmployeeId   NVARCHAR(64)  NOT NULL,
    EarningCode  NVARCHAR(32)  NOT NULL,
    Hours        DECIMAL(9,2)  NOT NULL,
    PeriodStart  DATE          NOT NULL,
    PeriodEnd    DATE          NOT NULL,
    LoadedAt     DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    Processed    BIT           NOT NULL DEFAULT 0
);
CREATE INDEX IX_TNA_PayrollImport_Batch ON dbo.TNA_PayrollImport (BatchRef);

/* Least-privilege login for the T&A app: */
-- CREATE LOGIN tna_writer WITH PASSWORD = '<strong password>';
-- CREATE USER tna_writer FOR LOGIN tna_writer;
-- GRANT INSERT ON dbo.TNA_PayrollImport TO tna_writer;
