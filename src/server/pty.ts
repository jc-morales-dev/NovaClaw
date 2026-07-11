// ── Terminal PTY real (WebSocket) ──────────────────────────────────────────
// Usa el truco de `script` (util-linux) para asignar un PTY real SIN código
// nativo: `script -q -c "stty ...; exec $SHELL -il" /dev/null` corre un shell
// interactivo dentro de una pseudo-terminal (/dev/pts/N), así vim/htop/tail -f
// funcionan de verdad. El WebSocket transporta la E/S hacia el xterm.js de la UI.
// Protocolo (mensajes JSON): {type:'input',data} y {type:'resize',cols,rows}.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

import { AGENT_TOKEN, DEFAULT_CWD } from './config';

function clampInt(value: string | null, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

export function attachPtyWebSocket(server: HttpServer) {
  const wss = new WebSocketServer({ server, path: '/pty' });

  wss.on('connection', (ws: WebSocket, req) => {
    const url = new URL(req.url ?? '/pty', 'http://localhost');
    // Auth: la terminal es una shell real; solo la UI de la app (con el token)
    // puede abrirla. Sin token configurado (dev) no se exige.
    if (AGENT_TOKEN && url.searchParams.get('token') !== AGENT_TOKEN) {
      try { ws.close(1008, 'forbidden'); } catch {}
      return;
    }
    const cols = clampInt(url.searchParams.get('cols'), 80, 20, 500);
    const rows = clampInt(url.searchParams.get('rows'), 24, 5, 300);

    const shell = process.env.SHELL || '/system/bin/sh';
    const scriptBin = process.env.PREFIX ? `${process.env.PREFIX}/bin/script` : 'script';
    // stty fija el tamaño del pts al del xterm; luego exec del shell interactivo.
    const inner = `stty rows ${rows} cols ${cols} 2>/dev/null; exec ${shell} -il`;

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(scriptBin, ['-q', '-c', inner, '/dev/null'], {
        cwd: process.env.HOME || DEFAULT_CWD,
        env: { ...process.env, TERM: 'xterm-256color' },
      });
    } catch (error: any) {
      try { ws.send(`\r\n\x1b[31mNo se pudo abrir la terminal: ${error?.message}\x1b[0m\r\n`); } catch {}
      ws.close();
      return;
    }

    const sendOut = (buf: Buffer) => {
      if (ws.readyState === ws.OPEN) ws.send(buf.toString('utf8'));
    };
    child.stdout.on('data', sendOut);
    child.stderr.on('data', sendOut);

    child.on('exit', (code) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(`\r\n\x1b[33m[proceso terminó con código ${code ?? 0}]\x1b[0m\r\n`);
        ws.close();
      }
    });

    ws.on('message', (raw) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg?.type === 'input' && typeof msg.data === 'string') {
        child.stdin.write(msg.data);
      }
      // El resize en vivo se omite a propósito: el pts lo posee `script` y no se
      // puede redimensionar desde node sin inyectar `stty` (que ensuciaría apps a
      // pantalla completa). El tamaño inicial ya se fija con el cols/rows del xterm.
    });

    ws.on('close', () => {
      try { child.kill('SIGHUP'); } catch {}
    });
  });

  console.log('PTY WebSocket listo en /pty');
}
