@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
cd /d "%~dp0"

where cloudflared >nul 2>nul
if errorlevel 1 (
  echo [AI Hub] No se encontro cloudflared en el PATH.
  echo Descargalo en: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
  pause
  exit /b 1
)

if "%PORT%"=="" set PORT=3000
if "%AIHUB_TUNNEL%"=="" set AIHUB_TUNNEL=aistudio
if "%AIHUB_HOST%"=="" set AIHUB_HOST=aistudio.marinweb.org

set "CF_DIR=%USERPROFILE%\.cloudflared"
set "CF_MAIN=%CF_DIR%\config.yml"
set "CF_CFG=%CF_DIR%\config-%AIHUB_TUNNEL%.yml"

REM 1) Si el config.yml principal ya incluye aistudio.marinweb.org, usarlo directamente
if exist "%CF_MAIN%" (
  findstr /i /c:"%AIHUB_HOST%" "%CF_MAIN%" >nul 2>nul
  if not errorlevel 1 (
    echo [AI Hub] Abriendo tunel Cloudflare usando %CF_MAIN% ^(%AIHUB_HOST% -^> http://127.0.0.1:%PORT%^) ...
    cloudflared tunnel --config "%CF_MAIN%" run
    if errorlevel 1 pause
    exit /b %errorlevel%
  )
)

REM 2) Si existe un tunel dedicado (por defecto "aistudio"), generar/usar config dedicado
if not exist "%CF_CFG%" (
  set "TUNNEL_ID="
  for /f "tokens=1,2" %%a in ('cloudflared tunnel list 2^>nul') do (
    if /i "%%b"=="%AIHUB_TUNNEL%" set "TUNNEL_ID=%%a"
  )
  if not "!TUNNEL_ID!"=="" (
    if not exist "%CF_DIR%" mkdir "%CF_DIR%"
    (
      echo tunnel: !TUNNEL_ID!
      echo credentials-file: '!CF_DIR!\!TUNNEL_ID!.json'
      echo ingress:
      echo   - hostname: %AIHUB_HOST%
      echo     service: http://127.0.0.1:%PORT%
      echo   - service: http_status:404
    ) > "%CF_CFG%"
    echo [AI Hub] Creada configuracion dedicada para %AIHUB_HOST%: %CF_CFG%
  )
)

if exist "%CF_CFG%" (
  echo [AI Hub] Abriendo tunel Cloudflare "%AIHUB_TUNNEL%" ^(%AIHUB_HOST%^) hacia http://127.0.0.1:%PORT% ...
  cloudflared tunnel --config "%CF_CFG%" run %AIHUB_TUNNEL%
) else (
  echo [AI Hub] Abriendo tunel Cloudflare "%AIHUB_TUNNEL%" ^(%AIHUB_HOST%^) hacia http://127.0.0.1:%PORT% ...
  cloudflared tunnel run --url http://127.0.0.1:%PORT% %AIHUB_TUNNEL%
)
if errorlevel 1 pause
