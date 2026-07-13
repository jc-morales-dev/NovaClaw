/**
 * Cliente unificado de modelos: verifica la API key, lista modelos en vivo y hace
 * las llamadas de chat con function-calling NATIVO, hablando tanto el formato
 * OpenAI (Zen, NVIDIA, OpenRouter, OpenAI) como el de Anthropic (Claude).
 */
import {
  getProvider,
  curateOpenRouter,
  prettyModel,
  type ModelInfo,
} from './providers';
import { toOpenAITools, toAnthropicTools, type ToolSchema } from './toolSchemas';

const ANTHROPIC_VERSION = '2023-06-01';

// Extended thinking (razonamiento largo) para modelos Claude: presupuesto de
// tokens de pensamiento + salida alta. Los proveedores OpenAI-compatible
// gestionan su propio razonamiento internamente.
const ANTHROPIC_THINKING_BUDGET = 4096;
const ANTHROPIC_MAX_TOKENS = 16384;
const OPENAI_MAX_TOKENS = 8192;

/** Imagen adjunta a un mensaje (para modelos multimodales: cámara, screenshots). */
export interface AgentImage {
  mediaType: string; // p.ej. 'image/jpeg', 'image/png'
  data: string;      // base64 (sin el prefijo data:)
}

export interface AgentMessage {
  role: 'user' | 'assistant' | 'tool';
  text?: string;
  toolCalls?: Array<{ id: string; name: string; args: Record<string, any> }>;
  toolCallId?: string;
  toolName?: string;
  result?: string;
  /** Imágenes adjuntas al mensaje (visión). Válido en 'user'. */
  images?: AgentImage[];
  /** Bloques de contenido crudos de Anthropic (incluye thinking). Con extended
   *  thinking + tool use, la API exige devolverlos INTACTOS en el turno siguiente. */
  rawContent?: any[];
}

/** Tokens consumidos por UNA llamada al modelo (incluye lecturas/escrituras de
 *  prompt cache cuando el proveedor las reporta). Sirve para ver el ahorro real. */
export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** Tokens leídos del cache (se cobran ~10% del precio normal). */
  cacheReadTokens?: number;
  /** Tokens escritos al cache (se cobran ~125% una vez, se ahorran después). */
  cacheWriteTokens?: number;
}

export interface ModelReply {
  text?: string;
  toolCalls?: Array<{ id: string; name: string; args: Record<string, any> }>;
  rawContent?: any[];
  usage?: ModelUsage;
}

function authHeaders(providerId: string, apiKey: string): Record<string, string> {
  const provider = getProvider(providerId);
  if (provider?.apiFormat === 'anthropic') {
    return {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'Content-Type': 'application/json',
    };
  }
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

// ── Reintentos con backoff (B2) ─────────────────────────────────────────────
// Errores transitorios (rate limit, sobrecarga, 5xx, caídas de red) se reintentan
// con espera creciente; los definitivos (400/401/403/404) NO. Clave en el celular,
// donde la red se corta seguido: la diferencia entre "terminó" y "se cortó".
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 529]);
const DEFAULT_MAX_RETRIES = 3;

/** Espera cancelable: se corta si el usuario toca Detener (abortSignal). */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });
}

/** Retry-After (segundos o fecha HTTP) → milisegundos, o null si no vino. */
function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

/** Backoff exponencial con jitter: 0.5s, 1s, 2s… tope 8s. */
function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 8000) + Math.floor(Math.random() * 250);
}

/**
 * fetch con reintentos. Cada intento tiene su propio timeout; si el usuario aborta
 * cortamos limpio (sin reintentar). Devuelve la Response tal cual para status no
 * reintentables (el caller lee el body del error) o cuando se agotan los reintentos.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: { timeoutMs: number; abortSignal?: AbortSignal; maxRetries?: number },
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  let attempt = 0;
  for (;;) {
    if (opts.abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const timeoutSignal = AbortSignal.timeout(opts.timeoutMs);
    const signal = opts.abortSignal ? AbortSignal.any([timeoutSignal, opts.abortSignal]) : timeoutSignal;
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal });
    } catch (error) {
      // El usuario tocó Detener → no reintentar. Timeout/caída de red → sí.
      if (opts.abortSignal?.aborted || attempt >= maxRetries) throw error;
      await sleep(backoffMs(attempt), opts.abortSignal);
      attempt += 1;
      continue;
    }
    if (res.ok || !RETRYABLE_STATUS.has(res.status) || attempt >= maxRetries) return res;
    const retryAfter = parseRetryAfterMs(res.headers.get('retry-after'));
    try { await res.text(); } catch { /* descartar el body antes de reintentar */ }
    await sleep(retryAfter ?? backoffMs(attempt), opts.abortSignal);
    attempt += 1;
  }
}

