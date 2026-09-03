$ErrorActionPreference = "Stop"

$binDir = "$HOME\.local\bin"
if (-not (Test-Path $binDir)) {
    New-Item -ItemType Directory -Path $binDir -Force | Out-Null
}

$sourceExe = Join-Path $PSScriptRoot "..\dist\drop-windows-x64.exe"
if (-not (Test-Path $sourceExe)) {
    $sourceExe = Join-Path $PSScriptRoot "..\dist\drop.exe"
}
if (-not (Test-Path $sourceExe)) {
    Write-Host "Compilando drop-windows-x64.exe primero..." -ForegroundColor Cyan
    node "$PSScriptRoot\build-cross.mjs" win-x64
    $sourceExe = Join-Path $PSScriptRoot "..\dist\drop-windows-x64.exe"
}

$destExe = Join-Path $binDir "drop.exe"
Copy-Item $sourceExe $destExe -Force

$userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if ($userPath -notlike "*$binDir*") {
    $newPath = "$userPath;$binDir"
    [Environment]::SetEnvironmentVariable("PATH", $newPath, "User")
    Write-Host "[+] $binDir anadido a la variable PATH de usuario." -ForegroundColor Green
}

Write-Host "`n[OK] Drop CLI instalado globalmente con exito!" -ForegroundColor Green
Write-Host "Ubicacion: $destExe" -ForegroundColor DarkGray
Write-Host "Ya puedes ejecutar directamente desde cualquier terminal:" -ForegroundColor Cyan
Write-Host "  drop send <archivo>" -ForegroundColor Yellow
Write-Host "  drop recv <codigo>`n" -ForegroundColor Yellow
