/**
 * Skills on-demand (B6) — al estilo Claude Code. Cada skill vive en
 * `skills/<nombre>/SKILL.md` bajo el workspace. Este módulo arma un ÍNDICE
 * liviano (nombre + descripción) que se inyecta al system prompt en cada turno;
 * el agente lee el SKILL.md completo con file_read SOLO cuando la tarea aplica.
 * Así la capacidad crece sin inflar el prompt base.
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_SKILLS = 50;

/** Descripción de un SKILL.md: frontmatter `description:` o la 1ª línea de texto. */
export function readSkillDescription(skillMdPath: string): string {
  try {
    const raw = fs.readFileSync(skillMdPath, 'utf8');
    const fm = raw.match(/^---[\s\S]*?\ndescription:\s*(.+?)\s*(?:\n|$)/i);
    if (fm) return fm[1].trim().replace(/^["']|["']$/g, '').slice(0, 200);
    for (const line of raw.split('\n')) {
      const t = line.trim().replace(/^#+\s*/, '').replace(/^---$/, '');
      if (t) return t.slice(0, 200);
    }
  } catch {
    // sin descripción legible
  }
  return '';
}

/**
 * Índice markdown de las skills disponibles, o '' si no hay ninguna.
 * Cada línea: nombre, descripción y la ruta del SKILL.md para leerlo entero.
 */
export function buildSkillsIndex(cwd: string): string {
  try {
    const skillsDir = path.join(cwd, 'skills');
    if (!fs.existsSync(skillsDir) || !fs.statSync(skillsDir).isDirectory()) return '';
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    const items: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const rel = path.join('skills', e.name, 'SKILL.md');
      const skillMd = path.join(skillsDir, e.name, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      const desc = readSkillDescription(skillMd);
      items.push(`- **${e.name}** — ${desc || '(sin descripción)'} · leé \`${rel}\` para el detalle completo.`);
      if (items.length >= MAX_SKILLS) break;
    }
    if (items.length === 0) return '';
    return [
      '## Available skills (on-demand)',
      'Reusable playbooks the user (or you) saved. When a task matches one, READ its SKILL.md with file_read for the full steps BEFORE acting — do not guess.',
      ...items,
    ].join('\n');
  } catch {
    return '';
  }
}
