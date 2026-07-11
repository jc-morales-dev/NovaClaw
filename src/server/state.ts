import { DEFAULT_CWD, zenConfig } from './config';

export type ModuleRuntimeStatus = 'stopped' | 'installing' | 'running';

export type RuntimeSnapshot = {
  agent: {
    status: 'stopped' | 'running';
    mode: 'remote' | 'local';
    label: string;
    lastStartedAt: string | null;
  };
  opencode: {
    status: ModuleRuntimeStatus;
    installed: boolean;
    available: boolean;
    version: string | null;
    commandPath: string | null;
    message: string;
    lastExitCode: number | null;
    lastStartedAt: string | null;
  };
  terminal: {
    status: 'ready';
    cwd: string;
  };
};

export const runtimeState: RuntimeSnapshot = {
  agent: {
    status: 'stopped',
    mode: zenConfig.apiKey ? 'remote' : 'local',
    label: zenConfig.apiKey ? 'Listo para usar el modelo remoto.' : 'Modo local de respaldo activo.',
    lastStartedAt: null,
  },
  opencode: {
    status: 'stopped',
    installed: false,
    available: false,
    version: null,
    commandPath: null,
    message: 'Comprobando OpenCode…',
    lastExitCode: null,
    lastStartedAt: null,
  },
  terminal: {
    status: 'ready',
    cwd: DEFAULT_CWD,
  },
};

const MAX_LOGS = 200;
export const systemLogs: string[] = [];

export function getRuntimeSnapshot() {
  return {
    ...runtimeState,
    agent: { ...runtimeState.agent },
    opencode: { ...runtimeState.opencode },
    terminal: { ...runtimeState.terminal },
  };
}

export function startAgentRuntime() {
  runtimeState.agent.status = 'running';
  runtimeState.agent.lastStartedAt = new Date().toISOString();
  runtimeState.agent.mode = zenConfig.apiKey ? 'remote' : 'local';
  runtimeState.agent.label = zenConfig.apiKey
    ? 'Modelo remoto en línea.'
    : 'Modo local de respaldo activo.';
}

/** Redirige console.* al buffer de logs de la UI (además de la consola real). */
export function overrideConsole() {
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const originalInfo = console.info;

  function addLog(level: string, args: unknown[]) {
    const timestamp = new Date().toISOString().split('T')[1].replace('Z', '');
    const message = args
      .map((value) => (typeof value === 'object' ? JSON.stringify(value) : String(value)))
      .join(' ');

    systemLogs.push(`[${timestamp}] [${level}] ${message}`);
    if (systemLogs.length > MAX_LOGS) {
      systemLogs.shift();
    }
  }

  console.log = (...args) => {
    addLog('INFO', args);
    originalLog(...args);
  };

  console.error = (...args) => {
    addLog('ERROR', args);
    originalError(...args);
  };

  console.warn = (...args) => {
    addLog('WARN', args);
    originalWarn(...args);
  };

  console.info = (...args) => {
    addLog('INFO', args);
    originalInfo(...args);
  };
}