// ── Prompt caching de Anthropic (B1) ────────────────────────────────────────
/** Claude 4.6+ / Sonnet 5 / Fable 5 usan adaptive thinking; el viejo
 *  budget_tokens los hace fallar con 400 (por eso Opus 4.8 corría SIN pensar).
 *  Los previos (Haiku 4.5, Sonnet 4.5…) siguen con budget_tokens. */
function supportsAdaptiveThinking(model: string): boolean {
  return /(opus-4-[678]|sonnet-4-6|sonnet-5|fable-5|mythos-5)\b/.test(model.toLowerCase());
}

// Modelos que ya devolvieron 400 por thinking: en el loop agéntico se llama al
// modelo decenas de veces por turno — sin esto, CADA iteración paga un 400 +
// reintento de más (latencia y requests duplicados con modelos sin thinking).
const thinkingUnsupported = new Set<string>();

// ── Métricas de uso/caching (B11) ────────────────────────────────────────────
/** usage de la API de Anthropic → ModelUsage (o undefined si no vino). */
function parseAnthropicUsage(u: any): ModelUsage | undefined {
  if (!u || typeof u !== 'object') return undefined;
  return {
    inputTokens: u.input_tokens ?? undefined,
    outputTokens: u.output_tokens ?? undefined,
    cacheReadTokens: u.cache_read_input_tokens ?? undefined,
    cacheWriteTokens: u.cache_creation_input_tokens ?? undefined,
  };
}

/** usage formato OpenAI/OpenRouter → ModelUsage. OpenRouter reporta las lecturas
 *  de cache en prompt_tokens_details.cached_tokens (y algunas pasarelas suman
 *  cache_creation_input_tokens para las escrituras). */
function parseOpenAIUsage(u: any): ModelUsage | undefined {
  if (!u || typeof u !== 'object') return undefined;
  return {
    inputTokens: u.prompt_tokens ?? undefined,
    outputTokens: u.completion_tokens ?? undefined,
    cacheReadTokens: u.prompt_tokens_details?.cached_tokens ?? undefined,
    cacheWriteTokens: u.cache_creation_input_tokens ?? undefined,
  };
}

// ── Streaming SSE del camino OpenAI (B10) ────────────────────────────────────
/**
 * Lee el stream de /chat/completions (formato OpenAI), acumula texto y tool_calls
 * por índice, y llama onTextDelta por cada fragmento de texto. Devuelve el mismo
 * ModelReply que el camino sin streaming, así el loop del agente no cambia.
 */
async function readOpenAIStream(res: Response, onTextDelta?: (delta: string) => void): Promise<ModelReply> {
  const reader = res.body?.getReader?.();
  if (!reader) {
    // Sin cuerpo legible: caemos al parseo JSON normal (por si un proxy no streamea).
    const data = await res.json();
    const message = data.choices?.[0]?.message ?? {};
    const text = (message.content ?? '').trim();
    const toolCalls = (message.tool_calls ?? []).map((tc: any) => {
      let args: Record<string, any> = {};
      try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { args = {}; }
      return { id: tc.id, name: tc.function?.name, args };
    });
    return {
      text: text || undefined,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      usage: parseOpenAIUsage(data.usage),
    };
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let usage: ModelUsage | undefined;
  const toolAcc: Record<number, { id?: string; name?: string; args: string }> = {};

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let chunk: any;
      try { chunk = JSON.parse(payload); } catch { continue; }
      // Con stream_options.include_usage, el chunk final trae usage (choices vacío).
      if (chunk.usage) usage = parseOpenAIUsage(chunk.usage) ?? usage;
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content;
        try { onTextDelta?.(delta.content); } catch { /* un sink roto no frena el stream */ }
      }
      for (const tc of delta.tool_calls ?? []) {
        const i = typeof tc.index === 'number' ? tc.index : 0;
        const acc = toolAcc[i] ?? (toolAcc[i] = { args: '' });
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name = tc.function.name;
        if (tc.function?.arguments) acc.args += tc.function.arguments;
      }
    }
  }

  const toolCalls = Object.values(toolAcc)
    .map((a) => {
      let args: Record<string, any> = {};
      try { args = JSON.parse(a.args || '{}'); } catch { args = {}; }
      return { id: a.id ?? '', name: a.name ?? '', args };
    })
    .filter((t) => t.name);
  const text = content.trim();
  return { text: text || undefined, toolCalls: toolCalls.length ? toolCalls : undefined, usage };
}

