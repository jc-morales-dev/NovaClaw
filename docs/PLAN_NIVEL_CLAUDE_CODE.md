# NovaClaw → nivel Claude Code (fortaleciendo el agente propio)

> Fecha: 11 de julio de 2026
> Autor del análisis: Claude (para Julio)
> Decisión de Julio: **camino "fortalecer mi propio agente"** (no incrustar Claude Code/OpenCode; hacer que el agente TypeScript de NovaClaw sea tan bueno solo).
> Fuente: auditoría del código real (`src/agent/nativeAgent.ts`, `modelClient.ts`, `tools.ts`, `toolShared.ts`, `toolSchemas.ts`, `diagnostics.ts`, `safety.ts`).

---

## 0. TL;DR (lo esencial)

- Con el **mismo modelo** (Opus 4.8), la diferencia entre agentes NO está en el cerebro: está en el **arnés** (qué tools tiene, cómo maneja el contexto, cómo verifica, cómo se recupera de errores).
- Tu agente ya cubre **~80%** de lo que hace bueno a Claude Code: function-calling nativo, thinking, edición quirúrgica, grep, paralelismo, compactación, subagentes, plan/build, undo, MCP, memoria de proyecto, guardrails anti-loop, diagnósticos reales.
- Lo que falta son **~10 piezas finas pero de alto impacto**. Ninguna es una montaña.
- **La brecha nº1 no es una tool nueva: es prompt caching + reintentos** (barato de hacer, enorme en costo/velocidad/robustez, sobre todo en red de celular).
- Plan realista: **2–3 semanas** para cerrar las brechas de resultado (Nivel 1 y 2). El Nivel 3 es percepción y se puede dejar para el final.

---

## Estado de implementación (11/jul — sesión autónoma)

**Hecho, verificado (tsc + tests + build) y respaldado en GitHub:**

| Ítem | Qué | Commit |
|---|---|---|
| ✅ B1 | Prompt caching (Anthropic: system+historial; OpenAI cachea solo) | d56198d |
| ✅ B2 | Reintentos con backoff (429/5xx/red, respeta Retry-After) | d56198d |
| ✅ Fix | Adaptive thinking para Opus 4.8 (antes daba 400 → corría sin pensar) | d56198d |
| ✅ B5 | Multi-edit atómico (`file_edit_multi`) | d56198d |
| ✅ B3 | Verificación obligatoria (empuja a diagnostics/ejecutar antes de cerrar) | c30e912 |
| ✅ B4 | Compactación fina (preserva rutas/comandos/plan, 1024→2048) | c30e912 |
| ✅ B8 | Subagentes en paralelo (fan-out) | a4b9b2a |
| ✅ B9 | Compactación por presupuesto de tokens (~100k) | fa6530f |
| ✅ B11 | Prompt reforzado (paralelo + multi-edit) | 5230a71 |
| ✅ B6 | Skills on-demand (`skills/<nombre>/SKILL.md` → índice al prompt) | 24d16c2 |
| ✅ B7 | Hooks PostToolUse (`novaclaw.hooks.json` → formatear/lint tras editar) | 24d16c2 |

**Pendiente (1 solo, a propósito):**

- ⏳ **B10 Streaming token-por-token** — toca modelClient (stream:true) + SSE del server + UI; **necesita prueba en el teléfono** (riesgo de romper la pantalla del chat), mejor hacerlo con Julio presente.

**APK LISTO PARA INSTALAR:** `android-native/app/build/outputs/apk/arm64/debug/app-arm64-debug.apk` (39 MB) compilado con TODOS estos cambios y verificado (los marcadores fetchWithRetry/adaptive/hooks/skills/multi-edit están en el `agent.cjs` empaquetado). Un vigilante en segundo plano lo instala solo (`adb install -r`, mantiene datos) apenas el OPPO se reconecte.

