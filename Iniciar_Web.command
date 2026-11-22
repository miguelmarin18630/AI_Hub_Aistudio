#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[AI Hub] No se encontró Node.js. Instala Node.js 22 o superior desde https://nodejs.org"
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "[AI Hub] Se necesita Node.js 22 o superior (actual: $(node -v))."
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "[AI Hub] Instalando dependencias por primera vez..."
  npm install
fi

export PORT="${PORT:-3000}"
if [ -z "${AIHUB_DATA_DIR:-}" ]; then
  if [ "$(uname -s)" = "Darwin" ]; then
    export AIHUB_DATA_DIR="$HOME/Library/Application Support/AIHub_Aistudio"
  else
    export AIHUB_DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/aihub-aistudio"
  fi
fi

echo "[AI Hub] Iniciando servidor web en http://127.0.0.1:${PORT}"
echo "[AI Hub] Carpeta del servidor: ${AIHUB_DATA_DIR}"
exec node server.ts
