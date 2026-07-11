// Runtime local heurístico (sin API key): protocolo simple de respaldo.
// Interpreta la última pregunta del usuario con regex y devuelve una acción
// (mensaje o tool_call) en el formato JSON del runtime clásico.
import { zenConfig } from './config';
import { runtimeState } from './state';

type ChatRole = 'user' | 'assistant' | 'system';

function getHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${zenConfig.apiKey}`,
  };
}

function createMessageAction(message: string) {
  return JSON.stringify({ kind: 'message', message });
}

function createToolCallAction(tool: string, argumentsValue: Record<string, unknown>) {
  return JSON.stringify({ kind: 'tool_call', tool, arguments: argumentsValue });
}

function isLikelySpanish(text: string): boolean {
  return /[áéíóúñ]|\b(hola|archivo|carpeta|directorio|crear|crea|muestra|lista|ejecuta|comando|donde|estoy|busca|ayuda)\b/i.test(text);
}

function truncateOutput(value: string, maxLength = 1200): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n...`;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function buildToolSummaryMessage(rawContent: string, spanish: boolean): string | null {
  if (rawContent.startsWith('User rejected tool call:')) {
    return spanish
      ? 'Entendido. No ejecutaré esa acción sensible sin tu permiso.'
      : 'Understood. I will not execute that sensitive action without your approval.';
  }

  const parsed = safeJsonParse(rawContent);
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const result = parsed as Record<string, unknown>;
  const toolName = String(result.tool ?? result.name ?? 'tool');
  const output = String(result.output ?? '');
  const status = String(result.status ?? 'success');
  const header = spanish ? `Resultado de \`${toolName}\`` : `Result from \`${toolName}\``;
  const statusLabel = status === 'error'
    ? (spanish ? 'La acción falló.' : 'The action failed.')
    : (spanish ? 'La acción terminó correctamente.' : 'The action completed successfully.');
  const body = output.trim()
    ? `\n\n\`\`\`\n${truncateOutput(output.trim())}\n\`\`\``
    : '';

  return `${header}\n\n${statusLabel}${body}`;
}

export function buildLocalAgentAction(input: {
  messages: Array<{ role: ChatRole; content: string }>;
  cwd: string;
  workspaceRoot: string;
}) {
  const lastUserMessage = [...input.messages].reverse().find((entry) => entry.role === 'user')?.content ?? '';
  const spanish = isLikelySpanish(lastUserMessage);
  const latestHistoryEntry = input.messages[input.messages.length - 1];

  if (latestHistoryEntry?.role === 'system') {
    const summaryMessage = buildToolSummaryMessage(latestHistoryEntry.content, spanish);
    if (summaryMessage) {
      return createMessageAction(summaryMessage);
    }
  }

  const normalized = lastUserMessage.trim();
  const lower = normalized.toLowerCase();

  if (!normalized) {
    return createMessageAction(
      spanish
        ? 'Estoy listo para ayudarte a inspeccionar archivos, ejecutar comandos o crear estructura de proyecto.'
        : 'I am ready to inspect files, run commands, or create project structure.',
    );
  }

  if (/^(pwd|where am i|current dir|directorio actual|donde estoy)$/i.test(normalized)) {
    return createToolCallAction('terminal.run', { command: 'pwd' });
  }

  if (/^(ls|dir)(\s+.*)?$/i.test(normalized)) {
    return createToolCallAction('terminal.run', { command: normalized });
  }

  if (/^(cat|type)\s+.+$/i.test(normalized)) {
    return createToolCallAction('terminal.run', { command: normalized });
  }

  if (/^(node|npm|python|git)\b/i.test(normalized)) {
    return createToolCallAction('terminal.run', { command: normalized });
  }

  const explicitRunMatch = normalized.match(/^(?:run|exec|execute|terminal|cmd|comando)\s+(.+)$/i);
  if (explicitRunMatch) {
    return createToolCallAction('terminal.run', { command: explicitRunMatch[1] });
  }

  if (
    /(lista|muestra|show|list).*(archivos|files|carpetas|folders)/i.test(lower)
    || /(que hay|what is in).*(directorio|folder|workspace)/i.test(lower)
  ) {
    return createToolCallAction('terminal.run', { command: 'ls' });
  }

  const readMatch = normalized.match(/(?:read|open|show|lee|abre|muestra)\s+(?:file\s+|archivo\s+)?(.+)$/i);
  if (readMatch) {
    return createToolCallAction('file.read', { path: readMatch[1].trim() });
  }

  const mkdirMatch = normalized.match(/(?:mkdir|create|make|crear|crea)\s+(?:folder|directory|carpeta|directorio)\s+(.+)$/i);
  if (mkdirMatch) {
    return createToolCallAction('workspace.mkdir', { path: mkdirMatch[1].trim() });
  }

  const writeMatch = normalized.match(
    /(?:write|create|crear|crea)\s+(?:file|archivo)\s+([^\s]+)(?:\s+(?:with|content|contenido)\s+([\s\S]+))?$/i,
  );
  if (writeMatch) {
    return createToolCallAction('file.write', {
      path: writeMatch[1].trim(),
      content: writeMatch[2]?.trim() ?? '',
    });
  }

  const searchMatch = normalized.match(/(?:search|find|buscar)\s+([^\s]+)(?:\s+(?:in|en)\s+(.+))?$/i);
  if (searchMatch) {
    return createToolCallAction('file.search', {
      query: searchMatch[1].trim(),
      path: searchMatch[2]?.trim() || '.',
    });
  }

  return createMessageAction(
    spanish
      ? 'Estoy funcionando en modo local. Puedo ejecutar comandos, leer archivos, crear carpetas y escribir archivos si me lo pides de forma directa.'
      : 'I am running in local mode. I can run commands, read files, create folders, and write files when you ask directly.',
  );
}

