import fs from 'node:fs';
import path from 'node:path';

import { createAgentSession, type AgentSession } from '../agent/runtime';
import { DEFAULT_CWD, NOVACLAW_CONFIG_PATH } from './config';

export const agentSessions = new Map<string, AgentSession>();

// Persistencia de conversaciones: viven junto a la config para sobrevivir a
// cierres de la app y reinicios del servicio (antes se perdían al reabrir).
const SESSIONS_PATH = path.join(path.dirname(NOVACLAW_CONFIG_PATH), 'novaclaw.sessions.json');

export function loadSessionsFromDisk() {
  try {
    if (!fs.existsSync(SESSIONS_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(SESSIONS_PATH, 'utf8'));
    if (raw && typeof raw === 'object') {
      for (const [id, session] of Object.entries(raw)) {
        agentSessions.set(id, session as AgentSession);
      }
    }
  } catch (error) {
    console.error('No se pudieron cargar las conversaciones guardadas:', error);
  }
}

export function saveSessionsToDisk() {
  try {
    const obj: Record<string, AgentSession> = {};
    for (const [id, session] of agentSessions.entries()) obj[id] = session;
    fs.writeFileSync(SESSIONS_PATH, JSON.stringify(obj), 'utf8');
  } catch (error) {
    console.error('No se pudieron guardar las conversaciones:', error);
  }
}

export function getOrCreateSession(sessionId: string): AgentSession {
  const existing = agentSessions.get(sessionId);
  if (existing) {
    return existing;
  }

  const session = createAgentSession(sessionId, DEFAULT_CWD);
  agentSessions.set(sessionId, session);
  return session;
}

/**
 * Rebobina la conversación al punto ANTES de la (userIndex)-ésima pregunta del
 * usuario (0-based): borra esa entrada y todo lo que vino después. Así el usuario
 * puede editar una pregunta vieja y regenerar desde ahí (como el rewind de Claude).
 */
export function rewindSession(session: AgentSession, userIndex: number): void {
  let count = 0;
  let cutAt = -1;
  for (let i = 0; i < session.history.length; i += 1) {
    if (session.history[i].role === 'user') {
      if (count === userIndex) { cutAt = i; break; }
      count += 1;
    }
  }
  if (cutAt >= 0) {
    session.history = session.history.slice(0, cutAt);
  }
  // Descartar cualquier aprobación o reanudación pendiente del tramo borrado.
  session.pendingApproval = null;
  (session as any).native = undefined;
}
