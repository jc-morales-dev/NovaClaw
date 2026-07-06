import type { AgentModelAction } from './types';

function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('```')) {
    return trimmed;
  }

  return trimmed
    .replace(/^```[a-zA-Z0-9_-]*\s*/, '')
    .replace(/\s*```$/, '')
    .trim();
}

function tryParseJson(raw: string): unknown {
  const cleaned = stripCodeFence(raw);

  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function validateAction(parsed: unknown): AgentModelAction | null {
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const action = parsed as Record<string, unknown>;

  if (action.kind === 'message' && typeof action.message === 'string') {
    return {
      kind: 'message',
      message: action.message,
    };
  }

  if (
    action.kind === 'tool_call' &&
    typeof action.tool === 'string' &&
    action.arguments &&
    typeof action.arguments === 'object' &&
    !Array.isArray(action.arguments)
  ) {
    return {
      kind: 'tool_call',
      tool: action.tool,
      arguments: action.arguments as Record<string, unknown>,
    };
  }

  return null;
}

export function extractModelAction(raw: string): AgentModelAction {
  const parsed = tryParseJson(raw);
  const action = validateAction(parsed);

  if (action) {
    return action;
  }

  throw new Error('Model response must be a valid JSON action.');
}

export { tryParseJson, validateAction };
