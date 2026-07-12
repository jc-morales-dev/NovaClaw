/**
 * webSearch.ts — Búsqueda web SIN API key (DuckDuckGo HTML). Le da al agente el
 * "buscar en internet" que le faltaba: hasta ahora solo podía LEER una URL con
 * web_fetch, no encontrarla. Con web_search encuentra las páginas y con web_fetch
 * las lee → patrón estilo Perplexity: buscar → abrir los mejores → sintetizar.
 *
 * Sin dependencias: usa el fetch global (Node 18+ y WebView). El parser del HTML
 * es PURO (parseDuckDuckGoHtml) para poder testearlo sin red; performWebSearch es
 * el único que toca la red.
 */

export type WebSearchResult = { title: string; url: string; snippet: string };

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

function fromCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return '';
  try {
    return String.fromCodePoint(cp);
  } catch {
    return '';
  }
}

/** Decodifica entidades HTML (nombradas comunes + numéricas &#NN; y &#xHH;). */
function decodeEntities(s: string): string {
  return s
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (m, name) => NAMED_ENTITIES[name] ?? m)
    .replace(/&#(\d+);/g, (_m, dec) => fromCodePoint(parseInt(dec, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => fromCodePoint(parseInt(hex, 16)));
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

/**
 * Extrae la URL real del redirect de DuckDuckGo. Los resultados vienen como
 * //duckduckgo.com/l/?uddg=<url-encodeada>&rut=… — devolvemos la url decodeada.
 * Si no hay redirect, normalizamos //host → https://host.
 */
export function decodeDuckDuckGoHref(href: string): string {
  const h = href.trim();
  const m = h.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      // uddg mal formado — caemos al normalizado de abajo
    }
  }
  if (h.startsWith('//')) return `https:${h}`;
  return h;
}

/**
 * Parser PURO del HTML de resultados de DuckDuckGo (endpoint html/lite).
 * Testeable sin red. Empareja título↔snippet por orden de aparición.
 */
export function parseDuckDuckGoHtml(html: string, maxResults: number): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  // Título/enlace: <a … class="… result__a …" … href="…">TÍTULO</a>
  const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  // Snippet: …class="… result__snippet …" …>SNIPPET</a>
  const snippetRe = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;

  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html)) !== null) snippets.push(stripTags(sm[1]));

  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = linkRe.exec(html)) !== null && results.length < maxResults) {
    const url = decodeDuckDuckGoHref(m[1]);
    const title = stripTags(m[2]);
    // Descartamos entradas sin título o que no apuntan a una página http(s).
    if (title && /^https?:\/\//i.test(url)) {
      results.push({ title, url, snippet: snippets[idx] ?? '' });
    }
    idx += 1;
  }
  return results;
}

/** Formatea los resultados como texto claro para devolver al modelo. */
export function formatSearchResults(query: string, results: WebSearchResult[]): string {
  if (results.length === 0) {
    return `No web results for "${query}". Try different keywords, or use web_fetch directly on a URL you already know.`;
  }
  const lines = results.map((r, i) =>
    `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`);
  return `Web results for "${query}":\n\n${lines.join('\n\n')}\n\nTo read a result in full, call web_fetch with its URL.`;
}

// html.duckduckgo.com no requiere key y devuelve resultados en HTML plano.
const SEARCH_ENDPOINT = 'https://html.duckduckgo.com/html/';

/**
 * Busca en la web (sin API key). Devuelve hasta maxResults resultados.
 * Lanza en error de red/timeout; el executor lo captura y lo reporta.
 */
export async function performWebSearch(query: string, maxResults = 8): Promise<WebSearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  const capped = Math.max(1, Math.min(maxResults, 20));
  const res = await fetch(SEARCH_ENDPOINT, {
    method: 'POST',
    signal: AbortSignal.timeout(20000),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Linux; Android 15; NovaClaw) AppleWebKit/537.36',
      Accept: 'text/html',
    },
    body: `q=${encodeURIComponent(q)}`,
  });
  const html = await res.text();
  return parseDuckDuckGoHtml(html, capped);
}