/** Marca el último bloque del último mensaje con cache_control, para cachear el
 *  prefijo del historial que crece en cada vuelta del loop (patrón multi-turno). */
function tagLastMessageForCache(messages: any[]): void {
  const last = messages[messages.length - 1];
  if (!last || !Array.isArray(last.content) || last.content.length === 0) return;
  const block = last.content[last.content.length - 1];
  if (block && typeof block === 'object') block.cache_control = { type: 'ephemeral' };
}

// ── Prompt caching de Claude vía OpenRouter (B11) ───────────────────────────
// OpenRouter cachea solo (server-side) los modelos OpenAI/DeepSeek/Gemini, pero
// para los Claude exige los MISMOS breakpoints cache_control que la API nativa
// de Anthropic — si no van, cada vuelta del loop re-paga TODO el contexto a
// precio lleno. Este es el camino que usa el usuario (OpenRouter + Claude).
function isClaudeViaOpenRouter(providerId: string, model: string): boolean {
  return providerId === 'openrouter' && /^anthropic\//i.test(model);
}

/** Convierte content string → partes multipart para poder colgar cache_control.
 *  Devuelve la última parte de texto, o null si el mensaje no tiene texto. */
function lastTextPart(msg: any): any | null {
  if (typeof msg.content === 'string') {
    msg.content = [{ type: 'text', text: msg.content }];
    return msg.content[0];
  }
  if (Array.isArray(msg.content)) {
    for (let i = msg.content.length - 1; i >= 0; i -= 1) {
      if (msg.content[i]?.type === 'text') return msg.content[i];
    }
  }
  return null;
}

/** Inserta los breakpoints de cache en mensajes formato OpenAI (para OpenRouter→Claude):
 *  el último mensaje user/tool (cachea el loop agéntico que crece por el final) y
 *  el último user (ancla estable entre iteraciones). Máx 2 + system = 3 de los 4
 *  breakpoints que permite Anthropic. Los assistant no se tocan. */
function tagOpenAIMessagesForCache(out: any[]): void {
  let lastTaggable = -1;
  let lastUser = -1;
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const role = out[i]?.role;
    if (lastTaggable === -1 && (role === 'user' || role === 'tool')) lastTaggable = i;
    if (lastUser === -1 && role === 'user') lastUser = i;
    if (lastTaggable !== -1 && lastUser !== -1) break;
  }
  for (const idx of new Set([lastTaggable, lastUser])) {
    if (idx === -1) continue;
    const part = lastTextPart(out[idx]);
    if (part) part.cache_control = { type: 'ephemeral' };
  }
}

/** Verifica la key llamando al /models real del proveedor y devuelve la lista. */
export async function verifyAndListModels(
  providerId: string,
  apiKey: string,
): Promise<{ ok: boolean; models: ModelInfo[]; error?: string }> {
  const provider = getProvider(providerId);
  if (!provider) return { ok: false, models: [], error: 'Proveedor desconocido.' };
  if (provider.needsKey && !apiKey.trim()) {
    return { ok: false, models: [], error: 'Falta la API key.' };
  }

  try {
    const res = await fetch(`${provider.baseUrl}${provider.modelsPath}`, {
      method: 'GET',
      headers: authHeaders(providerId, apiKey),
      signal: AbortSignal.timeout(12000),
    });

    if (res.status === 401 || res.status === 403) {
      return { ok: false, models: [], error: 'API key inválida o sin permisos.' };
    }
    if (!res.ok) {
      return { ok: false, models: [], error: `El proveedor respondió ${res.status}.` };
    }

    const data = await res.json();
    // OpenAI/OpenRouter/NVIDIA/Zen: { data: [{id}] }. Anthropic: { data: [{id}] } también.
    const rawList: any[] = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
    const ids: string[] = rawList
      .map((m) => (typeof m === 'string' ? m : m.id))
      .filter((id): id is string => typeof id === 'string');

    if (ids.length === 0) {
      return { ok: true, models: [], error: 'La key es válida pero no se listaron modelos.' };
    }

    let models: ModelInfo[];
    if (provider.curated) {
      models = curateOpenRouter(ids);
      if (models.length === 0) {
        // Si el filtro no matcheó nada, mostramos los primeros del catálogo.
        models = ids.slice(0, 20).map((id) => ({ id, label: prettyModel(id) }));
      }
    } else {
      models = ids
        .filter((id) => !/embed|whisper|tts|dall-e|image|moderation|rerank/i.test(id))
        .map((id) => ({ id, label: prettyModel(id) }));
    }

    return { ok: true, models };
  } catch (error: any) {
    const msg = error?.name === 'TimeoutError'
      ? 'El proveedor tardó demasiado en responder.'
      : `No se pudo contactar al proveedor: ${error?.message ?? 'error de red'}`;
    return { ok: false, models: [], error: msg };
  }
}

