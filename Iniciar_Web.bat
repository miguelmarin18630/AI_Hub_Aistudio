@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [AI Hub] No se encontro Node.js. Instala Node.js 22 o superior desde https://nodejs.org
  pause
  exit /b 1
)

for /f "tokens=1 delims=." %%v in ('node -v') do set NODE_MAJOR=%%v
set NODE_MAJOR=%NODE_MAJOR:v=%
if %NODE_MAJOR% LSS 22 (
  echo [AI Hub] Se necesita Node.js 22 o superior. Version actual:
  node -v
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [AI Hub] Instalando dependencias por primera vez...
  call npm install
  if errorlevel 1 (
    echo [AI Hub] Error instalando dependencias.
    pause
    exit /b 1
  )
)

if "%PORT%"=="" set PORT=3000
if "%AIHUB_DATA_DIR%"=="" set AIHUB_DATA_DIR=%APPDATA%\AIHub_Aistudio

echo [AI Hub] Iniciando servidor web en http://127.0.0.1:%PORT%
echo [AI Hub] Carpeta del servidor: %AIHUB_DATA_DIR%
node server.ts
if errorlevel 1 pause
