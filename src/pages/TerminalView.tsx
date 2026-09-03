import React, { useRef, useEffect, useState, useCallback } from 'react';
import { ArrowLeft, ArrowUp, ArrowDown, ArrowRight, Copy, ClipboardPaste } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { platform } from '../platform';

/**
 * TerminalView — terminal interactiva real con xterm.js sobre un PTY del Linux
 * embebido. El backend (server.ts) abre una pseudo-terminal vía `script` y la
 * transporta por WebSocket (/pty). Soporta programas interactivos: vim, htop,
 * tail -f, etc.
 *
 * Si el WebSocket no conecta (p. ej. el agente no está corriendo), cae al modo
 * simple pregunta/respuesta contra /api/terminal.
 *
 * xterm dibuja en canvas, así que el teclado de Android no ofrece flechas/Tab/
 * Ctrl ni permite seleccionar texto "como HTML". Para eso montamos una barra de
 * teclas especial (estilo Termux) + botones Copiar/Pegar.
 */

type Mode = 'connecting' | 'pty' | 'web';

const XTERM_THEME = {
  background: '#0C0C0C',
  foreground: '#d4d4d4',
  cursor: '#d4d4d4',
  cursorAccent: '#0C0C0C',
  selectionBackground: '#264f78',
  black: '#0C0C0C', red: '#f44747', green: '#6A9955', yellow: '#d7ba7d',
  blue: '#569cd6', magenta: '#c586c0', cyan: '#4ec9b0', white: '#d4d4d4',
  brightBlack: '#666666', brightRed: '#f44747', brightGreen: '#6A9955', brightYellow: '#d7ba7d',
  brightBlue: '#569cd6', brightMagenta: '#c586c0', brightCyan: '#4ec9b0', brightWhite: '#ffffff',
};

// --- Helpers de portapapeles / buffer -------------------------------------

/** Copia texto al portapapeles. Cae a execCommand si navigator.clipboard falla
 *  (WebView de Android a veces lo bloquea). Devuelve true si copió. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** Vuelca todo el buffer visible + scrollback de la terminal a texto plano. */
function getBufferText(term: any): string {
  try {
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      lines.push(line ? line.translateToString(true) : '');
    }
    return lines.join('\n').replace(/\s+$/, '');
  } catch {
    return '';
  }
}

// --- Definición de las teclas de la barra ---------------------------------

type KeySpec = {
  id: string;
  label?: string;
  icon?: React.ReactNode;
  seq: string;   // secuencia a mandar al PTY
  wide?: boolean;
};

const ESC = '\x1b';
const KEYS: KeySpec[] = [
  { id: 'esc', label: 'Esc', seq: ESC },
  { id: 'tab', label: 'Tab', seq: '\t' },
  { id: 'left', icon: <ArrowLeft size={15} />, seq: `${ESC}[D` },
  { id: 'up', icon: <ArrowUp size={15} />, seq: `${ESC}[A` },
  { id: 'down', icon: <ArrowDown size={15} />, seq: `${ESC}[B` },
  { id: 'right', icon: <ArrowRight size={15} />, seq: `${ESC}[C` },
  { id: 'ctrlc', label: '^C', seq: '\x03' },
  { id: 'ctrld', label: '^D', seq: '\x04' },
  { id: 'ctrlz', label: '^Z', seq: '\x1a' },
  { id: 'ctrll', label: '^L', seq: '\x0c' },
  { id: 'home', label: 'Home', seq: `${ESC}[H` },
  { id: 'end', label: 'End', seq: `${ESC}[F` },
  { id: 'pgup', label: 'PgUp', seq: `${ESC}[5~` },
  { id: 'pgdn', label: 'PgDn', seq: `${ESC}[6~` },
  { id: 'pipe', label: '|', seq: '|' },
  { id: 'slash', label: '/', seq: '/' },
  { id: 'tilde', label: '~', seq: '~' },
  { id: 'dash', label: '-', seq: '-' },
];

