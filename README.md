# AI Hub

Una aplicación web multiusuario en español para ver **qué modelos de IA puedes usar gratis y cuáles son los más baratos**, ordenados por relevancia y precio, con los proveedores que tú añadas (**OpenRouter**, **Ollama**, **OpenCode**, **OpenAI**, **Google Gemini**, **Groq**, **DeepSeek**, **Mistral** o cualquier servidor compatible con OpenAI). También sirve para usarlos directamente desde el navegador: chatear con memoria de conversación, leer y editar archivos de un proyecto, generar imágenes o vídeos y llevar el control de consumo por modelo.

Hecha con **Node.js 22**, **Express**, **TypeScript** y frontend ligero sin frameworks.

La **versión** se muestra dinámicamente en la cabecera y en la pantalla de acceso (por ejemplo, `v1.11.0`).

---

## Cómo arrancar

Requisitos: **Node.js 22 o superior** y conexión a internet.

- **Repositorio:** `https://github.com/miguelmarin18630/AI_Hub_Aistudio` (carpeta local en Windows: `C:\Proyectos\AI_Hub_Aistudio`).
- **Windows (doble clic):** usa **`Iniciar_Todo.bat`** (o **`Iniciar_Todo.vbs`** en segundo plano) para arrancar a la vez el servidor en el puerto `3000` y el túnel de Cloudflare `aistudio` hacia `https://aistudio.marinweb.org` (o por separado con **`Iniciar_Web.bat`** e **`Iniciar_Tunel.bat`**).
- **macOS / Linux:** ejecuta **`./Iniciar_Web.command`** o usa los comandos de terminal:

```bash
npm install
npm start        # arranca server.ts en el puerto 3000 (o PORT)
```

En desarrollo (con recarga automática):

```bash
npm run dev
```

Abre `http://127.0.0.1:3000` en el navegador. La primera vez te pedirá crear tu **código maestro de administrador**. Después, desde **🔑 Accesos** en la barra superior podrás generar **códigos personales de invitación** (sin usuario ni contraseña, con límite de usos, caducidad, paquete inicial opcional de proveedores y revocación inmediata).

Todos los proveedores se añaden desde **⚙ Ajustes → Proveedores** (no hay proveedores preinstalados obligatorios):

