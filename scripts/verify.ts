import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as access from "../src/access.ts";
import * as catalog from "../src/catalog.ts";
import * as chat from "../src/chat.ts";
import * as custom from "../src/custom.ts";
import * as github from "../src/github.ts";
import * as githubSync from "../src/sync.ts";
import { APP_VERSION } from "../src/types.ts";
import type { ChatMessage, ModelData } from "../src/types.ts";

function checkVersion(): void {
  const pkgPath = path.resolve(process.cwd(), "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
  assert.equal(pkg.version, APP_VERSION, "package.json version must match APP_VERSION in src/types.ts");
  console.log(`✓ Versión sincronizada: v${APP_VERSION}`);
}

function checkTwoTurnMemory(): void {
  const history: ChatMessage[] = [
    { role: "user", content: "Me llamo Miguel y estoy trabajando en AI Hub." },
    { role: "assistant", content: "Hola Miguel, perfecto. ¿En qué te ayudo con AI Hub?" },
    { role: "user", content: "¿Recuerdas cómo me llamo y en qué proyecto estoy?" },
  ];
  const { messages, info } = chat.buildMessages(history, { limit: 32_768 });
  assert.equal(info.turns, 2, "Debe contabilizar 2 turnos");
  assert.equal(info.dropped, 0, "No debe recortar turnos cuando hay espacio");
  assert.equal(messages[0]?.role, "system", "Debe anteponer el prompt del sistema");
  assert.equal(messages.length, 4, "Debe incluir system + 3 mensajes de historial");
  assert.ok(
    String(messages[1]?.content).includes("Miguel"),
    "El primer turno debe conservarse en el contexto del segundo turno"
  );
  assert.equal(chat.contextNote(info), "", "Sin recorte no debe generar aviso");
  console.log("✓ Memoria de conversación (2 turnos) OK");
}

function checkContextTrimming(): void {
  const longBlock = "bloque de código de ejemplo ".repeat(120);
  const history: ChatMessage[] = [
    { role: "user", content: "Turno 1: " + longBlock },
    { role: "assistant", content: "Respuesta 1: " + longBlock },
    { role: "user", content: "Turno 2: " + longBlock },
    { role: "assistant", content: "Respuesta 2: " + longBlock },
    { role: "user", content: "Turno 3: pregunta final corta" },
  ];
  const { messages, info } = chat.buildMessages(history, { limit: 2_048, reserve: 512 });
  assert.equal(info.turns, 3, "Debe contar los 3 turnos totales");
  assert.ok(info.dropped > 0, "Debe recortar turnos antiguos al superar la ventana");
  assert.equal(messages[0]?.role, "system", "El prompt del sistema siempre se conserva");
  assert.equal(messages[messages.length - 1]?.content, "Turno 3: pregunta final corta");
  const note = chat.contextNote(info);
  assert.ok(note.includes("Contexto:"), "Debe emitir aviso en español al recortar");
  console.log(`✓ Recorte de contexto OK (${note})`);
}

function checkCatalogRelevanceAndPayload(): void {
  const strongFree: ModelData = {
    provider: "openrouter",
    uid: "qwen/qwen3-coder:free",
    name: "Qwen3 Coder 70B",
    category: "code",
    p_in: 0,
    p_out: 0,
    price: 0,
    unit: "1M tokens",
    free: true,
    context: 131_072,
    tags: ["herramientas", "visión", "razonamiento"],
    desc: "Modelo gratuito avanzado de programación.",
    extra: {},
  };
  const routerFree: ModelData = {
    provider: "openrouter",
    uid: "openrouter/auto:free",
    name: "Auto Router",
    category: "code",
    p_in: 0,
    p_out: 0,
    price: 0,
    unit: "1M tokens",
    free: true,
    context: 8_192,
    tags: [],
    desc: "Enrutador genérico.",
    extra: {},
  };
  const strongScore = catalog.relevanceScore(strongFree);
  const routerScore = catalog.relevanceScore(routerFree);
  assert.ok(
    strongScore > routerScore,
    `Modelo capaz (${strongScore}) debe puntuar por encima de un router (${routerScore})`
  );
  const payload = catalog.modelPayload(strongFree);
  assert.equal(payload.relevance_score, strongScore);
  assert.equal(payload.price_text, "Gratis");
  assert.equal(payload.group, "code");
  assert.equal(payload.group_label, "Programación");
  // Check tag deduplication (no repeated Razonamiento or Gratis/free)
  const reasoningModel: ModelData = {
    ...strongFree,
    uid: "deepseek/deepseek-r1:free",
    name: "DeepSeek R1",
    tags: ["gratis", "free", "razonamiento", "Razonamiento", "herramientas"],
  };
  const rPayload = catalog.modelPayload(reasoningModel);
  assert.equal(rPayload.group, "reasoning");
  assert.ok(!rPayload.tags.some((t) => /gratis|free|razonamiento/i.test(t)), "No debe repetir Razonamiento ni Gratis en tags");
  // Check custom_ollama downloadable marker
  const ollamaDown: ModelData = {
    provider: "custom_ollama",
    uid: "qwen3:8b",
    name: "qwen3:8b",
    category: "code",
    free: true,
    p_in: 0,
    p_out: 0,
    price: 0,
    unit: "local",
    context: null,
    desc: "Modelo local.",
    tags: ["local", "requiere descarga"],
    extra: { installed: false, downloadable: true },
  };
  const oPayload = catalog.modelPayload(ollamaDown);
  assert.ok(oPayload.info_text.includes("Requiere descarga"), "Debe marcar modelos Ollama no instalados como Requiere descarga");
  assert.ok(oPayload.price_detail.includes("Local y gratis"), "Debe reconocer custom_ollama en price_detail");
  console.log(`✓ Relevancia, etiquetas sin duplicados y marcador descargable OK (${strongScore} > ${routerScore})`);
}

function checkModelGroups(): void {
  const mk = (partial: Partial<ModelData>): ModelData => ({
    provider: "openrouter",
    uid: "vendor/model",
    name: "Model",
    category: "code",
    free: true,
    p_in: 0,
    p_out: 0,
    price: 0,
    unit: "1M tokens",
    context: 32_768,
    desc: "",
    tags: [],
    extra: {},
    ...partial,
  });
  assert.equal(catalog.classifyGroup(mk({ uid: "qwen/qwen2.5-coder:free", name: "Qwen Coder" })), "code");
  assert.equal(catalog.classifyGroup(mk({ provider: "claude", uid: "sonnet", name: "Claude Sonnet" })), "code");
  assert.equal(catalog.classifyGroup(mk({ uid: "deepseek/deepseek-r1:free", name: "DeepSeek R1", tags: ["razonamiento"] })), "reasoning");
  assert.equal(catalog.classifyGroup(mk({ uid: "meta/llama-vision:free", name: "Llama Vision", tags: ["visión"] })), "vision");
  assert.equal(catalog.classifyGroup(mk({ uid: "meta/llama-3.3-70b:free", name: "Llama 3.3 70B" })), "chat");
  assert.equal(catalog.classifyGroup(mk({ category: "image", uid: "black-forest/flux", name: "Flux" })), "image");
  assert.equal(catalog.classifyGroup(mk({ category: "video", uid: "google/veo", name: "Veo" })), "video");
  console.log("✓ Clasificación en 6 grupos de modelos OK");
}

function checkPwaCompliance(): void {
  const pubDir = path.resolve(process.cwd(), "public");
  const manifestPath = path.join(pubDir, "manifest.json");
  assert.ok(fs.existsSync(manifestPath), "Falta public/manifest.json");
  assert.ok(fs.existsSync(path.join(pubDir, "sw.js")), "Falta public/sw.js");
  assert.ok(fs.existsSync(path.join(pubDir, "apple-touch-icon.png")), "Falta public/apple-touch-icon.png");

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    id?: string;
    name?: string;
    short_name?: string;
    start_url?: string;
    scope?: string;
    display?: string;
    icons?: Array<{ src: string; sizes: string; purpose?: string }>;
  };
  assert.equal(manifest.id, "/");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");
  assert.ok(manifest.short_name && manifest.short_name.length <= 12, "short_name debe tener ≤ 12 caracteres");
  const icons = manifest.icons || [];
  assert.ok(icons.some((i) => i.sizes === "192x192" && i.purpose === "any"), "Falta icono 192x192");
  assert.ok(icons.some((i) => i.sizes === "512x512" && i.purpose === "any"), "Falta icono 512x512");
  assert.ok(icons.some((i) => i.sizes === "512x512" && i.purpose === "maskable"), "Falta icono maskable 512x512");
  for (const icon of icons) {
    const file = path.join(pubDir, icon.src.replace(/^\//, ""));
    assert.ok(fs.existsSync(file), `Falta archivo de icono ${icon.src}`);
  }
  console.log("✓ Manifiesto PWA, Service Worker e iconos OK");
}

function checkFreeModelRules(): void {
  assert.equal(custom.isFreeModel("gemini-2.5-flash"), true);
  assert.equal(custom.isFreeModel("gpt-4o"), false);
  assert.equal(custom.isFreeModel("deepseek-coder"), true);
  assert.equal(custom.isFreeModel("mistral-small-latest"), true);
  assert.equal(custom.isFreeModel("llama-3.3-70b-versatile"), false);
  console.log("✓ Reglas de clasificación gratis/pago OK");
}

function checkNoBuiltInProviders(): void {
  assert.equal(
    catalog.BASE_PROVIDERS.length,
    0,
    "No debe haber proveedores integrados por defecto (Ollama, OpenCode y OpenRouter son proveedores añadidos)"
  );
  const presetIds = new Set(custom.PRESETS.map((p) => p.id));
  for (const id of ["openrouter", "ollama", "opencode"]) {
    assert.ok(presetIds.has(id), `Falta el preset '${id}' en custom.PRESETS`);
  }
  console.log("✓ Sin proveedores integrados (OpenRouter, Ollama y OpenCode como proveedores añadidos) OK");
}

function checkStartupScripts(): void {
  const root = process.cwd();
  for (const file of [
    "Iniciar_Todo.bat",
    "Iniciar_Todo.vbs",
    "Instalar_Inicio_Windows.bat",
    "Instalar_AutoSync_GitHub.bat",
    "Actualizar_Desde_GitHub.bat",
    "Actualizar_Desde_GitHub.vbs",
    "Iniciar_Web.bat",
    "Iniciar_Web.vbs",
    "Iniciar_Tunel.bat",
    "Iniciar_Tunel.vbs",
    "Iniciar_Web.command",
  ]) {
    assert.ok(fs.existsSync(path.join(root, file)), `Falta lanzador de arranque ${file}`);
  }
  console.log("✓ Lanzadores de arranque (Web + Túnel) OK");
}

function checkAccessCodes(): void {
  const created = access.createAccessCode({
    label: "Test Invitado",
    maxUses: 1,
    expiresDays: 7,
    bootstrapPack: {
      openrouter_api_key: "sk-or-test-dedicated-key",
      custom_providers: [
        {
          id: "groq",
          name: "Groq",
          base: "https://api.groq.com/openai/v1",
          key: "",
          glyph: "⚡",
          color: "#f97316",
          categories: ["code"],
        },
      ],
    },
  });
  try {
    assert.ok(created.code.startsWith("AH-"), "El código debe empezar por AH-");
    assert.equal(created.record.has_pack, true, "Debe incluir el paquete inicial");
    assert.equal(created.record.pack_providers, 1);

    const redeemed = access.redeemCode(created.code);
    assert.ok(redeemed, "El canje del código válido debe funcionar");
    assert.equal(redeemed.user.name, "Test Invitado");
    assert.equal(redeemed.bootstrapPack?.openrouter_api_key, "sk-or-test-dedicated-key");
    assert.equal(redeemed.bootstrapPack?.custom_providers?.length, 1);

    // Session must be valid immediately after redeem
    const validSession = access.isCodeSessionValid(redeemed.subjectId, redeemed.tokenVersion);
    assert.ok(validSession, "La sesión emitida debe ser válida");

    // Bootstrap pack must be wiped from disk once single-use code is exhausted
    const afterRedeem = access.getCodeRecord(created.record.id);
    assert.equal(afterRedeem?.bootstrap_pack, null, "El paquete inicial debe borrarse tras agotar usos");

    // Second redeem must throw because maxUses = 1
    assert.throws(() => access.redeemCode(created.code), /límite de usos/i);

    // Revoking must immediately invalidate the active session
    access.revokeAccessCode(created.record.id);
    const revokedSession = access.isCodeSessionValid(redeemed.subjectId, redeemed.tokenVersion);
    assert.equal(revokedSession, null, "Revocar debe invalidar la sesión al instante");
    console.log("✓ Códigos de acceso revocables y paquete de proveedores OK");
  } finally {
    try {
      access.deleteAccessCode(created.record.id);
    } catch {
      /* ignore cleanup error */
    }
  }
}

async function checkLiveServer(): Promise<void> {
  const port = process.env.PORT || "3000";
  const base = `http://127.0.0.1:${port}`;
  const url = `${base}/api/state`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    assert.equal(res.status, 200, `GET ${url} devolvió ${res.status}`);
    const data = (await res.json()) as { version?: string; setup_required?: boolean };
    assert.equal(data.version, APP_VERSION, `Versión en vivo (${data.version}) != ${APP_VERSION}`);

    const manRes = await fetch(`${base}/manifest.json`, { signal: AbortSignal.timeout(2_000) });
    assert.equal(manRes.status, 200, "GET /manifest.json debe devolver 200");
    const swRes = await fetch(`${base}/sw.js`, { signal: AbortSignal.timeout(2_000) });
    assert.equal(swRes.status, 200, "GET /sw.js debe devolver 200");
    console.log(`✓ Smoke HTTP y PWA en vivo OK (${url} → v${data.version})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/fetch failed|ECONNREFUSED|timeout/i.test(msg)) {
      console.log(`• Smoke HTTP omitido (servidor no activo en ${url})`);
      return;
    }
    throw err;
  }
}

function checkGithubSyncModule(): void {
  // Robocopy exit codes 0..7 indicate success; >= 8 indicate error
  for (let c = 0; c <= 7; c++) {
    assert.equal(githubSync.isRobocopySuccess(c), true, `Robocopy código ${c} debe ser éxito`);
  }
  assert.equal(githubSync.isRobocopySuccess(8), false, "Robocopy código 8 debe ser error");
  assert.equal(githubSync.isRobocopySuccess(16), false, "Robocopy código 16 debe ser error");
  assert.equal(githubSync.isRobocopySuccess(-1), false);

  // Robocopy args must target the Windows path and exclude sensitive files/dirs
  const roboArgs = githubSync.buildRobocopyArgs("C:\\staging", githubSync.DEFAULT_WINDOWS_TARGET);
  assert.equal(roboArgs[1], "C:\\Proyectos\\AI_Hub_Aistudio");
  assert.ok(roboArgs.includes("/MIR"), "Debe usar /MIR en robocopy");
  assert.ok(roboArgs.includes("/XD") && roboArgs.includes(".git") && roboArgs.includes("node_modules"));
  assert.ok(roboArgs.includes("/XF") && roboArgs.includes(".env") && roboArgs.includes("vault.json"));

  // Rsync args must preserve trailing slashes and exclusions
  const rsyncArgs = githubSync.buildRsyncArgs("/tmp/src", "/tmp/dst");
  assert.ok(rsyncArgs.includes("-a") && rsyncArgs.includes("--delete"));
  assert.ok(rsyncArgs.includes(".env") && rsyncArgs.includes(".git/"));
  assert.equal(rsyncArgs[rsyncArgs.length - 2], "/tmp/src/");
  assert.equal(rsyncArgs[rsyncArgs.length - 1], "/tmp/dst/");

  // HMAC-SHA256 webhook verification
  const payload = Buffer.from('{"ref":"refs/heads/main"}', "utf8");
  const secret = "test-webhook-secret-123";
  const goodSig = "sha256=" + crypto.createHmac("sha256", secret).update(payload).digest("hex");
  assert.equal(githubSync.verifyGithubSignature(payload, goodSig, secret), true, "Firma HMAC válida debe pasar");
  assert.equal(githubSync.verifyGithubSignature(payload, "sha256=" + "0".repeat(64), secret), false, "Firma distinta debe fallar");
  assert.equal(githubSync.verifyGithubSignature(payload, goodSig, ""), false, "Sin secreto debe fallar");
  assert.equal(githubSync.verifyGithubSignature(Buffer.from('{"ref":"other"}'), goodSig, secret), false, "Payload alterado debe fallar");
  console.log("✓ Módulo de sincronización GitHub → robocopy/rsync + HMAC OK");
}

function checkProjectRepoModule(): void {
  // Nombres de repositorio válidos a partir del nombre del proyecto
  assert.equal(github.sanitizeRepoName("Mi Proyecto Ñandú"), "Mi-Proyecto-Nandu");
  assert.equal(github.sanitizeRepoName("  app   web  "), "app-web");
  assert.equal(github.sanitizeRepoName(""), "proyecto");
  assert.equal(github.sanitizeRepoName("  "), "proyecto");
  assert.equal(github.sanitizeRepoName("proyecto/con:raros*"), "proyecto-con-raros");

  // URL pública del repositorio
  assert.equal(
    github.repoWebUrl("miguelmarin18630", "Mi-Proyecto.git"),
    "https://github.com/miguelmarin18630/Mi-Proyecto"
  );
  assert.equal(github.repoWebUrl("", "Mi-Proyecto"), "");

  // Los tokens nunca deben aparecer en los mensajes de error
  const leak =
    "fatal: unable to access 'https://x-access-token:ghp_1234567890abcdef@github.com/miguelmarin18630/x.git/'";
  const safe = github.redactSecrets(leak);
  assert.ok(!safe.includes("ghp_1234567890abcdef"), "El token debe quedar oculto");
  assert.ok(!safe.includes("x-access-token:ghp_"), "La URL con token debe quedar oculta");

  // Mensajes de error en español según el código de GitHub
  assert.ok(github.describeGithubError(403, "").includes("repo"));
  assert.ok(github.describeGithubError(401, "").includes("credenciales"));
  console.log("✓ Módulo de repositorios GitHub (nombre, URL y secretos) OK");
}

async function main(): Promise<void> {
  checkVersion();
  checkTwoTurnMemory();
  checkContextTrimming();
  checkCatalogRelevanceAndPayload();
  checkModelGroups();
  checkPwaCompliance();
  checkFreeModelRules();
  checkNoBuiltInProviders();
  checkStartupScripts();
  checkAccessCodes();
  checkGithubSyncModule();
  checkProjectRepoModule();
  await checkLiveServer();
  console.log("Verificación AI Hub OK");
}

main().catch((err) => {
  console.error("Error en verificación:", err);
  process.exit(1);
});
