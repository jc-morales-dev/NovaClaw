/**
 * Registro de proveedores de IA. Cada uno expone su base URL, el formato de API
 * (OpenAI-compatible o Anthropic) y cómo autenticar. La verificación de la key y
 * el listado de modelos son EN VIVO (se llama al /models real del proveedor), así
 * nunca mostramos modelos inventados ni catálogos que quedan viejos.
 */

export type ApiFormat = 'openai' | 'anthropic' | 'openai-responses';

export interface ProviderDef {
  id: string;
  label: string;
  baseUrl: string;
  apiFormat: ApiFormat;
  /** Ruta del listado de modelos, relativa a baseUrl. */
  modelsPath: string;
  /** true = para OpenRouter filtramos el catálogo enorme a los mejores. */
  curated?: boolean;
  /** Texto de ayuda para la UI (dónde sacar la key). */
  keyHint: string;
  /** Si no usa key (login OAuth u otra vía), la UI lo trata distinto. */
  needsKey: boolean;
  note?: string;
}

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'opencode-zen',
    label: 'OpenCode Zen',
    baseUrl: 'https://opencode.ai/zen/v1',
    apiFormat: 'openai',
    modelsPath: '/models',
    needsKey: true,
    keyHint: 'Tu key de OpenCode Zen (opencode.ai/zen). Modelos curados para agentes.',
  },
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    baseUrl: 'https://api.anthropic.com/v1',
    apiFormat: 'anthropic',
    modelsPath: '/models',
    needsKey: true,
    keyHint: 'Tu API key de Anthropic (console.anthropic.com). Claude en su formato nativo.',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiFormat: 'openai',
    modelsPath: '/models',
    needsKey: true,
    keyHint: 'Tu API key de OpenAI (platform.openai.com).',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiFormat: 'openai',
    modelsPath: '/models',
    curated: true,
    needsKey: true,
    keyHint: 'Tu key de OpenRouter (openrouter.ai). Acceso a todos los modelos; te mostramos los mejores.',
  },
  {
    id: 'nvidia',
    label: 'NVIDIA',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    apiFormat: 'openai',
    modelsPath: '/models',
    needsKey: true,
    keyHint: 'Tu key de NVIDIA (build.nvidia.com). Muchos modelos con nivel free.',
  },
  {
    id: 'openai-codex',
    label: 'OpenAI Codex (cuenta ChatGPT)',
    // Backend de Codex para cuentas ChatGPT: habla la Responses API, no
    // chat/completions, y autentica con los tokens OAuth (no hay API key).
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    apiFormat: 'openai-responses',
    modelsPath: '/models',
    needsKey: false,
    keyHint: 'Sin API key: iniciás sesión con tu cuenta de ChatGPT (sirve la gratis) y usás los modelos GPT de Codex. El uso descuenta de los límites de tu plan.',
    note: 'login-oauth',
  },
];

/** Modelos de Codex conocidos, por si el /models del backend no responde.
 *  gpt-5.6-sol NO está: OpenAI lo bloquea para cuentas ChatGPT (solo API paga). */
export const CODEX_FALLBACK_MODELS = [
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.4-codex',
  'gpt-5.4',
  'gpt-5.4-mini',
];

export function getProvider(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/**
 * OpenRouter tiene 300+ modelos. Curamos a los mejores por gama: premium
 * (caros y potentes) y valor (baratos pero fuertes). Se filtra por coincidencia
 * de id (substring), así se auto-ajusta a lo que esté vivo hoy.
 */
export const OPENROUTER_CURATED: Array<{ match: string; tier: 'premium' | 'value' }> = [
  // Premium — máxima calidad
  { match: 'anthropic/claude-fable-5', tier: 'premium' },
  { match: 'anthropic/claude-sonnet', tier: 'premium' },
  { match: 'anthropic/claude-opus-4.8', tier: 'premium' },
  { match: 'anthropic/claude-opus', tier: 'premium' },
  { match: 'openai/gpt-5', tier: 'premium' },
  { match: 'google/gemini-3-pro', tier: 'premium' },
  { match: 'google/gemini-2.5-pro', tier: 'premium' },
  { match: 'x-ai/grok-4', tier: 'premium' },
  // Valor — baratos y potentes
  { match: 'deepseek/deepseek-v3', tier: 'value' },
  { match: 'deepseek/deepseek-chat', tier: 'value' },
  { match: 'deepseek/deepseek-r1', tier: 'value' },
  { match: 'z-ai/glm-5.2', tier: 'value' },
  { match: 'z-ai/glm-5', tier: 'value' },
  { match: 'z-ai/glm-4.6', tier: 'value' },
  { match: 'minimax/minimax-m3', tier: 'value' },
  { match: 'minimax/minimax-m2', tier: 'value' },
  { match: 'qwen/qwen3-coder', tier: 'value' },
  { match: 'moonshotai/kimi-k2.7', tier: 'value' },
  { match: 'moonshotai/kimi-k2', tier: 'value' },
];

export interface ModelInfo {
  id: string;
  label: string;
  tier?: 'premium' | 'value';
}

/** Aplica el filtro curado de OpenRouter sobre la lista viva de modelos.
 *  Para cada regla elige el modelo BASE de chat (descarta variantes de imagen,
 *  audio, embeddings, etc.), y ante varias coincidencias toma el id más corto. */
export function curateOpenRouter(ids: string[]): ModelInfo[] {
  const out: ModelInfo[] = [];
  const excluded = /image|vision|audio|tts|embed|\bfree\b|-online|search/i;
  for (const rule of OPENROUTER_CURATED) {
    const candidates = ids
      .filter((id) => id.includes(rule.match) && !excluded.test(id))
      .sort((a, b) => a.length - b.length); // el más corto suele ser el base
    const hit = candidates[0];
    if (hit && !out.some((m) => m.id === hit)) {
      out.push({ id: hit, label: prettyModel(hit), tier: rule.tier });
    }
  }
  return out;
}

export function prettyModel(id: string): string {
  // "anthropic/claude-sonnet-4.6" -> "Claude Sonnet 4.6"
  const tail = id.includes('/') ? id.split('/').slice(1).join('/') : id;
  return tail
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bGlm\b/g, 'GLM')
    .replace(/\bGpt\b/g, 'GPT')
    .trim();
}
