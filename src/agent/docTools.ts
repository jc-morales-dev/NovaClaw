/**
 * docTools.ts — Deja listas las herramientas para ANALIZAR ARCHIVOS que sube el
 * usuario (PDF, Office, ZIP, …). Se instalan UNA vez, en segundo plano, al
 * arrancar el agente en el teléfono; guardado por marcador; nunca bloquea.
 *
 * Qué instala (y por qué en este orden):
 *   1. update-ca-certificates → arregla el bundle de CA que bajo proot no se
 *      genera (sin esto, curl Y pip fallan el TLS: "no CA certificate bundle").
 *   2. poppler-utils (pdftotext) + unzip por apt → PDF y ZIP, robusto.
 *   3. markitdown por pip (con --trusted-host de respaldo) → PDF/Word/Excel/
 *      PowerPoint/… a Markdown limpio para la IA (alta calidad).
 * Si algo falla, file_extract igual funciona con lo que sí se instaló (pdftotext,
 * unzip, lectura directa de texto).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { sanitizeChildEnv } from './childEnv';

const MARKER = path.join(os.homedir() || '/root', '.novaclaw', 'doctools-ready');

const SCRIPT = [
  'export DEBIAN_FRONTEND=noninteractive',
  'update-ca-certificates --fresh >/dev/null 2>&1',
  'apt-get install -y --no-install-recommends poppler-utils unzip >/dev/null 2>&1',
  'command -v pip3 >/dev/null 2>&1 || apt-get install -y --no-install-recommends python3-pip >/dev/null 2>&1',
  'pip3 install --break-system-packages --trusted-host pypi.org --trusted-host files.pythonhosted.org "markitdown[pdf,docx,pptx,xlsx]" >/dev/null 2>&1',
].join('\n');

function markReady(): void {
  try {
    mkdirSync(path.dirname(MARKER), { recursive: true });
    writeFileSync(MARKER, 'ok', 'utf8');
  } catch {
    // sin marcador → se reintenta el chequeo el próximo arranque
  }
}

/** Provisiona las herramientas de análisis de archivos una vez, en background. */
export function ensureDocToolsInstalled(): void {
  // Solo en el runtime del teléfono (RuntimeManager setea NOVACLAW_TOKEN).
  if (!process.env.NOVACLAW_TOKEN) return;
  if (existsSync(MARKER)) return;

  // Si markitdown Y pdftotext ya están, solo marcamos.
  try {
    const md = spawnSync('python3', ['-m', 'markitdown', '--version'], { encoding: 'utf8', timeout: 8000 });
    const pdf = spawnSync('pdftotext', ['-v'], { encoding: 'utf8', timeout: 8000 });
    if (!md.error && md.status === 0 && !pdf.error) {
      markReady();
      return;
    }
  } catch {
    // seguimos a la instalación
  }

  console.log('[docTools] Instalando herramientas para analizar archivos (PDF/Office/ZIP) en segundo plano…');
  try {
    const child = spawn(process.env.SHELL || 'sh', ['-c', SCRIPT], {
      detached: true, stdio: 'ignore', env: sanitizeChildEnv(process.env),
    });
    child.on('exit', () => {
      // Marcamos aunque markitdown falle: pdftotext/unzip suelen quedar OK y no
      // queremos reintentar la instalación pesada en cada arranque.
      markReady();
      console.log('[docTools] Herramientas de archivos provisionadas.');
    });
    child.on('error', () => console.log('[docTools] No se pudo lanzar la instalación; queda on-demand.'));
    child.unref();
  } catch {
    console.log('[docTools] No se pudo lanzar la instalación; queda on-demand.');
  }
}
