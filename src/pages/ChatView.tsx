import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileCode2,
  FolderTree,
  History,
  Paperclip,
  Pencil,
  Plus,
  Sparkles,
  Square,
  Terminal as TerminalIcon,
  Trash2,
  X,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';

import { useSettings } from '../context/SettingsContext';
import { translations } from '../translations';
import NovaCircle from '../components/NovaCircle';
import { platform, type PendingApprovalSnapshot, type SessionHistoryEntry } from '../platform';

type ToolExecutionStatus = 'success' | 'error';

type ToolExecutionMessage = {
  name: string;
  command: string;
  status: ToolExecutionStatus;
  output?: string;
};

type ApprovalRequestMessage = {
  summary: string;
  reason: string;
  toolCall: {
    tool: string;
    arguments: Record<string, unknown>;
  };
  status: 'pending' | 'approved' | 'rejected';
};

type TodoStatus = 'pending' | 'in_progress' | 'completed';
type TodoItem = { content: string; status: TodoStatus };

export interface Message {
  id: number;
  role: 'user' | 'assistant';
  content?: string;
  toolExecution?: ToolExecutionMessage;
  approvalRequest?: ApprovalRequestMessage;
  todos?: TodoItem[];
}

type ServerEvent =
  | {
      type: 'message';
      message: string;
    }
  | {
      type: 'toolExecution';
      toolExecution: ToolExecutionMessage;
    }
  | {
      type: 'approval';
      approval: {
        summary: string;
        reason: string;
        toolCall: {
          tool: string;
          arguments: Record<string, unknown>;
        };
      };
    }
  | {
      type: 'todo';
      todos: TodoItem[];
    };

// Sesión por defecto (retrocompat con la clave vieja) + helpers multi-conversación.
const DEFAULT_SESSION_ID = 'nova-chat-session';
const ACTIVE_SESSION_KEY = 'novaActiveSessionV1';
const HISTORY_LIST_KEY = 'novaChatHistoryV1';

// Clave de localStorage donde viven los mensajes de una conversación concreta.
// La sesión por defecto conserva la clave vieja para no perder el chat existente.
function msgStorageKey(sid: string): string {
  return sid === DEFAULT_SESSION_ID ? 'novaChatMessagesV3' : `novaChatMsgs_${sid}`;
}

type ChatHistoryItem = { id: string; title: string; date: string; updatedAt: number };