**Resumen honesto:** cerrados **10 de 11 ítems** del plan (todo Nivel 1 y 2 + la mayoría del 3) + el fix crítico de thinking. Solo queda **B10** (percepción, no resultado bruto) para validar la UI en el teléfono con Julio.

---

---

## 1. Qué YA está a la par de Claude Code (NO reinventar)

| Capacidad | Estado en NovaClaw |
|---|---|
| Function-calling nativo (OpenAI + Anthropic) | ✅ `modelClient.ts` |
| Extended + interleaved thinking (Claude) | ✅ budget 4096, rawContent preservado |
| Edición quirúrgica `old→new` con validaciones | ✅ `applyStringEdit` (estilo Claude Code) |
| `file_read` con nº de línea + offset/limit + cap 256 KB | ✅ `formatWithLineNumbers` |
| `file_grep` / `file_search` / `file_list` | ✅ |
| Paralelismo de tools de solo-lectura | ✅ `READ_ONLY_TOOLS` + Promise.all |
| Compactación de contexto con resumen del modelo | ✅ `compactWithSummary` |
| Subagentes con contexto limpio | ✅ `subagent_run` |
| Plan visible (todo list) | ✅ `todo_write` |
| Modos Plan / Build | ✅ |
| Deshacer (undo) | ✅ journal de cambios |
| Streaming de eventos (SSE) | ✅ tool calls + respuesta en vivo |
| MCP (stdio + HTTP + OAuth device flow) | ✅ |
| Memoria de proyecto (NOVACLAW.md ≈ CLAUDE.md) | ✅ inyectada al system prompt |
| Guardrails: anti-loop, tool alucinada, aviso de presupuesto | ✅ nivel harness |
| Seguridad allowlist default-deny | ✅ `safety.ts` |
| Diagnósticos reales (tsc/ruff/eslint/go vet/node --check/JSON) | ✅ `diagnostics.ts` |
| Visión (ver imágenes/fotos/screenshots) | ✅ `image_view` — **Claude Code NO tiene esto** |

**Conclusión:** el andamiaje está. No hay que empezar de cero; hay que **pulir los bordes** que separan "muy bueno" de "nivel Claude Code".

---

## 2. Las brechas reales, priorizadas por impacto en el RESULTADO

### 🔴 Nivel 1 — Alto impacto (esto mueve la aguja de verdad)

**B1. Prompt caching (`cache_control`) — HOY NO EXISTE.**
`modelClient.ts` arma el body de Anthropic sin `cache_control`. Agregarlo (marcar el system prompt + el historial estable como cacheable):
- Abarata **5–10×** los tokens repetidos (system prompt + contexto se re-cobran cada turno hoy).
- Baja mucho la **latencia** por turno.
- Para BYOK económico como el tuyo, es lo que permite **más iteraciones por el mismo dinero** → mejores resultados sin gastar más.
- **Dónde:** `modelClient.ts` (rama Anthropic: `cache_control: {type:'ephemeral'}` en el último bloque de system y en el último tool result; header `anthropic-beta` si hace falta).
- **Costo:** bajo (1–2 días). **Impacto:** altísimo.

**B2. Reintentos automáticos con backoff en errores transitorios.**
Hoy un `429` (rate limit), `500`, o un corte de red mata el turno entero con `friendlyModelError`. En **red de celular flaky** (tu caso real, disco E y WiFi incluidos) esto es la diferencia entre "terminó la tarea" y "se cortó a la mitad".
- **Dónde:** `callModelWithTools` en `modelClient.ts` — envolver el `fetch` en un retry con backoff exponencial (3–4 intentos) SOLO para 429/500/502/503/timeout, respetando `Retry-After`. No reintentar en 401/400.
- **Costo:** bajo (1 día). **Impacto:** alto (robustez móvil).

