@echo off
setlocal
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

echo [AI Hub] Abriendo tunel Cloudflare "%AIHUB_TUNNEL%" (aistudio.marinweb.org) hacia http://127.0.0.1:%PORT% ...
cloudflared tunnel run --url http://127.0.0.1:%PORT% %AIHUB_TUNNEL%
if errorlevel 1 pause
