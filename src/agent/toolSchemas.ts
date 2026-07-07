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
    description: "Read a text file's contents.",
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to the file.' } },
      required: ['path'],
    },
  },
  {
    name: 'file_write',
    description: 'Create or overwrite a file with the given content.',
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
      'Take a photo with the phone camera and save it as a file (then read/analyze it). Needs the Camera connector.',
    parameters: {
      type: 'object',
      properties: { facing: { type: 'string', enum: ['back', 'front'], description: 'Which camera.' } },
    },
  },
];

/** El modelo usa nombres con guion bajo (terminal_run); el executor usa punto
 *  (terminal.run). Este mapa traduce en ambos sentidos. */
export const TOOL_NAME_TO_DOT: Record<string, string> = {
  terminal_run: 'terminal.run',
  file_read: 'file.read',
  file_write: 'file.write',
  file_list: 'file.list',
  file_search: 'file.search',
  workspace_mkdir: 'workspace.mkdir',
  phone_location: 'phone.location',
  phone_contacts: 'phone.contacts',
  phone_photo: 'phone.photo',
};

/** Formato OpenAI: [{type:'function', function:{name,description,parameters}}] */
export function toOpenAITools() {
  return TOOL_SCHEMAS.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/** Formato Anthropic: [{name,description,input_schema}] */
export function toAnthropicTools() {
  return TOOL_SCHEMAS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}
