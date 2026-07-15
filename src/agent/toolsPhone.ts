/**
 * toolsPhone.ts — Herramientas del TELÉFONO y VISIÓN del executor local.
 * Todo lo que sale del sandbox de archivos/terminal y habla con el hardware:
 *   - phone.location / phone.contacts / phone.calendar / phone.photo → puente
 *     HTTP con el servidor de capacidades nativas (Kotlin) en 127.0.0.1:8099.
 *   - image.view → carga una imagen del disco como base64 para que el modelo la VEA.
 * Módulo solo-Node (usa fetch/fs); lo consume tools.ts vía executePhoneTool.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import type { ToolCallLike, ToolExecutionResult } from './types';
import { MAX_IMAGE_BYTES, imageMediaTypeFor } from './toolShared';
import { resolveTargetPath, type ToolExecutionContext } from './toolsFsHelpers';

/** Tools que este módulo atiende (nombres con punto, como los ve el executor). */
export const PHONE_TOOLS = new Set([
  'phone.location',
  'phone.contacts',
  'phone.calendar',
  'phone.photo',
  'phone.packages',
  'image.view',
]);

// Puente con el servidor de capacidades nativas (Kotlin) — cámara/GPS/contactos.
const NATIVE_TOOLS_BASE = process.env.NOVACLAW_NATIVE_URL || 'http://127.0.0.1:8099';

async function callNativeTool(pathAndQuery: string): Promise<any> {
  const token = process.env.NOVACLAW_TOKEN || '';
  const res = await fetch(`${NATIVE_TOOLS_BASE}${pathAndQuery}`, {
    signal: AbortSignal.timeout(15000),
    headers: token ? { 'X-Nova-Token': token } : undefined,
  });
  const data = await res.json();
  if (data && data.error) {
    throw new Error(data.error);
  }
  return data;
}

/** Lee un archivo de imagen y lo devuelve como base64 + media type para vision. */
async function loadImageAsBase64(imagePath: string): Promise<{ mediaType: string; data: string }> {
  const mediaType = imageMediaTypeFor(imagePath);
  if (!mediaType) {
    throw new Error(`Unsupported image type "${path.extname(imagePath).toLowerCase()}". Use jpg, png, webp or gif.`);
  }
  const stat = await fs.stat(imagePath);
  if (!stat.isFile()) throw new Error(`Not a file: ${imagePath}`);
  if (stat.size > MAX_IMAGE_BYTES) {
    throw new Error(`Image too large (${Math.round(stat.size / 1024)} KB, max 5 MB).`);
  }
  const buf = await fs.readFile(imagePath);
  return { mediaType, data: buf.toString('base64') };
}

