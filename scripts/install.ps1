$ErrorActionPreference = "Stop"

$binDir = "$HOME\.local\bin"
if (-not (Test-Path $binDir)) {
    New-Item -ItemType Directory -Path $binDir -Force | Out-Null
}

$sourceExe = Join-Path $PSScriptRoot "..\cli\target\release\drop.exe"
if (-not (Test-Path $sourceExe)) {
    $sourceExe = (Get-ChildItem (Join-Path $PSScriptRoot "..\dist\drop*windows-x64.exe") -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
}
if (-not $sourceExe -or -not (Test-Path $sourceExe)) {
    Write-Host "Compilando binario Rust de Windows primero..." -ForegroundColor Cyan
    cargo build --release --manifest-path (Join-Path $PSScriptRoot "..\cli\Cargo.toml")
    $sourceExe = Join-Path $PSScriptRoot "..\cli\target\release\drop.exe"
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
