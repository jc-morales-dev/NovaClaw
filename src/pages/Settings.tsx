import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Info,
  MessageSquare,
  ChevronRight,
  X,
  Cpu,
  Eye,
  EyeOff,
  CheckCircle2,
  AlertCircle,
  FolderOpen,
  Camera,
  MapPin,
  Users,
  Calendar,
  Plug,
  Wrench,
  Plus,
  Trash2,
  ShieldCheck,
  ExternalLink,
  Fingerprint,
} from 'lucide-react';
import { useSettings } from '../context/SettingsContext';
import { translations } from '../translations';
import { platform, type ProviderConfig, type ProviderInfo, type ModelInfo, type McpCatalogItem } from '../platform';
import { saveMcpSecret, hasMcpSecret, clearMcpSecret, confirmBiometric, hasNativeMcp } from '../mcpNative';
import {
  getConnectors,
  requestConnector,
  onConnectorsChanged,
  hasNativeConnectors,
  type ConnectorKey,
  type ConnectorState,
} from '../connectors';

export default function Settings() {
  const navigate = useNavigate();
  const { appLanguage, setAppLanguage } = useSettings();
  const t = translations[appLanguage as keyof typeof translations] || translations['English'];

  const [activeModal, setActiveModal] = useState<string | null>(null);
  const [feedbackText, setFeedbackText] = useState('');
  const [isFeedbackSent, setIsFeedbackSent] = useState(false);

  const isSpanish = appLanguage === 'Español';

  // Config del proveedor de IA — vive en el agente (novaclaw.config.json).
  const [config, setConfig] = useState<ProviderConfig | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<string>('opencode-zen');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState('');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [providerSaving, setProviderSaving] = useState(false);
  const [providerSaved, setProviderSaved] = useState(false);
  // Proveedores que ya tienen una API key guardada (una key por proveedor).
  const [keyProviders, setKeyProviders] = useState<string[]>([]);

  // Conectores del teléfono (permisos reales de Android).
  const [connectors, setConnectors] = useState<ConnectorState>(() => getConnectors());
  const nativeConnectors = hasNativeConnectors();

  // MCP: herramientas externas. Catálogo curado + formulario simple (sin JSON).
  const [mcpCatalog, setMcpCatalog] = useState<McpCatalogItem[]>([]);
  const [mcpTools, setMcpTools] = useState<Array<{ name: string; server: string }>>([]);
  const [mcpServers, setMcpServers] = useState<string[]>([]);
  const [mcpBusy, setMcpBusy] = useState('');   // id que se está conectando/quitando
  const [mcpError, setMcpError] = useState('');
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});
  const [savedSecrets, setSavedSecrets] = useState<Record<string, boolean>>({});
  // Formulario manual (avanzado).
  const [showManual, setShowManual] = useState(false);
  const [manName, setManName] = useState('');
  const [manCmd, setManCmd] = useState('npx');
  const [manArgs, setManArgs] = useState('');
  const [manSecretEnv, setManSecretEnv] = useState('');
  const [manSecretVal, setManSecretVal] = useState('');
  // JSON crudo (súper avanzado, escondido).
  const [showJson, setShowJson] = useState(false);
  const [mcpJson, setMcpJson] = useState('{\n  "mcpServers": {}\n}');

  async function refreshMcp() {
    try {
      const s = await platform.getMcpStatus();
      setMcpTools((s.tools ?? []).map((t) => ({ name: t.name, server: t.server })));
      setMcpServers(s.servers ?? []);
    } catch { /* ignore */ }
  }

  function toolCountFor(server: string): number {
    return mcpTools.filter((t) => t.server === server).length;
  }

  /** Conecta un MCP del catálogo (token → Keystore, huella, conectar). */
  async function connectCatalog(item: McpCatalogItem) {
    setMcpError('');
    const alreadyHasSecret = hasMcpSecret(item.id) || savedSecrets[item.id];
    const token = (secretDrafts[item.id] ?? '').trim();
    if (item.needsSecret && !alreadyHasSecret && !token) {
      setMcpError(isSpanish ? `Falta el ${item.secretLabel ?? 'token'}.` : `Missing the ${item.secretLabel ?? 'token'}.`);
      return;
    }
    setMcpBusy(item.id);
    try {
      if (item.needsSecret && token) {
        saveMcpSecret(item.id, token);                 // Keystore (teléfono) / no-op web
        setSavedSecrets((s) => ({ ...s, [item.id]: true }));
      }
      const ok = await confirmBiometric(
        isSpanish ? `Instalar ${item.label}` : `Install ${item.label}`,
        isSpanish ? 'Confirmá con tu huella' : 'Confirm with your fingerprint',
      );
      if (!ok) { setMcpError(isSpanish ? 'Cancelado.' : 'Cancelled.'); return; }
      const payload: any = { catalogId: item.id };
      if (item.needsSecret && token && !hasNativeMcp()) payload.secretValueDev = token; // dev/PC
      const res = await platform.connectMcp(payload);
      if (!res.ok) setMcpError(res.error ?? (isSpanish ? 'No se pudo conectar. Revisá el token.' : 'Could not connect. Check the token.'));
      setSecretDrafts((d) => ({ ...d, [item.id]: '' }));
      await refreshMcp();
    } catch (error: any) {
      setMcpError(error?.message ?? 'Error');
    } finally {
      setMcpBusy('');
    }
  }

  /** Conecta un MCP manual (formulario, no JSON). */
  async function connectManual() {
    setMcpError('');
    const id = manName.trim();
    if (!id || !manCmd.trim()) { setMcpError(isSpanish ? 'Poné nombre y comando.' : 'Enter a name and a command.'); return; }
    setMcpBusy(id);
    try {
      const hasSecret = Boolean(manSecretEnv.trim() && manSecretVal.trim());
      if (hasSecret) saveMcpSecret(id, manSecretVal.trim());
      const ok = await confirmBiometric(
        isSpanish ? `Instalar ${id}` : `Install ${id}`,
        isSpanish ? 'Confirmá con tu huella' : 'Confirm with your fingerprint',
      );
      if (!ok) { setMcpError(isSpanish ? 'Cancelado.' : 'Cancelled.'); return; }
      const payload: any = {
        id,
        command: manCmd.trim(),
        args: manArgs.trim() ? manArgs.trim().split(/\s+/) : [],
        secretEnv: manSecretEnv.trim() || undefined,
      };
      if (hasSecret && !hasNativeMcp()) payload.secretValueDev = manSecretVal.trim();
      const res = await platform.connectMcp(payload);
      if (!res.ok) { setMcpError(res.error ?? (isSpanish ? 'No se pudo conectar.' : 'Could not connect.')); }
      else { setManName(''); setManArgs(''); setManSecretEnv(''); setManSecretVal(''); setShowManual(false); }
      await refreshMcp();
    } catch (error: any) {
      setMcpError(error?.message ?? 'Error');
    } finally {
      setMcpBusy('');
    }
  }

  async function disconnectMcp(id: string) {
    setMcpBusy(id);
    try { await platform.disconnectMcp(id); clearMcpSecret(id); setSavedSecrets((s) => ({ ...s, [id]: false })); await refreshMcp(); }
    catch (error: any) { setMcpError(error?.message ?? 'Error'); }
    finally { setMcpBusy(''); }
  }

  /** Camino súper-avanzado: pegar el JSON crudo (formato Claude Desktop). */
  async function handleSaveMcpJson() {
    setMcpError('');
    let servers: Record<string, unknown>;
    try {
      const parsed = JSON.parse(mcpJson);
      servers = (parsed?.mcpServers ?? parsed) as Record<string, unknown>;
    } catch {
      setMcpError(isSpanish ? 'JSON inválido.' : 'Invalid JSON.');
      return;
    }
    setMcpBusy('__json__');
    try {
      const r = await platform.saveMcpConfig(servers as any);
      if (r.failed?.length) setMcpError((isSpanish ? 'Falló: ' : 'Failed: ') + r.failed.map((f) => `${f.name} (${f.error})`).join(', '));
      await refreshMcp();
    } catch (error: any) {
      setMcpError(error?.message ?? 'Error');
    } finally {
      setMcpBusy('');
    }
  }

  async function loadConfig() {
    try {
      const c = await platform.getConfig();
      setConfig(c);
      setSelectedProvider(c.provider ?? 'opencode-zen');
      setSelectedModel(c.model ?? '');
    } catch {}
  }

  useEffect(() => {
    loadConfig();
    platform.getProviders().then((r) => setProviders(r.providers ?? [])).catch(() => {});
    platform.getMcpConfig().then((r) => setMcpJson(JSON.stringify({ mcpServers: r.mcpServers ?? {} }, null, 2))).catch(() => {});
    platform.getMcpCatalog().then((r) => setMcpCatalog(r.catalog ?? [])).catch(() => {});
    platform.getMcpStatus().then((s) => {
      setMcpTools((s.tools ?? []).map((t) => ({ name: t.name, server: t.server })));
      setMcpServers(s.servers ?? []);
    }).catch(() => {});
    platform.getApiKeyProviders().then(setKeyProviders).catch(() => {});
  }, []);

  const currentProviderDef = providers.find((p) => p.id === selectedProvider);
  const hasKeyForSelected = keyProviders.includes(selectedProvider);
  const refreshKeyProviders = () => platform.getApiKeyProviders().then(setKeyProviders).catch(() => {});

  // Ver la key guardada: al mostrar, si el campo está vacío, la carga para verla/editarla.
  async function handleRevealKey() {
    if (!apiKeyVisible && !apiKeyInput.trim() && hasKeyForSelected) {
      try {
        const k = await platform.getStoredApiKey(selectedProvider);
        if (k) setApiKeyInput(k);
      } catch { /* sin puente (web) */ }
    }
    setApiKeyVisible((v) => !v);
  }

  async function handleDeleteKey() {
    try {
      await platform.deleteApiKey(selectedProvider);
      setApiKeyInput('');
      setApiKeyVisible(false);
      setModels([]);
      refreshKeyProviders();
    } catch { /* ignore */ }
  }

  async function handleVerify() {
    setVerifying(true);
    setVerifyError('');
    setModels([]);
    try {
      // Si el campo está vacío pero hay una key guardada del proveedor, usarla.
      let key = apiKeyInput.trim();
      if (!key && hasKeyForSelected) {
        try { key = await platform.getStoredApiKey(selectedProvider); } catch { /* web */ }
      }
      const result = await platform.verifyProvider(selectedProvider, key);
      if (!result.ok) {
        setVerifyError(result.error ?? 'No se pudo verificar.');
        return;
      }
      setModels(result.models);
      if (result.models.length > 0) {
        // Preseleccionar el modelo actual si sigue en la lista, o el primero.
        const keep = result.models.find((m) => m.id === selectedModel);
        setSelectedModel(keep ? keep.id : result.models[0].id);
      }
      if (result.error) setVerifyError(result.error);
    } catch (err: any) {
      setVerifyError(err?.message ?? 'Error verificando.');
    } finally {
      setVerifying(false);
    }
  }

  // Refrescar conectores al montar, al volver de un permiso, y periódicamente
  // (cubre el regreso desde la pantalla del sistema de "todos los archivos").
  useEffect(() => {
    const refresh = () => setConnectors(getConnectors());
    refresh();
    const unsub = onConnectorsChanged(refresh);
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    const interval = window.setInterval(refresh, 2500);
    return () => {
      unsub();
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(interval);
    };
  }, []);

  function handleConnector(key: ConnectorKey) {
    requestConnector(key);
    // Reintento de lectura tras el diálogo (por si el evento nativo se pierde).
    window.setTimeout(() => setConnectors(getConnectors()), 800);
  }

  const openModal = (name: string) => {
    if (name === 'provider' && config) {
      setSelectedProvider(config.provider ?? 'opencode-zen');
      setSelectedModel(config.model ?? '');
      setApiKeyInput('');
      setModels([]);
      setVerifyError('');
    }
    setActiveModal(name);
  };
  const closeModal = () => {
    setActiveModal(null);
    setApiKeyInput('');
    setApiKeyVisible(false);
    setProviderSaved(false);
    setVerifyError('');
    setModels([]);
  };

  async function handleSaveProvider() {
    setProviderSaving(true);
    setVerifyError('');
    try {
      const update: { provider?: string; model?: string; apiKey?: string } = {
        provider: selectedProvider,
        model: selectedModel.trim(),
      };
      // Solo mandamos la key si el usuario escribió una nueva (no pisamos la guardada).
      if (apiKeyInput.trim()) update.apiKey = apiKeyInput.trim();
      const c = await platform.saveConfig(update);
      setConfig(c);
      setSelectedModel(c.model ?? '');
      setProviderSaved(true);
      setApiKeyInput('');
      refreshKeyProviders();
      setTimeout(() => closeModal(), 1600);
    } catch (err: any) {
      setVerifyError(err?.message ?? (isSpanish ? 'No se pudo guardar.' : 'Failed to save.'));
    } finally {
      setProviderSaving(false);
    }
  }

  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-100 font-sans relative">
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-12 pb-4 sticky top-0 bg-zinc-950/80 backdrop-blur-xl z-20">
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate(-1)}
            className="p-2 -ml-2 text-zinc-400 hover:text-zinc-100 transition-colors"
          >
            <ArrowLeft size={24} />
          </button>
          <h1 className="text-xl font-bold">{t.settings}</h1>
        </div>
        <button
          onClick={() => { setFeedbackText(''); setIsFeedbackSent(false); openModal('feedback'); }}
          className="text-[#FFB25C] hover:text-orange-300 font-semibold text-sm px-2"
        >
          {appLanguage === 'Español' ? 'Comentarios' : appLanguage === 'Français' ? 'Retour' : 'Feedback'}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-12 space-y-8">

        {/* Modelo de IA — una sola entrada: proveedor + key + modelo verificado */}
        <SettingsSection icon={<Cpu size={18} />} title={isSpanish ? 'Modelo de IA' : 'AI Model'}>
          <SettingsGroup>
            <SettingsItem
              title={isSpanish ? 'Proveedor y modelo' : 'Provider & model'}
              value={
                config
                  ? `${providers.find((p) => p.id === config.provider)?.label ?? config.provider} · ${config.model || (isSpanish ? 'sin modelo' : 'no model')}`
                  : (isSpanish ? 'Cargando…' : 'Loading…')
              }
              valueColor={config?.hasApiKey ? 'text-emerald-400' : 'text-amber-400'}
              onClick={() => openModal('provider')}
            />
          </SettingsGroup>
          <p className="text-zinc-600 text-xs px-2 mt-2 leading-relaxed">
            {isSpanish
              ? 'Elegí el proveedor, pegá tu API key y verificamos en el momento. Te mostramos los modelos reales de ese proveedor.'
              : 'Pick the provider, paste your API key and we verify instantly, then show that provider\'s real models.'}
          </p>
        </SettingsSection>

        {/* Conectores — permisos del teléfono que activa el usuario */}
        <SettingsSection icon={<Plug size={18} />} title={isSpanish ? 'Conectores' : 'Connectors'}>
          <SettingsGroup>
            <ConnectorRow
              icon={<FolderOpen size={20} className="text-[#FFB25C]" />}
              title={isSpanish ? 'Archivos del teléfono' : 'Phone files'}
              desc={isSpanish ? 'El agente puede buscar, leer y organizar tus archivos' : 'The agent can search, read and organize your files'}
              on={connectors.files || connectors.allFiles}
              onConnect={() => handleConnector('files')}
              isSpanish={isSpanish}
            />
            <ConnectorRow
              icon={<Camera size={20} className="text-[#FFB25C]" />}
              title={isSpanish ? 'Cámara' : 'Camera'}
              desc={isSpanish ? 'Tomar y analizar fotos' : 'Take and analyze photos'}
              on={connectors.camera}
              onConnect={() => handleConnector('camera')}
              isSpanish={isSpanish}
            />
            <ConnectorRow
              icon={<MapPin size={20} className="text-[#FFB25C]" />}
              title={isSpanish ? 'Ubicación' : 'Location'}
              desc={isSpanish ? 'Saber dónde estás para tareas con contexto' : 'Know where you are for context-aware tasks'}
              on={connectors.location}
              onConnect={() => handleConnector('location')}
              isSpanish={isSpanish}
            />
            <ConnectorRow
              icon={<Users size={20} className="text-[#FFB25C]" />}
              title={isSpanish ? 'Contactos' : 'Contacts'}
              desc={isSpanish ? 'Buscar personas para mensajes y agenda' : 'Look up people for messages and scheduling'}
              on={connectors.contacts}
              onConnect={() => handleConnector('contacts')}
              isSpanish={isSpanish}
            />
            <ConnectorRow
              icon={<Calendar size={20} className="text-[#FFB25C]" />}
              title={isSpanish ? 'Calendario' : 'Calendar'}
              desc={isSpanish ? 'Ver y crear eventos' : 'View and create events'}
              on={connectors.calendar}
              onConnect={() => handleConnector('calendar')}
              isSpanish={isSpanish}
            />
          </SettingsGroup>

          {/* Acceso total a archivos (el "modo AnyClaw") */}
          <div className="mt-2.5 rounded-2xl border border-[#FF7A1A]/25 bg-[#FF7A1A]/[0.06] p-4">
            <div className="flex items-start gap-3">
              <FolderOpen size={20} className="text-[#FFB25C] mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <h3 className="font-semibold text-zinc-100 text-[15px]">
                  {isSpanish ? 'Acceso total al teléfono' : 'Full phone access'}
                </h3>
                <p className="text-zinc-400 text-[12.5px] mt-0.5 leading-relaxed">
                  {isSpanish
                    ? 'Deja que el agente revise, encuentre y gestione cualquier archivo del teléfono. Ideal para pedirle cosas como "buscá el PDF que descargué ayer".'
                    : 'Let the agent review, find and manage any file on the phone. Great for asking "find the PDF I downloaded yesterday".'}
                </p>
                <button
                  type="button"
                  onClick={() => handleConnector('allFiles')}
                  className={`mt-3 px-4 py-2 rounded-xl text-[13px] font-semibold transition-colors ${
                    connectors.allFiles
                      ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                      : 'bg-[#FF7A1A] text-[#1A0E02] hover:brightness-110'
                  }`}
                >
                  {connectors.allFiles
                    ? (isSpanish ? '✓ Activado' : '✓ Enabled')
                    : (isSpanish ? 'Activar acceso total' : 'Enable full access')}
                </button>
              </div>
            </div>
          </div>

          <p className="text-zinc-600 text-xs px-2 mt-2 leading-relaxed">
            {!nativeConnectors
              ? (isSpanish
                  ? 'Los conectores funcionan dentro de la app instalada en el teléfono.'
                  : 'Connectors work inside the app installed on the phone.')
              : (isSpanish
                  ? 'Activá solo lo que quieras. Podés revocar los permisos cuando quieras desde los ajustes del sistema.'
                  : 'Enable only what you want. You can revoke permissions anytime from system settings.')}
          </p>
        </SettingsSection>

        {/* Herramientas MCP (externas) */}
        <SettingsSection icon={<Wrench size={18} />} title={isSpanish ? 'Herramientas (MCP)' : 'Tools (MCP)'}>
          <SettingsGroup>
            <SettingsItem
              title={isSpanish ? 'Servidores MCP' : 'MCP servers'}
              value={mcpTools.length ? `${mcpTools.length} ${isSpanish ? 'conectadas' : 'connected'}` : (isSpanish ? 'Ninguno' : 'None')}
              onClick={() => openModal('mcp')}
            />
          </SettingsGroup>
          <p className="text-zinc-600 text-xs px-2 mt-2 leading-relaxed">
            {isSpanish
              ? 'Conectá herramientas externas (GitHub, bases de datos, buscadores…) por MCP, como en OpenCode.'
              : 'Connect external tools (GitHub, databases, search…) via MCP, like OpenCode.'}
          </p>
        </SettingsSection>

        {/* Preferences */}
        <SettingsSection icon={<Info size={18} />} title={t.preferences}>
          <SettingsGroup>
            <SettingsItem
              title={t.appLanguage}
              value={appLanguage}
              onClick={() => openModal('language')}
            />
          </SettingsGroup>
        </SettingsSection>

        {/* Logs */}
        <SettingsSection>
          <SettingsGroup>
            <SettingsItem
              title={t.viewLogs}
              value="Node.js, WebView & system logs"
              icon={<MessageSquare size={18} className="text-zinc-500" />}
              onClick={() => navigate('/logs')}
            />
          </SettingsGroup>
        </SettingsSection>

        <div className="pt-4 pb-8 flex flex-col items-center">
          <p className="text-zinc-600 text-sm font-medium mb-6">NovaClaw v3.0.0</p>
        </div>
      </div>

      {/* Modals */}
      {activeModal && (
        <div className="absolute inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-end justify-center sm:items-center">
          <div className="bg-zinc-900 w-full rounded-t-[32px] sm:rounded-[32px] sm:w-[90%] p-6 pb-10 sm:pb-6 border border-zinc-800 shadow-2xl">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold">
                {activeModal === 'language' && t.appLanguage}
                {activeModal === 'feedback' && 'Send Feedback'}
                {activeModal === 'provider' && (isSpanish ? 'Proveedor de IA' : 'AI Provider')}
                {activeModal === 'mcp' && (isSpanish ? 'Herramientas (MCP)' : 'Tools (MCP)')}
              </h2>
              <button onClick={closeModal} className="p-2 bg-zinc-800 rounded-full hover:bg-zinc-700 text-zinc-400">
                <X size={20} />
              </button>
            </div>

            {/* Provider modal: proveedor -> API key -> verificar -> modelo */}
            {activeModal === 'provider' && (
              <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
                {providerSaved ? (
                  <div className="flex flex-col items-center justify-center py-8 text-center space-y-3">
                    <CheckCircle2 size={48} className="text-emerald-400" />
                    <p className="font-semibold text-emerald-400 text-lg">
                      {isSpanish ? '¡Guardado!' : 'Saved!'}
                    </p>
                    <p className="text-zinc-400 text-sm">
                      {isSpanish ? 'El agente ya usa el nuevo modelo.' : 'The agent now uses the new model.'}
                    </p>
                  </div>
                ) : (
                  <>
                    {/* Paso 1: proveedor */}
                    <div className="space-y-1.5">
                      <label className="text-zinc-400 text-xs font-semibold px-1">
                        {isSpanish ? '1 · Proveedor' : '1 · Provider'}
                      </label>
                      <div className="grid grid-cols-2 gap-2">
                        {providers.map((p) => {
                          const disabled = p.note === 'login-oauth';
                          const active = p.id === selectedProvider;
                          return (
                            <button
                              key={p.id}
                              type="button"
                              disabled={disabled}
                              onClick={() => { setSelectedProvider(p.id); setModels([]); setVerifyError(''); setApiKeyInput(''); setApiKeyVisible(false); }}
                              className={`px-3 py-2.5 rounded-xl text-[13px] font-semibold text-left border transition-colors ${
                                active
                                  ? 'bg-[#FF7A1A]/12 border-[#FF7A1A] text-orange-100'
                                  : disabled
                                    ? 'bg-zinc-950 border-zinc-900 text-zinc-600 cursor-not-allowed'
                                    : 'bg-zinc-950 border-zinc-800 text-zinc-300 hover:bg-zinc-800'
                              }`}
                            >
                              <span className="flex items-center gap-1.5">
                                {keyProviders.includes(p.id) && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" title="Con key guardada" />}
                                {p.label}
                              </span>
                              {disabled && <span className="block text-[10px] text-zinc-600 mt-0.5">{isSpanish ? 'Próximamente' : 'Coming soon'}</span>}
                            </button>
                          );
                        })}
                      </div>
                      {currentProviderDef && (
                        <p className="text-zinc-600 text-[11px] px-1 pt-1 leading-snug">{currentProviderDef.keyHint}</p>
                      )}
                    </div>

                    {/* Paso 2: API key + verificar */}
                    <div className="space-y-1.5">
                      <label className="text-zinc-400 text-xs font-semibold px-1 flex items-center justify-between">
                        <span>
                          {isSpanish ? '2 · API Key de ' : '2 · API Key for '}{currentProviderDef?.label ?? selectedProvider}
                          {hasKeyForSelected && <span className="text-emerald-500"> · {isSpanish ? 'guardada' : 'saved'}</span>}
                        </span>
                        {hasKeyForSelected && (
                          <button type="button" onClick={handleDeleteKey} className="text-red-400/80 hover:text-red-400 text-[11px] font-semibold">
                            {isSpanish ? 'Borrar' : 'Delete'}
                          </button>
                        )}
                      </label>
                      <div className="relative">
                        <input
                          type={apiKeyVisible ? 'text' : 'password'}
                          value={apiKeyInput}
                          onChange={(e) => { setApiKeyInput(e.target.value); setVerifyError(''); }}
                          placeholder={hasKeyForSelected ? (isSpanish ? 'Dejar vacío para usar la guardada' : 'Leave blank to keep saved') : 'sk-...'}
                          className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 pr-12 text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-[#FF7A1A] text-[14px] font-mono"
                          autoComplete="off" autoCorrect="off" autoCapitalize="none"
                        />
                        <button
                          type="button"
                          onClick={handleRevealKey}
                          title={isSpanish ? 'Ver / ocultar' : 'Show / hide'}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors p-1"
                        >
                          {apiKeyVisible ? <EyeOff size={18} /> : <Eye size={18} />}
                        </button>
                      </div>
                      <button
                        type="button"
                        disabled={verifying || (!apiKeyInput.trim() && !hasKeyForSelected)}
                        onClick={handleVerify}
                        className="w-full mt-1 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-100 font-semibold py-3 rounded-xl transition-colors flex items-center justify-center gap-2"
                      >
                        {verifying ? (isSpanish ? 'Verificando…' : 'Verifying…') : (isSpanish ? 'Verificar y ver modelos' : 'Verify & list models')}
                      </button>
                    </div>

                    {verifyError && (
                      <div className="flex items-center gap-2 text-amber-400 text-sm">
                        <AlertCircle size={16} className="shrink-0" />
                        <span>{verifyError}</span>
                      </div>
                    )}

                    {/* Paso 3: modelos (aparecen tras verificar) */}
                    {models.length > 0 && (
                      <div className="space-y-1.5">
                        <label className="text-zinc-400 text-xs font-semibold px-1 flex items-center gap-1.5">
                          <CheckCircle2 size={14} className="text-emerald-400" />
                          {isSpanish ? `3 · Modelo (${models.length} disponibles)` : `3 · Model (${models.length} available)`}
                        </label>
                        <div className="space-y-1.5 max-h-52 overflow-y-auto">
                          {models.map((m) => (
                            <button
                              key={m.id}
                              type="button"
                              onClick={() => setSelectedModel(m.id)}
                              className={`w-full text-left px-3.5 py-2.5 rounded-xl border flex items-center justify-between gap-2 transition-colors ${
                                m.id === selectedModel
                                  ? 'bg-[#FF7A1A]/12 border-[#FF7A1A] text-orange-100'
                                  : 'bg-zinc-950 border-zinc-800 text-zinc-300 hover:bg-zinc-800'
                              }`}
                            >
                              <span className="min-w-0">
                                <span className="block text-[14px] font-medium truncate">{m.label}</span>
                                <span className="block text-[11px] text-zinc-500 truncate font-mono">{m.id}</span>
                              </span>
                              {m.tier && (
                                <span className={`shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-full ${
                                  m.tier === 'premium' ? 'bg-violet-500/15 text-violet-300' : 'bg-emerald-500/15 text-emerald-300'
                                }`}>
                                  {m.tier === 'premium' ? (isSpanish ? 'POTENTE' : 'PREMIUM') : (isSpanish ? 'VALOR' : 'VALUE')}
                                </span>
                              )}
                              {m.id === selectedModel && !m.tier && <CheckCircle2 size={16} className="text-[#FFB25C] shrink-0" />}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Guardar */}
                    <button
                      type="button"
                      disabled={providerSaving || !selectedModel}
                      onClick={handleSaveProvider}
                      className="w-full bg-[#E8660D] hover:bg-[#FF7A1A] disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-3.5 rounded-xl transition-colors"
                    >
                      {providerSaving ? (isSpanish ? 'Guardando…' : 'Saving…') : (isSpanish ? 'Guardar y usar este modelo' : 'Save & use this model')}
                    </button>
                  </>
                )}
              </div>
            )}

            {/* MCP modal: editor de config + tools conectadas */}
            {activeModal === 'mcp' && (
              <div className="space-y-3 max-h-[72vh] overflow-y-auto pr-1">
                {/* Lo más fácil: pedirle al agente */}
                <div className="rounded-2xl border border-[#FF7A1A]/25 bg-[#FF7A1A]/[0.06] p-3.5">
                  <p className="text-[13px] text-zinc-200 leading-relaxed">
                    💡 <span className="font-semibold">{isSpanish ? 'Lo más fácil:' : 'Easiest:'}</span>{' '}
                    {isSpanish
                      ? 'pedile al agente en el chat, por ejemplo '
                      : 'just ask the agent in chat, e.g. '}
                    <span className="text-[#FFB25C] font-medium">"{isSpanish ? 'instalá el MCP de GitHub' : 'install the GitHub MCP'}"</span>
                    {isSpanish ? ' y lo instala solo.' : ' and it installs it for you.'}
                  </p>
                </div>

                {mcpError && <p className="text-red-400 text-[12px] leading-snug">{mcpError}</p>}

                {/* Conectados */}
                {mcpServers.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-emerald-400 text-[12px] font-semibold">{isSpanish ? 'Conectados' : 'Connected'}</p>
                    {mcpServers.map((srv) => (
                      <div key={srv} className="flex items-center justify-between rounded-xl bg-zinc-900 border border-zinc-800 px-3 py-2.5">
                        <div className="min-w-0">
                          <p className="text-[13px] font-medium text-zinc-100 truncate">{srv}</p>
                          <p className="text-[11px] text-zinc-500">{toolCountFor(srv)} {isSpanish ? 'herramientas' : 'tools'}</p>
                        </div>
                        <button
                          type="button"
                          disabled={mcpBusy === srv}
                          onClick={() => disconnectMcp(srv)}
                          className="shrink-0 p-2 rounded-lg text-zinc-400 hover:text-red-400 hover:bg-red-500/10 disabled:opacity-40 transition-colors"
                          aria-label={isSpanish ? 'Quitar' : 'Remove'}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Catálogo */}
                <p className="text-zinc-400 text-[12px] font-semibold pt-1">{isSpanish ? 'Conectar una herramienta' : 'Connect a tool'}</p>
                <div className="space-y-2">
                  {mcpCatalog.filter((c) => !mcpServers.includes(c.id)).map((item) => {
                    const stored = hasMcpSecret(item.id) || savedSecrets[item.id];
                    const needsInput = item.needsSecret && !stored;
                    return (
                      <div key={item.id} className="rounded-xl bg-zinc-900 border border-zinc-800 p-3 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <p className="text-[13px] font-medium text-zinc-100 truncate">{item.label}</p>
                              {item.verified && <ShieldCheck size={13} className="text-emerald-400 shrink-0" />}
                            </div>
                            <p className="text-[11px] text-zinc-500 leading-snug">{item.description}</p>
                          </div>
                          <button
                            type="button"
                            disabled={mcpBusy === item.id}
                            onClick={() => connectCatalog(item)}
                            className="shrink-0 flex items-center gap-1 bg-[#FF7A1A] text-[#1A0E02] text-[12px] font-semibold px-3 py-1.5 rounded-lg hover:brightness-110 disabled:opacity-50 transition"
                          >
                            {mcpBusy === item.id ? (isSpanish ? '…' : '…') : (<><Plus size={13} /> {isSpanish ? 'Conectar' : 'Connect'}</>)}
                          </button>
                        </div>
                        {needsInput && (
                          <div className="space-y-1.5">
                            <input
                              type="password"
                              value={secretDrafts[item.id] ?? ''}
                              onChange={(e) => setSecretDrafts((d) => ({ ...d, [item.id]: e.target.value }))}
                              placeholder={item.secretLabel ?? (isSpanish ? 'Token' : 'Token')}
                              spellCheck={false}
                              autoCapitalize="none"
                              autoCorrect="off"
                              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-[12px] text-zinc-200 focus:outline-none focus:border-[#FF7A1A]/50"
                            />
                            {(item.secretHint || item.secretHelpUrl) && (
                              <p className="text-[10.5px] text-zinc-500 leading-snug">
                                {item.secretHint}
                                {item.secretHelpUrl && (
                                  <> · <a href={item.secretHelpUrl} target="_blank" rel="noreferrer" className="text-[#FFB25C] inline-flex items-center gap-0.5">{isSpanish ? 'generar' : 'get one'} <ExternalLink size={10} /></a></>
                                )}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Agregar manualmente (formulario, no JSON) */}
                <button
                  type="button"
                  onClick={() => setShowManual((v) => !v)}
                  className="w-full flex items-center justify-center gap-1.5 text-[12px] text-zinc-400 hover:text-zinc-200 py-2 transition-colors"
                >
                  <Plus size={14} /> {isSpanish ? 'Agregar manualmente' : 'Add manually'}
                </button>
                {showManual && (
                  <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-3 space-y-2">
                    <input value={manName} onChange={(e) => setManName(e.target.value)} placeholder={isSpanish ? 'Nombre (ej: github)' : 'Name (e.g. github)'} spellCheck={false} autoCapitalize="none" autoCorrect="off" className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-[12px] text-zinc-200 focus:outline-none focus:border-[#FF7A1A]/50" />
                    <input value={manCmd} onChange={(e) => setManCmd(e.target.value)} placeholder="npx" spellCheck={false} autoCapitalize="none" autoCorrect="off" className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-[12px] font-mono text-zinc-200 focus:outline-none focus:border-[#FF7A1A]/50" />
                    <input value={manArgs} onChange={(e) => setManArgs(e.target.value)} placeholder={isSpanish ? 'Argumentos (ej: -y @scope/paquete)' : 'Args (e.g. -y @scope/package)'} spellCheck={false} autoCapitalize="none" autoCorrect="off" className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-[12px] font-mono text-zinc-200 focus:outline-none focus:border-[#FF7A1A]/50" />
                    <div className="grid grid-cols-2 gap-2">
                      <input value={manSecretEnv} onChange={(e) => setManSecretEnv(e.target.value)} placeholder={isSpanish ? 'Variable (opcional)' : 'Env var (optional)'} spellCheck={false} autoCapitalize="none" autoCorrect="off" className="bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-[12px] font-mono text-zinc-200 focus:outline-none focus:border-[#FF7A1A]/50" />
                      <input type="password" value={manSecretVal} onChange={(e) => setManSecretVal(e.target.value)} placeholder={isSpanish ? 'Token (opcional)' : 'Token (optional)'} spellCheck={false} autoCapitalize="none" autoCorrect="off" className="bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-[12px] text-zinc-200 focus:outline-none focus:border-[#FF7A1A]/50" />
                    </div>
                    <button type="button" disabled={mcpBusy === manName.trim()} onClick={connectManual} className="w-full bg-[#FF7A1A] text-[#1A0E02] font-semibold py-2.5 rounded-lg hover:brightness-110 disabled:opacity-50 transition-colors text-[13px]">
                      {isSpanish ? 'Conectar' : 'Connect'}
                    </button>
                  </div>
                )}

                {/* Nota de seguridad: la huella */}
                <p className="text-[10.5px] text-zinc-500 leading-snug flex items-start gap-1.5 pt-1">
                  <Fingerprint size={13} className="text-zinc-400 shrink-0 mt-0.5" />
                  {isSpanish
                    ? 'Al instalar una herramienta nueva te pedimos tu huella. Los tokens se guardan cifrados en el teléfono.'
                    : 'Installing a new tool asks for your fingerprint. Tokens are stored encrypted on the phone.'}
                </p>

                {/* Súper-avanzado: JSON crudo (escondido) */}
                <button type="button" onClick={() => setShowJson((v) => !v)} className="w-full text-[11px] text-zinc-600 hover:text-zinc-400 py-1 transition-colors">
                  {isSpanish ? 'Avanzado: editar JSON' : 'Advanced: edit JSON'}
                </button>
                {showJson && (
                  <div className="space-y-2">
                    <textarea
                      value={mcpJson}
                      onChange={(e) => setMcpJson(e.target.value)}
                      spellCheck={false}
                      autoCapitalize="none"
                      autoCorrect="off"
                      className="w-full h-40 bg-zinc-950 border border-zinc-800 rounded-xl p-3 text-[12px] font-mono text-zinc-200 resize-none focus:outline-none focus:border-[#FF7A1A]/50"
                    />
                    <button type="button" disabled={mcpBusy === '__json__'} onClick={handleSaveMcpJson} className="w-full bg-zinc-800 text-zinc-100 font-semibold py-2.5 rounded-lg hover:bg-zinc-700 disabled:opacity-50 transition-colors text-[13px]">
                      {mcpBusy === '__json__' ? (isSpanish ? 'Conectando…' : 'Connecting…') : (isSpanish ? 'Guardar JSON' : 'Save JSON')}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Feedback modal */}
            {activeModal === 'feedback' && (
              <div className="space-y-4">
                {isFeedbackSent ? (
                  <div className="flex flex-col items-center justify-center py-6 text-center space-y-4">
                    <div className="w-16 h-16 bg-emerald-500/20 rounded-full flex items-center justify-center text-emerald-500">
                      <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                    </div>
                    <p className="font-medium text-emerald-400">Feedback sent!</p>
                    <button onClick={closeModal} className="mt-4 w-full bg-zinc-800 hover:bg-zinc-700 text-white font-semibold py-3 rounded-xl transition-colors">Close</button>
                  </div>
                ) : (
                  <>
                    <p className="text-zinc-400 text-sm">Tell us what you think or report a bug.</p>
                    <textarea
                      value={feedbackText}
                      onChange={(e) => setFeedbackText(e.target.value)}
                      placeholder="Describe your feedback..."
                      className="w-full h-32 bg-zinc-950 border border-zinc-800 rounded-xl p-4 text-zinc-100 focus:outline-none focus:border-[#FF7A1A] resize-none"
                    />
                    <button
                      disabled={!feedbackText.trim()}
                      onClick={() => { setTimeout(() => { setIsFeedbackSent(true); setTimeout(() => closeModal(), 2500); }, 500); }}
                      className="w-full bg-[#E8660D] hover:bg-[#FF7A1A] disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-xl mt-2 transition-colors"
                    >
                      Send
                    </button>
                  </>
                )}
              </div>
            )}

            {/* Language modal */}
            {activeModal === 'language' && (
              <div className="space-y-3">
                {['English', 'Español', 'Français'].map((lang) => (
                  <button
                    key={lang}
                    onClick={() => { setAppLanguage(lang); closeModal(); }}
                    className={`w-full text-left px-4 py-3 rounded-xl flex items-center justify-between border ${
                      lang === appLanguage
                        ? 'bg-[#FF7A1A]/10 border-[#FF7A1A] text-orange-100'
                        : 'bg-zinc-950 border-zinc-800 text-zinc-300 hover:bg-zinc-800'
                    }`}
                  >
                    <span className="font-medium">{lang}</span>
                    {lang === appLanguage && <CheckCircle2 size={18} className="text-[#FFB25C]" />}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ConnectorRow({
  icon,
  title,
  desc,
  on,
  onConnect,
  isSpanish,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  on: boolean;
  onConnect: () => void;
  isSpanish: boolean;
}) {
  return (
    <div className="flex items-center justify-between p-4 bg-zinc-900">
      <div className="flex items-start gap-3 min-w-0">
        <div className="mt-0.5 shrink-0">{icon}</div>
        <div className="min-w-0">
          <h3 className="font-semibold text-zinc-100 text-[15px]">{title}</h3>
          <p className="text-zinc-500 text-[12px] mt-0.5 leading-snug">{desc}</p>
        </div>
      </div>
      <button
        type="button"
        onClick={onConnect}
        disabled={on}
        className={`shrink-0 ml-3 px-3.5 py-2 rounded-xl text-[13px] font-semibold transition-colors ${
          on
            ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
            : 'bg-[#FF7A1A]/12 text-[#FFC58A] border border-[#FF7A1A]/30 hover:bg-[#FF7A1A]/20'
        }`}
      >
        {on ? (isSpanish ? '✓ Activo' : '✓ On') : (isSpanish ? 'Conectar' : 'Connect')}
      </button>
    </div>
  );
}

function SettingsSection({ title, icon, children }: { title?: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      {title && (
        <div className="flex items-center gap-2 px-2 text-[#FFB25C]">
          {icon}
          <span className="font-semibold text-sm uppercase tracking-wider">{title}</span>
        </div>
      )}
      {children}
    </div>
  );
}

function SettingsGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-zinc-900 rounded-2xl border border-zinc-800 overflow-hidden divide-y divide-zinc-800/50 shadow-sm">
      {children}
    </div>
  );
}

function SettingsItem({ title, value, icon, onClick, valueColor = 'text-zinc-400' }: { title: string; value?: string; icon?: React.ReactNode; onClick?: () => void; valueColor?: string; }) {
  return (
    <div
      onClick={onClick}
      className={`flex items-center justify-between p-4 bg-zinc-900 hover:bg-zinc-800/50 transition-colors ${onClick ? 'cursor-pointer active:bg-zinc-800' : ''}`}
    >
      <div className="flex items-start gap-3">
        {icon && <div className="mt-0.5">{icon}</div>}
        <div>
          <h3 className="font-semibold text-zinc-100 text-[16px]">{title}</h3>
          {value && <p className={`${valueColor} text-sm mt-0.5 truncate max-w-[220px]`}>{value}</p>}
        </div>
      </div>
      {onClick && <ChevronRight size={20} className="text-zinc-600 shrink-0 ml-2" />}
    </div>
  );
}