export default function TerminalView() {
  const navigate = useNavigate();
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<any>(null);
  const fitAddonRef = useRef<any>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [mode, setMode] = useState<Mode>('connecting');

  // Ctrl "sostenido": la próxima letra tipeada se convierte en Ctrl+letra.
  const ctrlRef = useRef(false);
  const [ctrlOn, setCtrlOn] = useState(false);

  // Aviso efímero (copiado, pegado, error de portapapeles…)
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<any>(null);
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 1600);
  }, []);

  // Web mode state (fallback)
  const [history, setHistory] = useState<{ type: 'input' | 'output'; text: string }[]>([]);
  const [input, setInput] = useState('');
  const [cwd, setCwd] = useState('~');
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const fallbackToWeb = useCallback(() => {
    setMode('web');
    setHistory((h) => h.length ? h : [
      { type: 'output', text: 'NovaClaw Shell — modo simple (sin PTY)' },
      { type: 'output', text: 'Escribí "help" para ver comandos.' },
    ]);
  }, []);

  // Manda datos crudos al PTY y devuelve el foco a la terminal (para que el
  // teclado del sistema no se cierre al tocar un botón de la barra).
  const sendPty = useCallback((data: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data }));
    }
    xtermRef.current?.focus();
  }, []);

  const toggleCtrl = useCallback(() => {
    ctrlRef.current = !ctrlRef.current;
    setCtrlOn(ctrlRef.current);
    xtermRef.current?.focus();
  }, []);

  const copyFromTerm = useCallback(async () => {
    const term = xtermRef.current;
    if (!term) return;
    const sel = (term.getSelection?.() || '').trim();
    const text = sel || getBufferText(term);
    if (!text) { showToast('Nada para copiar'); return; }
    const ok = await copyText(text);
    showToast(ok ? (sel ? 'Selección copiada' : 'Pantalla copiada') : 'No pude copiar');
    term.focus();
  }, [showToast]);

  const pasteToTerm = useCallback(async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (t) { sendPty(t); showToast('Pegado'); }
      else showToast('Portapapeles vacío');
    } catch {
      showToast('No pude leer el portapapeles');
    }
  }, [sendPty, showToast]);

  useEffect(() => {
    let disposed = false;

    async function initPty() {
      if (!terminalRef.current) return;
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      // @ts-ignore — Vite maneja el import del CSS
      await import('@xterm/xterm/css/xterm.css');
      if (disposed || !terminalRef.current) return;

      const term = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: '"Cascadia Code", "JetBrains Mono", Menlo, Monaco, monospace',
        theme: XTERM_THEME,
        allowProposedApi: true,
      });
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(terminalRef.current);
      fitAddon.fit();
      xtermRef.current = term;
      fitAddonRef.current = fitAddon;

      // Apaga autocorrección/predicción del teclado Android en el textarea interno
      // de xterm: si no, el teclado duplica/altera las teclas dentro de la terminal.
      const ta = (term as any).textarea as HTMLTextAreaElement | undefined;
      if (ta) {
        ta.setAttribute('autocomplete', 'off');
        ta.setAttribute('autocorrect', 'off');
        ta.setAttribute('autocapitalize', 'none');
        ta.setAttribute('spellcheck', 'false');
      }

      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const host = window.location.host || '127.0.0.1:8088';
      // El token (inyectado por el server en el HTML) autentica la shell /pty.
      const token = (window as any).__NOVA_TOKEN__ || '';
      const auth = token ? `&token=${encodeURIComponent(token)}` : '';
      const url = `${proto}://${host}/pty?cols=${term.cols}&rows=${term.rows}${auth}`;

      let opened = false;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      // Si no abre en 4s, asumimos que no hay agente y caemos al modo simple.
      const openTimeout = setTimeout(() => { if (!opened) { try { ws.close(); } catch {} } }, 4000);

      ws.onopen = () => {
        opened = true;
        clearTimeout(openTimeout);
        if (disposed) { ws.close(); return; }
        setMode('pty');
        term.focus();
      };
      ws.onmessage = (ev) => { term.write(typeof ev.data === 'string' ? ev.data : ''); };
      ws.onclose = () => { if (!opened && !disposed) fallbackToWeb(); };
      ws.onerror = () => { if (!opened && !disposed) fallbackToWeb(); };

      term.onData((data: string) => {
        let out = data;
        // Ctrl sostenido: convierte la próxima letra en su carácter de control.
        if (ctrlRef.current && data.length === 1) {
          const up = data.toUpperCase().charCodeAt(0);
          if (up >= 64 && up <= 95) out = String.fromCharCode(up & 31);
          ctrlRef.current = false;
          setCtrlOn(false);
        }
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data: out }));
      });

      const onResize = () => {
        fitAddon.fit();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      };
      const ro = new ResizeObserver(onResize);
      ro.observe(terminalRef.current);
      window.addEventListener('resize', onResize);
      (term as any)._cleanup = () => { ro.disconnect(); window.removeEventListener('resize', onResize); };
    }

    initPty().catch(() => { if (!disposed) fallbackToWeb(); });

    return () => {
      disposed = true;
      if (toastTimer.current) clearTimeout(toastTimer.current);
      try { wsRef.current?.close(); } catch {}
      try { xtermRef.current?._cleanup?.(); } catch {}
      try { xtermRef.current?.dispose?.(); } catch {}
      xtermRef.current = null;
    };
  }, [fallbackToWeb]);

  // Web mode command handler
  const handleWebCommand = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    const cmd = input.trim();
    setInput('');
    setHistory(prev => [...prev, { type: 'input', text: `${getPromptLabel(cwd)} $ ${cmd}` }]);
    if (cmd === 'clear') { setHistory([]); return; }
    try {
      const data = await platform.runTerminal(cmd, cwd === '~' ? undefined : cwd);
      if (data.cwd) setCwd(data.cwd);
      if (data.output) setHistory(prev => [...prev, { type: 'output', text: data.output }]);
    } catch (err: any) {
      setHistory(prev => [...prev, { type: 'output', text: `Error: ${err.message}` }]);
    }
  }, [input, cwd]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [history]);

  function getPromptLabel(cwd: string) {
    if (!cwd || cwd === '~') return '~';
    const normalized = cwd.replace(/\\/g, '/').replace(/\/$/, '');
    const parts = normalized.split('/');
    return parts[parts.length - 1] || normalized;
  }

  // preventDefault en el pointerdown evita que el botón robe el foco al textarea
  // de xterm y cierre el teclado del sistema.
  const keepFocus = (e: React.PointerEvent) => e.preventDefault();

  return (
    <div className="flex flex-col h-full bg-[#0C0C0C] text-zinc-300 font-mono text-[13px] relative">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 sticky top-0 bg-zinc-900/95 border-b border-zinc-800 z-10">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate(-1)} className="text-zinc-400 hover:text-zinc-100 transition-colors">
            <ArrowLeft size={18} />
          </button>
          <span className="text-zinc-100 font-sans font-semibold text-sm">Terminal</span>
          {mode === 'pty' && (
            <span className="text-[10px] bg-emerald-900/50 text-emerald-400 px-2 py-0.5 rounded-full font-sans">PTY</span>
          )}
          {mode === 'web' && (
            <span className="text-[10px] bg-amber-900/40 text-amber-400 px-2 py-0.5 rounded-full font-sans">simple</span>
          )}
        </div>
      </div>

      {/* PTY container — siempre montado para poder inicializar xterm; oculto en modo web */}
      <div
        ref={terminalRef}
        className="flex-1 px-1 py-1"
        style={{ minHeight: 0, display: mode === 'web' ? 'none' : 'block' }}
      />

      {mode === 'connecting' && (
        <div className="absolute inset-x-0 bottom-4 text-center text-zinc-600 text-xs pointer-events-none">
          Conectando terminal…
        </div>
      )}

      {mode === 'web' && (
        <div className="flex-1 overflow-y-auto p-4 space-y-1 scrollbar-hide pb-20" onClick={() => inputRef.current?.focus()}>
          {history.map((item, i) => (
            <div key={i} className={`whitespace-pre-wrap break-words ${item.type === 'input' ? 'text-emerald-400 font-medium' : 'text-zinc-300'}`}>
              {item.text}
            </div>
          ))}
          <div className="flex items-start">
            <span className="text-emerald-400 mr-2 shrink-0 font-medium" title={cwd}>{getPromptLabel(cwd)} $</span>
            <form onSubmit={handleWebCommand} className="flex-1">
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={e => setInput(e.target.value)}
                className="w-full bg-transparent outline-none text-zinc-100 caret-zinc-100"
                autoFocus autoCapitalize="none" autoComplete="off" autoCorrect="off" spellCheck="false"
              />
            </form>
          </div>
          <div ref={bottomRef} className="h-4" />
        </div>
      )}

      {/* Toast efímero */}
      {toast && (
        <div className="absolute bottom-14 left-1/2 -translate-x-1/2 bg-zinc-800 text-zinc-100 text-xs font-sans px-3 py-1.5 rounded-full shadow-lg border border-zinc-700 pointer-events-none z-20">
          {toast}
        </div>
      )}

      {/* Barra de teclas especial (solo en PTY) */}
      {mode === 'pty' && (
        <div className="flex-shrink-0 border-t border-zinc-800 bg-zinc-900/95 pb-safe-sm">
          <div className="flex items-center gap-1.5 px-2 py-1.5 overflow-x-auto scrollbar-hide">
            {/* Ctrl sostenido */}
            <button
              onPointerDown={keepFocus}
              onClick={toggleCtrl}
              className={`shrink-0 h-9 min-w-[42px] px-2.5 rounded-md text-xs font-sans font-medium transition-colors ${
                ctrlOn
                  ? 'bg-emerald-600 text-white'
                  : 'bg-zinc-800 text-zinc-200 active:bg-zinc-700'
              }`}
            >
              Ctrl
            </button>

            {KEYS.map((k) => (
              <button
                key={k.id}
                onPointerDown={keepFocus}
                onClick={() => sendPty(k.seq)}
                className="shrink-0 h-9 min-w-[42px] px-2.5 rounded-md bg-zinc-800 text-zinc-200 active:bg-zinc-700 text-xs font-sans font-medium flex items-center justify-center transition-colors"
              >
                {k.icon ?? k.label}
              </button>
            ))}

            <div className="shrink-0 w-px h-6 bg-zinc-700 mx-0.5" />

            <button
              onPointerDown={keepFocus}
              onClick={copyFromTerm}
              className="shrink-0 h-9 px-3 rounded-md bg-zinc-800 text-zinc-200 active:bg-zinc-700 text-xs font-sans font-medium flex items-center gap-1.5 transition-colors"
            >
              <Copy size={14} /> Copiar
            </button>
            <button
              onPointerDown={keepFocus}
              onClick={pasteToTerm}
              className="shrink-0 h-9 px-3 rounded-md bg-zinc-800 text-zinc-200 active:bg-zinc-700 text-xs font-sans font-medium flex items-center gap-1.5 transition-colors"
            >
              <ClipboardPaste size={14} /> Pegar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
