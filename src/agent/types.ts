export type AgentMessageAction = {
  kind: 'message';
  message: string;
};

export type AgentToolCallAction = {
  kind: 'tool_call';
  tool: string;
  arguments: Record<string, unknown>;
};

export type AgentModelAction = AgentMessageAction | AgentToolCallAction;

export type ToolCallLike = {
  tool: string;
  arguments: Record<string, unknown>;
};

export type ToolApprovalDecision = {
  requiresApproval: boolean;
  reason: string;
  summary: string;
};

export type ToolExecutionResult = {
  name: string;
  command: string;
  status: 'success' | 'error';
  output: string;
  cwd?: string;
  /** Imagen producida por la tool (p.ej. image.view / phone.photo) para que el
   *  modelo la VEA en el próximo turno. base64 sin el prefijo data:. */
  image?: { mediaType: string; data: string };
};
