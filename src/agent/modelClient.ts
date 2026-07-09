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

export interface ModelReply {
  text?: string;
  toolCalls?: Array<{ id: string; name: string; args: Record<string, any> }>;
  rawContent?: any[];
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

function toOpenAIMessages(system: string, messages: AgentMessage[]): any[] {
  const out: any[] = [{ role: 'system', content: system }];
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
}): Promise<ModelReply> {
  const provider = getProvider(input.providerId);
  if (!provider) throw new Error(`Proveedor desconocido: ${input.providerId}`);
  const headers = authHeaders(input.providerId, input.apiKey);
  const timeoutSignal = AbortSignal.timeout(input.timeoutMs ?? 180000);
  // Cancela por timeout O por el botón Detener del usuario.
  const signal = input.abortSignal
    ? AbortSignal.any([timeoutSignal, input.abortSignal])
    : timeoutSignal;
  const exclude = input.excludeTools ?? [];
  const extra = input.extraTools ?? [];
  const noTools = Boolean(input.noTools);

  if (provider.apiFormat === 'anthropic') {
    const maxTokens = input.maxTokens ?? ANTHROPIC_MAX_TOKENS;

    async function callAnthropic(withThinking: boolean): Promise<Response> {
      const body: Record<string, any> = {
        model: input.model,
        max_tokens: maxTokens,
        system: input.system,
        messages: toAnthropicMessages(input.messages),
      };
      if (!noTools) body.tools = toAnthropicTools(exclude, extra);
      let callHeaders = headers;
      if (withThinking && !noTools) {
        body.thinking = { type: 'enabled', budget_tokens: ANTHROPIC_THINKING_BUDGET };
        // interleaved thinking: el modelo puede razonar TAMBIÉN entre tool calls.
        callHeaders = { ...headers, 'anthropic-beta': 'interleaved-thinking-2025-05-14' };
      }
      return fetch(`${provider!.baseUrl}/messages`, {
        method: 'POST',
        headers: callHeaders,
        signal,
        body: JSON.stringify(body),
      });
    }

    let res = await callAnthropic(true);
    if (res.status === 400) {
      // Modelos Claude viejos sin extended thinking: reintentar sin razonamiento.
      const errText = await res.text();
      if (/thinking/i.test(errText)) {
        res = await callAnthropic(false);
      } else if (!res.ok) {
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
    };
  }

  // Formato OpenAI-compatible
  const maxTokens = input.maxTokens ?? OPENAI_MAX_TOKENS;
  const body: Record<string, any> = {
    model: input.model,
    messages: toOpenAIMessages(input.system, input.messages),
    temperature: 0.2,
    max_tokens: maxTokens,
  };
  if (!noTools) {
    body.tools = toOpenAITools(exclude, extra);
    body.tool_choice = 'auto';
  }
  const res = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Modelo ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const message = data.choices?.[0]?.message ?? {};
  const text = (message.content ?? '').trim();
  const toolCalls = (message.tool_calls ?? []).map((tc: any) => {
    let args: Record<string, any> = {};
    try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { args = {}; }
    return { id: tc.id, name: tc.function?.name, args };
  });
  return { text: text || undefined, toolCalls: toolCalls.length ? toolCalls : undefined };
}
