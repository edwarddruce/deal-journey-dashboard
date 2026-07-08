$pgBin  = "C:\Program Files\PostgreSQL\17\bin"
$pgData = "C:\Program Files\PostgreSQL\17\data"
$svcName = "postgresql-x64-17"

Write-Host "=== Step 1: Create 'postgres' Windows user ===" -ForegroundColor Cyan
$pass = ConvertTo-SecureString "postgres" -AsPlainText -Force
try {
    New-LocalUser -Name "postgres" -Password $pass -PasswordNeverExpires -UserMayNotChangePassword `
        -Description "PostgreSQL Database Server" -ErrorAction Stop
    Write-Host "Created local user 'postgres'"
} catch {
    Write-Host "User 'postgres' already exists (or: $_)"
}

Write-Host "=== Step 2: Grant postgres user full access to data dir ===" -ForegroundColor Cyan
$acl = Get-Acl $pgData
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    "$env:COMPUTERNAME\postgres","FullControl",
    "ContainerInherit,ObjectInherit","None","Allow"
)
$acl.SetAccessRule($rule)
Set-Acl -Path $pgData -AclObject $acl
Write-Host "Permissions set on $pgData"

Write-Host "=== Step 3: Run initdb as 'postgres' user ===" -ForegroundColor Cyan
$pwFile = "C:\pg_init_pw.txt"
Set-Content $pwFile "postgres"

$credential = New-Object System.Management.Automation.PSCredential(
    "$env:COMPUTERNAME\postgres", $pass
)

$proc = Start-Process "$pgBin\initdb.exe" `
    -ArgumentList "-D `"$pgData`" -U postgres --pwfile=`"$pwFile`" -E UTF8" `
    -Credential $credential -Wait -PassThru -WorkingDirectory "C:\"
Write-Host "initdb exit code: $($proc.ExitCode)"
Remove-Item $pwFile -Force -ErrorAction SilentlyContinue

if ($proc.ExitCode -ne 0) {
    Write-Host "ERROR: initdb failed. Check if data dir is writable." -ForegroundColor Red
    exit 1
}

Write-Host "=== Step 4: Reconfigure service to use postgres user ===" -ForegroundColor Cyan
sc.exe config $svcName obj="$env:COMPUTERNAME\postgres" password="postgres" | Out-Null
Write-Host "Service account updated"

Write-Host "=== Step 5: Start the service ===" -ForegroundColor Cyan
Start-Service $svcName -ErrorAction SilentlyContinue
Start-Sleep 3
$status = (Get-Service $svcName).Status
Write-Host "Service status: $status"

if ($status -eq "Running") {
    Write-Host ""
    Write-Host "SUCCESS — PostgreSQL 17 is running on port 5432" -ForegroundColor Green
} else {
    Write-Host "Service did not start. Check Event Viewer for details." -ForegroundColor Red
}

Read-Host "Press Enter to close"
