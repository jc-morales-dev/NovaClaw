/**
 * toolShared.ts — Lógica PURA compartida por los dos tool executors:
 *   - tools.ts (Node: PC dev y agente embebido en el APK)
 *   - toolsWebView.ts (Capacitor/WebView: shell nativo por plugin)
 *
 * Regla: acá no se toca fs, shell ni red — solo transformaciones y
 * validaciones. Así los dos executors no pueden divergir en el
 * comportamiento visible al modelo (mensajes de error incluidos).
 */

// ── Límites compartidos ──────────────────────────────────────────────────────
export const MAX_READ_BYTES = 256 * 1024; // 256 KB: protege la ventana de contexto
export const MAX_READ_LINES = 2000; // líneas por lectura sin rango explícito
export const WEB_FETCH_MAX_CHARS = 80 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB

// ── Imágenes (vision) ────────────────────────────────────────────────────────
export const IMAGE_MEDIA_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** Media type por extensión, o null si el formato no lo soportan los modelos. */
export function imageMediaTypeFor(filePath: string): string | null {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = filePath.slice(dot).toLowerCase();
  return IMAGE_MEDIA_TYPES[ext] ?? null;
}

// ── file.read: numeración de líneas estilo `cat -n` ─────────────────────────
/**
 * Formatea el contenido de un archivo con números de línea, respetando
 * offset/limit (1-based) para leer ventanas de archivos grandes. Así el
 * modelo puede referenciar líneas exactas al editar.
 */
export function formatWithLineNumbers(
  content: string,
  args: Record<string, any>,
  maxLines: number = MAX_READ_LINES,
  maxBytes: number = MAX_READ_BYTES,
): string {
  const bounded = content.length > maxBytes ? content.slice(0, maxBytes) : content;
  const lines = bounded.split('\n');
  const totalLines = lines.length;

  const offset = Math.max(1, Math.floor(Number(args.offset)) || 1);
  const hasLimit = args.limit !== undefined && args.limit !== null;
  const limit = hasLimit ? Math.max(1, Math.floor(Number(args.limit))) : maxLines;

  if (offset > totalLines) {
    return `[file has ${totalLines} lines; offset ${offset} is past the end]`;
  }

  const startIdx = offset - 1;
  const endIdx = Math.min(startIdx + limit, totalLines);
  const width = String(endIdx).length;
  const numbered = lines
    .slice(startIdx, endIdx)
    .map((line, i) => `${String(offset + i).padStart(width, ' ')}\t${line}`)
    .join('\n');

  const notes: string[] = [];
  if (endIdx < totalLines) {
    notes.push(`[... ${totalLines - endIdx} more lines below; use offset=${endIdx + 1} to continue ...]`);
  }
  if (content.length > maxBytes) {
    notes.push(`[file truncated at ${maxBytes} bytes]`);
  }
  return notes.length ? `${numbered}\n${notes.join('\n')}` : numbered;
}

// ── file.edit: reemplazo quirúrgico old→new con validaciones ────────────────
// Nota: ambas ramas declaran todas las props (con undefined) porque el tsconfig
// del proyecto no usa strict y el narrowing por discriminante no aplica.
export type StringEditResult =
  | { ok: true; updated: string; replacedCount: number; error?: undefined }
  | { ok: false; error: string; updated?: undefined; replacedCount?: undefined };

/**
 * Aplica el reemplazo exacto old_string→new_string con las validaciones de
 * Claude Code: no encontrado → error claro; ambiguo → pedir más contexto o
 * replace_all. Ambos executors DEBEN usar esta función para no divergir.
 */
export function applyStringEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): StringEditResult {
  if (!oldString) {
    return { ok: false, error: 'old_string is empty. Provide the exact text to replace.' };
  }

  const occurrences = content.split(oldString).length - 1;
  if (occurrences === 0) {
    return {
      ok: false,
      error:
        'old_string was NOT found in the file. It must match exactly, including whitespace and indentation. Read the file again and copy the exact snippet.',
    };
  }
  if (occurrences > 1 && !replaceAll) {
    return {
      ok: false,
      error: `old_string appears ${occurrences} times in the file. Include more surrounding lines to make it unique, or set replace_all=true to replace every occurrence.`,
    };
  }

  const updated = replaceAll
    ? content.split(oldString).join(newString)
    : content.replace(oldString, newString);
  return { ok: true, updated, replacedCount: replaceAll ? occurrences : 1 };
}

// ── web.fetch: SSRF guard + reducción de HTML ────────────────────────────────
/**
 * SSRF guard: web.fetch no debe alcanzar loopback ni redes internas (sus
 * propios servidores 127.0.0.1:8088/8099, la LAN, o metadata de nube 169.254.x).
 */
export function isBlockedFetchHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '0.0.0.0' || h === '::1' || h === '::') return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  return /^fe80:/i.test(h) || /^fc/i.test(h) || /^fd/i.test(h);
}

/** Reduce HTML a texto legible para no quemar la ventana de contexto. */
export function htmlToReadableText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/** Trunca el body de web.fetch con la nota estándar. */
export function truncateFetchBody(body: string, maxChars: number = WEB_FETCH_MAX_CHARS): string {
  if (body.length <= maxChars) return body;
  return `${body.slice(0, maxChars)}\n\n[... truncated, response was ${body.length} chars ...]`;
}
