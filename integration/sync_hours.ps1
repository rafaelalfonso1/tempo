<#
  Hours sync job (PowerShell, no Node needed): SQL Server -> Time & Attendance app.
  Schedule with Windows Task Scheduler 2-4 times a day.

  Requires the SqlServer module:  Install-Module SqlServer -Scope CurrentUser
  Usage:
    .\sync_hours.ps1 -SqlServer "PHONEDB01" -Database "CallCenter" -TnaUrl "https://tna.yourcompany.com" -ApiKey "<key>"
  Uses Windows integrated auth by default; pass -Credential for SQL auth.
#>
param(
  [Parameter(Mandatory)] [string] $SqlServer,
  [Parameter(Mandatory)] [string] $Database,
  [Parameter(Mandatory)] [string] $TnaUrl,
  [Parameter(Mandatory)] [string] $ApiKey,
  [string] $QueryFile = (Join-Path $PSScriptRoot 'hours_query.sql'),
  [string] $KeyType = 'phone_system_id',
  [string] $Source = 'phone',
  [pscredential] $Credential
)
$ErrorActionPreference = 'Stop'
Import-Module SqlServer

$params = @{ ServerInstance = $SqlServer; Database = $Database; InputFile = $QueryFile; TrustServerCertificate = $true }
if ($Credential) { $params.Credential = $Credential }
$data = Invoke-Sqlcmd @params

$rows = @($data | ForEach-Object {
  @{
    employee_key = "$($_.employee_key)".Trim()
    work_date    = ([datetime]$_.work_date).ToString('yyyy-MM-dd')
    hours        = [double]$_.hours
    first_login  = if ($_.first_login -is [DBNull]) { $null } else { "$($_.first_login)" }
    last_logout  = if ($_.last_logout -is [DBNull]) { $null } else { "$($_.last_logout)" }
  }
})
Write-Host "Fetched $($rows.Count) rows"

$body = @{ source = $Source; key_type = $KeyType; rows = $rows } | ConvertTo-Json -Depth 4 -Compress
$res = Invoke-RestMethod -Method Post -Uri ($TnaUrl.TrimEnd('/') + '/api/ingest/hours') `
  -Headers @{ 'X-API-Key' = $ApiKey } -ContentType 'application/json' -Body $body
Write-Host "Applied $($res.applied), rejected $($res.rejected)"
$res.errors | ForEach-Object { Write-Warning "rejected $($_.key): $($_.error)" }
if ($res.rejected -gt 0) { exit 1 }