function loadHistoryList(): ChatHistoryItem[] {
  try {
    const raw = localStorage.getItem(HISTORY_LIST_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return [];
}

function loadMessagesFor(sid: string, welcome: string): Message[] {
  try {
    const raw = localStorage.getItem(msgStorageKey(sid));
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return createWelcomeMessage(welcome);
}

function newSessionId(): string {
  return `nova-${nextMessageId().toString(36)}`;
}

function createWelcomeMessage(welcomeMessage: string): Message[] {
  return [
    {
      id: Date.now(),
      role: 'assistant',
      content: welcomeMessage,
    },
  ];
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseToolExecutionMessage(content: string): ToolExecutionMessage | null {
  const parsed = safeJsonParse(content);
  if (!parsed || typeof parsed !== 'object') return null;

  const record = parsed as Record<string, unknown>;
  const name = record.tool ?? record.name;
  const command = record.command;
  const status = record.status;

  if (
    typeof name === 'string' &&
    typeof command === 'string' &&
    (status === 'success' || status === 'error')
  ) {
    return {
      name,
      command,
      status,
      output: typeof record.output === 'string' ? record.output : undefined,
    };
  }

  return null;
}

function isInternalToolCall(content: string): boolean {
  const parsed = safeJsonParse(content);
  return Boolean(
    parsed &&
      typeof parsed === 'object' &&
      (parsed as Record<string, unknown>).kind === 'tool_call',
  );
}

function buildMessagesFromServerHistory(
  history: SessionHistoryEntry[],
  pendingApproval: PendingApprovalSnapshot,
  welcomeMessage: string,
): Message[] {
  const restoredMessages: Message[] = [];

  history.forEach((entry, index) => {
    const id = Date.now() + index;

    if (entry.role === 'user') {
      restoredMessages.push({
        id,
        role: 'user',
        content: entry.content,
      });
      return;
    }

    if (entry.role === 'assistant') {
      if (isInternalToolCall(entry.content)) {
        return;
      }

      restoredMessages.push({
        id,
        role: 'assistant',
        content: entry.content,
      });
      return;
    }

    const toolExecution = parseToolExecutionMessage(entry.content);
    if (toolExecution) {
      restoredMessages.push({
        id,
        role: 'assistant',
        toolExecution,
      });
    }
  });

  if (pendingApproval) {
    restoredMessages.push({
      id: Date.now() + history.length + 1,
      role: 'assistant',
      approvalRequest: {
        ...pendingApproval,
        status: 'pending',
      },
    });
  }

  return restoredMessages.length > 0 ? restoredMessages : createWelcomeMessage(welcomeMessage);
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback para WebViews viejos sin Clipboard API.
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // sin clipboard disponible — no hacemos nada visible
    }
  };

  return (
    <div className="pl-7 mt-2">
      <button
        type="button"
        onClick={copy}
        aria-label="Copiar respuesta"
        className="inline-flex items-center gap-1.5 text-[12px] text-zinc-500 hover:text-zinc-300 transition-colors py-1"
      >
        {copied ? (
          <>
            <Check size={13} strokeWidth={2.4} className="text-emerald-500" />
            <span className="text-emerald-500">Copiado</span>
          </>
        ) : (
          <>
            <Copy size={13} strokeWidth={2.2} />
            <span>Copiar</span>
          </>
        )}
      </button>
    </div>
  );
}

function TodoListBlock({ msg }: { msg: Message }) {
  if (!msg.todos || msg.todos.length === 0) return null;
  const done = msg.todos.filter((t) => t.status === 'completed').length;

  return (
    <div className="mb-2 max-w-[90%] w-full bg-[#0D0D0D] border border-[#FF7A1A]/30 rounded-xl overflow-hidden text-sm shadow-xl ml-2">
      <div className="flex items-center justify-between px-4 py-2.5 bg-zinc-900/80 border-b border-zinc-800">
        <span className="text-xs uppercase tracking-wider text-[#FFB25C] font-semibold">Plan</span>
        <span className="text-[11px] text-zinc-500 tabular-nums">{done}/{msg.todos.length}</span>
      </div>
      <ul className="p-3 space-y-1.5">
        {msg.todos.map((todo, i) => (
          <li key={i} className="flex items-start gap-2.5">
            <span
              className={
                todo.status === 'completed'
                  ? 'mt-[3px] w-4 h-4 rounded-[5px] bg-emerald-500/90 text-black text-[11px] font-bold flex items-center justify-center shrink-0'
                  : todo.status === 'in_progress'
                    ? 'mt-[3px] w-4 h-4 rounded-[5px] border-2 border-[#FF7A1A] shrink-0 animate-pulse'
                    : 'mt-[3px] w-4 h-4 rounded-[5px] border-2 border-zinc-700 shrink-0'
              }
            >
              {todo.status === 'completed' ? '✓' : ''}
            </span>
            <span
              className={
                todo.status === 'completed'
                  ? 'text-zinc-500 line-through leading-relaxed'
                  : todo.status === 'in_progress'
                    ? 'text-zinc-100 font-medium leading-relaxed'
                    : 'text-zinc-400 leading-relaxed'
              }
            >
              {todo.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ToolExecutionBlock({ msg }: { msg: Message }) {
  const [isOpen, setIsOpen] = useState(false);

  if (!msg.toolExecution) return null;
  const { name, command, status, output } = msg.toolExecution;

  return (
    <div className="mb-2 max-w-[90%] w-full bg-[#0D0D0D] border border-zinc-800 rounded-xl overflow-hidden font-mono text-sm shadow-xl ml-2 transition-all">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-4 py-2.5 bg-zinc-900/80 hover:bg-zinc-800/80 transition-colors border-b border-zinc-800 cursor-pointer"
      >
        <div className="flex items-center gap-2 text-zinc-400">
          <TerminalIcon size={14} />
          <span className="text-xs uppercase tracking-wider">{name}</span>
          {isOpen ? <ChevronDown size={14} className="ml-1" /> : <ChevronRight size={14} className="ml-1" />}
        </div>
        <div className="flex items-center gap-2">
          {status === 'success' && <span className="text-emerald-500 text-[11px] uppercase tracking-wider font-semibold">Exito</span>}
          {status === 'error' && <span className="text-red-500 text-[11px] uppercase tracking-wider font-semibold">Error</span>}
        </div>
      </button>

      {isOpen && (
        <div className="p-4 space-y-2 text-zinc-300">
          <div className="flex gap-2 items-start">
            <span className="text-[#FFB25C] mt-[2px]">{'>'}</span>
            <span className="text-zinc-100 leading-relaxed font-semibold break-words">{command}</span>
          </div>
          {output && (
            <div className="text-zinc-500 text-[13px] whitespace-pre-wrap mt-3 pl-4 border-l-2 border-zinc-800 overflow-x-auto leading-relaxed">
              {output}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ApprovalRequestBlock({
  msg,
  onResolve,
  disabled,
  approveLabel,
  rejectLabel,
}: {
  msg: Message;
  onResolve: (messageId: number, approved: boolean) => void;
  disabled: boolean;
  approveLabel: string;
  rejectLabel: string;
}) {
  if (!msg.approvalRequest) return null;

  const { summary, reason, toolCall, status } = msg.approvalRequest;

  return (
    <div className="max-w-[90%] bg-zinc-900 border border-zinc-800 rounded-2xl rounded-tl-sm px-4 py-4 shadow-sm">
      <div className="flex items-center justify-between gap-3 mb-3">
        <p className="text-[15px] font-semibold text-zinc-100">Approval required</p>
        <span
          className={`text-[11px] uppercase tracking-wider font-semibold ${
            status === 'approved'
              ? 'text-emerald-400'
              : status === 'rejected'
                ? 'text-red-400'
                : 'text-amber-400'
          }`}
        >
          {status}
        </span>
      </div>

      <p className="text-[14px] text-zinc-100 leading-relaxed">{reason}</p>
      <p className="text-[13px] text-zinc-400 leading-relaxed mt-3 break-words">{summary}</p>
      <div className="mt-3 p-3 rounded-xl bg-zinc-950 border border-zinc-800 text-[13px] text-zinc-300 whitespace-pre-wrap break-words">
        {toolCall.tool}
        {'\n'}
        {JSON.stringify(toolCall.arguments, null, 2)}
      </div>

      {status === 'pending' && (
        <div className="flex gap-2 mt-4">
          <button
            type="button"
            disabled={disabled}
            onClick={() => onResolve(msg.id, true)}
            className="flex-1 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2.5 rounded-xl transition-colors"
          >
            {approveLabel}
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onResolve(msg.id, false)}
            className="flex-1 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-100 text-sm font-semibold px-4 py-2.5 rounded-xl transition-colors"
          >
            {rejectLabel}
          </button>
        </div>
      )}
    </div>
  );
}

// Ids monótonos para mensajes: con streaming pueden llegar varios eventos en el
// mismo milisegundo y Date.now() solo colisionaría (keys de React duplicadas).
let messageIdSeq = 0;
function nextMessageId(): number {
  messageIdSeq += 1;
  return Date.now() + messageIdSeq;
}

export default function ChatView() {
  const navigate = useNavigate();
  const { appLanguage } = useSettings();
  const t = translations[appLanguage as keyof typeof translations] || translations.English;

  const [input, setInput] = useState('');
  const [activeSessionId, setActiveSessionId] = useState<string>(
    () => localStorage.getItem(ACTIVE_SESSION_KEY) || DEFAULT_SESSION_ID,
  );
  const [messages, setMessages] = useState<Message[]>(() =>
    loadMessagesFor(localStorage.getItem(ACTIVE_SESSION_KEY) || DEFAULT_SESSION_ID, t.welcomeMessage),
  );
  const [isTyping, setIsTyping] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const [pendingApprovalMessageId, setPendingApprovalMessageId] = useState<number | null>(null);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [chatHistory, setChatHistory] = useState<ChatHistoryItem[]>(() => loadHistoryList());

  // sessionId activo usado por TODAS las llamadas al agente (multi-conversación).
  const sessionId = activeSessionId;

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    localStorage.setItem(msgStorageKey(activeSessionId), JSON.stringify(messages));
  }, [messages, activeSessionId]);

  useEffect(() => {
    localStorage.setItem(HISTORY_LIST_KEY, JSON.stringify(chatHistory));
  }, [chatHistory]);

  useEffect(() => {
    localStorage.setItem(ACTIVE_SESSION_KEY, activeSessionId);
  }, [activeSessionId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  useEffect(() => {
    let isMounted = true;

    async function loadServerHistory() {
      try {
        const data = await platform.getChatHistory(sessionId);
        if (!isMounted) return;

        const serverHasContent = (data.history ?? []).length > 0;
        const serverMessages = buildMessagesFromServerHistory(
          data.history ?? [],
          data.pendingApproval ?? null,
          t.welcomeMessage,
        );
        // No pisar la conversación local guardada si el servidor responde
        // vacío (p. ej. el agente acaba de reiniciar y aún no cargó del disco).
        setMessages((prev) => {
          const prevHasContent = prev.some((m) => m.role === 'user');
          if (!serverHasContent && prevHasContent) return prev;
          return serverMessages;
        });
      } catch {
        // Keep the local fallback state when the backend cannot be reached.
      }
    }

    loadServerHistory();

    return () => {
      isMounted = false;
    };
  }, [activeSessionId, t.welcomeMessage]);

  function appendServerEvents(events: ServerEvent[]) {
    setMessages((prev) => {
      let next = [...prev];
      for (const event of events) {
        // El plan de tareas es una tarjeta VIVA: si ya hay una en la
        // conversación, la actualizamos in-place en vez de apilar otra.
        if (event.type === 'todo') {
          const idx = [...next].reverse().findIndex((m) => m.todos);
          if (idx !== -1) {
            const realIdx = next.length - 1 - idx;
            next[realIdx] = { ...next[realIdx], todos: event.todos };
          } else {
            next.push({ id: nextMessageId(), role: 'assistant', todos: event.todos });
          }
          continue;
        }
        if (event.type === 'toolExecution') {
          next.push({ id: nextMessageId(), role: 'assistant', toolExecution: event.toolExecution });
        } else if (event.type === 'approval') {
          next.push({ id: nextMessageId(), role: 'assistant', approvalRequest: { ...event.approval, status: 'pending' } });
        } else {
          next.push({ id: nextMessageId(), role: 'assistant', content: event.message });
        }
      }
      return next;
    });
  }

  async function sendChatMessage(userText: string, signal: AbortSignal) {
    // Streaming: cada evento (mensaje, tool call, aprobación) aparece EN VIVO.
    await platform.sendChatStream(userText, sessionId, (ev) => appendServerEvents([ev]), signal);
  }

  // Botón Detener: aborta el turno en curso (corta el stream y para el agente).
  const stopGeneration = () => {
    abortRef.current?.abort();
    abortRef.current = null;
  };

  // Rebobinar/editar: al editar una pregunta, la conversación vuelve a ese punto
  // (se borra esa pregunta y todo lo posterior) y el texto va al input para reeditar.
  const handleEditMessage = async (messageId: number) => {
    if (isTyping) return;
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx === -1 || messages[idx].role !== 'user') return;

    // Índice de esta pregunta entre TODAS las preguntas del usuario (0-based).
    const userIndex = messages.slice(0, idx).filter((m) => m.role === 'user').length;
    const original = messages[idx].content ?? '';

    try {
      await platform.rewindToUserMessage(sessionId, userIndex);
    } catch {
      // si el rewind del server falla igual truncamos la UI para no confundir
    }
    // Truncar la UI desde esa pregunta (inclusive) y cargar el texto al input.
    setMessages((prev) => prev.slice(0, idx));
    setInput(original);
    requestAnimationFrame(() => {
      const ta = document.querySelector<HTMLTextAreaElement>('textarea');
      if (ta) {
        ta.focus();
        ta.style.height = 'auto';
        ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
      }
    });
  };

  // Registra/actualiza la conversación activa en el historial. Cuando la entrada
  // es NUEVA, pide al modelo un título según el tema de la charla (no depende de
  // que sea el primer turno: una sesión reutilizada igual estrena entrada).
  const upsertHistoryEntry = async (userText: string) => {
    const sid = activeSessionId;
    const now = Date.now();
    const isNew = !chatHistory.some((c) => c.id === sid);
    setChatHistory((prev) => {
      if (prev.some((c) => c.id === sid)) {
        return prev.map((c) => (c.id === sid ? { ...c, updatedAt: now } : c));
      }
      const provisional = userText.slice(0, 40) || 'Nueva conversación';
      return [{ id: sid, title: provisional, date: 'Ahora', updatedAt: now }, ...prev];
    });
    if (isNew) {
      try {
        const title = await platform.generateChatTitle(sid);
        if (title) setChatHistory((prev) => prev.map((c) => (c.id === sid ? { ...c, title } : c)));
      } catch { /* mantiene el título provisional */ }
    }
  };

  const submitText = async (rawText: string) => {
    const userText = rawText.trim();
    if (!userText || isTyping) return;

    setMessages((prev) => [
      ...prev,
      {
        id: nextMessageId(),
        role: 'user',
        content: userText,
      },
    ]);
    setInput('');
    setIsTyping(true);

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await sendChatMessage(userText, controller.signal);
      // Guardar/renombrar la conversación en el historial (título por tema).
      await upsertHistoryEntry(userText);
    } catch (error: any) {
      if (error?.name !== 'AbortError') {
        setMessages((prev) => [
          ...prev,
          {
            id: nextMessageId(),
            role: 'assistant',
            content: `Error: ${error.message}`,
          },
        ]);
      }
    } finally {
      abortRef.current = null;
      setIsTyping(false);
    }
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (isTyping) {
      stopGeneration();
      return;
    }
    await submitText(input);
  };

  const handleApprovalResolution = async (messageId: number, approved: boolean) => {
    setPendingApprovalMessageId(messageId);
    setMessages((prev) =>
      prev.map((message) =>
        message.id === messageId && message.approvalRequest
          ? {
              ...message,
              approvalRequest: {
                ...message.approvalRequest,
                status: approved ? 'approved' : 'rejected',
              },
            }
          : message,
      ),
    );
    setIsTyping(true);

    try {
      await platform.approveActionStream(sessionId, approved, (ev) => appendServerEvents([ev]));
    } catch (error: any) {
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now() + 1,
          role: 'assistant',
          content: `Error: ${error.message}`,
        },
      ]);
    } finally {
      setPendingApprovalMessageId(null);
      setIsTyping(false);
    }
  };

  // Nueva conversación: crea un sessionId fresco y arranca en blanco. La
  // conversación anterior queda guardada en el historial (con su contexto en el
  // server bajo su propio sessionId) — NO se resetea.
  const startNewChat = () => {
    if (isTyping) stopGeneration();
    const sid = newSessionId();
    setActiveSessionId(sid);
    setMessages(createWelcomeMessage(t.welcomeMessage));
    setInput('');
    setIsHistoryOpen(false);
  };

  // Abre una conversación guardada: activa su sessionId y carga sus mensajes.
  const openConversation = (sid: string) => {
    if (sid === activeSessionId) { setIsHistoryOpen(false); return; }
    if (isTyping) stopGeneration();
    setActiveSessionId(sid);
    setMessages(loadMessagesFor(sid, t.welcomeMessage));
    setInput('');
    setIsHistoryOpen(false);
  };

  // Elimina una conversación: del historial, de localStorage y del server.
  const deleteConversation = async (sid: string) => {
    setChatHistory((prev) => prev.filter((c) => c.id !== sid));
    try { localStorage.removeItem(msgStorageKey(sid)); } catch { /* ignore */ }
    try { await platform.resetChat(sid); } catch { /* ignore */ }
    // Si borré la conversación abierta, arranco una nueva en blanco.
    if (sid === activeSessionId) {
      const fresh = newSessionId();
      setActiveSessionId(fresh);
      setMessages(createWelcomeMessage(t.welcomeMessage));
    }
  };

  const hasConversation = messages.some((m) => m.role === 'user');
  const suggestions = [
    { icon: <FolderTree size={17} />, label: 'Listar los archivos del proyecto', text: 'Listá los archivos del directorio actual con detalle' },
    { icon: <FileCode2 size={17} />, label: 'Escribir un script en Python', text: 'Escribí un script de Python que sume dos números y muestre el resultado' },
    { icon: <TerminalIcon size={17} />, label: 'Ver los procesos en ejecución', text: 'Mostrame los procesos que están corriendo' },
  ];

  return (
    <div className="flex flex-col h-full bg-[#0B0908] text-zinc-100 font-sans relative overflow-hidden">
      {/* Drawer de historial */}
      <div className={`absolute inset-0 z-50 transition-opacity ${isHistoryOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setIsHistoryOpen(false)} />
        <div className={`absolute top-0 right-0 w-[280px] h-full bg-[#0B0908] border-l border-white/10 flex flex-col transition-transform duration-300 ${isHistoryOpen ? 'translate-x-0' : 'translate-x-full'}`}>
          <div className="p-4 pt-12 border-b border-white/5 flex items-center justify-between">
            <h2 className="font-bold text-zinc-100 flex items-center gap-2"><History size={18} /> Historial</h2>
            <div className="flex items-center gap-1">
              <button onClick={startNewChat} className="p-2 text-zinc-400 hover:text-[#FFB25C] bg-zinc-900 hover:bg-zinc-800 rounded-lg transition-colors flex items-center gap-1" title="Nuevo chat">
                <Plus size={18} />
              </button>
              <button onClick={() => setIsHistoryOpen(false)} className="p-2 text-zinc-400 hover:text-zinc-100 rounded-lg"><X size={20} /></button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {chatHistory.map((item) => {
              const isActive = item.id === activeSessionId;
              return (
                <div
                  key={item.id}
                  onClick={() => openConversation(item.id)}
                  className={`p-3 rounded-xl cursor-pointer transition-colors mb-1 flex justify-between items-center gap-2 ${isActive ? 'bg-[#FF7A1A]/10 border border-[#FF7A1A]/25' : 'hover:bg-zinc-900 active:bg-zinc-800 border border-transparent'}`}
                >
                  <div className="overflow-hidden pr-1 min-w-0">
                    <p className={`text-sm font-medium truncate ${isActive ? 'text-[#FFB25C]' : 'text-zinc-200'}`}>{item.title}</p>
                    <p className="text-xs text-zinc-500 mt-0.5">{item.date}</p>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteConversation(item.id);
                    }}
                    aria-label="Eliminar conversación"
                    className="p-2 text-zinc-500 hover:text-red-400 active:text-red-400 hover:bg-zinc-800 rounded-lg transition-colors shrink-0"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              );
            })}
            {chatHistory.length === 0 && (
              <div className="text-zinc-500 text-sm p-4 text-center mt-10">Todavía no hay conversaciones.</div>
            )}
          </div>
        </div>
      </div>

      {/* Header minimalista */}
      <header className="flex items-center justify-between px-2.5 pt-11 pb-3 sticky top-0 bg-[#0B0908]/85 backdrop-blur-xl z-20 border-b border-white/5">
        <button onClick={() => navigate('/')} className="p-2 text-zinc-400 hover:text-zinc-100 transition-colors rounded-full">
          <ArrowLeft size={22} />
        </button>
        <div className="flex items-center gap-2">
          <span className="w-6 h-6 rounded-full bg-black border border-white/10 flex items-center justify-center overflow-hidden">
            <NovaCircle className="w-[130%] h-[130%]" />
          </span>
          <span className="text-[15px] font-semibold tracking-tight bg-gradient-to-r from-orange-300 via-amber-200 to-orange-400 bg-clip-text text-transparent">NovaClaw</span>
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-[0_0_6px] shadow-emerald-500/60" />
        </div>
        <div className="flex items-center">
          <button onClick={startNewChat} className="p-2 text-zinc-400 hover:text-zinc-100 transition-colors rounded-full" title="Nuevo chat">
            <Plus size={20} />
          </button>
          <button onClick={() => setIsHistoryOpen(true)} className="p-2 text-zinc-400 hover:text-zinc-100 transition-colors rounded-full">
            <History size={19} />
          </button>
        </div>
      </header>

      {/* Cuerpo: empty state o conversación */}
      {!hasConversation ? (
        <div className="flex-1 overflow-y-auto flex flex-col items-center justify-center px-6 text-center">
          <div className="w-16 h-16 rounded-[20px] bg-black border border-white/10 flex items-center justify-center overflow-hidden mb-5 shadow-[inset_0_0_22px_rgba(255,122,26,0.20)]">
            <NovaCircle className="w-[135%] h-[135%]" />
          </div>
          <h2 className="text-[23px] font-bold tracking-tight bg-gradient-to-r from-white to-zinc-400 bg-clip-text text-transparent">
            ¿En qué te ayudo?
          </h2>
          <p className="text-zinc-500 text-[13.5px] mt-2 mb-8 max-w-[16rem] leading-relaxed">
            Tu agente de código, corriendo entero dentro del teléfono.
          </p>
          <div className="w-full max-w-sm space-y-2.5">
            {suggestions.map((s) => (
              <button
                key={s.label}
                onClick={() => submitText(s.text)}
                disabled={isTyping}
                className="w-full flex items-center gap-3 px-4 py-3.5 rounded-2xl bg-zinc-900/60 border border-white/5 hover:bg-zinc-800/60 active:scale-[0.99] text-left transition-all disabled:opacity-50"
              >
                <span className="text-[#FFB25C] shrink-0">{s.icon}</span>
                <span className="text-[14px] text-zinc-300">{s.label}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-4 py-6 scroll-smooth space-y-6">
          {messages.map((msg) => {
            if (msg.todos) {
              return <div key={msg.id} className="flex justify-start"><TodoListBlock msg={msg} /></div>;
            }
            if (msg.toolExecution) {
              return <div key={msg.id} className="flex justify-start"><ToolExecutionBlock msg={msg} /></div>;
            }
            if (msg.approvalRequest) {
              return (
                <div key={msg.id} className="flex justify-start">
                  <ApprovalRequestBlock
                    msg={msg}
                    onResolve={handleApprovalResolution}
                    disabled={pendingApprovalMessageId === msg.id}
                    approveLabel={t.approveAction}
                    rejectLabel={t.rejectAction}
                  />
                </div>
              );
            }
            if (msg.role === 'user') {
              return (
                <div key={msg.id} className="flex flex-col items-end gap-1">
                  <div className="max-w-[82%] bg-zinc-800/80 text-zinc-100 rounded-2xl rounded-br-md px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap break-words">
                    {msg.content}
                  </div>
                  {!isTyping && (
                    <button
                      type="button"
                      onClick={() => handleEditMessage(msg.id)}
                      aria-label="Editar y rebobinar"
                      className="inline-flex items-center gap-1.5 text-[12px] text-zinc-500 hover:text-zinc-300 transition-colors py-0.5 pr-1"
                    >
                      <Pencil size={12} strokeWidth={2.2} />
                      <span>Editar</span>
                    </button>
                  )}
                </div>
              );
            }
            // Asistente: full-width, sin burbuja (estilo Claude/ChatGPT)
            return (
              <div key={msg.id} className="w-full">
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-5 h-5 rounded-full bg-gradient-to-br from-[#FF7A1A] to-amber-400 flex items-center justify-center shrink-0">
                    <Sparkles size={11} className="text-white" />
                  </span>
                  <span className="text-[12.5px] font-semibold text-zinc-400 tracking-wide">NovaClaw</span>
                </div>
                <div className="prose prose-invert max-w-none pl-7 text-[15px] leading-relaxed prose-p:leading-relaxed prose-p:my-2 prose-headings:font-semibold prose-pre:bg-[#0D0D0D] prose-pre:border prose-pre:border-white/10 prose-pre:rounded-xl prose-code:text-[#FFC58A] prose-code:before:content-none prose-code:after:content-none prose-a:text-[#FFB25C]">
                  <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
                    {msg.content || ''}
                  </ReactMarkdown>
                </div>
                {msg.content && msg.content.trim() && <CopyButton text={msg.content} />}
              </div>
            );
          })}

          {isTyping && (
            <div className="w-full">
              <div className="flex items-center gap-2 mb-2">
                <span className="w-5 h-5 rounded-full bg-gradient-to-br from-[#FF7A1A] to-amber-400 flex items-center justify-center">
                  <Sparkles size={11} className="text-white" />
                </span>
                <span className="text-[12.5px] font-semibold text-zinc-400 tracking-wide">NovaClaw</span>
              </div>
              <div className="pl-7 flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-zinc-600 animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-2 h-2 rounded-full bg-zinc-600 animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-2 h-2 rounded-full bg-zinc-600 animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          )}
          <div ref={messagesEndRef} className="h-4" />
        </div>
      )}

      {/* Composer */}
      <div className="px-3 pt-2 pb-7 bg-gradient-to-t from-[#0B0908] via-[#0B0908] to-transparent">
        <form
          onSubmit={handleSubmit}
          className="flex items-end gap-1.5 bg-zinc-900/90 border border-white/10 rounded-[26px] pl-1.5 pr-1.5 py-1.5 focus-within:border-[#FF7A1A]/40 focus-within:ring-2 focus-within:ring-[#FF7A1A]/15 transition-all shadow-lg shadow-black/40"
        >
          <input type="file" ref={fileInputRef} className="hidden" onChange={() => {}} />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="p-2.5 text-zinc-500 hover:text-zinc-200 transition-colors shrink-0 self-end mb-0.5"
          >
            <Paperclip size={19} />
          </button>
          <textarea
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            placeholder={t.chatInputPlaceholder}
            className="flex-1 bg-transparent text-zinc-100 placeholder-zinc-500 px-1 py-2.5 focus:outline-none text-[15px] resize-none min-h-[42px] max-h-[120px] scrollbar-hide"
            rows={1}
          />
          {isTyping ? (
            <button
              type="button"
              onClick={stopGeneration}
              aria-label="Detener"
              className="w-9 h-9 flex items-center justify-center rounded-full shrink-0 self-end mb-0.5 transition-all bg-zinc-700 text-white hover:bg-zinc-600 active:scale-95"
            >
              <Square size={15} strokeWidth={2.6} fill="currentColor" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim()}
              aria-label="Enviar"
              className="w-9 h-9 flex items-center justify-center rounded-full shrink-0 self-end mb-0.5 transition-all disabled:bg-zinc-800 disabled:text-zinc-600 enabled:bg-gradient-to-br enabled:from-[#FF7A1A] enabled:to-amber-500 enabled:text-white enabled:hover:brightness-110 enabled:active:scale-95"
            >
              <ArrowUp size={19} strokeWidth={2.4} />
            </button>
          )}
        </form>
        <p className="text-center text-[11px] text-zinc-600 mt-2.5">NovaClaw puede cometer errores. Verificá lo importante.</p>
      </div>
    </div>
  );
}