**B3. Verificación obligatoria de "cerrar el loop".**
El agente PUEDE correr `diagnostics` y ejecutar código, pero no hay disciplina fuerte de *no declarar "listo" sin haberlo verificado ejecutando*. Claude Code tiene el patrón `/verify` (ejercer el cambio de punta a punta).
- **Dónde:** (a) system prompt — regla dura: "tras editar código, SIEMPRE `diagnostics` + correr (test/script) antes de responder; si no verificaste, decilo". (b) harness — un chequeo suave que, si el turno editó un archivo de código y nunca llamó `diagnostics`/`terminal_run` de verificación, inyecta un recordatorio antes de cerrar.
- **Costo:** medio (2–3 días). **Impacto:** alto (sube la tasa de "código que realmente funciona").

**B4. Compactación de contexto más fina.**
La actual: umbral 44 entradas, resumen de 1024 tokens, deja las últimas 16. En sesiones largas de código pierde el hilo antes que Claude Code.
- **Mejoras:** (a) el resumen debe **preservar explícitamente** archivos creados/editados con sus rutas, comandos corridos y sus resultados clave, y el plan (todo list) vigente; (b) subir el presupuesto del resumen (1024→2048) y no colapsar tool results MUY recientes; (c) preservar los `file_edit` hechos como "estado" durable.
- **Dónde:** `compactWithSummary` en `nativeAgent.ts`.
- **Costo:** medio (2 días). **Impacto:** medio-alto (tareas grandes).

### 🟡 Nivel 2 — Impacto medio (capacidad y robustez)

**B5. `file_edit` múltiple atómico (multi-edit).**
Varios `old→new` en un archivo en UNA llamada, todo-o-nada. Reduce vueltas y evita estados intermedios rotos.
- **Dónde:** nueva tool `file_edit_multi` en `toolSchemas.ts` + lógica en `toolShared.ts` (aplicar en orden, validar cada uno, revertir si falla alguno).
- **Costo:** bajo-medio (1–2 días). **Impacto:** medio.

**B6. Sistema de Skills real (carga on-demand).**
El prompt menciona una carpeta "skills" pero no hay carga on-demand por relevancia (como el `SKILL.md` de Claude Code). Un sistema de skills = el agente aprende tareas repetibles sin inflar el prompt base.
- **Dónde:** convención `skills/<nombre>/SKILL.md` en el workspace; un índice (nombre + descripción) inyectado al system prompt; una tool `skill_read` para cargar la skill completa cuando es relevante. Reusar `file_read`.
- **Costo:** medio (2–3 días). **Impacto:** medio-alto (capacidad que crece con el uso).

**B7. Hooks (PostToolUse).**
Auto-formatear/lint tras editar, verificación al terminar — sin que el modelo tenga que acordarse.
- **Dónde:** config `novaclaw.hooks.json`; el harness corre el hook tras `file_write`/`file_edit` (p.ej. `prettier --write`) y tras el turno.
- **Costo:** medio (2 días). **Impacto:** medio.

**B8. Subagentes en paralelo + con rol.**
Hoy `subagent_run` es uno genérico y secuencial. Para exploraciones grandes, lanzar varios en paralelo con roles distintos mejora cobertura y velocidad.
- **Dónde:** `nativeAgent.ts` — permitir un batch de `subagent_run` con `Promise.all`; parámetro opcional `role`/`system` por subagente.
- **Costo:** medio (2 días). **Impacto:** medio.

**B9. Presupuesto por TOKENS, no por iteraciones.**
Hoy cuenta iteraciones (32) y avisa a las 6 restantes. Contar tokens reales (aprox por longitud) permite compactar/cerrar en el momento justo y no desperdiciar el turno.
- **Dónde:** `runLoop` en `nativeAgent.ts` — estimador de tokens del contexto; disparar compactación por tokens, no solo por nº de entradas.
- **Costo:** bajo-medio (1–2 días). **Impacto:** medio.

### 🟢 Nivel 3 — Percepción / UX (no cambia el resultado bruto, sí la sensación)

