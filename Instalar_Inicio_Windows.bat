@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

set "WORKDIR=%~dp0"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "TARGET=%~dp0Iniciar_Web.vbs"

if not exist "%TARGET%" (
  echo [AI Hub] No se encontro Iniciar_Todo.vbs en %~dp0
  pause
  exit /b 1
)

echo [AI Hub] Eliminando accesos de inicio antiguos de AI Hub / Tunel en:
echo          %STARTUP%
echo.

for %%P in (
  "*AIHub*"
  "*AI_Hub*"
  "*AI Hub*"
  "*Iniciar_Web*"
  "*Iniciar_Tunel*"
  "*Iniciar_Todo*"
  "*cloudflared*"
  "*aistudio*"
) do (
  for %%F in ("%STARTUP%\%%~P") do (
    if exist "%%~fF" (
      echo   - Eliminando: %%~nxF
      del /f /q "%%~fF"
    )
  )
)

echo.
echo [AI Hub] Creando acceso directo en el inicio de Windows para:
echo          %TARGET% (solo servidor web http://127.0.0.1:3000)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$q=[char]34; $s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $env:STARTUP 'AI_Hub_Aistudio.lnk')); $s.TargetPath='wscript.exe'; $s.Arguments=$q+$env:TARGET+$q; $s.WorkingDirectory=$env:WORKDIR; $s.Description='AI Hub (http://127.0.0.1:3000) y tunel Cloudflare aistudio.marinweb.org'; $s.Save()"

if errorlevel 1 (
  echo [AI Hub] Error creando el acceso directo en Inicio de Windows.
  pause
  exit /b 1
)

echo.
echo [AI Hub] Listo. Al encender Windows arrancara automaticamente:
echo          1^) Servidor web en http://127.0.0.1:3000
echo.
echo [AI Hub] El tunel Cloudflare NO se inicia automaticamente.
echo          Para iniciarlo manualmente, ejecuta: Iniciar_Tunel.vbs
echo.
pause
