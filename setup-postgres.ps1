$pgBin  = "C:\Program Files\PostgreSQL\17\bin"
$pgData = "C:\Program Files\PostgreSQL\17\data"

# Write a temp password file for initdb
$pwFile = "$env:TEMP\pg_init_pw.txt"
Set-Content -Path $pwFile -Value "postgres"

Write-Host "Initialising PostgreSQL data directory..."
& "$pgBin\initdb.exe" -D "$pgData" -U postgres --pwfile="$pwFile" -E UTF8 --locale=en-US

Remove-Item $pwFile -Force

Write-Host "Registering Windows service..."
& "$pgBin\pg_ctl.exe" register -N "postgresql-x64-17" -U "NT AUTHORITY\NetworkService" -D "$pgData"

Write-Host "Starting PostgreSQL service..."
Start-Service "postgresql-x64-17"

Write-Host ""
Write-Host "Done. PostgreSQL 17 is running."
