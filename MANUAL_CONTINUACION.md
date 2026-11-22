# Manual de Continuación — AI Hub

> **Qué es este documento.** Es el **modelo de trabajo** para continuar el proyecto:
> cómo actualizar archivos, verificar, cambiar de versión y subir a GitHub.
> **No es un registro de cambios.** No se anota aquí cada modificación; el historial
> vive en los commits de Git. Este archivo solo cambia si cambia *el proceso*.

Ubicación fija: `MANUAL_CONTINUACION.md` (raíz del repositorio)

---

## 1. Resumen del proyecto

**AI Hub** es una aplicación web multiusuario en español (Node.js 22 + Express + TypeScript)
para ver y usar modelos de IA: muestra qué modelos son gratis y cuáles son los más baratos,
y permite chatear con memoria de conversación, leer y editar archivos de un proyecto,
generar imágenes/vídeo y consultar el consumo por modelo.

- **Entrada:** `server.ts` (puerto `3000`, `npm run dev` / `npm start`)
- **Frontend:** `public/` (HTML, CSS y JavaScript sin framework, servido en `/` y `/static/`)
- **Proveedores:** OpenCode, Claude Code, Ollama, OpenRouter (+ proveedores
  personalizados compatibles con OpenAI: OpenAI, Gemini, Groq, DeepSeek, Mistral,
  Together AI, LM Studio…).
- **Categorías:** Programación (chat) e Imagen y vídeo.

## 2. Restricciones técnicas (no romper)

- **Node.js 22+ con TypeScript nativo y Express.** Mantener dependencias mínimas
  (`express`, `cookie-parser`). En imports relativos de archivos `.ts` usar siempre
  extensión `.ts` e `import type` para tipos (compatibilidad con `node server.ts` y `tsx`).
- **Interfaz y mensajes en español.**
- **Puerto y entorno embebido:** el servidor escucha en `0.0.0.0:3000` (o `PORT`).
  No usar `window.alert`, `window.confirm` ni `window.prompt` en el frontend (usar
  los modales propios `confirmModal` y `promptModal`).
- **Contexto de conversación:** los mensajes se construyen con `src/chat.ts`
  (`buildMessages`, `contextNote`). No enviar el historial en bruto ni duplicar el
  mensaje del usuario. El recorte se hace por turnos completos, conserva las
  instrucciones del sistema y nunca parte una llamada a herramientas. El límite se
  toma de `model.context` (o `OLLAMA_CONTEXT` / `DEFAULT_CONTEXT`).
- **Datos y secretos fuera del repositorio:** la configuración, usuarios, historial
  y claves viven en el directorio de datos (`AIHUB_DATA_DIR`, por defecto en
  `os.tmpdir()/aihub-data` o la carpeta local configurada), nunca dentro del repo.
  Nunca commitear `.env`, `config.json`, `users.json` ni `secret.key`.

## 3. Estructura de archivos

| Archivo | Responsabilidad |
| --- | --- |
| `server.ts` | Servidor HTTP/SSE (Express), rutas `/api/*`, estáticos y seguridad |
| `src/types.ts` | **Versión** (`APP_VERSION`) y tipos compartidos |
| `src/catalog.ts` | Modelos, catálogos, precios, relevancia (`relevanceScore`), caché |
| `src/custom.ts` | Proveedores personalizados compatibles con OpenAI y `isFreeModel` |
| `src/api.ts` | Llamadas HTTP, streaming SSE, generación media y traducción de errores |
| `src/chat.ts` | Contexto de conversación: sistema, historial, recorte, avisos y tokens |
| `src/agent.ts` | Bucle de agente con herramientas (listar, leer, escribir y editar archivos) |
| `src/config.ts` | Lectura/escritura de `config.json`, favoritos, historial y rutas |
| `src/projects.ts` | Proyectos, exploración segura de carpetas y lectura de archivos |
| `src/usage.ts` | Consumo diario y total por modelo y reinicio de contadores |
| `src/users.ts` | Cuentas, login (PBKDF2-HMAC-SHA256), sesiones, rate-limit y carpetas por usuario |
| `public/index.html` | Estructura HTML, cabecera con versión dinámica y pantallas de login/app |
| `public/styles.css` | Tema oscuro, layout de tres columnas, modales y responsive móvil |
| `public/app.js` | Lógica cliente, catálogo, chat SSE, Markdown, atajos y modales |
| `scripts/verify.ts` | Comprobación automática (`npm test`): versión, memoria 2 turnos, recorte, relevancia y smoke HTTP |
| `README.md` | Documentación para el usuario final |
| `WEB.md` | Publicación web, Cloudflare Tunnel, seguridad y copias de seguridad |
| `LEEME-MAC.md` | Guía rápida para macOS, Linux y Windows |

