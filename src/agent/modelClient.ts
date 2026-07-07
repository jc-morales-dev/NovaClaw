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
import { toOpenAITools, toAnthropicTools } from './toolSchemas';

const ANTHROPIC_VERSION = '2023-06-01';

export interface AgentMessage {
  role: 'user' | 'assistant' | 'tool';
  text?: string;
  toolCalls?: Array<{ id: string; name: string; args: Record<string, any> }>;
  toolCallId?: string;
  toolName?: string;
  result?: string;
}

export interface ModelReply {
  text?: string;
  toolCalls?: Array<{ id: string; name: string; args: Record<string, any> }>;
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
      out.push({ role: 'user', content: m.text ?? '' });
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
      out.push({ role: 'user', content: [{ type: 'text', text: m.text ?? '' }] });
    } else if (m.role === 'assistant') {
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
}): Promise<ModelReply> {
  const provider = getProvider(input.providerId);
  if (!provider) throw new Error(`Proveedor desconocido: ${input.providerId}`);
  const headers = authHeaders(input.providerId, input.apiKey);
  const maxTokens = input.maxTokens ?? 4096;
  const signal = AbortSignal.timeout(input.timeoutMs ?? 120000);

  if (provider.apiFormat === 'anthropic') {
    const res = await fetch(`${provider.baseUrl}/messages`, {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({
        model: input.model,
        max_tokens: maxTokens,
        system: input.system,
        messages: toAnthropicMessages(input.messages),
        tools: toAnthropicTools(),
      }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const blocks: any[] = data.content ?? [];
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    const toolCalls = blocks
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, args: b.input ?? {} }));
    return { text: text || undefined, toolCalls: toolCalls.length ? toolCalls : undefined };
  }

  // Formato OpenAI-compatible
  const res = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      model: input.model,
      messages: toOpenAIMessages(input.system, input.messages),
      tools: toOpenAITools(),
      tool_choice: 'auto',
      temperature: 0.2,
      max_tokens: maxTokens,
    }),
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
