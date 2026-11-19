# Instalador de drop CLI para Windows (PowerShell)
# Uso: irm https://drop.oloxx.dev/install.ps1 | iex
$ErrorActionPreference = "Stop"

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch {
    # PowerShell 7+ ya usa TLS 1.2/1.3 por defecto.
}

$repo = "Oloxx/drop"
$headers = @{ "User-Agent" = "drop-installer-ps1" }

function Get-LatestVersion {
    if ($env:DROP_VERSION -and $env:DROP_VERSION.Trim() -ne "") {
        return $env:DROP_VERSION.Trim().TrimStart("v", "V")
    }
    try {
        $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers $headers -TimeoutSec 15
        if ($rel.tag_name) {
            return $rel.tag_name.ToString().TrimStart("v", "V")
        }
    } catch {
        # Respaldo ante rate-limit de GitHub API: consultar /version en drop.oloxx.dev
    }
    $verRes = Invoke-RestMethod -Uri "https://drop.oloxx.dev/version" -Headers $headers -TimeoutSec 15
    if (-not $verRes.version) {
        throw "No se pudo determinar la última versión de drop."
    }
    return $verRes.version.ToString().TrimStart("v", "V")
}

$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("drop-install-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null

try {
    Write-Host ""
    Write-Host "  Buscando última versión de drop..." -ForegroundColor DarkGray
    $version = Get-LatestVersion
    $tag = "v$version"
    $asset = "drop-$tag-windows-x64.exe"
    $baseUrl = "https://github.com/$repo/releases/download/$tag"

    $tmpExe = Join-Path $tmpDir $asset
    $tmpSums = Join-Path $tmpDir "SHA256SUMS"

    Write-Host "  Descargando $asset..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri "$baseUrl/$asset" -OutFile $tmpExe -Headers $headers -UseBasicParsing
    Invoke-WebRequest -Uri "$baseUrl/SHA256SUMS" -OutFile $tmpSums -Headers $headers -UseBasicParsing

    $expected = $null
    foreach ($line in Get-Content $tmpSums) {
        $trimmed = $line.Trim()
        if ($trimmed -match "^([0-9a-fA-F]{64})\s+\*?(.+)$") {
            $name = [System.IO.Path]::GetFileName($Matches[2].Trim())
            if ($name -eq $asset) {
                $expected = $Matches[1].ToLowerInvariant()
                break
            }
        }
    }
    if (-not $expected) {
        throw "No se encontró el hash de $asset en SHA256SUMS."
    }

    $actual = (Get-FileHash -Path $tmpExe -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
        throw "SHA-256 no coincide para $asset (esperado $($expected.Substring(0,12)), recibido $($actual.Substring(0,12)))."
    }
    Write-Host "  ✔ SHA-256 verificado ($($actual.Substring(0,12)))." -ForegroundColor Green

    & $tmpExe install
    if ($LASTEXITCODE -ne 0) {
        throw "Error instalando drop (código $LASTEXITCODE)."
    }

    $installDir = if ($env:DROP_INSTALL_DIR -and $env:DROP_INSTALL_DIR.Trim() -ne "") {
        $env:DROP_INSTALL_DIR.Trim()
    } else {
        Join-Path $env:LOCALAPPDATA "Programs\drop"
    }
    if (-not (($env:Path -split ";") | Where-Object { $_.TrimEnd("\") -ieq $installDir.TrimEnd("\") })) {
        $env:Path = "$env:Path;$installDir"
    }
} finally {
    Remove-Item -Path $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
}
