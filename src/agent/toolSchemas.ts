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
      "Check a code file for REAL errors: runs the language's type-checker/linter (tsc for TypeScript types, ruff/pyflakes for Python, eslint/node --check for JS, go vet, JSON parse) and returns the compiler/linter diagnostics. Call it right AFTER editing code to SEE the errors you may have introduced and fix them — this is how you verify code without guessing. If the checker isn't installed it tells you how to install it.",
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to the code file to check.' } },
      required: ['path'],
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
    name: 'web_fetch',
    description:
      'Fetch a web page or API over HTTP GET and return its text content (HTML is stripped to readable text, output truncated). Use to read documentation, check an API, or research something online.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The http(s) URL to fetch.' } },
      required: ['url'],
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
      'Delegate a self-contained subtask to a fresh sub-agent with its own clean context (like a research assistant). It has the same tools (except spawning more sub-agents and approval-gated actions) and returns a final text report. Use it for big explorations (e.g. "map this repo", "find all usages of X") so the main conversation stays focused. The sub-agent knows NOTHING about this conversation: include every detail it needs in the task.',
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
  file_grep: 'file.grep',
  file_list: 'file.list',
  file_search: 'file.search',
  workspace_mkdir: 'workspace.mkdir',
  diagnostics: 'diagnostics.check',
  phone_location: 'phone.location',
  phone_contacts: 'phone.contacts',
  phone_photo: 'phone.photo',
  phone_calendar: 'phone.calendar',
  image_view: 'image.view',
  web_fetch: 'web.fetch',
  subagent_run: 'subagent.run',
  todo_write: 'todo.write',
};

/** Formato OpenAI: [{type:'function', function:{name,description,parameters}}] */
export function toOpenAITools(exclude: string[] = []) {
  return TOOL_SCHEMAS.filter((t) => !exclude.includes(t.name)).map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/** Formato Anthropic: [{name,description,input_schema}] */
export function toAnthropicTools(exclude: string[] = []) {
  return TOOL_SCHEMAS.filter((t) => !exclude.includes(t.name)).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}
