import { exec as execCallback, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';

import { DEFAULT_CWD } from './config';
import { runtimeState } from './state';

const execAsync = promisify(execCallback);

let opencodeInstallProcess: ChildProcessWithoutNullStreams | null = null;
let opencodeRuntimeProcess: ChildProcessWithoutNullStreams | null = null;

async function resolveOpenCodeBinary(): Promise<string | null> {
  const commands = process.platform === 'win32'
    ? ['where.exe opencode.cmd', 'where.exe opencode']
    : ['which opencode'];

  for (const command of commands) {
    try {
      const { stdout } = await execAsync(command, { cwd: DEFAULT_CWD, timeout: 10000 });
      const binaryPath = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);

      if (binaryPath) {
        return binaryPath;
      }
    } catch {
      // Try the next resolution strategy.
    }
  }

  return null;
}

async function getOpenCodeVersion(binaryPath: string): Promise<string | null> {
  try {
    const quotedPath = binaryPath.includes(' ') ? `"${binaryPath}"` : binaryPath;
    const { stdout, stderr } = await execAsync(`${quotedPath} --version`, { cwd: DEFAULT_CWD, timeout: 10000 });
    const versionText = [stdout, stderr]
      .join('\n')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);

    return versionText || null;
  } catch {
    return null;
  }
}

export async function refreshOpenCodeAvailability() {
  const binaryPath = await resolveOpenCodeBinary();
  const version = binaryPath ? await getOpenCodeVersion(binaryPath) : null;
  const isInstalling = Boolean(opencodeInstallProcess);
  const isRunning = Boolean(opencodeRuntimeProcess);

  runtimeState.opencode.installed = Boolean(binaryPath);
  runtimeState.opencode.available = Boolean(binaryPath);
  runtimeState.opencode.commandPath = binaryPath;
  runtimeState.opencode.version = version;

  if (isInstalling) {
    runtimeState.opencode.status = 'installing';
    if (!runtimeState.opencode.message) {
      runtimeState.opencode.message = 'Instalando OpenCode con npm…';
    }
    return;
  }

  if (isRunning) {
    runtimeState.opencode.status = 'running';
    runtimeState.opencode.message = 'OpenCode está ejecutándose.';
    return;
  }

  runtimeState.opencode.status = 'stopped';
  runtimeState.opencode.message = binaryPath
    ? `OpenCode detectado${version ? ` (${version})` : ''}.`
    : 'OpenCode no está instalado. Al iniciarlo se instala solo.';
}

function appendOpenCodeMessage(message: string) {
  const trimmed = message.trim();
  if (trimmed) {
    runtimeState.opencode.message = trimmed;
  }
}

export async function startOpenCodeInstall() {
  if (opencodeInstallProcess) {
    return;
  }

  runtimeState.opencode.status = 'installing';
  runtimeState.opencode.lastStartedAt = new Date().toISOString();
  runtimeState.opencode.lastExitCode = null;
  runtimeState.opencode.message = 'Instalando OpenCode con npm…';

  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  opencodeInstallProcess = spawn(command, ['install', '-g', 'opencode-ai'], {
    cwd: DEFAULT_CWD,
    env: process.env,
  });

  opencodeInstallProcess.stdout.on('data', (chunk) => {
    appendOpenCodeMessage(String(chunk));
  });

  opencodeInstallProcess.stderr.on('data', (chunk) => {
    appendOpenCodeMessage(String(chunk));
  });

  opencodeInstallProcess.on('error', async (error) => {
    opencodeInstallProcess = null;
    runtimeState.opencode.lastExitCode = -1;
    runtimeState.opencode.status = 'stopped';
    runtimeState.opencode.message = `OpenCode install failed: ${error.message}`;
    await refreshOpenCodeAvailability();
  });

  opencodeInstallProcess.on('close', async (code) => {
    opencodeInstallProcess = null;
    runtimeState.opencode.lastExitCode = code ?? null;
    await refreshOpenCodeAvailability();
    runtimeState.opencode.message = code === 0
      ? 'OpenCode instalado con éxito. Tocá Iniciar de nuevo para abrirlo.'
      : `La instalación de OpenCode falló (código ${code ?? 'desconocido'}).`;
  });
}

export async function startOpenCodeRuntime() {
  if (opencodeRuntimeProcess || opencodeInstallProcess) {
    return;
  }

  await refreshOpenCodeAvailability();
  const binaryPath = runtimeState.opencode.commandPath;

  if (!binaryPath) {
    await startOpenCodeInstall();
    return;
  }

  runtimeState.opencode.status = 'running';
  runtimeState.opencode.lastStartedAt = new Date().toISOString();
  runtimeState.opencode.lastExitCode = null;
  runtimeState.opencode.message = 'Abriendo OpenCode…';

  opencodeRuntimeProcess = spawn(binaryPath, [], {
    cwd: DEFAULT_CWD,
    env: process.env,
  });

  opencodeRuntimeProcess.stdout.on('data', (chunk) => {
    appendOpenCodeMessage(String(chunk));
  });

  opencodeRuntimeProcess.stderr.on('data', (chunk) => {
    appendOpenCodeMessage(String(chunk));
  });

  opencodeRuntimeProcess.on('error', async (error) => {
    opencodeRuntimeProcess = null;
    runtimeState.opencode.lastExitCode = -1;
    runtimeState.opencode.status = 'stopped';
    runtimeState.opencode.message = `OpenCode failed to launch: ${error.message}`;
    await refreshOpenCodeAvailability();
  });

  opencodeRuntimeProcess.on('close', async (code) => {
    opencodeRuntimeProcess = null;
    runtimeState.opencode.lastExitCode = code ?? null;
    runtimeState.opencode.status = 'stopped';
    await refreshOpenCodeAvailability();
    runtimeState.opencode.message = code === 0
      ? 'OpenCode se cerró normalmente.'
      : `OpenCode se cerró con código ${code ?? 'desconocido'}.`;
  });
}

export async function stopOpenCodeRuntime() {
  if (opencodeInstallProcess) {
    opencodeInstallProcess.kill();
    opencodeInstallProcess = null;
  }

  if (opencodeRuntimeProcess) {
    opencodeRuntimeProcess.kill();
    opencodeRuntimeProcess = null;
  }

  runtimeState.opencode.lastExitCode = null;
  await refreshOpenCodeAvailability();
}

/** true si hay un proceso de OpenCode (install o runtime) vivo ahora mismo. */
export function isOpenCodeBusy(): boolean {
  return Boolean(opencodeInstallProcess || opencodeRuntimeProcess);
}