export async function callZenAgent(input: {
  systemPrompt: string;
  messages: Array<{ role: ChatRole; content: string }>;
  cwd: string;
  workspaceRoot: string;
}) {
  if (!zenConfig.apiKey) {
    return buildLocalAgentAction(input);
  }

  const messages = [
    {
      role: 'system' as const,
      content: `${input.systemPrompt}

Current cwd: ${input.cwd}
Workspace root: ${input.workspaceRoot}

When the user asks to inspect files, run commands, create folders, or edit content, prefer a tool call over a generic answer.
If a requested action may be sensitive, still emit the exact tool_call and let the runtime ask the user for approval.
Return JSON only.`,
    },
    ...input.messages,
  ];

  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const controller = new AbortController();
      // Configurable: algunos modelos free/razonadores tardan más de 30s.
      const timeoutMs = Number(process.env.ZEN_TIMEOUT_MS) || 90000;
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(`${zenConfig.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: getHeaders(),
        signal: controller.signal,
        body: JSON.stringify({
          model: zenConfig.model,
          messages,
          temperature: 0.2,
          max_tokens: Number(process.env.ZEN_MAX_TOKENS) || 2048,
        }),
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Zen API Error:', response.status, errorText);

        if (response.status >= 500 && attempt < maxRetries) {
          console.log(`Retrying Zen API call (attempt ${attempt + 1}/${maxRetries})...`);
          continue;
        }

        runtimeState.agent.mode = 'local';
        runtimeState.agent.label = 'Modelo remoto no disponible. Modo local de respaldo activo.';
        return buildLocalAgentAction(input);
      }

      const data = await response.json();
      const assistantMessage = data.choices?.[0]?.message?.content?.trim();

      if (!assistantMessage) {
        runtimeState.agent.mode = 'local';
        runtimeState.agent.label = 'El modelo remoto no devolvió contenido. Modo local de respaldo activo.';
        return buildLocalAgentAction(input);
      }

      runtimeState.agent.mode = 'remote';
      runtimeState.agent.label = 'Modelo remoto en línea.';
      return assistantMessage;
    } catch (error: any) {
      console.error('Zen Error:', error.message, '| cause:', error?.cause?.code || error?.cause?.message || 'n/a', '| url:', `${zenConfig.baseUrl}/chat/completions`);

      if (attempt < maxRetries && (error.name === 'AbortError' || error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT')) {
        console.log(`Retrying Zen API call after network error (attempt ${attempt + 1}/${maxRetries})...`);
        continue;
      }

      runtimeState.agent.mode = 'local';
      runtimeState.agent.label = 'No se pudo contactar el modelo remoto. Modo local de respaldo activo.';
      return buildLocalAgentAction(input);
    }
  }

  runtimeState.agent.mode = 'local';
  runtimeState.agent.label = 'Modelo remoto no disponible tras varios intentos. Modo local de respaldo activo.';
  return buildLocalAgentAction(input);
}
