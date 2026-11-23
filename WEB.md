# AI Hub Web · despliegue y uso multiusuario

AI Hub funciona como aplicación web multiusuario en el navegador para que varias
personas (por ejemplo, tu familia o equipo) usen modelos de IA, cada una con su
propia cuenta, claves, proveedores, historial y proyectos.

## 1. Arrancar en tu servidor u ordenador

Requisitos: **Node.js 22 o superior**.

- **Repositorio GitHub:** <https://github.com/miguelmarin18630/AI_Hub_Aistudio>
- **Carpeta local (Windows):** `C:\Proyectos\AI_Hub_Aistudio`
- **Windows (arranque rápido):** haz doble clic en **`Iniciar_Web.bat`** (con ventana de consola) o **`Iniciar_Web.vbs`** (en segundo plano). Arranca en el puerto `3000` (listo para el túnel `aistudio` hacia `aistudio.marinweb.org`) usando `%APPDATA%\AIHub_Aistudio` para los códigos de acceso del servidor e instala las dependencias automáticamente si es la primera vez.
- **macOS / Linux:** ejecuta `./Iniciar_Web.command` (o `npm install && npm start`, puerto `3000` por defecto).

En desarrollo (con recarga automática):

```bash
npm run dev
```

Abre `http://127.0.0.1:3000` en el navegador. La primera vez te pedirá crear tu **código maestro de administrador** (o puedes definir `AIHUB_ADMIN_CODE` en las variables de entorno).

## 2. Códigos de acceso personales y datos en el disco duro de cada usuario

El administrador entra en **🔑 Accesos** (o **⚙ Ajustes → Códigos de acceso**) y genera un **código personal de invitación** (`AH-XXXXXX-XXXX-XXXX`) para cada persona autorizada:

- **Sin usuario ni contraseña:** la persona solo pega su código personal una vez y entra directamente.
- **Control total:** puedes elegir cuántos dispositivos/usos permite (por defecto **1 dispositivo / un solo uso**), fecha de caducidad opcional y **revocar** su acceso al instante (su sesión se invalida en la siguiente petición).
- **Mismos proveedores y claves opcionales por persona:** al crear un código puedes marcar **«Incluir mi lista de proveedores»** para que la otra persona vea los mismos proveedores y modelos desde el primer segundo (sin copiar tus claves privadas), y opcionalmente pegar claves API dedicadas para esa persona que se transfieren una sola vez a su disco duro y luego se borran del servidor.

**Todos los datos personales de cada usuario se guardan únicamente en su propio
disco duro** (nunca en el servidor central):

- su clave de OpenRouter y las claves de sus proveedores propios;
- la caché de modelos descargados y sus favoritos;
- todo su historial de conversaciones;
- sus estadísticas de consumo por modelo.

Los datos se guardan automáticamente en el equipo de cada persona (IndexedDB) y,
en Chrome/Edge de escritorio, desde **⚙ Ajustes → Mis datos (Disco duro local)**
se puede pulsar **📁 Vincular archivo en mi disco** para sincronizarlos en tiempo
real con un archivo `aihub-datos-<usuario>.json` en la carpeta que elija, o usar
**⬇ Exportar copia (.json)** / **⬆ Importar copia (.json)** para llevarlos a
cualquier otro ordenador o móvil.

Si ya tenías claves, proveedores o historial guardados en el servidor de una
versión anterior, al iniciar sesión se importan automáticamente a tu disco duro
local y aparece el botón **🗑 Borrar copia antigua del servidor**.

### Uso desde el móvil e instalación como PWA

AI Hub funciona como **Progressive Web App (PWA)** instalable en ordenadores y móviles:

- En **Windows, macOS y Android** (Chrome / Edge), pulsa **⬇ Instalar** en la cabecera (o en el menú **⋯**) para instalarla en ventana propia con su icono.
- En **iPhone / iPad** (Safari), el botón **⬇ Instalar app** abre una guía para pulsar **Compartir → Añadir a pantalla de inicio**.
- En móvil la barra superior se reduce a **☰ Modelos** y al menú **⋯**, y los paneles se abren como cajones laterales.
- Si se pierde la conexión, aparece un aviso discreto en la esquina inferior izquierda y el Service Worker mantiene disponible la interfaz en caché.

## 3. Publicar en aistudio.marinweb.org (Cloudflare Tunnel)

El servidor escucha por defecto en el puerto `3000` (configurable con `PORT`).

- **Windows (arranque rápido conjunto):** desde `C:\Proyectos\AI_Hub_Aistudio`, haz doble clic en **`Iniciar_Todo.bat`** (o **`Iniciar_Todo.vbs`** en segundo plano) para arrancar a la vez `Iniciar_Web.bat` (puerto `3000`) y `Iniciar_Tunel.bat` (túnel `aistudio`). También puedes lanzar solo el túnel con **`Iniciar_Tunel.bat`** / **`Iniciar_Tunel.vbs`**.

Si lo configuras desde cero:

1. Instala `cloudflared` (<https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/>).
2. Inicia sesión: `cloudflared tunnel login`
3. Crea el túnel: `cloudflared tunnel create aistudio`
4. Asocia el dominio: `cloudflared tunnel route dns aistudio aistudio.marinweb.org`
5. Arranca todo (`Iniciar_Todo.bat` / `Iniciar_Todo.vbs`).

Cuando el tráfico entra por HTTPS (a través de Cloudflare), las cookies de sesión se emiten automáticamente con `HttpOnly` y `Secure`.

## 4. Seguridad

- Las claves de API, proveedores propios e historial de cada usuario viven únicamente en su propio disco duro; el servidor actúa como proxy sin almacenar esos datos.
- Los códigos de acceso personales se guardan en el servidor como hash **scrypt** con sal aleatoria (nunca en texto plano) y pueden revocarse al instante.
- Las contraseñas clásicas (opcionales) usan **PBKDF2-HMAC-SHA256** (260 000 iteraciones y sal aleatoria).
- El canje de códigos y el inicio de sesión aplican límite de intentos fallidos por IP.
- No publiques el servidor directamente en internet sin HTTPS.

## 5. Copias de seguridad

- **Cada usuario:** puede vincular un archivo `.json` en su disco duro o pulsar **⬇ Exportar copia (.json)** en **⚙ Ajustes**.
- **Servidor (cuentas de acceso):** copia la carpeta persistente configurada en `AIHUB_DATA_DIR` (por defecto `%APPDATA%\AIHub` en Windows o `~/Library/Application Support/AIHub` en macOS). Nunca la incluyas dentro del repositorio Git.
