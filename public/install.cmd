@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM Instalador de drop CLI para Windows (CMD)
REM Uso: curl -fsSL https://drop.oloxx.dev/install.cmd -o "%TEMP%\drop-install.cmd" && "%TEMP%\drop-install.cmd" && del "%TEMP%\drop-install.cmd"

set "REPO=Oloxx/drop"

where curl.exe >nul 2>&1
if errorlevel 1 (
    echo.
    echo   Error: curl.exe no esta disponible en este sistema.
    echo   Descarga el binario manualmente en: https://github.com/%REPO%/releases/latest
    echo.
    exit /b 1
)

echo.
echo   Buscando ultima version de drop...

set "TAG="
if defined DROP_VERSION (
    set "VER=%DROP_VERSION: =%"
    if not "!VER!"=="" (
        if /i "!VER:~0,1!"=="v" (
            set "TAG=!VER!"
        ) else (
            set "TAG=v!VER!"
        )
    )
)

if not defined TAG (
    for /f "usebackq delims=" %%U in (`curl.exe -fsSI -o nul -w "%%{redirect_url}" "https://github.com/%REPO%/releases/latest"`) do (
        set "REDIRECT_URL=%%U"
    )
    if defined REDIRECT_URL (
        for %%A in ("!REDIRECT_URL:/=" "!") do set "TAG=%%~A"
    )
)

if not defined TAG (
    echo   Error: no se pudo determinar la ultima version de drop.
    echo.
    exit /b 1
)

set "ASSET=drop-%TAG%-windows-x64.exe"
set "BASE_URL=https://github.com/%REPO%/releases/download/%TAG%"
set "TMP_DIR=%TEMP%\drop-install-%RANDOM%%RANDOM%"
mkdir "%TMP_DIR%" >nul 2>&1
set "TMP_EXE=%TMP_DIR%\%ASSET%"
set "TMP_SUMS=%TMP_DIR%\SHA256SUMS"

echo   Descargando %ASSET%...
curl.exe -fsSL "%BASE_URL%/%ASSET%" -o "%TMP_EXE%"
if errorlevel 1 (
    echo   Error: no se pudo descargar %ASSET%.
    rmdir /s /q "%TMP_DIR%" >nul 2>&1
    exit /b 1
)

curl.exe -fsSL "%BASE_URL%/SHA256SUMS" -o "%TMP_SUMS%"
if errorlevel 1 (
    echo   Error: no se pudo descargar SHA256SUMS.
    rmdir /s /q "%TMP_DIR%" >nul 2>&1
    exit /b 1
)

set "EXPECTED="
for /f "usebackq tokens=1,2" %%H in ("%TMP_SUMS%") do (
    set "FNAME=%%I"
    if "!FNAME:~0,1!"=="*" set "FNAME=!FNAME:~1!"
    if /i "!FNAME!"=="%ASSET%" set "EXPECTED=%%H"
)

if not defined EXPECTED (
    echo   Error: no se encontro el hash de %ASSET% en SHA256SUMS.
    rmdir /s /q "%TMP_DIR%" >nul 2>&1
    exit /b 1
)

set "ACTUAL="
set "LINE_NUM=0"
for /f "usebackq delims=" %%L in (`certutil -hashfile "%TMP_EXE%" SHA256`) do (
    set /a LINE_NUM+=1
    if !LINE_NUM!==2 (
        set "ACTUAL=%%L"
        set "ACTUAL=!ACTUAL: =!"
    )
)

if /i not "%ACTUAL%"=="%EXPECTED%" (
    echo   Error: SHA-256 no coincide para %ASSET%.
    echo     Esperado: %EXPECTED%
    echo     Recibido: %ACTUAL%
    rmdir /s /q "%TMP_DIR%" >nul 2>&1
    exit /b 1
)

echo   [OK] SHA-256 verificado (%ACTUAL:~0,12%).

"%TMP_EXE%" install
set "EXIT_CODE=%ERRORLEVEL%"

rmdir /s /q "%TMP_DIR%" >nul 2>&1
exit /b %EXIT_CODE%
