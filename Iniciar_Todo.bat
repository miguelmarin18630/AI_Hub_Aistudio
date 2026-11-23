@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

if not exist "%~dp0Iniciar_Web.bat" (
  echo [AI Hub] No se encontro Iniciar_Web.bat en %~dp0
  pause
  exit /b 1
)

if not exist "%~dp0Iniciar_Tunel.bat" (
  echo [AI Hub] No se encontro Iniciar_Tunel.bat en %~dp0
  pause
  exit /b 1
)

if "%PORT%"=="" set PORT=3000

echo [AI Hub] Iniciando servidor web en http://127.0.0.1:%PORT% ...
start "AI Hub - Web (%PORT%)" /D "%~dp0" cmd /c "Iniciar_Web.bat"

REM Esperar hasta 15 segundos a que el puerto 3000 este escuchando
set /a TRIES=0
:wait_port
netstat -ano | findstr /R /C:":%PORT% .*LISTENING" >nul 2>nul
if not errorlevel 1 goto start_tunnel
set /a TRIES+=1
if %TRIES% GEQ 15 goto start_tunnel
timeout /t 1 /nobreak >nul
goto wait_port

:start_tunnel
echo [AI Hub] Iniciando tunel Cloudflare hacia http://127.0.0.1:%PORT% ...
start "AI Hub - Tunel Cloudflare" /D "%~dp0" cmd /c "Iniciar_Tunel.bat"

exit /b 0