- **OpenRouter** → consigue tu clave en [openrouter.ai/keys](https://openrouter.ai/keys) y añádelo desde el preset `OpenRouter`.
- **Ollama (Local)** → [ollama.com](https://ollama.com) (con `ollama serve` en marcha) y añádelo desde el preset `Ollama (Local)` sin clave.
- **OpenCode**, **OpenAI**, **Google Gemini**, **Groq**, **DeepSeek**, **Mistral**, **LM Studio**, etc. → añádelos desde sus presets o como proveedor personalizado.

Para instrucciones específicas de macOS/Linux consulta `LEEME-MAC.md`, y para publicar en tu propio dominio con Cloudflare Tunnel consulta `WEB.md`.

---

## Qué muestra

La pantalla tiene tres columnas:

1. **Proveedores y modelos** (izquierda, plegable) → elige un proveedor concreto o **Todos los proveedores** y filtra por grupo (**Todos**, **Código**, **Razona**, **Visión**, **Chat**, **Imagen**, **Vídeo**). La lista se organiza jerárquicamente: **dentro de cada proveedor** aparecen sus **grupos** (Programación, Razonamiento, Visión y multimodal, Chat y texto, Imagen y Vídeo) y, **dentro de cada grupo**, primero los modelos **gratuitos ordenados por relevancia** (contexto, herramientas, visión, razonamiento, tamaño, familia e instalados en local) y después los **de pago de menor a mayor precio**. Incluye buscador, filtro (**Todos / Gratis / De pago / Favoritos**) y orden (**Relevancia / Precio ↑, Precio ↓, Nombre, Contexto ↓**). El botón **◀** (`Ctrl+B`) pliega la columna a una franja lateral.
2. **Conversación o generador** (centro) → cabecera con el modelo activo, el **indicador de contexto** (turnos y tokens aproximados frente al límite del modelo) y **＋ Nuevo chat** (`Ctrl+N`). El hilo de mensajes se conserva entre consultas y al cambiar de modelo; admite bloques de código con botón **Copiar** y botón **Copiar** por respuesta. Para modelos de imagen/vídeo, el panel central muestra el generador con relación de aspecto, duración y resolución.
3. **Detalles, consumo y archivos** (derecha) → grupo, precio, descripción, etiquetas, favorito (`★`), copiar ID, consumo acumulado/diario (con botón para reiniciar en Ajustes) y explorador de **Archivos del proyecto**.

**Aplicación instalable (PWA):** AI Hub incluye manifiesto web, Service Worker e iconos adaptados (estándar, `maskable` para Android y `apple-touch-icon` para iOS). En Windows, macOS y Android aparece el botón **⬇ Instalar** en la cabecera y el menú para abrirla en ventana propia sin barra del navegador; en iPhone/iPad (Safari) muestra una guía paso a paso para añadirla a la pantalla de inicio, además de un indicador automático si te quedas sin conexión.

---

## Cómo funciona la conversación (contexto)

Una IA no recuerda nada entre peticiones: la memoria la gestiona AI Hub enviando el historial en `src/chat.ts`:

1. **Tu consulta se guarda** en el historial como mensaje de usuario.
2. **Se construye el contexto**: instrucciones del sistema (responder en español, no inventar, mantener el hilo) + turnos anteriores + tu mensaje nuevo.
3. **Se respeta la ventana del modelo**. Si la conversación supera el límite del modelo activo, se recortan los turnos más antiguos completos (sin partir llamadas a herramientas) y aparece un aviso en el chat. El indicador de la cabecera muestra turnos y `~tokens de límite`.
4. **La respuesta llega en streaming** (SSE) y se guarda en el historial junto a las acciones de herramientas si se usaron.
5. **El hilo se conserva** al cambiar de modelo o recargar la página (hasta 30 conversaciones guardadas por usuario en **Historial**). Solo **＋ Nuevo chat** empieza de cero.

Los tokens son una **estimación** (≈4 caracteres/token); el gasto real lo marca la cuenta del proveedor.

---

## Proveedores, precios y archivos

### Cómo se calculan los precios

- Los catálogos se descargan **en vivo** para cada proveedor que añadas: OpenRouter (`/models`, `/images/models`, `/videos/models` con precios en tiempo real), Ollama (`/api/tags` más modelos curados locales) y cualquier API compatible con OpenAI (`/models`).
- **Gratis** = 0 $ por token (o `:free` / `-free` / modelos locales en Ollama).
- En programación se muestra **entrada / salida por 1M de tokens**; en imagen, **por imagen o megapíxel**; en vídeo, **por segundo**.

### Añadir proveedores

En **⚙ Ajustes → Proveedores** no viene ningún proveedor preinstalado: tú eliges los que quieras desde un preset (**OpenRouter**, **Ollama (Local)**, **OpenCode**, **OpenAI**, **Google Gemini**, **Groq**, **DeepSeek**, **Mistral**, **Together AI**, **Perplexity**, **Fireworks AI**, **xAI**, **Cerebras**, **SambaNova**, **Hugging Face**, **Novita AI**, **SiliconFlow**, **Hyperbolic**, **Cohere**, **Alibaba/Qwen**, **Moonshot**, **MiniMax**) o **Personalizado** para cualquier servidor compatible con OpenAI (por ejemplo LM Studio en `http://localhost:1234/v1`).

Al seleccionar un preset se rellena la URL base y una ayuda orientativa. Los proveedores, las claves, el caché de modelos, los favoritos, el consumo y el historial se guardan únicamente en el **disco duro local de cada usuario** (IndexedDB + sincronización opcional con un archivo `.json` en tu disco y botones de exportar/importar en **⚙ Ajustes**).

### Archivos del proyecto (agente)

- Conversar o generar imágenes/vídeos **no necesita proyecto**.
- Si seleccionas o creas un proyecto (botón **Proyecto** en la cabecera) y activas la casilla **Acceso a archivos del proyecto**, los modelos compatibles con herramientas pueden listar, leer, crear y editar archivos dentro de esa carpeta (nunca fuera ni dentro de `.git`).
- Cada acción aparece en la conversación (`⚙ list_files`, `⚙ read_file`, `⚙ write_file`, `⚙ replace_in_file`).

---

## Atajos de teclado

| Atajo | Acción |
| --- | --- |
| `Ctrl+N` / `Cmd+N` | Empezar un nuevo chat |
| `Ctrl+B` / `Cmd+B` | Mostrar u ocultar el panel de modelos |
| `Ctrl+I` / `Cmd+I` | Enfocar el campo de mensaje |
| `Ctrl+F` / `Cmd+F` | Ir al buscador de modelos (abre el panel si está plegado) |
| `Ctrl+/` o `?` | Abrir o cerrar la guía de atajos de teclado |
| `F5` | Actualizar catálogos |
| `Enter` en el buscador | Seleccionar el primer modelo visible y enfocar el compositor |
| `Enter` / `Ctrl+Enter` en el compositor | Enviar la consulta (`Shift+Enter` = salto de línea) |
| `Esc` | Cerrar modales, menús y cajones laterales |

---

## Datos, caché y variables de entorno

- **Datos de cada usuario (proveedores, claves API, modelos en caché, favoritos, consumo e historial):** se guardan exclusivamente en el **disco duro del propio usuario** (IndexedDB del dispositivo y, opcionalmente, sincronizados con un archivo `aihub-datos-<usuario>.json` en su disco duro desde **⚙ Ajustes → Mis datos**).
- **Datos del servidor (cuentas de acceso):** se guardan en una carpeta persistente del disco duro del equipo servidor (`%APPDATA%\AIHub` en Windows, `~/Library/Application Support/AIHub` en macOS, `~/.local/share/aihub` en Linux), configurable con `AIHUB_DATA_DIR`.

Variables opcionales (ver `.env.example`):

- `PORT`: puerto HTTP (por defecto `3000`).
- `AIHUB_DATA_DIR`: carpeta persistente del servidor para códigos de acceso y sesiones (en los lanzadores: `%APPDATA%\AIHub_Aistudio`).
- `AIHUB_ADMIN_CODE`: código maestro de administrador opcional (mínimo 6 dígitos o caracteres).
- `AIHUB_TUNNEL`: nombre del túnel de Cloudflare usado por `Iniciar_Tunel.bat` (por defecto `aistudio` para `aistudio.marinweb.org`).
- `OLLAMA_URL`: URL del servidor Ollama local (por defecto `http://127.0.0.1:11434`).
- `AIHUB_SYNC_TARGET_DIR`: carpeta local donde el servidor sincroniza automáticamente los cambios de GitHub usando `robocopy` en Windows (por defecto `C:\Proyectos\AI_Hub_Aistudio`) o `rsync` en Linux/macOS.
- `AIHUB_AUTO_SYNC` / `AIHUB_AUTO_SYNC_SECONDS`: activa la comprobación automática periódica desde el servidor (en Windows activa cada `60` s por defecto; también controlable desde **🔑 Accesos**).
- `AIHUB_GITHUB_WEBHOOK_SECRET`: secreto opcional HMAC-SHA256 para disparar la sincronización al instante mediante un webhook push de GitHub en `POST /api/webhook/github`.

---

## Comprobación y diagnóstico

```bash
npm run lint              # verificación de tipos TypeScript
npm run build             # validación de compilación
node --check public/app.js # sintaxis del frontend
npm test                  # versión, memoria 2 turnos, recorte, relevancia y smoke HTTP
```

Si algo falla:

- **No hay modelos**: pulsa **⟳ Actualizar** (`F5`). Comprueba tu conexión o tu clave en **⚙ Ajustes**.
- **Ollama sin modelos**: asegúrate de tener `ollama serve` activo y pulsa **⟳ Actualizar**.
- **Error de clave o sin saldo (429)**: revisa la clave en **⚙ Ajustes**; AI Hub distingue falta de créditos de límite temporal de peticiones.

---

## Arquitectura

```text
AI_Hub_Aistudio/
├─ server.ts                  servidor Express (API HTTP/SSE y archivos estáticos)
├─ package.json               scripts y dependencias (Node.js 22)
├─ tsconfig.json              configuración TypeScript
├─ .env.example               variables de entorno de ejemplo
├─ src/
│  ├─ types.ts                versión (APP_VERSION) y tipos compartidos
│  ├─ config.ts               configuración, favoritos, historial y rutas por usuario
│  ├─ access.ts               códigos de acceso personales, paquete inicial y revocación
│  ├─ users.ts                sesiones HMAC versionadas y acceso clásico opcional
│  ├─ api.ts                  OpenRouter, Ollama, streaming SSE y mensajes de error
│  ├─ catalog.ts              modelos, precios, relevancia y caché
│  ├─ custom.ts               presets y proveedores compatibles con OpenAI
│  ├─ chat.ts                 contexto de conversación (turnos, recorte y tokens)
│  ├─ agent.ts                bucle de herramientas sobre archivos del proyecto
│  ├─ projects.ts             gestión y lectura segura de proyectos
│  └─ usage.ts                registro y reinicio de consumo por modelo
├─ public/
│  ├─ index.html              interfaz principal y pantallas de login/setup
│  ├─ styles.css              tema oscuro y diseño responsive
│  └─ app.js                  cliente web, catálogo, chat SSE y modales
├─ scripts/
│  └─ verify.ts               verificación automática (npm test)
├─ MANUAL_CONTINUACION.md     modelo de trabajo del proyecto
├─ WEB.md                     publicación con Cloudflare Tunnel y seguridad
└─ LEEME-MAC.md               guía rápida para macOS, Linux y Windows
```

Los precios son informativos y pueden cambiar: la app los consulta en vivo al actualizar. El gasto real lo marca la cuenta de cada proveedor.

---

## Licencia

© 2026 Miguel Marín. Todos los derechos reservados. AI Hub es software propietario: no se permite su copia, distribución, modificación ni uso comercial sin autorización escrita. El código está publicado para consulta; no se concede licencia para reutilizarlo. Ver `LICENSE`.
