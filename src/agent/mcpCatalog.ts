/**
 * mcpCatalog.ts — Catálogo curado de servidores MCP conocidos.
 *
 * Es la lista "de un toque" de la UI y la referencia que usa el agente cuando le
 * pedís "instalá el MCP de X": ya sabe el paquete, el comando y qué secreto pide
 * (con el link para generarlo). Para lo que NO está acá, el agente igual puede
 * instalar cualquier comando, pero marcado como "no verificado".
 */

export type McpSecretSpec = {
  /** Nombre de la variable de entorno que el servidor MCP espera (ej: GITHUB_PERSONAL_ACCESS_TOKEN). */
  env: string;
  /** Etiqueta corta para la UI/el agente (ej: "Token de GitHub"). */
  label: string;
  /** Dónde generarlo (link que el usuario abre). */
  helpUrl?: string;
  /** Pista de permisos/scopes (ej: "permiso 'repo'"). */
  hint?: string;
};

export type McpAuthSpec =
  | { type: 'none' }
  | { type: 'token'; secret: McpSecretSpec }
  // Fase B: device flow (el "código"). endpoints conocidos por proveedor.
  | {
      type: 'device';
      secret: McpSecretSpec;
      deviceAuthUrl: string;
      tokenUrl: string;
      clientId: string;
      scope?: string;
    };

export type McpCatalogEntry = {
  /** Id/slug estable (ej: "github"). Es el nombre del servidor en la config. */
  id: string;
  /** Nombre lindo para la UI (ej: "GitHub"). */
  label: string;
  /** Una línea de qué hace. */
  description: string;
  command: string;
  args: string[];
  auth: McpAuthSpec;
  /** true si es oficial/verificado (para el badge de confianza en la UI). */
  verified: boolean;
  /** Palabras que ayudan a matchear "instalá el MCP de ..." → esta entrada. */
  aliases?: string[];
};

/**
 * Curado a mano. Todos usan `npx -y <paquete>` (stdio), que es lo que corre en
 * el Linux embebido. Los tokens van al Keystore vía ${SECRET:<id>} — nunca al
 * archivo de config en texto plano.
 */
export const MCP_CATALOG: McpCatalogEntry[] = [
  {
    id: 'filesystem',
    label: 'Archivos',
    description: 'Leer y escribir archivos de una carpeta que vos elijas.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
    auth: { type: 'none' },
    verified: true,
    aliases: ['files', 'filesystem', 'archivos', 'fs'],
  },
  {
    id: 'memory',
    label: 'Memoria',
    description: 'Memoria persistente tipo grafo de conocimiento para el agente.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    auth: { type: 'none' },
    verified: true,
    aliases: ['memory', 'memoria', 'knowledge'],
  },
  {
    id: 'github',
    label: 'GitHub',
    description: 'Repos, issues, PRs y código de GitHub.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    auth: {
      // GitHub soporta device flow → en Fase B esto puede pasar a type:'device'.
      type: 'token',
      secret: {
        env: 'GITHUB_PERSONAL_ACCESS_TOKEN',
        label: 'Token de GitHub',
        helpUrl: 'https://github.com/settings/tokens/new?scopes=repo&description=NovaClaw',
        hint: "permiso 'repo' (y 'read:org' si usás organizaciones)",
      },
    },
    verified: true,
    aliases: ['github', 'git hub', 'gh'],
  },
  {
    id: 'gitlab',
    label: 'GitLab',
    description: 'Repos, issues y merge requests de GitLab.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-gitlab'],
    auth: {
      type: 'token',
      secret: {
        env: 'GITLAB_PERSONAL_ACCESS_TOKEN',
        label: 'Token de GitLab',
        helpUrl: 'https://gitlab.com/-/user_settings/personal_access_tokens',
        hint: "scope 'api'",
      },
    },
    verified: true,
    aliases: ['gitlab'],
  },
  {
    id: 'slack',
    label: 'Slack',
    description: 'Leer y enviar mensajes en tus canales de Slack.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    auth: {
      type: 'token',
      secret: {
        env: 'SLACK_BOT_TOKEN',
        label: 'Bot token de Slack',
        helpUrl: 'https://api.slack.com/apps',
        hint: "token que empieza con 'xoxb-'",
      },
    },
    verified: true,
    aliases: ['slack'],
  },
  {
    id: 'postgres',
    label: 'PostgreSQL',
    description: 'Consultar una base de datos PostgreSQL (solo lectura).',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres'],
    auth: {
      type: 'token',
      secret: {
        env: 'POSTGRES_CONNECTION_STRING',
        label: 'Cadena de conexión',
        hint: 'postgresql://usuario:clave@host:5432/basededatos',
      },
    },
    verified: true,
    aliases: ['postgres', 'postgresql', 'pg', 'base de datos', 'database'],
  },
  {
    id: 'brave-search',
    label: 'Búsqueda web (Brave)',
    description: 'Buscar en la web con la API de Brave Search.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    auth: {
      type: 'token',
      secret: {
        env: 'BRAVE_API_KEY',
        label: 'API key de Brave Search',
        helpUrl: 'https://brave.com/search/api/',
        hint: 'plan gratuito disponible',
      },
    },
    verified: true,
    aliases: ['brave', 'busqueda', 'search', 'web search'],
  },
];

/** Busca una entrada del catálogo por id o alias (para "instalá el MCP de ..."). */
export function findCatalogEntry(query: string): McpCatalogEntry | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  return MCP_CATALOG.find(
    (e) => e.id === q || e.label.toLowerCase() === q || (e.aliases ?? []).some((a) => a === q || q.includes(a)),
  );
}

/** Vista liviana para la UI/el agente (sin exponer nada sensible; no hay secretos acá). */
export function catalogForClient() {
  return MCP_CATALOG.map((e) => ({
    id: e.id,
    label: e.label,
    description: e.description,
    verified: e.verified,
    needsSecret: e.auth.type !== 'none',
    secretLabel: e.auth.type === 'none' ? null : e.auth.secret.label,
    secretHelpUrl: e.auth.type === 'none' ? null : e.auth.secret.helpUrl ?? null,
    secretHint: e.auth.type === 'none' ? null : e.auth.secret.hint ?? null,
    authType: e.auth.type,
  }));
}
