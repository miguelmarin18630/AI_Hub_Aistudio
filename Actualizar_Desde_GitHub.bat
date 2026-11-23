@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
cd /d "%~dp0"

set "AUTO_MODE=0"
if /i "%~1"=="--auto" set "AUTO_MODE=1"
if "%PORT%"=="" set PORT=3000

where git >nul 2>nul
if errorlevel 1 (
  if "%AUTO_MODE%"=="0" (
    echo [AI Hub] No se encontro Git instalado. Descargalo en https://git-scm.com
    pause
  )
  exit /b 1
)

if not exist ".git" (
  echo [AI Hub] Conectando esta carpeta con https://github.com/miguelmarin18630/AI_Hub_Aistudio.git ...
  git init -b main >nul 2>nul || git init >nul 2>nul
  git remote add origin https://github.com/miguelmarin18630/AI_Hub_Aistudio.git >nul 2>nul
  git fetch origin main --quiet
  if errorlevel 1 (
    if "%AUTO_MODE%"=="0" (
      echo [AI Hub] No se pudo conectar con GitHub. Revisa tu conexion a internet.
      pause
    )
    exit /b 1
  )
  git reset --hard origin/main >nul 2>nul
  git branch -M main >nul 2>nul
  git branch --set-upstream-to=origin/main main >nul 2>nul
)

REM Asegurar que el remoto apunta al repo correcto AI_Hub_Aistudio (nunca al de Python AI_Hub)
for /f "delims=" %%r in ('git remote get-url origin 2^>nul') do set "ORIGIN_URL=%%r"
echo !ORIGIN_URL! | findstr /i "AI_Hub_Aistudio" >nul 2>nul
if errorlevel 1 (
  echo [AI Hub] Ajustando remoto origin a https://github.com/miguelmarin18630/AI_Hub_Aistudio.git ...
  git remote set-url origin https://github.com/miguelmarin18630/AI_Hub_Aistudio.git 2>nul
)

git fetch origin main --quiet
if errorlevel 1 (
  if "%AUTO_MODE%"=="0" (
    echo [AI Hub] No se pudo consultar GitHub. Revisa tu conexion a internet.
    pause
  )
  exit /b 1
)

for /f "delims=" %%h in ('git rev-parse HEAD 2^>nul') do set "LOCAL_REV=%%h"
for /f "delims=" %%h in ('git rev-parse origin/main 2^>nul') do set "REMOTE_REV=%%h"

if "!LOCAL_REV!"=="!REMOTE_REV!" (
  if "%AUTO_MODE%"=="0" (
    echo [AI Hub] Tu carpeta ya esta al dia con GitHub ^(origin/main^).
    pause
  )
  exit /b 0
)

echo [AI Hub] Nuevos cambios detectados en GitHub. Actualizando carpeta...
git pull --ff-only origin main
if errorlevel 1 (
  if "%AUTO_MODE%"=="0" (
    echo [AI Hub] Hay cambios locales sin subir que impiden actualizar automaticamente.
    echo Revisa con "git status" antes de volver a intentarlo.
    pause
  )
  exit /b 1
)

REM Reinstalar dependencias solo si cambio package.json
git diff --name-only !LOCAL_REV! !REMOTE_REV! | findstr /i "package.json" >nul 2>nul
if not errorlevel 1 (
  echo [AI Hub] Cambio detectado en package.json. Ejecutando npm install...
  call npm install
)

REM Si AI Hub estaba escuchando en el puerto 3000, reiniciar solo ese proceso para cargar la nueva version
set "SERVER_PID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:":%PORT% .*LISTENING"') do set "SERVER_PID=%%p"
if not "!SERVER_PID!"=="" (
  echo [AI Hub] Reiniciando servidor web ^(PID !SERVER_PID!^) para aplicar la actualizacion...
  taskkill /PID !SERVER_PID! /F >nul 2>nul
  timeout /t 1 /nobreak >nul
  if exist "%~dp0Iniciar_Web.vbs" (
    wscript.exe "%~dp0Iniciar_Web.vbs"
  )
)

echo [AI Hub] Carpeta sincronizada con GitHub correctamente.
if "%AUTO_MODE%"=="0" pause
exit /b 0
