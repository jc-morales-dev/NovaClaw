/**
 * Definiciones de herramientas en JSON Schema para function-calling nativo.
 * Un solo set, que se traduce al formato de cada API (OpenAI vs Anthropic).
 * Los nombres coinciden con el executor en tools.ts.
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
      'Run a shell command in the phone\'s embedded Linux. Use for anything: ls, find, cat, git, pkg/npm install, and reading/deleting files under /sdcard (the whole phone storage) when the Files connector is enabled.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'The shell command to execute.' } },
      required: ['command'],
    },
  },
  {
    name: 'file_read',
    description:
      "Read a text file's contents. Output is prefixed with line numbers (like `cat -n`) so you can reference exact lines when editing. For large files, use offset+limit to read a window of lines instead of the whole file.",
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
      'Create a NEW file with the given content. For modifying an existing file prefer file_edit (surgical) — only use file_write to overwrite when a full rewrite is really needed.',
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
      'Surgically edit an existing file: replace an EXACT text snippet with new text, without rewriting the whole file. old_string must match the file content exactly (including whitespace/indentation) and must be unique in the file — include a few surrounding lines to disambiguate. IMPORTANT: file_read prefixes each line with "<number>\\t" — do NOT include that line-number prefix in old_string, only the real file text. Use replace_all=true to replace every occurrence (e.g. renaming).',
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
      'Apply SEVERAL surgical edits to ONE file ATOMICALLY (all-or-nothing). Each edit is an exact old_string→new_string replacement (same rules as file_edit: match exactly, no line-number prefix, unique unless replace_all). If ANY edit fails to match, NOTHING is written — fix it and resend. Prefer this over multiple file_edit calls when changing several spots in the same file: fewer round-trips and no half-edited intermediate state.',
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
      'Search file CONTENTS with a regular expression, recursively. Returns matching lines as path:line: text. Use this to find where code/text lives before reading or editing. Skips node_modules, .git and binary files.',
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
      "Extract the TEXT/content of a RICH file (PDF, Word .docx, Excel .xlsx, PowerPoint .pptx, .zip, .html, .csv, .epub, etc.) as clean Markdown so you can read and analyze it. Uses markitdown under the hood (high quality, LLM-oriented). Use this on any non-plain-text file the user attaches (they land in ~/uploads or /root/uploads) — e.g. 'resumime este PDF', 'qué dice este Excel'. For plain text/code use file_read; for images use image_view. Handles large files (output is trimmed if huge).",
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
      "Check a code file for REAL errors: runs the language's type-checker/linter and returns the compiler diagnostics. Supports TypeScript (tsc types), Python (ruff/pyflakes/py_compile), JS (eslint/node --check), Go (go vet), Rust (cargo check), C/C++ (gcc/clang -fsyntax-only), PHP (php -l), Ruby (ruby -c), shell (shellcheck/bash -n) and JSON. Call it right AFTER editing code to SEE the errors you may have introduced and fix them — this is how you verify code without guessing. If the checker isn't installed it tells you how to install it.",
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to the code file to check.' } },
      required: ['path'],
    },
  },
  {
    name: 'code_intel',
    description:
      "Code intelligence via a real LSP language server (TypeScript/JavaScript for now) — understand code WITHOUT blind grepping. Actions: 'symbols' (outline a file: its functions/classes/variables with line numbers — pass path); 'find' (where a symbol is DEFINED across the project, by name — pass query, optional path to scope the project); 'references' (every place a symbol is used, by name — pass query). Prefer this over file_grep to navigate real code: it understands scopes/imports, not just text. It needs the language server installed in the phone's Linux (it tells you the install command if missing).",
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
      "Get the phone's current GPS location AND human-readable address (street, city, state, country). Use when the user asks where they are. Needs the Location connector.",
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
      'Take a photo with the phone camera and save it as a file, then VIEW it automatically — the image is attached so you can actually see and describe what is in front of the camera. Needs the Camera connector.',
    parameters: {
      type: 'object',
      properties: { facing: { type: 'string', enum: ['back', 'front'], description: 'Which camera.' } },
    },
  },
  {
    name: 'phone_calendar',
    description:
      "Read the user's upcoming calendar events for the next N days (title, date/time, location). Use when the user asks about their agenda, meetings or what they have coming up. Needs the Calendar connector.",
    parameters: {
      type: 'object',
      properties: { days: { type: 'number', description: 'How many days ahead to look (default 14).' } },
    },
  },
  {
    name: 'image_view',
    description:
      'Look at an image file (jpg, png, webp, gif) and attach it so you can actually SEE it — describe it, read text in it, analyze a screenshot or photo. Use for images under /sdcard/DCIM, /sdcard/Pictures, downloads, or a photo you just took.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to the image file.' } },
      required: ['path'],
    },
  },
  {
    name: 'deep_research',
    description:
      'Research a question ACROSS MULTIPLE web sources in one shot: it searches the web, opens the best results, and returns a digest with an excerpt from each source (numbered). Then you synthesize the answer citing the sources [1][2] and cross-checking facts between them (flag disagreements). Use this for any non-trivial question that benefits from several sources — "what is the best X", comparisons, current events, prices, how something works, fact-checking. For a single known URL use web_fetch; for a quick lookup use web_search; for a real answer that must be RIGHT and well-sourced, use deep_research.',
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
      'Search the WEB and get a ranked list of results (title, URL, snippet) — no API key needed. This is your way to FIND pages when you don\'t already know the URL: current info, docs, error messages, prices, news, "how to X", any research question. Workflow (like a research pro): web_search to find the best sources, then web_fetch the top 1-3 URLs to read them in full, then synthesize the answer with citations. Use precise keywords; refine and search again if the first results are weak. For anything time-sensitive or that you are not 100% sure of, SEARCH instead of guessing.',
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
      'Fetch a web page or API over HTTP GET and return its text content (HTML is stripped to readable text, output truncated). Use to READ a specific URL — docs, an API, or a result you got from web_search. To find URLs in the first place, use web_search.',
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
      "Install/connect an MCP server so its tools become available to you. Use when the user asks to add/install an MCP (e.g. \"instalá el MCP de GitHub\"). Most MCP servers run via npx: command='npx', args=['-y','<package>']. Common packages: @modelcontextprotocol/server-github, @modelcontextprotocol/server-filesystem, @modelcontextprotocol/server-postgres, @modelcontextprotocol/server-slack, @modelcontextprotocol/server-brave-search, firecrawl-mcp, @notionhq/notion-mcp-server. If you don't know the exact package, web_fetch to find the official one first. Give the server a short lowercase name. SECRETS/TOKENS: never ask the user to type a token in the chat (it would be exposed). If the server needs a token, set env to a PLACEHOLDER like {\"GITHUB_PERSONAL_ACCESS_TOKEN\":\"${SECRET:github}\"} (SECRET id = the server name) and tell the user to paste the token in Ajustes → Herramientas (MCP) → the server's card, then retry. If the connection fails, read the error (it includes the server's stderr) to explain what's missing.",
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
      'Maintain a visible task plan for a multi-step job. Call it at the start to lay out the steps, and again to update statuses as you go (mark one in_progress before working on it, completed when done). The user sees the checklist update live. Use it for non-trivial tasks with 3+ steps; skip it for single-step requests.',
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
      'Delegate a self-contained subtask to a fresh sub-agent with its own clean context (like a research assistant). It has the same tools (except spawning more sub-agents and approval-gated actions) and returns a final text report. Use it for big explorations (e.g. "map this repo", "find all usages of X") so the main conversation stays focused. To fan out, issue SEVERAL subagent_run calls in the SAME turn for independent subtasks — they run in PARALLEL. The sub-agent knows NOTHING about this conversation: include every detail it needs in the task.',
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
