import fs from 'node:fs';
import type { Express } from 'express';

import type { McpServerConfig } from '../../agent/mcp';
import { PROVIDERS, getProvider } from '../../agent/providers';
import { verifyAndListModels } from '../../agent/modelClient';
import { catalogForClient, findCatalogEntry } from '../../agent/mcpCatalog';
import { saveConfigToFile, syncBaseUrlToProvider, zenConfig } from '../config';
import { getRuntimeSnapshot, runtimeState, startAgentRuntime, systemLogs } from '../state';
import { MCP_CONFIG_PATH, mcpManager, readMcpConfig, reconnectMcp, saveMcpSecretDev, writeMcpConfig } from '../mcpRegistry';
import { isOpenCodeBusy, refreshOpenCodeAvailability, startOpenCodeRuntime, stopOpenCodeRuntime } from '../opencode';
import { undoLastChange } from '../agentRuntimes';

export function registerAdminRoutes(app: Express) {
  // Estado de los servidores MCP conectados y sus tools (Fase 2).
  app.get('/api/mcp', (_req, res) => {
    const tools = mcpManager.listTools();
    res.json({
      tools: tools.map((t) => ({ name: t.name, server: t.server, description: t.description })),
      servers: [...new Set(tools.map((t) => t.server))],
    });
  });

  // Config de servidores MCP (para la UI de Ajustes).
  app.get('/api/mcp/config', (_req, res) => {
    res.json({ mcpServers: readMcpConfig() });
  });

  app.post('/api/mcp/config', async (req, res) => {
    const servers = (req.body?.mcpServers ?? {}) as Record<string, McpServerConfig>;
    try {
      fs.writeFileSync(MCP_CONFIG_PATH, JSON.stringify({ mcpServers: servers }, null, 2), 'utf8');
      const result = await reconnectMcp();
      res.json({
        ...result,
        tools: mcpManager.listTools().map((t) => ({ name: t.name, server: t.server })),
      });
    } catch (error: any) {
      res.status(400).json({ error: error?.message ?? 'No se pudo guardar la config MCP.' });
    }
  });

  // Catálogo curado de MCP conocidos (para los botones "Conectar" de un toque).
  app.get('/api/mcp/catalog', (_req, res) => {
    res.json({ catalog: catalogForClient() });
  });

  // Conectar un MCP (desde el catálogo por `id`, o manual con command/args).
  // Los secretos NO viajan en texto plano al config: se guardan aparte (Keystore
  // en el teléfono vía el bridge; en dev, secretValueDev → novaclaw.secrets.json)
  // y el config solo lleva el placeholder ${SECRET:<id>}.
  app.post('/api/mcp/connect', async (req, res) => {
    const body = req.body ?? {};
    const fromCatalog = body.catalogId ? findCatalogEntry(String(body.catalogId)) : undefined;

    const id = String(body.id ?? fromCatalog?.id ?? '').trim();
    const command = String(body.command ?? fromCatalog?.command ?? '').trim();
    const args = Array.isArray(body.args) ? body.args.map(String) : (fromCatalog?.args ?? []);
    if (!id || !command) {
      return res.status(400).json({ error: 'Faltan "id" o "command".' });
    }

    // Nombre de la env var del secreto (del catálogo, o del form manual).
    const secretEnv = fromCatalog && fromCatalog.auth.type !== 'none'
      ? fromCatalog.auth.secret.env
      : (typeof body.secretEnv === 'string' ? body.secretEnv.trim() : '');

    // En dev (PC) el valor del secreto puede venir para guardarlo localmente.
    // En el teléfono el WebView YA lo guardó en el Keystore vía el bridge.
    if (secretEnv && typeof body.secretValueDev === 'string' && body.secretValueDev) {
      saveMcpSecretDev(id, body.secretValueDev);
    }

    const cfg = readMcpConfig();
    cfg[id] = {
      command,
      args,
      ...(secretEnv ? { env: { [secretEnv]: `\${SECRET:${id}}` } } : {}),
    };
    try {
      writeMcpConfig(cfg);
      const result = await reconnectMcp();
      const ok = result.connected.includes(id);
      const failure = result.failed.find((f) => f.name === id);
      const tools = mcpManager.listTools().filter((t) => t.server === id);
      res.json({
        ok,
        server: id,
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
        // Si falló y pedía secreto, probablemente falta/está mal el token.
        needsSecret: !ok && Boolean(secretEnv),
        error: ok ? null : (failure?.error ?? 'No se pudo conectar.'),
      });
    } catch (error: any) {
      res.status(500).json({ error: error?.message ?? 'No se pudo conectar el MCP.' });
    }
  });

  // Desconectar/quitar un MCP.
  app.post('/api/mcp/disconnect', async (req, res) => {
    const id = String(req.body?.id ?? '').trim();
    if (!id) return res.status(400).json({ error: 'Falta "id".' });
    const cfg = readMcpConfig();
    delete cfg[id];
    try {
      writeMcpConfig(cfg);
      await reconnectMcp();
      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ error: error?.message ?? 'No se pudo desconectar.' });
    }
  });

  // Deshacer: revierte el último archivo que el agente escribió/editó.
  app.post('/api/undo', (_req, res) => {
    const result = undoLastChange();
    if (result.ok) {
      return res.json({ ok: true, path: result.path, remaining: result.remaining });
    }
    if (result.status === 500) {
      return res.status(500).json({ ok: false, message: result.message });
    }
    return res.json({ ok: false, message: result.message });
  });

  app.get('/api/runtime/status', async (_req, res) => {
    if (!isOpenCodeBusy()) {
      await refreshOpenCodeAvailability();
    }
    res.json(getRuntimeSnapshot());
  });

  app.get('/api/logs', (_req, res) => {
    res.json({ logs: systemLogs });
  });

  app.delete('/api/logs', (_req, res) => {
    systemLogs.length = 0;
    res.json({ success: true });
  });

  let userSettings: Record<string, unknown> = {};

  app.get('/api/settings', (_req, res) => {
    res.json(userSettings);
  });

  app.post('/api/settings', (req, res) => {
    userSettings = { ...userSettings, ...req.body };
    res.json({ success: true });
  });

  app.post('/api/agent/start', (_req, res) => {
    startAgentRuntime();
    console.log(`Agent started successfully in ${runtimeState.agent.mode} mode.`);
    res.json({
      success: true,
      agent: runtimeState.agent,
    });
  });

  app.post('/api/opencode/start', async (_req, res) => {
    await startOpenCodeRuntime();
    return res.json({ success: true, opencode: runtimeState.opencode });
  });

  app.post('/api/opencode/stop', async (_req, res) => {
    await stopOpenCodeRuntime();
    res.json({ success: true, opencode: runtimeState.opencode });
  });

  // Config del proveedor de IA desde la UI (reemplaza el push manual por USB).
  // NUNCA devolvemos la apiKey; solo si está seteada.
  app.get('/api/config', (_req, res) => {
    res.json({
      provider: zenConfig.provider,
      baseUrl: zenConfig.baseUrl,
      model: zenConfig.model,
      hasApiKey: !!zenConfig.apiKey,
      mode: zenConfig.apiKey ? 'remote' : 'local',
    });
  });

  app.post('/api/config', (req, res) => {
    const { provider, baseUrl, apiKey, model } = req.body ?? {};
    // Solo se actualizan los campos provistos. Un apiKey === '' limpia la key.
    if (typeof provider === 'string' && provider.trim() && getProvider(provider.trim())) {
      zenConfig.provider = provider.trim();
      syncBaseUrlToProvider();
    }
    if (typeof baseUrl === 'string' && baseUrl.trim()) zenConfig.baseUrl = baseUrl.trim();
    if (typeof model === 'string' && model.trim()) zenConfig.model = model.trim();
    if (typeof apiKey === 'string') zenConfig.apiKey = apiKey.trim();

    try {
      saveConfigToFile();
    } catch (error: any) {
      return res.status(500).json({ error: `No se pudo guardar la config: ${error?.message}` });
    }

    // Refleja el nuevo estado en el runtime sin reiniciar el agente.
    runtimeState.agent.mode = zenConfig.apiKey ? 'remote' : 'local';
    runtimeState.agent.label = zenConfig.apiKey
      ? 'Modelo remoto en línea.'
      : 'Modo local de respaldo activo.';

    res.json({
      success: true,
      provider: zenConfig.provider,
      baseUrl: zenConfig.baseUrl,
      model: zenConfig.model,
      hasApiKey: !!zenConfig.apiKey,
      mode: zenConfig.apiKey ? 'remote' : 'local',
    });
  });

  // Lista de proveedores disponibles para la UI.
  app.get('/api/providers', (_req, res) => {
    res.json({
      providers: PROVIDERS.map((p) => ({
        id: p.id,
        label: p.label,
        needsKey: p.needsKey,
        keyHint: p.keyHint,
        note: p.note ?? null,
      })),
      current: zenConfig.provider,
    });
  });

  // Verificación real: pega la key, elige proveedor, verificamos contra su
  // /models y devolvemos la lista viva de modelos. Nada de humo.
  app.post('/api/provider/verify', async (req, res) => {
    const { provider, apiKey } = req.body ?? {};
    const providerId = typeof provider === 'string' ? provider : zenConfig.provider;
    const key = typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : zenConfig.apiKey;
    try {
      const result = await verifyAndListModels(providerId, key);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ ok: false, models: [], error: error?.message ?? 'Error verificando.' });
    }
  });
}
