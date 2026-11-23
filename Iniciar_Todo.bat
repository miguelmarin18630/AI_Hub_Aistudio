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

echo [AI Hub] Iniciando servidor web (puerto 3000)...
start "AI Hub - Web" /D "%~dp0" cmd /c "Iniciar_Web.bat"

timeout /t 3 /nobreak >nul

echo [AI Hub] Iniciando tunel Cloudflare...
start "AI Hub - Tunel Cloudflare" /D "%~dp0" cmd /c "Iniciar_Tunel.bat"

exit /b 0
