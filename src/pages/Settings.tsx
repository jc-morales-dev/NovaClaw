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
  Mic,
  Plug,
} from 'lucide-react';
import { useSettings } from '../context/SettingsContext';
import { translations } from '../translations';
import { platform, type ProviderConfig, type ProviderInfo, type ModelInfo } from '../platform';
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

  // Conectores del teléfono (permisos reales de Android).
  const [connectors, setConnectors] = useState<ConnectorState>(() => getConnectors());
  const nativeConnectors = hasNativeConnectors();

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
  }, []);

  const currentProviderDef = providers.find((p) => p.id === selectedProvider);

  async function handleVerify() {
    setVerifying(true);
    setVerifyError('');
    setModels([]);
    try {
      const result = await platform.verifyProvider(selectedProvider, apiKeyInput.trim());
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
                              onClick={() => { setSelectedProvider(p.id); setModels([]); setVerifyError(''); }}
                              className={`px-3 py-2.5 rounded-xl text-[13px] font-semibold text-left border transition-colors ${
                                active
                                  ? 'bg-[#FF7A1A]/12 border-[#FF7A1A] text-orange-100'
                                  : disabled
                                    ? 'bg-zinc-950 border-zinc-900 text-zinc-600 cursor-not-allowed'
                                    : 'bg-zinc-950 border-zinc-800 text-zinc-300 hover:bg-zinc-800'
                              }`}
                            >
                              {p.label}
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
                      <label className="text-zinc-400 text-xs font-semibold px-1">
                        {isSpanish ? '2 · API Key' : '2 · API Key'}
                        {config?.hasApiKey && <span className="text-emerald-500"> · {isSpanish ? 'ya hay una guardada' : 'one already saved'}</span>}
                      </label>
                      <div className="relative">
                        <input
                          type={apiKeyVisible ? 'text' : 'password'}
                          value={apiKeyInput}
                          onChange={(e) => { setApiKeyInput(e.target.value); setVerifyError(''); }}
                          placeholder={config?.hasApiKey ? (isSpanish ? 'Dejar vacío para usar la guardada' : 'Leave blank to keep current') : 'sk-...'}
                          className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 pr-12 text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-[#FF7A1A] text-[14px] font-mono"
                          autoComplete="off" autoCorrect="off" autoCapitalize="none"
                        />
                        <button
                          type="button"
                          onClick={() => setApiKeyVisible((v) => !v)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors p-1"
                        >
                          {apiKeyVisible ? <EyeOff size={18} /> : <Eye size={18} />}
                        </button>
                      </div>
                      <button
                        type="button"
                        disabled={verifying || (!apiKeyInput.trim() && !config?.hasApiKey)}
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