---

## 4. Modelo de trabajo (paso a paso)

### 4.1 Antes de empezar
1. Lee este manual y `README.md`.
2. Localiza el archivo responsable del cambio (tabla de la sección 3).
3. Comprueba que la app **no** está a medias de otra tarea.

### 4.2 Actualizar archivos
- Haz **ediciones dirigidas** sobre el archivo correcto; mantén el estilo, los
  nombres y los patrones existentes.
- Textos de UI en español, con el mismo tono que el resto.
- Si tocas una función compartida, revisa sus llamadas (por ejemplo `modelPayload`
  o `priceText` los usan todos los proveedores).
- No reescribas archivos enteros si basta un cambio local.

### 4.3 Verificar (obligatorio)
```bash
# 1) Comprobación de tipos y build
npm run lint
npm run build

# 2) Sintaxis del frontend
node --check public/app.js

# 3) Verificación automática (versión, memoria 2 turnos, recorte, relevancia y smoke HTTP)
npm test
```

> Si tocas el contexto o el chat, verifica además con el servidor reiniciado **dos
> consultas seguidas**: la segunda debe recordar la primera y el indicador de contexto
> en la cabecera debe subir de turnos y mostrar los tokens frente al límite del modelo.

> **Importante:** los cambios en `server.ts` o `src/` requieren **reiniciar el
> servidor** (en `npm run dev`, `tsx watch` recarga automáticamente; en producción
> reinicia `node server.ts`). El botón «Actualizar» de la UI solo vuelve a descargar
> catálogos, no recarga el servidor.

**Si el servidor «no arranca»:**
1. Verifica Node.js (`node -v`, debe ser 22 o superior) y ejecuta `npm install`.
2. Ejecuta `npm run lint` para detectar errores de TypeScript o imports.
3. Comprueba que el puerto `3000` esté libre o define `PORT` antes de arrancar.
4. Verifica que el directorio `AIHUB_DATA_DIR` tenga permisos de escritura.

### 4.4 Cambiar la versión
La versión se mantiene sincronizada en dos sitios (verificados por `npm test`):
- `src/types.ts` → `export const APP_VERSION = "X.Y.Z";`
- `package.json` → `"version": "X.Y.Z"`

Reglas:
- Súbela con **SemVer** (`MAYOR.MENOR.PARCHE`) según la sección 5.
- La app muestra la versión dinámicamente desde `/api/state` y `/api/catalog`
  (`· vX.Y.Z` en la cabecera y pantalla de acceso); no la escribas a mano en el HTML.

### 4.5 Documentación
- Si el cambio altera **lo que ve el usuario** (pasos, botones, requisitos,
  proveedores), actualiza `README.md` (y `WEB.md` / `LEEME-MAC.md` si aplica).
- Si el cambio altera **el proceso de trabajo**, actualiza este manual.
- No uses este manual como changelog.

### 4.6 Subir a GitHub
El repositorio remoto de referencia es:

- **Remoto:** <https://github.com/miguelmarin18630/AI_Hub_Aistudio>
- **Carpeta local (Windows):** `C:\Proyectos\AI_Hub_Aistudio`
- **Puerto y URL pública:** puerto `3000` · `http://ai_hub.marinweb.org` (túnel `ai_hub`)
- **Rama:** `main` (sigue a `origin/main`)

En cada cambio:
```bash
git status                 # revisa qué cambia y que no haya secretos
git add -A
git commit -m "tipo: resumen corto"
git push
```

**`.gitignore` recomendado** (en la raíz del repo):
```gitignore
node_modules/
.env
.env.local
dist/
build/
# Nunca subir configuración local con claves ni sesiones
config.json
cache.json
conversations.json
users.json
secret.key
```

> Las claves **no** están en el repo (viven en `AIHUB_DATA_DIR`). Aun así,
> revisa `git status` antes de cada commit para no colar secretos ni archivos
> temporales.

**Convención de mensajes de commit** (`tipo: resumen`):
- `feat:` nueva funcionalidad
- `fix:` corrección de error
- `docs:` documentación
- `refactor:` reorganización sin cambiar comportamiento
- `chore:` versión, configuración, mantenimiento

---

## 5. Política de versiones (SemVer)

| Cambio | Qué subir | Ejemplo |
| --- | --- | --- |
| Corrección de fallo, sin funcionalidad nueva | **PARCHE** | `1.6.0 → 1.6.1` |
| Funcionalidad nueva compatible | **MENOR** | `1.5.3 → 1.6.0` |
| Cambio incompatible (rompe config/formato) | **MAYOR** | `1.6.0 → 2.0.0` |

