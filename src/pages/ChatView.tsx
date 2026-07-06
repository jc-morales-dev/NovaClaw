import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  FileCode2,
  FolderTree,
  History,
  Paperclip,
  Plus,
  Sparkles,
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

export interface Message {
  id: number;
  role: 'user' | 'assistant';
  content?: string;
  toolExecution?: ToolExecutionMessage;
  approvalRequest?: ApprovalRequestMessage;
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
    };

const sessionId = 'nova-chat-session';
const storageKey = 'novaChatMessagesV3';

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

export default function ChatView() {
  const navigate = useNavigate();
  const { appLanguage } = useSettings();
  const t = translations[appLanguage as keyof typeof translations] || translations.English;

  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>(() => {
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch {
        return createWelcomeMessage(t.welcomeMessage);
      }
    }
    return createWelcomeMessage(t.welcomeMessage);
  });
  const [isTyping, setIsTyping] = useState(false);
  const [pendingApprovalMessageId, setPendingApprovalMessageId] = useState<number | null>(null);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [chatHistory, setChatHistory] = useState(() => {
    const saved = localStorage.getItem('chatHistoryList');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch {
        return [];
      }
    }
    return [];
  });

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify(messages));
  }, [messages]);

  useEffect(() => {
    localStorage.setItem('chatHistoryList', JSON.stringify(chatHistory));
  }, [chatHistory]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  useEffect(() => {
    let isMounted = true;

    async function loadServerHistory() {
      try {
        const data = await platform.getChatHistory(sessionId);
        if (!isMounted) return;

        setMessages(
          buildMessagesFromServerHistory(
            data.history ?? [],
            data.pendingApproval ?? null,
            t.welcomeMessage,
          ),
        );
      } catch {
        // Keep the local fallback state when the backend cannot be reached.
      }
    }

    loadServerHistory();

    return () => {
      isMounted = false;
    };
  }, [t.welcomeMessage]);

  function appendServerEvents(events: ServerEvent[]) {
    const newMessages: Message[] = events.map((event, index) => {
      const id = Date.now() + index;
      if (event.type === 'toolExecution') {
        return {
          id,
          role: 'assistant',
          toolExecution: event.toolExecution,
        };
      }

      if (event.type === 'approval') {
        return {
          id,
          role: 'assistant',
          approvalRequest: {
            ...event.approval,
            status: 'pending',
          },
        };
      }

      return {
        id,
        role: 'assistant',
        content: event.message,
      };
    });

    setMessages((prev) => [...prev, ...newMessages]);
  }

  async function sendChatMessage(userText: string) {
    const data = await platform.sendChat(userText, sessionId);
    appendServerEvents(data.events ?? []);
  }

  const submitText = async (rawText: string) => {
    const userText = rawText.trim();
    if (!userText || isTyping) return;

    setMessages((prev) => [
      ...prev,
      {
        id: Date.now(),
        role: 'user',
        content: userText,
      },
    ]);
    setInput('');
    setIsTyping(true);

    try {
      await sendChatMessage(userText);
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
      setIsTyping(false);
    }
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
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
      const data = await platform.approveAction(sessionId, approved);
      appendServerEvents(data.events ?? []);
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

  const startNewChat = async () => {
    if (messages.length > 1) {
      const title = messages.find((message) => message.role === 'user')?.content?.substring(0, 30) || 'Nueva conversacion';
      setChatHistory((prev) => [{ id: Date.now(), title, date: 'Just now' }, ...prev]);
    }

    try {
      await platform.resetChat(sessionId);
    } catch {}

    setMessages(createWelcomeMessage(t.welcomeMessage));
    setIsHistoryOpen(false);
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
            {chatHistory.map((item: { id: number; title: string; date: string }) => (
              <div key={item.id} className="p-3 hover:bg-zinc-900 rounded-xl cursor-pointer transition-colors mb-1 group flex justify-between items-start">
                <div className="overflow-hidden pr-2">
                  <p className="text-sm font-medium text-zinc-200 truncate">{item.title}</p>
                  <p className="text-xs text-zinc-500 mt-1">{item.date}</p>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setChatHistory((prev: Array<{ id: number; title: string; date: string }>) => prev.filter((historyItem) => historyItem.id !== item.id));
                  }}
                  className="p-1.5 text-zinc-500 opacity-0 group-hover:opacity-100 hover:text-red-400 hover:bg-zinc-800 rounded-lg transition-all shrink-0"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
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
                <div key={msg.id} className="flex justify-end">
                  <div className="max-w-[82%] bg-zinc-800/80 text-zinc-100 rounded-2xl rounded-br-md px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap break-words">
                    {msg.content}
                  </div>
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
          <button
            type="submit"
            disabled={!input.trim() || isTyping}
            className="w-9 h-9 flex items-center justify-center rounded-full shrink-0 self-end mb-0.5 transition-all disabled:bg-zinc-800 disabled:text-zinc-600 enabled:bg-gradient-to-br enabled:from-[#FF7A1A] enabled:to-amber-500 enabled:text-white enabled:hover:brightness-110 enabled:active:scale-95"
          >
            <ArrowUp size={19} strokeWidth={2.4} />
          </button>
        </form>
        <p className="text-center text-[11px] text-zinc-600 mt-2.5">NovaClaw puede cometer errores. Verificá lo importante.</p>
      </div>
    </div>
  );
}