**B10. Streaming token-por-token de la respuesta final.**
Hoy la respuesta final llega de una. Claude Code la va escribiendo. Es percepción, no calidad — pero se siente MUCHO más pro.
- **Dónde:** usar streaming del API del modelo (`stream:true`) y reenviar deltas por el SSE que ya existe.
- **Costo:** medio (2–3 días). **Impacto:** bajo en resultado, alto en sensación.

**B11. Afinar el system prompt con few-shot.**
Un par de trayectorias ejemplares (explorar → editar → verificar → responder) embebidas guían mejor a modelos chicos sin estorbar a los fuertes.
- **Costo:** bajo (medio día). **Impacto:** bajo-medio.

---

## 3. Plan por fases (orden recomendado)

### Fase A — "Barato y enorme" (los cimientos): 3–4 días
- [ ] **B1** Prompt caching (Anthropic + OpenAI si soporta).
- [ ] **B2** Reintentos con backoff.
- [ ] **B11** Afinar system prompt (rápido, va de la mano).
> **Hito:** mismo modelo, mismas tareas, pero más barato, más rápido y sin cortarse en red mala. Se nota de inmediato.

### Fase B — "Que el código salga bien de verdad": 4–5 días
- [ ] **B3** Verificación obligatoria (prompt + chequeo del harness).
- [ ] **B5** Multi-edit atómico.
- [ ] **B4** Compactación fina.
> **Hito:** tareas de código de varios pasos terminan con código que compila/pasa tests, sin perder el hilo en sesiones largas.

### Fase C — "Capacidad que escala": 4–6 días
- [ ] **B6** Skills on-demand.
- [ ] **B8** Subagentes en paralelo.
- [ ] **B7** Hooks PostToolUse.
- [ ] **B9** Presupuesto por tokens.
> **Hito:** el agente aprende tareas repetibles, explora en paralelo y automatiza el formateo/lint.

### Fase D — "Que se sienta Claude Code": 2–3 días
- [ ] **B10** Streaming token-por-token.
> **Hito:** la respuesta se escribe en vivo; sensación de producto de cientos de dólares.

**Estimación total: ~2–3 semanas** de trabajo enfocado. Se puede parar después de la Fase B y ya estarías muy cerca en lo que importa (resultado de código).

---

## 4. Cómo medimos "llegamos al nivel" (no a ojo)

Armar un set chico de **tareas-prueba reales** y correrlas en NovaClaw con Opus 4.8, comparando contra Claude Code con el mismo modelo:
1. "Encontrá dónde se maneja X y arreglá el bug" (multi-archivo).
2. "Agregá una feature chica con su test y verificá que pasa."
3. "Refactorizá esta función sin romper nada" (con diagnostics).
4. Una tarea larga (20+ pasos) para medir que no pierde el hilo.

Métrica honesta: **% de tareas que terminan con código que compila/pasa tests sin intervención**, tokens gastados, y tiempo. Si empatás en la 1ª y 3ª y quedás cerca en la larga → objetivo cumplido para código de escritorio. En lo phone-native (visión, cámara, GPS, Shizuku) ya lo superás por definición.

---

## 5. Lo que NO vamos a hacer (y por qué)

- **LSP completo** (go-to-definition, hover types persistente): Claude Code **tampoco** usa LSP — usa grep + diagnostics, igual que vos. Es brecha con OpenCode, no con Claude Code. `diagnostics.ts` ya cubre lo que importa. **Descartado** salvo pedido explícito.
- **Incrustar Claude Code/OpenCode reales:** descartado por decisión de Julio (este plan es el camino "agente propio"). El otro camino queda documentado por si algún día se quiere un "Motor Pro".

---

## 6. Próximo paso concreto

Arrancar por **B1 (prompt caching)** y **B2 (reintentos)** en `modelClient.ts`: son un par de días, no tocan la arquitectura, y el efecto (más barato + más rápido + no se corta) se siente en la primera prueba. Cuando Julio dé el OK, empiezo por ahí.