Reglas:
- Un commit de trabajo = como mínimo un bump de **PARCHE** si cambia el
  comportamiento.
- La versión se actualiza en `src/types.ts` y `package.json` (`npm test` comprueba
  que coincidan).
- El commit de versión puede ir junto al cambio o aparte (`chore: vX.Y.Z`).

---

## 6. Convenciones de código y UI

- **UI:** tema oscuro (`public/styles.css`); textos en español; el panel central de
  chat es el más grande; la columna izquierda es estrecha y plegable; en móvil pasa
  a cajones laterales.
- **Contexto visible:** la cabecera del chat muestra turnos y tokens aproximados
  usados frente al límite del modelo (`~X de Y tokens`); al recortar se emite un
  evento SSE `system` que avisa en la conversación.
- **Orden de modelos:** primero los gratuitos ordenados por relevancia
  (`relevance_score` en `src/catalog.ts`), después los de pago de menor a mayor precio.
- **Errores:** traducirlos a mensajes claros (ver `errorMessage` en `src/api.ts`);
  no mostrar trazas internas al usuario final.
- **Clasificación gratis/pago:** `isFreeModel()` en `src/custom.ts` decide por
  nombre de modelo y proveedor. Si añades un proveedor, añade su regla ahí.
- **Archivos del proyecto:** el agente (`src/agent.ts`) solo lee/escribe dentro del
  proyecto seleccionado y nunca modifica `.git`.
- **Modales:** usar `openModal`, `confirmModal` y `promptModal` en `public/app.js`;
  nunca cuadros nativos del navegador (`alert`, `confirm`, `prompt`).

---

## 7. Referencia rápida: gratis vs. pago

`src/custom.ts` (`isFreeModel`) marca gratuitos por patrón. Situación actual:

| Proveedor | Gratis | Notas |
| --- | --- | --- |
| OpenAI | — | API de pago (requiere saldo) |
| Google Gemini | `flash`, `preview` | cuota diaria gratuita |
| DeepSeek | `-code`, `-coder`, `-distill` | nivel gratuito de código |
| Groq | — | sin nivel gratuito de chat |
| Mistral | `-instruct`, `-small`, `-v0.1` | prueba/ligero |
| Together AI | — | de pago |
| Perplexity | — | de pago (búsqueda aumentada) |
| Fireworks AI | `free`, `:free` | según modelo |
| xAI (Grok) | — | de pago |
| Cerebras | `free`, `:free` | cuota gratuita según modelo |
| SambaNova | `free`, `:free` | cuota gratuita según modelo |
| Hugging Face | `free`, `:free` | inferencia gratuita limitada |
| Novita AI | `free`, `:free` | según modelo |
| SiliconFlow | `free`, `:free` | modelos gratuitos marcados |
| Hyperbolic | `free`, `:free` | según modelo |
| Cohere | `trial`, `free` | nivel de prueba |
| Alibaba (Qwen) | `free`, `:free` | según modelo |
| Moonshot (Kimi) | `free`, `:free` | según modelo |
| MiniMax | `free`, `:free` | según modelo |

Recuerda: si un modelo de pago da error 429, `errorMessage()` en `src/api.ts`
distingue «sin saldo/créditos» de «límite de peticiones».

---

## 8. Checklist «definición de terminado»

Antes de dar una tarea por acabada:

- [ ] `npm run lint` y `npm run build` sin errores.
- [ ] `node --check public/app.js` sin errores.
- [ ] `npm test` en verde (versión sincronizada, memoria 2 turnos, recorte, relevancia y smoke HTTP).
- [ ] Dos consultas seguidas recuerdan la anterior si tocas `src/chat.ts` o `/api/chat`.
- [ ] Probado con el servidor **reiniciado** (no solo pulsando «Actualizar»).
- [ ] Versión subida en `src/types.ts` y `package.json` si cambia el comportamiento.
- [ ] `README.md` (y `WEB.md` / `LEEME-MAC.md` si aplica) actualizados si cambia lo que ve el usuario.
- [ ] Este manual actualizado **solo** si cambia el proceso.
- [ ] `git status` limpio de secretos/temporales; commit y `push`.

---

## 9. Limitaciones conocidas

- Los tokens del indicador de contexto son una estimación (≈4 caracteres/token);
  el gasto real lo marca la cuenta del proveedor.
- Los modelos locales (Ollama) usan 8K de contexto por defecto si el catálogo no
  informa de otra ventana.
- Imágenes y vídeo en OpenRouter requieren saldo; el chat gratuito sigue funcionando.
- Los modelos sin soporte de herramientas caen a chat plano cuando se desactiva o no
  está disponible el modo agente.
- La descarga de catálogos en vivo necesita conexión a internet (y Ollama en marcha
  para detectar modelos locales).
