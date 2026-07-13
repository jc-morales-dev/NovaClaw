// NovaClaw — punto de entrada del agente (PC dev y APK).
// La lógica vive en src/server/ (módulos chicos y cohesivos); acá solo se
// orquesta el arranque: config → MCP → sesiones → Express → PTY.
//
// vite se importa dinámicamente solo en dev (ver startServer). Así el bundle de
// producción para Android no arrastra vite (que no se usa en prod).
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';

import { AGENT_TOKEN, loadConfigFromFile } from './src/server/config';
import { overrideConsole } from './src/server/state';
import { reconnectMcp } from './src/server/mcpRegistry';
import { loadSessionsFromDisk } from './src/server/sessions';
import { refreshOpenCodeAvailability } from './src/server/opencode';
import { attachPtyWebSocket } from './src/server/pty';
import { ensureLspInstalled } from './src/agent/lspInstall';
import { registerAdminRoutes } from './src/server/routes/admin';
import { registerChatRoutes } from './src/server/routes/chat';
import { registerTerminalRoutes } from './src/server/routes/terminal';

// Mismo orden de arranque que siempre: config → MCP → sesiones → logs.
loadConfigFromFile();
void reconnectMcp();
loadSessionsFromDisk();
overrideConsole();

async function startServer() {
  const app = express();
  const port = Number(process.env.PORT) || 3000;

  // Límite alto: los mensajes pueden traer imágenes en base64 (visión). Sin esto,
  // Express corta en 100kb y devuelve 413 (HTML) → "Unexpected token '<'" en la UI.
  app.use(express.json({ limit: '25mb' }));

  // Autenticación por token en TODO /api/*. Solo la UI de la app (que recibe el
  // token inyectado en el HTML) puede llamar al agente. Sin token (dev) se saltea.
  app.use('/api', (req, res, next) => {
    if (!AGENT_TOKEN) return next();
    const provided = req.headers['x-nova-token'] ?? req.query.token;
    if (provided !== AGENT_TOKEN) return res.status(403).json({ error: 'forbidden' });
    next();
  });

  registerAdminRoutes(app);
  registerChatRoutes(app);
  registerTerminalRoutes(app);

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = process.env.NOVACLAW_DIST || path.join(process.cwd(), 'dist');
    // index:false → servimos el index.html nosotros para INYECTAR el token, que la
    // UI (webAdapter) reenvía en cada llamada a /api. Los assets (js/css) van normal.
    app.use(express.static(distPath, { index: false }));
    let indexHtml = '';
    try { indexHtml = fs.readFileSync(path.join(distPath, 'index.html'), 'utf8'); } catch {}
    const injectedHtml = AGENT_TOKEN
      ? indexHtml.replace('</head>', `<script>window.__NOVA_TOKEN__=${JSON.stringify(AGENT_TOKEN)};</script></head>`)
      : indexHtml;
    app.get('*', (_req, res) => {
      res.type('html').send(injectedHtml || '<!doctype html><title>NovaClaw</title>');
    });
  }

  // Bind SOLO a loopback: el agente ejecuta comandos y toca el teléfono; jamás
  // debe quedar expuesto a la red WiFi/LTE. La UI lo alcanza en 127.0.0.1.
  const server = app.listen(port, '127.0.0.1', () => {
    console.log(`Server running on http://127.0.0.1:${port}`);
  });

  attachPtyWebSocket(server);

  // Deja code_intel listo de fábrica: instala el language server una vez, en
  // segundo plano (no bloquea el arranque; solo en el teléfono).
  ensureLspInstalled();

  await refreshOpenCodeAvailability();
}

startServer();
