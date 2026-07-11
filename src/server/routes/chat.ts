import type { Express, Response } from 'express';

import { callModelWithTools } from '../../agent/modelClient';
import { AGENT_SESSION_ID, DEFAULT_CWD, zenConfig } from '../config';
import { runtimeState, startAgentRuntime } from '../state';
import { agentSessions, getOrCreateSession, rewindSession, saveSessionsToDisk } from '../sessions';
import { pickRuntime } from '../agentRuntimes';
import { cleanTitle, smartFallbackTitle } from '../titles';

/** Abre una respuesta SSE y devuelve el emisor de eventos. */
function openSse(res: Response) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  return (eventName: string, payload: unknown) => {
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
  };
}

export function registerChatRoutes(app: Express) {
  app.post('/api/chat', async (req, res) => {
    const { message, sessionId = AGENT_SESSION_ID, mode } = req.body;

    if (!message?.trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }

    if (runtimeState.agent.status !== 'running') {
      startAgentRuntime();
    }

    console.log(`[Chat] Session: ${sessionId}, Message: ${message.substring(0, 100)}...`);

    try {
      const session = getOrCreateSession(sessionId);
      const turnMode = mode === 'plan' ? 'plan' : mode === 'auto' ? 'auto' : 'build';
      const result = await pickRuntime().runUserTurn(session, message, undefined, undefined, turnMode);
      runtimeState.terminal.cwd = session.cwd;
      saveSessionsToDisk();
      return res.json({ events: result.events });
    } catch (error: any) {
      console.error('Chat API Error:', error);
      return res.status(500).json({
        events: [
          {
            type: 'message',
            message: `Error del agente: ${error.message}`,
          },
        ],
      });
    }
  });

  // ── Streaming en vivo (SSE): los eventos del agente llegan a medida que
  // ocurren (mensajes, tool calls, aprobaciones), como en Claude Code. ──────
  app.post('/api/chat/stream', async (req, res) => {
    const { message, sessionId = AGENT_SESSION_ID, mode } = req.body;
    if (!message?.trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }
    if (runtimeState.agent.status !== 'running') {
      startAgentRuntime();
    }
    // Botón Detener: abortamos SOLO si el cliente cierra la conexión ANTES de
    // que el turno termine. Ojo: se usa res.on('close') (no req.on('close'),
    // que se dispara apenas se lee el body POST y abortaría de inmediato).
    const controller = new AbortController();
    let finished = false;
    res.on('close', () => { if (!finished) controller.abort(); });
    const send = openSse(res);
    try {
      const session = getOrCreateSession(sessionId);
      const turnMode = mode === 'plan' ? 'plan' : mode === 'auto' ? 'auto' : 'build';
      const result = await pickRuntime().runUserTurn(session, message, (ev) => send('agent', ev), controller.signal, turnMode);
      finished = true;
      runtimeState.terminal.cwd = session.cwd;
      saveSessionsToDisk();
      send('done', { count: result.events.length });
    } catch (error: any) {
      finished = true;
      console.error('Chat stream error:', error);
      send('agent', { type: 'message', message: `Error del agente: ${error.message}` });
      send('done', { error: error.message });
    }
    res.end();
  });

  app.post('/api/chat/approval/stream', async (req, res) => {
    const { sessionId = AGENT_SESSION_ID, approved, scope } = req.body;
    const controller = new AbortController();
    let finished = false;
    res.on('close', () => { if (!finished) controller.abort(); });
    const send = openSse(res);
    try {
      const session = getOrCreateSession(sessionId);
      const approvalScope = scope === 'always' ? 'always' : 'once';
      const result = await pickRuntime().resolveApproval(session, Boolean(approved), (ev) => send('agent', ev), controller.signal, approvalScope);
      finished = true;
      runtimeState.terminal.cwd = session.cwd;
      saveSessionsToDisk();
      send('done', { count: result.events.length });
    } catch (error: any) {
      finished = true;
      console.error('Approval stream error:', error);
      send('agent', { type: 'message', message: `Error resolviendo aprobacion: ${error.message}` });
      send('done', { error: error.message });
    }
    res.end();
  });

  app.post('/api/chat/approval', async (req, res) => {
    const { sessionId = AGENT_SESSION_ID, approved, scope } = req.body;

    try {
      const session = getOrCreateSession(sessionId);
      const result = await pickRuntime().resolveApproval(session, Boolean(approved), undefined, undefined, scope === 'always' ? 'always' : 'once');
      runtimeState.terminal.cwd = session.cwd;
      saveSessionsToDisk();
      return res.json({ events: result.events });
    } catch (error: any) {
      console.error('Approval API Error:', error);
      return res.status(500).json({
        events: [
          {
            type: 'message',
            message: `Error resolviendo aprobacion: ${error.message}`,
          },
        ],
      });
    }
  });

  // Título del chat según el tema: lo genera el modelo (barato) o cae a la
  // primera pregunta del usuario si no hay key / falla.
  app.post('/api/chat/title', async (req, res) => {
    const { sessionId = AGENT_SESSION_ID } = req.body ?? {};
    const session = getOrCreateSession(sessionId);
    const firstUser = session.history.find((e) => e.role === 'user')?.content ?? '';
    const fallback = smartFallbackTitle(firstUser);

    if (!zenConfig.apiKey) {
      return res.json({ title: fallback });
    }
    try {
      const transcript = session.history
        .slice(0, 12)
        .map((e) => `${e.role}: ${e.content}`)
        .join('\n')
        .slice(0, 4000);
      const reply = await callModelWithTools({
        providerId: zenConfig.provider,
        apiKey: zenConfig.apiKey,
        model: zenConfig.model,
        system: 'Devuelve SOLO un título corto (3 a 6 palabras, sin comillas ni punto final) que describa el tema de esta conversación. En el idioma del usuario.',
        messages: [{ role: 'user', text: `Conversación:\n${transcript}\n\nTítulo:` }],
        // Alto a propósito: los modelos RAZONADORES (deepseek-v4, etc.) gastan
        // tokens "pensando" antes de escribir; con poco presupuesto el título
        // sale vacío. 512 deja aire para el razonamiento + el título final.
        maxTokens: 512,
        noTools: true,
      });
      const title = cleanTitle(reply.text ?? '') || fallback;
      res.json({ title });
    } catch (error: any) {
      console.error('Title generation failed:', error?.message);
      res.json({ title: fallback });
    }
  });

  // Rebobinar: truncar la conversación en la (userIndex)-ésima pregunta.
  app.post('/api/chat/rewind', (req, res) => {
    const { sessionId = AGENT_SESSION_ID, userIndex } = req.body ?? {};
    const idx = Number(userIndex);
    if (!Number.isInteger(idx) || idx < 0) {
      return res.status(400).json({ error: 'userIndex inválido' });
    }
    const session = getOrCreateSession(sessionId);
    rewindSession(session, idx);
    saveSessionsToDisk();
    return res.json({ success: true, history: session.history });
  });

  app.post('/api/chat/reset', (req, res) => {
    const { sessionId = AGENT_SESSION_ID } = req.body;
    agentSessions.delete(sessionId);
    saveSessionsToDisk();
    runtimeState.terminal.cwd = DEFAULT_CWD;
    res.json({ success: true });
  });

  app.get('/api/chat/history', (req, res) => {
    const sessionId = (req.query.sessionId as string) || AGENT_SESSION_ID;
    const session = getOrCreateSession(sessionId);
    res.json({ history: session.history, pendingApproval: session.pendingApproval });
  });
}
