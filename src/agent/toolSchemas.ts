/**
 * Definiciones de herramientas en JSON Schema para function-calling nativo.
 * Un solo set, que se traduce al formato de cada API (OpenAI vs Anthropic).
 * Los nombres coinciden con el executor en tools.ts.
 *
 * ⚠️ Las descripciones viajan ENTERAS en CADA llamada al modelo, antes del
 * mensaje del usuario. Con 26 herramientas eso eran ~4.500 tokens de prefill
 * por turno, y en proveedores sin prompt caching (NVIDIA) se re-procesan cada
 * vez — era la causa de que el primer "hola" tardara. Se escriben densas a
 * propósito: la regla que el modelo necesita, sin ejemplos ni relleno. Antes de
 * agregar una frase acá, preguntarse si el modelo falla sin ella.
 */

export interface ToolSchema {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: 'terminal_run',
    description:
      "Run a shell command in the phone's embedded Linux (ls, find, cat, git, pkg/npm install…). Also reaches /sdcard — the whole phone storage — when the Files connector is on.",
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'The shell command to execute.' } },
      required: ['command'],
    },
  },
  {
    name: 'file_read',
    description:
      'Read a text file. Output is prefixed with line numbers (like `cat -n`) so you can cite exact lines when editing. Use offset+limit to read a window of a large file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file.' },
        offset: { type: 'number', description: 'First line to read (1-based). Omit to start at the top.' },
        limit: { type: 'number', description: 'How many lines to read from offset. Omit to read to the end (capped).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'file_write',
    description:
      'Create a NEW file. To change an existing one prefer file_edit — only overwrite here when a full rewrite is really needed.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file.' },
        content: { type: 'string', description: 'Full file content.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'file_edit',
    description:
      'Replace an EXACT snippet in an existing file. old_string must match the file byte-for-byte (whitespace and indentation included) and be unique — add surrounding lines to disambiguate. Do NOT include the "<number>\\t" prefix that file_read adds. replace_all=true replaces every occurrence.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to edit.' },
        old_string: { type: 'string', description: 'Exact text to find (must be unique unless replace_all).' },
        new_string: { type: 'string', description: 'Replacement text.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence (default false).' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'file_edit_multi',
    description:
      'Several exact edits to ONE file, atomically. Same matching rules as file_edit. If any edit fails to match, NOTHING is written — fix and resend. Prefer this over repeated file_edit calls on the same file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to edit.' },
        edits: {
          type: 'array',
          description: 'Edits applied in order. All must match or none are written.',
          items: {
            type: 'object',
            properties: {
              old_string: { type: 'string', description: 'Exact text to find (unique unless replace_all).' },
              new_string: { type: 'string', description: 'Replacement text.' },
              replace_all: { type: 'boolean', description: 'Replace every occurrence (default false).' },
            },
            required: ['old_string', 'new_string'],
          },
        },
      },
      required: ['path', 'edits'],
    },
  },
  {
    name: 'file_grep',
    description:
      'Search file CONTENTS by regex, recursively. Returns matching lines as path:line: text. Use it to locate code before reading or editing. Skips node_modules, .git and binaries.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for (JS syntax).' },
        path: { type: 'string', description: 'Root directory or file to search (default: current dir).' },
        max_results: { type: 'number', description: 'Max matching lines to return (default 60).' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'file_extract',
    description:
      'Extract the text of a RICH file (PDF, .docx, .xlsx, .pptx, .zip, .html, .csv, .epub…) as clean Markdown. Use it on any non-plain-text file the user attaches — they land in ~/uploads. Plain text and code go to file_read; images to image_view.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to the file to extract (e.g. /root/uploads/informe.pdf).' } },
      required: ['path'],
    },
  },
  {
    name: 'file_list',
    description: 'List the entries of a directory.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path (default: current).' } },
    },
  },
  {
    name: 'file_search',
    description: 'Search for files by name pattern, recursively.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name substring to match.' },
        path: { type: 'string', description: 'Root directory to search (default: current).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'workspace_mkdir',
    description: 'Create a directory tree.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path to create.' } },
      required: ['path'],
    },
  },
  {
    name: 'diagnostics',
    description:
      "Run the language's type-checker or linter on a file and return the real compiler errors. Covers TypeScript, Python, JS, Go, Rust, C/C++, PHP, Ruby, shell and JSON. Call it right AFTER editing code to see what you broke instead of guessing. Says how to install the checker if it's missing.",
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to the code file to check.' } },
      required: ['path'],
    },
  },
  {
    name: 'code_intel',
    description:
      "Code intelligence via a real LSP server (TypeScript/JavaScript). Actions: 'symbols' (outline a file — pass path), 'find' (where a symbol is DEFINED — pass query), 'references' (every use of a symbol — pass query). Prefer it over file_grep on real code: it understands scopes and imports. Says how to install the server if it's missing.",
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['symbols', 'find', 'references'], description: 'What to do.' },
        query: { type: 'string', description: 'Symbol name (for find/references).' },
        path: { type: 'string', description: 'File to outline (symbols) or a file/dir to scope the project (find/references).' },
      },
      required: ['action'],
    },
  },
  {
    name: 'phone_location',
    description:
      "The phone's current GPS location plus a readable address (street, city, country). Needs the Location connector.",
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'phone_contacts',
    description: "Search the phone's contacts by name (or all if empty). Needs the Contacts connector.",
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Name to search, or empty for all.' } },
    },
  },
  {
    name: 'phone_photo',
    description:
      'Take a photo with the phone camera and view it automatically, so you can actually see and describe what is in front of the lens. Needs the Camera connector.',
    parameters: {
      type: 'object',
      properties: { facing: { type: 'string', enum: ['back', 'front'], description: 'Which camera.' } },
    },
  },
  {
    name: 'phone_packages',
    description:
      "The phone's apps: action='installed' lists them newest-first, 'uninstalled' shows the uninstall history, 'search' finds one by name or package. No connector needed.",
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['installed', 'uninstalled', 'search'], description: 'What to list.' },
        query: { type: 'string', description: 'Name or package to filter/search.' },
        include_system: { type: 'boolean', description: 'Include pure system apps in the installed list (default false).' },
        limit: { type: 'number', description: 'Max results (default 50).' },
      },
      required: ['action'],
    },
  },
  {
    name: 'phone_calendar',
    description:
      "The user's upcoming calendar events for the next N days (title, time, location). Needs the Calendar connector.",
    parameters: {
      type: 'object',
      properties: { days: { type: 'number', description: 'How many days ahead to look (default 14).' } },
    },
  },
  {
    name: 'image_view',
    description:
      'Look at an image file (jpg, png, webp, gif) and attach it so you can actually SEE it — describe it, read text in it, analyze a screenshot or photo.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to the image file.' } },
      required: ['path'],
    },
  },
  {
    name: 'deep_research',
    description:
      'Research a question across MULTIPLE web sources in one shot: searches, opens the best results, returns a numbered digest. Then synthesize citing [1][2] and flag disagreements between sources. Use it when the answer must be right and well-sourced — comparisons, current events, prices, fact-checking. One known URL → web_fetch; quick lookup → web_search.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The research question or topic.' },
        max_sources: { type: 'number', description: 'How many sources to read (default 4, max 8).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_search',
    description:
      "Search the WEB for a ranked list of results (title, URL, snippet). This is how you FIND pages when you don't know the URL. Then web_fetch the top 1-3 to read them in full and answer with citations. On anything time-sensitive or uncertain, search instead of guessing.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query (precise keywords work best).' },
        max_results: { type: 'number', description: 'How many results to return (default 8, max 20).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description:
      'Fetch a web page or API over HTTP GET and return its readable text (HTML stripped, output truncated). To find URLs in the first place, use web_search.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The http(s) URL to fetch.' } },
      required: ['url'],
    },
  },
  {
    name: 'mcp_list',
    description: 'List the MCP servers currently configured and how many tools are connected.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'mcp_add',
    description:
      "Install/connect an MCP server so its tools become available to you. Use it whenever the user asks to add one (\"instalá el MCP de GitHub\") — they should never have to find it in the settings themselves. Most run via npx: command='npx', args=['-y','<package>']. Give the server a short lowercase name; web_fetch the official package if unsure. NEVER ask the user to type a token in the chat — set env to a placeholder like {\"GITHUB_PERSONAL_ACCESS_TOKEN\":\"${SECRET:github}\"} (SECRET id = server name) and tell them to paste it in Ajustes → Herramientas (MCP), then retry. On failure, read the error (it carries the server's stderr) to explain what's missing.",
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short lowercase id for the server (e.g. "github").' },
        command: { type: 'string', description: 'Command to launch it, usually "npx".' },
        args: { type: 'array', items: { type: 'string' }, description: 'Arguments, e.g. ["-y","@modelcontextprotocol/server-github"].' },
        env: { type: 'object', description: 'Optional env vars the server needs (e.g. API tokens).' },
      },
      required: ['name', 'command'],
    },
  },
  {
    name: 'mcp_remove',
    description: 'Remove/disconnect a previously installed MCP server by its name.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The server name to remove.' } },
      required: ['name'],
    },
  },
  {
    name: 'todo_write',
    description:
      'Maintain a visible task plan for a multi-step job. Call it at the start to lay out the steps, then again to update statuses (one in_progress at a time, completed when done). Always send the FULL list. Use it for 3+ steps; skip it for single-step requests.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The full task list (always send the complete list, not a delta).',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'Short imperative description of the step.' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Current status.' },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
  },
  {
    name: 'subagent_run',
    description:
      'Delegate a self-contained subtask to a fresh sub-agent with its own clean context. It has the same tools (except spawning more sub-agents) and returns a text report. Issue SEVERAL calls in the SAME turn to run independent subtasks in PARALLEL. The sub-agent knows NOTHING about this conversation — put every detail it needs in the task.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Complete, self-contained description of the subtask.' },
      },
      required: ['task'],
    },
  },
];