// ── Llamada de chat con herramientas nativas ────────────────────────────────

function toOpenAIMessages(system: string, messages: AgentMessage[], cacheClaude = false): any[] {
  // B11: para Claude vía OpenRouter el system va como parte multipart con
  // cache_control → cachea tools+system (el prefijo más gordo y estable).
  const out: any[] = [{
    role: 'system',
    content: cacheClaude
      ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
      : system,
  }];
  for (const m of messages) {
    if (m.role === 'user') {
      if (m.images && m.images.length > 0) {
        // Contenido multimodal: texto + imágenes (formato OpenAI image_url).
        const parts: any[] = [];
        if (m.text) parts.push({ type: 'text', text: m.text });
        for (const img of m.images) {
          parts.push({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.data}` } });
        }
        out.push({ role: 'user', content: parts });
      } else {
        out.push({ role: 'user', content: m.text ?? '' });
      }
    } else if (m.role === 'assistant') {
      const msg: any = { role: 'assistant', content: m.text ?? '' };
      if (m.toolCalls && m.toolCalls.length > 0) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        }));
        if (!m.text) msg.content = null;
      }
      out.push(msg);
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.result ?? '' });
    }
  }
  if (cacheClaude) tagOpenAIMessagesForCache(out);
  return out;
}

function toAnthropicMessages(messages: AgentMessage[]): any[] {
  const out: any[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      const content: any[] = [];
      if (m.text) content.push({ type: 'text', text: m.text });
      for (const img of m.images ?? []) {
        content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
      }
      if (content.length === 0) content.push({ type: 'text', text: '' });
      out.push({ role: 'user', content });
    } else if (m.role === 'assistant') {
      // Con thinking activado hay que reenviar los bloques crudos tal cual
      // (incluidos los bloques thinking firmados) o la API rechaza el turno.
      if (m.rawContent && m.rawContent.length > 0) {
        out.push({ role: 'assistant', content: m.rawContent });
        continue;
      }
      const blocks: any[] = [];
      if (m.text) blocks.push({ type: 'text', text: m.text });
      for (const tc of m.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
      }
      out.push({ role: 'assistant', content: blocks });
    } else if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.result ?? '' }],
      });
    }
  }
  return out;
}

export async function callModelWithTools(input: {
  providerId: string;
  apiKey: string;
  model: string;
  system: string;
  messages: AgentMessage[];
  maxTokens?: number;
  timeoutMs?: number;
  /** Tools a excluir (p.ej. el subagente no puede lanzar más subagentes). */
  excludeTools?: string[];
  /** Tools dinámicas extra (servidores MCP) para ofrecer al modelo. */
  extraTools?: ToolSchema[];
  /** Señal de cancelación del usuario (botón Detener). Se combina con el timeout. */
  abortSignal?: AbortSignal;
  /** Llamada de texto puro (sin tools ni thinking): p.ej. generar un título. */
  noTools?: boolean;
  /** B10: si viene, el camino OpenAI-compatible streamea y llama esto por cada
   *  fragmento de texto (para escribir la respuesta en vivo). Anthropic NO
   *  streamea (protege el replay de thinking) y este callback no se usa ahí. */
  onTextDelta?: (delta: string) => void;
}): Promise<ModelReply> {
  const provider = getProvider(input.providerId);
  if (!provider) throw new Error(`Proveedor desconocido: ${input.providerId}`);
  const headers = authHeaders(input.providerId, input.apiKey);
  const timeoutMs = input.timeoutMs ?? 180000;
  const exclude = input.excludeTools ?? [];
  const extra = input.extraTools ?? [];
  const noTools = Boolean(input.noTools);

  if (provider.apiFormat === 'anthropic') {
    const maxTokens = input.maxTokens ?? ANTHROPIC_MAX_TOKENS;
    // El resumen/título es one-off: cachearlo sería puro costo de escritura sin lecturas.
    const useCache = !noTools;
    const adaptive = supportsAdaptiveThinking(input.model);

    // Prompt caching (B1): el system va como bloque con cache_control → cachea
    // tools+system juntos (orden de render tools→system→messages). Necesita
    // prefijo ≥4096 tokens en Opus 4.8; si es menor, la API lo ignora sin error.
    const systemParam = useCache
      ? [{ type: 'text', text: input.system, cache_control: { type: 'ephemeral' } }]
      : input.system;

    async function callAnthropic(withThinking: boolean): Promise<Response> {
      const messages = toAnthropicMessages(input.messages);
      // Cachea el prefijo del historial que crece en cada vuelta del loop agéntico.
      if (useCache) tagLastMessageForCache(messages);
      const body: Record<string, any> = {
        model: input.model,
        max_tokens: maxTokens,
        system: systemParam,
        messages,
      };
      if (!noTools) body.tools = toAnthropicTools(exclude, extra);
      let callHeaders = headers;
      if (withThinking && !noTools) {
        if (adaptive) {
          // Claude 4.6+ / Sonnet 5 / Fable 5: adaptive (interleaved va incluido, sin beta header).
          body.thinking = { type: 'adaptive' };
        } else {
          // Modelos previos (Haiku 4.5, etc.): budget_tokens + interleaved por header.
          body.thinking = { type: 'enabled', budget_tokens: ANTHROPIC_THINKING_BUDGET };
          callHeaders = { ...headers, 'anthropic-beta': 'interleaved-thinking-2025-05-14' };
        }
      }
      return fetchWithRetry(`${provider!.baseUrl}/messages`, {
        method: 'POST',
        headers: callHeaders,
        body: JSON.stringify(body),
      }, { timeoutMs, abortSignal: input.abortSignal });
    }

    let res = await callAnthropic(!thinkingUnsupported.has(input.model));
    if (res.status === 400) {
      // Modelos sin extended thinking (o config no soportada): reintentar sin
      // razonamiento y RECORDARLO para no repetir el 400 en cada iteración.
      const errText = await res.text();
      if (/thinking/i.test(errText) && !thinkingUnsupported.has(input.model)) {
        thinkingUnsupported.add(input.model);
        res = await callAnthropic(false);
      } else {
        throw new Error(`Anthropic 400: ${errText}`);
      }
    }
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const blocks: any[] = data.content ?? [];
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    const toolCalls = blocks
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, args: b.input ?? {} }));
    return {
      text: text || undefined,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      rawContent: blocks.length ? blocks : undefined,
      usage: parseAnthropicUsage(data.usage),
    };
  }

  // Formato OpenAI-compatible
  const maxTokens = input.maxTokens ?? OPENAI_MAX_TOKENS;
  // B10: streamear en vivo cuando el llamador lo pide (respuesta token-por-token).
  const wantsStream = typeof input.onTextDelta === 'function';
  // B11: OpenAI/DeepSeek/Gemini cachean solos (server-side); los Claude vía
  // OpenRouter necesitan breakpoints cache_control explícitos, como en la API nativa.
  const cacheClaude = !noTools && isClaudeViaOpenRouter(input.providerId, input.model);

  function buildOpenAIBody(withCache: boolean): Record<string, any> {
    const body: Record<string, any> = {
      model: input.model,
      messages: toOpenAIMessages(input.system, input.messages, withCache),
      temperature: 0.2,
      max_tokens: maxTokens,
    };
    if (!noTools) {
      body.tools = toOpenAITools(exclude, extra);
      body.tool_choice = 'auto';
    }
    if (wantsStream) {
      body.stream = true;
      // usage en el último chunk del stream. Solo donde está confirmado que se
      // soporta (OpenRouter/OpenAI); en pasarelas menores podría dar 400.
      if (input.providerId === 'openrouter' || input.providerId === 'openai') {
        body.stream_options = { include_usage: true };
      }
    }
    return body;
  }

  let res = await fetchWithRetry(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(buildOpenAIBody(cacheClaude)),
  }, { timeoutMs, abortSignal: input.abortSignal });
  if (res.status === 400 && cacheClaude) {
    // Red de seguridad: si la pasarela rechazara el payload con cache_control,
    // degradamos a sin-cache (el estado de siempre) en vez de romper el chat.
    try { await res.text(); } catch { /* descartar el body del error */ }
    res = await fetchWithRetry(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildOpenAIBody(false)),
    }, { timeoutMs, abortSignal: input.abortSignal });
  }
  if (!res.ok) throw new Error(`Modelo ${res.status}: ${await res.text()}`);
  if (wantsStream) {
    return readOpenAIStream(res, input.onTextDelta);
  }
  const data = await res.json();
  const message = data.choices?.[0]?.message ?? {};
  const text = (message.content ?? '').trim();
  const toolCalls = (message.tool_calls ?? []).map((tc: any) => {
    let args: Record<string, any> = {};
    try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { args = {}; }
    return { id: tc.id, name: tc.function?.name, args };
  });
  return {
    text: text || undefined,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    usage: parseOpenAIUsage(data.usage),
  };
}
