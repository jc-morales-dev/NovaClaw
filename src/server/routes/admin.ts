import fs from 'node:fs';
import type { Express } from 'express';

import type { McpServerConfig } from '../../agent/mcp';
import { PROVIDERS, getProvider } from '../../agent/providers';
import { verifyAndListModels } from '../../agent/modelClient';
import { saveConfigToFile, syncBaseUrlToProvider, zenConfig } from '../config';
import { getRuntimeSnapshot, runtimeState, startAgentRuntime, systemLogs } from '../state';
import { MCP_CONFIG_PATH, mcpManager, readMcpConfig, reconnectMcp } from '../mcpRegistry';
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