/** Ejecuta una tool de teléfono/visión. Se asume que PHONE_TOOLS.has(call.tool). */
export async function executePhoneTool(
  call: ToolCallLike,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  if (call.tool === 'phone.location') {
    try {
      const loc = await callNativeTool('/location');
      return {
        name: 'phone.location',
        command: 'location',
        status: 'success',
        output: JSON.stringify(loc),
        cwd: context.cwd,
      };
    } catch (error: any) {
      return {
        name: 'phone.location',
        command: 'location',
        status: 'error',
        output: error?.message ?? 'Could not read location.',
        cwd: context.cwd,
      };
    }
  }

  if (call.tool === 'phone.contacts') {
    const q = String(call.arguments.query ?? '').trim();
    try {
      const data = await callNativeTool(`/contacts?q=${encodeURIComponent(q)}`);
      const list = (data.contacts ?? [])
        .map((c: any) => `${c.name || '(sin nombre)'} — ${c.number}`)
        .join('\n');
      return {
        name: 'phone.contacts',
        command: `contacts ${q}`.trim(),
        status: 'success',
        output: list || 'No matching contacts.',
        cwd: context.cwd,
      };
    } catch (error: any) {
      return {
        name: 'phone.contacts',
        command: `contacts ${q}`.trim(),
        status: 'error',
        output: error?.message ?? 'Could not read contacts.',
        cwd: context.cwd,
      };
    }
  }

  if (call.tool === 'phone.calendar') {
    const days = Math.max(1, Math.min(365, Math.floor(Number(call.arguments.days) || 14)));
    try {
      const data = await callNativeTool(`/calendar?days=${days}`);
      const events = Array.isArray(data.events) ? data.events : [];
      const list = events
        .map((e: any) => `- ${e.start}${e.allDay ? ' (todo el día)' : ''}: ${e.title}${e.location ? ` @ ${e.location}` : ''}`)
        .join('\n');
      return {
        name: 'phone.calendar',
        command: `calendar ${days}d`,
        status: 'success',
        output: events.length
          ? `${data.count} evento(s) en los próximos ${days} días:\n${list}`
          : `No hay eventos en los próximos ${days} días.`,
        cwd: context.cwd,
      };
    } catch (error: any) {
      return {
        name: 'phone.calendar',
        command: `calendar ${days}d`,
        status: 'error',
        output: error?.message ?? 'Could not read calendar.',
        cwd: context.cwd,
      };
    }
  }

  if (call.tool === 'phone.packages') {
    const action = ['installed', 'uninstalled', 'search'].includes(String(call.arguments.action))
      ? String(call.arguments.action)
      : 'installed';
    const q = String(call.arguments.query ?? '').trim();
    const includeSystem = call.arguments.include_system === true;
    const limit = Math.max(1, Math.min(300, Math.floor(Number(call.arguments.limit) || 50)));
    const cmd = `packages ${action}${q ? ` "${q}"` : ''}`;
    try {
      const params = new URLSearchParams({ action, limit: String(limit) });
      if (q) params.set('q', q);
      if (includeSystem) params.set('system', '1');
      const data = await callNativeTool(`/packages?${params.toString()}`);

      if (action === 'uninstalled') {
        const items = Array.isArray(data.uninstalled) ? data.uninstalled : [];
        const list = items
          .map((p: any) => {
            const name = p.name ? `${p.name} (${p.package})` : p.package;
            const when = p.uninstalledAt
              ? `desinstalada el ${p.uninstalledAt}`
              : `desinstalada entre ${p.uninstalledBetween}`;
            return `- ${name} — ${when}`;
          })
          .join('\n');
        return {
          name: 'phone.packages',
          command: cmd,
          status: 'success',
          output: items.length
            ? `${data.count} desinstalación(es) registradas (la más reciente primero):\n${list}`
            : String(data.note || 'Sin desinstalaciones registradas todavía.'),
          cwd: context.cwd,
        };
      }

      const items = Array.isArray(data.packages) ? data.packages : [];
      const list = items
        .map((p: any) => {
          const extras = [
            p.version ? `v${p.version}` : '',
            `instalada ${p.installedAt}`,
            p.updatedAt ? `act. ${p.updatedAt}` : '',
            p.system ? 'sistema' : '',
          ].filter(Boolean).join(', ');
          return `- ${p.name} (${p.package}) — ${extras}`;
        })
        .join('\n');
      return {
        name: 'phone.packages',
        command: cmd,
        status: 'success',
        output: items.length
          ? `${data.count} de ${data.total} app(s)${action === 'search' ? ` que coinciden con "${q}"` : ', las instaladas más recientemente primero'}:\n${list}`
          : (action === 'search' ? `Ninguna app coincide con "${q}".` : 'No se encontraron apps.'),
        cwd: context.cwd,
      };
    } catch (error: any) {
      return {
        name: 'phone.packages',
        command: cmd,
        status: 'error',
        output: error?.message ?? 'Could not read the package list.',
        cwd: context.cwd,
      };
    }
  }

  if (call.tool === 'phone.photo') {
    const facing = String(call.arguments.facing ?? 'back');
    try {
      const data = await callNativeTool(`/photo?facing=${encodeURIComponent(facing)}`);
      // Adjuntamos la foto para que el modelo la VEA de una (no solo el path).
      let image: { mediaType: string; data: string } | undefined;
      try {
        image = await loadImageAsBase64(String(data.path));
      } catch {
        image = undefined; // si no se puede leer, al menos damos el path
      }
      return {
        name: 'phone.photo',
        command: `photo ${facing}`,
        status: 'success',
        output: image
          ? `Photo taken (${data.facing} camera), saved to ${data.path}. See the attached image.`
          : `Photo saved: ${data.path} (${data.bytes} bytes, ${data.facing} camera). Use image_view to look at it.`,
        image,
        cwd: context.cwd,
      };
    } catch (error: any) {
      return {
        name: 'phone.photo',
        command: `photo ${facing}`,
        status: 'error',
        output: error?.message ?? 'Could not take a photo.',
        cwd: context.cwd,
      };
    }
  }

  if (call.tool === 'image.view') {
    const targetPath = resolveTargetPath(String(call.arguments.path ?? ''), context.cwd);
    try {
      const image = await loadImageAsBase64(targetPath);
      return {
        name: 'image.view',
        command: targetPath,
        status: 'success',
        output: `Loaded image ${targetPath}. See the attached image.`,
        image,
        cwd: context.cwd,
      };
    } catch (error: any) {
      return {
        name: 'image.view',
        command: targetPath,
        status: 'error',
        output: error?.message ?? 'Could not load the image.',
        cwd: context.cwd,
      };
    }
  }

  throw new Error(`Unsupported phone tool: ${call.tool}`);
}