/** El modelo usa nombres con guion bajo (terminal_run); el executor usa punto
 *  (terminal.run). Este mapa traduce en ambos sentidos. */
export const TOOL_NAME_TO_DOT: Record<string, string> = {
  terminal_run: 'terminal.run',
  file_read: 'file.read',
  file_write: 'file.write',
  file_edit: 'file.edit',
  file_edit_multi: 'file.edit_multi',
  file_grep: 'file.grep',
  file_extract: 'file.extract',
  file_list: 'file.list',
  file_search: 'file.search',
  workspace_mkdir: 'workspace.mkdir',
  diagnostics: 'diagnostics.check',
  code_intel: 'code.intel',
  mcp_list: 'mcp.list',
  mcp_add: 'mcp.add',
  mcp_remove: 'mcp.remove',
  phone_location: 'phone.location',
  phone_contacts: 'phone.contacts',
  phone_photo: 'phone.photo',
  phone_packages: 'phone.packages',
  phone_calendar: 'phone.calendar',
  image_view: 'image.view',
  deep_research: 'deep.research',
  web_search: 'web.search',
  web_fetch: 'web.fetch',
  subagent_run: 'subagent.run',
  todo_write: 'todo.write',
};

/** Formato OpenAI: [{type:'function', function:{name,description,parameters}}].
 *  `extra` son tools dinámicas (p.ej. de servidores MCP) que se suman a las base. */
export function toOpenAITools(exclude: string[] = [], extra: ToolSchema[] = []) {
  const base = TOOL_SCHEMAS.filter((t) => !exclude.includes(t.name));
  return [...base, ...extra].map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/** Formato Anthropic: [{name,description,input_schema}]. `extra` = tools dinámicas (MCP). */
export function toAnthropicTools(exclude: string[] = [], extra: ToolSchema[] = []) {
  const base = TOOL_SCHEMAS.filter((t) => !exclude.includes(t.name));
  return [...base, ...extra].map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}
