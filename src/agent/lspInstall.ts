/**
 * lspInstall.ts — Deja code_intel listo DE FÁBRICA: instala el language server
 * (typescript-language-server@4.3.3 + typescript@5) UNA sola vez, en segundo
 * plano, la primera vez que arranca el agente en el teléfono. Guardado por un
 * marcador; nunca bloquea ni tira el arranque; si falla, queda el camino
 * on-demand (el agente lo instala cuando se usa code_intel).
 *
 * Versiones pinneadas a propósito: 4.3.3 = última que corre en Node 18 del Linux
 * embebido; typescript@5 = trae el lib/tsserver.js clásico que el LSP entiende
 * (el typescript 7.x nativo no lo trae).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { sanitizeChildEnv } from './childEnv';

const MARKER = path.join(os.homedir() || '/root', '.novaclaw', 'lsp-ready');
const INSTALL_CMD = 'npm i -g typescript-language-server@4.3.3 typescript@5';

function markReady(): void {
  try {
    mkdirSync(path.dirname(MARKER), { recursive: true });
    writeFileSync(MARKER, 'ok', 'utf8');
  } catch {
    // sin marcador solo reintentará el chequeo el próximo arranque; no es grave
  }
}

/** Instala el language server una vez, en segundo plano. No bloquea ni lanza. */
export function ensureLspInstalled(): void {
  // Solo en el runtime del teléfono (RuntimeManager setea NOVACLAW_TOKEN); en la
  // PC de dev no queremos ensuciar el npm global.
  if (!process.env.NOVACLAW_TOKEN) return;
  if (existsSync(MARKER)) return;

  // ¿Ya está instalado (p.ej. el usuario lo puso a mano)? → solo marcar.
  try {
    const check = spawnSync('typescript-language-server', ['--version'], {
      encoding: 'utf8', timeout: 8000, shell: false,
    });
    if (!check.error && check.status === 0) {
      markReady();
      return;
    }
  } catch {
    // seguimos al install
  }

  console.log('[LSP] Instalando language server para code_intel en segundo plano…');
  try {
    const child = spawn(process.env.SHELL || 'sh', ['-c', INSTALL_CMD], {
      detached: true, stdio: 'ignore', env: sanitizeChildEnv(process.env),
    });
    child.on('exit', (code) => {
      if (code === 0) {
        markReady();
        console.log('[LSP] Language server listo — code_intel disponible.');
      } else {
        console.log(`[LSP] La instalación falló (code ${code}); code_intel se instalará on-demand al usarse.`);
      }
    });
    child.on('error', () => {
      console.log('[LSP] No se pudo lanzar la instalación; code_intel queda on-demand.');
    });
    child.unref();
  } catch {
    console.log('[LSP] No se pudo lanzar la instalación; code_intel queda on-demand.');
  }
}
