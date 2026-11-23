@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

set "TASK_NAME=AI_Hub_Aistudio_GitHub_Sync"
set "VBS_PATH=%~dp0Actualizar_Desde_GitHub.vbs"

if not exist "%VBS_PATH%" (
  echo [AI Hub] No se encontro Actualizar_Desde_GitHub.vbs en esta carpeta.
  pause
  exit /b 1
)

echo [AI Hub] Instalando sincronizacion automatica con GitHub...
echo          Carpeta: %~dp0
echo          Frecuencia: cada 1 minuto en segundo plano (sin ventanas)
echo.

schtasks /Delete /TN "%TASK_NAME%" /F >nul 2>nul
schtasks /Create /SC MINUTE /MO 1 /TN "%TASK_NAME%" /TR "wscript.exe \"%VBS_PATH%\"" /F
if errorlevel 1 (
  echo.
  echo [AI Hub] No se pudo crear la tarea programada. Prueba a hacer clic derecho -^> Ejecutar como administrador.
  pause
  exit /b 1
)

echo.
echo [AI Hub] Listo. Tarea "%TASK_NAME%" activada correctamente.
echo          Cada vez que sincronices cambios con GitHub, tu carpeta
echo          "%~dp0" se actualizara automaticamente en menos de 1 minuto
echo          y el servidor en el puerto 3000 se reiniciara solo si hubo cambios.
echo.
echo          Para desactivarla en el futuro ejecuta en PowerShell/CMD:
echo          schtasks /Delete /TN "%TASK_NAME%" /F
echo.
echo [AI Hub] Comprobando GitHub ahora mismo por primera vez...
call "%~dp0Actualizar_Desde_GitHub.bat" --auto
echo [AI Hub] Comprobacion inicial completada.
pause
exit /b 0
