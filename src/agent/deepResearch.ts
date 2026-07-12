/**
 * deepResearch.ts — Investigación PRO (fase 2): encadena búsqueda multi-fuente +
 * lectura + verificación cruzada en UNA capacidad. En vez de que el agente tenga
 * que orquestar a mano web_search → varios web_fetch → sintetizar (algo que los
 * modelos chicos hacen mal), el tool deep_research hace el fan-out solo y devuelve
 * un DOSSIER con extractos de varias fuentes + la instrucción de responder con
 * citas y contrastando las fuentes. Así CUALQUIER modelo investiga como un pro.
 *
 * Sin dependencias (fetch global). El armado del dossier es PURO (testeable) y la
 * orquestación acepta inyección de search/fetch para testear sin red.
 */
import { performWebSearch, type WebSearchResult } from './webSearch';
import { isBlockedFetchHost, htmlToReadableText } from './toolShared';

export type ResearchSource = {
  title: string;
  url: string;
  snippet: string;
  content: string;
  error: string;
};

/** Descarga una página y la devuelve como texto legible (HTML→texto), con guard SSRF. */
export async function fetchReadableText(
  url: string,
  maxChars: number,
): Promise<{ ok: boolean; text: string }> {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return { ok: false, text: 'invalid URL' };
  }
  if (!host || isBlockedFetchHost(host)) {
    return { ok: false, text: 'blocked: private/loopback address (SSRF)' };
  }
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: {
        'User-Agent': 'NovaClaw/1.0 (Android agent)',
        Accept: 'text/html,text/plain,application/json,*/*',
      },
      redirect: 'follow',
    });
    const contentType = res.headers.get('content-type') ?? '';
    let body = await res.text();
    if (/text\/html/i.test(contentType)) body = htmlToReadableText(body);
    body = body.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, maxChars);
    return { ok: res.ok, text: body || '(empty page)' };
  } catch (error: any) {
    return { ok: false, text: `fetch failed: ${error?.message ?? 'network error'}` };
  }
}

export interface DeepResearchOptions {
  maxSources?: number;
  perSourceChars?: number;
  /** Inyección para tests (por defecto: la búsqueda y el fetch reales). */
  search?: (query: string, max: number) => Promise<WebSearchResult[]>;
  fetchPage?: (url: string, maxChars: number) => Promise<{ ok: boolean; text: string }>;
}

/**
 * Busca la pregunta, abre las mejores fuentes EN PARALELO y devuelve sus extractos.
 * No usa el modelo (determinista); la síntesis la hace el agente con el dossier.
 */
export async function performDeepResearch(
  query: string,
  options: DeepResearchOptions = {},
): Promise<{ query: string; sources: ResearchSource[] }> {
  const maxSources = Math.max(1, Math.min(options.maxSources ?? 4, 8));
  const perSourceChars = options.perSourceChars ?? 2500;
  const search = options.search ?? performWebSearch;
  const fetchPage = options.fetchPage ?? fetchReadableText;

  const q = query.trim();
  if (!q) return { query: q, sources: [] };

  // Pedimos algunos de más por si alguna URL no se puede leer.
  const results = await search(q, maxSources + 3);
  const top = results.slice(0, maxSources);

  const sources = await Promise.all(
    top.map(async (r): Promise<ResearchSource> => {
      const page = await fetchPage(r.url, perSourceChars);
      return {
        title: r.title,
        url: r.url,
        snippet: r.snippet,
        content: page.ok ? page.text : '',
        error: page.ok ? '' : page.text,
      };
    }),
  );
  return { query: q, sources };
}

/** Arma el dossier de texto para el modelo (PURO, testeable). */
export function buildResearchDigest(query: string, sources: ResearchSource[]): string {
  const readable = sources.filter((s) => s.content);
  if (sources.length === 0) {
    return `No sources found for "${query}". Try web_search with different keywords.`;
  }

  const header =
    `Research digest for "${query}" — ${sources.length} source(s), ${readable.length} readable.\n\n` +
    'Write the answer FROM these sources. Cite them inline as [1], [2]… (the numbers below). ' +
    'CROSS-CHECK facts across sources: if they disagree or a claim appears in only one weak source, say so explicitly. ' +
    'Do NOT state anything that no source supports. If the sources are insufficient, say what is missing and consider another web_search.';

  const blocks = sources.map((s, i) => {
    const head = `## [${i + 1}] ${s.title}\n${s.url}`;
    const body = s.content
      ? s.content
      : `(could not read this page: ${s.error || 'no content'} — rely on the snippet: ${s.snippet || 'n/a'})`;
    return `${head}\n\n${body}`;
  });

  return `${header}\n\n${blocks.join('\n\n---\n\n')}`;
}
