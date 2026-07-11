/**
 * Limpia la salida del modelo para quedarse con un título usable: quita el
 * razonamiento (<think>…</think>), prefijos tipo "Título:", comillas y puntos.
 * Toma la última línea con texto (los razonadores ponen el título al final).
 */
export function cleanTitle(raw: string): string {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  let cand = lines[lines.length - 1] || '';
  cand = cand.replace(/^(t[ií]tulo|title)\s*:\s*/i, '');
  cand = cand.replace(/^["'#*\s]+|["'.\s]+$/g, '');
  return cand.slice(0, 48);
}

/**
 * Título "por tema" derivado de la primera pregunta, SIN llamar al modelo.
 * Quita muletillas iniciales ("cuáles son", "dame", "explicame"…) y capitaliza.
 * Es el respaldo cuando el modelo (p.ej. un razonador) no devuelve texto útil.
 */
export function smartFallbackTitle(firstUser: string): string {
  let t = firstUser.trim().replace(/\s+/g, ' ');
  t = t.replace(/^(hola[,\s]+)?/i, '');
  t = t.replace(/^(me\s+)?(puedes?|podr[ií]as?|podes|podr[ií]a)\s+/i, '');
  t = t.replace(/^(dame|explicame|expl[ií]came|dime|cu[aá]les?\s+son|cu[aá]l\s+es|qu[eé]\s+es|c[oó]mo|como|necesito|quiero|ay[uú]dame|hazme|escr[ií]beme|dame\s+informaci[oó]n\s+sobre|habl[aá]me\s+de|cu[eé]ntame\s+sobre)\s+/i, '');
  t = t.replace(/^(a\s+)?(los|las|el|la|un|una|unos|unas)\s+/i, '');
  t = t.trim();
  if (!t) return firstUser.trim().slice(0, 42) || 'Nueva conversación';
  return (t.charAt(0).toUpperCase() + t.slice(1)).slice(0, 42);
}
