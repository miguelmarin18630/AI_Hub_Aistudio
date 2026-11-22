# AI Hub · guía rápida para macOS, Linux y Windows

Requisitos: **Node.js 22 o superior** y conexión a internet.

## macOS y Linux

1. Instala Node.js 22+ si no lo tienes (<https://nodejs.org/> o `brew install node@22`).
2. Abre la carpeta del proyecto en Terminal y ejecuta:

   ```bash
   npm install
   npm test          # comprueba versión, memoria de conversación y reglas del catálogo
   npm run dev       # arranca el servidor en http://127.0.0.1:3000
   ```

3. Si quieres conservar tus códigos y sesiones del servidor en una ruta fija de macOS:

   ```bash
   AIHUB_DATA_DIR="$HOME/Library/Application Support/AIHub_Aistudio" npm start
   ```

## Windows (PowerShell)

```powershell
npm install
npm test
$env:AIHUB_DATA_DIR = "$env:APPDATA\AIHub_Aistudio"
npm start
```

Después abre <http://127.0.0.1:3000> en tu navegador.

## Comprobaciones

```bash
npm run lint               # tipos TypeScript
npm run build              # comprobación de build
node --check public/app.js # sintaxis del cliente web
npm test                   # verificación automática y smoke HTTP
```

## Uso rápido

1. La primera vez crea la cuenta de administrador en el navegador.
2. Elige proveedor y categoría; los modelos **gratis** salen primero ordenados por relevancia.
3. Selecciona un modelo en la lista (o busca con `Ctrl+F` / `Cmd+F` y pulsa `Enter`).
4. Escribe tu consulta y pulsa **Enter** (o `Ctrl+Enter`). `Shift+Enter` añade un salto de línea.
   La conversación **recuerda los turnos anteriores**; la cabecera muestra turnos y tokens
   aproximados frente al límite del modelo. **＋ Nuevo chat** empieza de cero.
5. Para **leer y escribir archivos**, elige o crea un proyecto en **Proyecto** y activa
   «Acceso a archivos del proyecto» bajo el compositor. Conversar o generar imágenes/vídeos
   no requiere proyecto.

La clave de OpenRouter se guarda en **⚙ Ajustes** (por usuario en el servidor) o mediante la
variable de entorno `OPENROUTER_API_KEY`.