/**
 * upload.ts — Subida de CUALQUIER archivo al workspace del agente. El body va
 * como binario crudo (no JSON) y se streamea a disco, así soporta archivos
 * GRANDES sin cargarlos en memoria ni inflarlos en base64. El agente después lo
 * analiza con sus tools (file_extract/markitdown, image_view, file_read, unzip…).
 *
 * Queda bajo /api → ya está protegido por el token (X-Nova-Token) en server.ts.
 */
import type { Express, Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';

// Los uploads viven en el workspace del agente (HOME=/root en el teléfono).
const UPLOAD_DIR = path.join(process.env.HOME || process.cwd(), 'uploads');
const MAX_BYTES = 200 * 1024 * 1024; // 200 MB

/** Nombre seguro: sin rutas, sin metacaracteres raros; conserva la extensión. */
function sanitizeName(raw: string): string {
  const base = path.basename(String(raw || 'archivo')).replace(/[^\w.\-]+/g, '_').slice(0, 140);
  return base.replace(/^\.+/, '') || 'archivo';
}

/** Si ya existe, agrega un sufijo incremental para no pisar. */
function uniqueTarget(dir: string, name: string): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  let i = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem}-${i}${ext}`);
    i += 1;
  }
  return candidate;
}

export function registerUploadRoute(app: Express): void {
  app.post('/api/upload', (req: Request, res: Response) => {
    try {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    } catch (e: any) {
      return res.status(500).json({ error: `No se pudo preparar la carpeta de subidas: ${e?.message ?? e}` });
    }

    const name = sanitizeName((req.query.name as string) ?? '');
    const target = uniqueTarget(UPLOAD_DIR, name);
    const out = fs.createWriteStream(target);
    let bytes = 0;
    let aborted = false;

    const fail = (msg: string, code = 500) => {
      if (aborted) return;
      aborted = true;
      try { out.destroy(); } catch { /* noop */ }
      try { fs.unlinkSync(target); } catch { /* noop */ }
      if (!res.headersSent) res.status(code).json({ error: msg });
    };

    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) fail('El archivo supera el máximo (200 MB).', 413);
    });
    req.on('error', () => fail('Falló la subida del archivo.'));
    out.on('error', (e) => fail(`No se pudo escribir el archivo: ${e?.message ?? e}`));
    out.on('finish', () => {
      if (aborted) return;
      res.json({ path: target, name: path.basename(target), bytes });
    });

    req.pipe(out);
  });
}
