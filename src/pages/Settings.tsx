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
} from 'lucide-react';
import { useSettings } from '../context/SettingsContext';
import { translations } from '../translations';
import { platform, type ProviderConfig } from '../platform';

export default function Settings() {
  const navigate = useNavigate();
  const { appLanguage, setAppLanguage } = useSettings();
  const t = translations[appLanguage as keyof typeof translations] || translations['English'];

  const [activeModal, setActiveModal] = useState<string | null>(null);
  const [feedbackText, setFeedbackText] = useState('');
  const [isFeedbackSent, setIsFeedbackSent] = useState(false);

  const isSpanish = appLanguage === 'Español';

  // Provider config state (baseUrl / model / apiKey) — vive en el agente (novaclaw.config.json).
  const [config, setConfig] = useState<ProviderConfig | null>(null);
  const [baseUrlInput, setBaseUrlInput] = useState('');
  const [modelInput, setModelInput] = useState('');
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [providerSaving, setProviderSaving] = useState(false);
  const [providerSaved, setProviderSaved] = useState(false);
  const [providerError, setProviderError] = useState('');

  async function loadConfig() {
    try {
      const c = await platform.getConfig();
      setConfig(c);
      setBaseUrlInput(c.baseUrl ?? '');
      setModelInput(c.model ?? '');
    } catch {}
  }

  useEffect(() => {
    loadConfig();
  }, []);

  const openModal = (name: string) => {
    if (name === 'provider' && config) {
      setBaseUrlInput(config.baseUrl ?? '');
      setModelInput(config.model ?? '');
      setApiKeyInput('');
    }
    setActiveModal(name);
  };
  const closeModal = () => {
    setActiveModal(null);
    setApiKeyInput('');
    setApiKeyVisible(false);
    setProviderSaved(false);
    setProviderError('');
  };

  async function handleSaveProvider() {
    setProviderSaving(true);
    setProviderError('');
    try {
      // Solo mandamos la key si el usuario escribió una nueva (no pisamos la guardada).
      const update: { baseUrl?: string; model?: string; apiKey?: string } = {
        baseUrl: baseUrlInput.trim(),
        model: modelInput.trim(),
      };
      if (apiKeyInput.trim()) update.apiKey = apiKeyInput.trim();
      const c = await platform.saveConfig(update);
      setConfig(c);
      setBaseUrlInput(c.baseUrl ?? '');
      setModelInput(c.model ?? '');
      setProviderSaved(true);
      setApiKeyInput('');
      setTimeout(() => closeModal(), 1600);
    } catch (err: any) {
      setProviderError(err?.message ?? (isSpanish ? 'No se pudo guardar.' : 'Failed to save.'));
    } finally {
      setProviderSaving(false);
    }
  }

  async function handleClearApiKey() {
    try {
      const c = await platform.saveConfig({ apiKey: '' });
      setConfig(c);
    } catch {}
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

        {/* Proveedor de IA — modelo, URL base y API key (guardado en el agente) */}
        <SettingsSection icon={<Cpu size={18} />} title={isSpanish ? 'Modelo de IA' : 'AI Model'}>
          <SettingsGroup>
            <SettingsItem
              title={isSpanish ? 'Proveedor y modelo' : 'Provider & model'}
              value={config ? config.model : (isSpanish ? 'Cargando…' : 'Loading…')}
              onClick={() => openModal('provider')}
            />
            <SettingsItem
              title="API Key"
              value={
                config?.hasApiKey
                  ? (isSpanish ? '● Configurada' : '● Configured')
                  : (isSpanish ? 'Sin configurar' : 'Not configured')
              }
              valueColor={config?.hasApiKey ? 'text-emerald-400' : 'text-amber-400'}
              onClick={() => openModal('provider')}
            />
          </SettingsGroup>
          <p className="text-zinc-600 text-xs px-2 mt-2 leading-relaxed">
            {isSpanish
              ? 'Configurá el proveedor (OpenRouter, Zen, etc.), el modelo y tu API key. Se guarda en el teléfono y el agente lo usa al instante.'
              : 'Set the provider (OpenRouter, Zen, etc.), the model and your API key. Saved on-device; the agent uses it right away.'}
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
          <p className="text-zinc-600 text-sm font-medium mb-6">NovaClaw v2.1.0</p>
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

            {/* Provider modal (baseUrl / model / apiKey) */}
            {activeModal === 'provider' && (
              <div className="space-y-4">
                {providerSaved ? (
                  <div className="flex flex-col items-center justify-center py-8 text-center space-y-3">
                    <CheckCircle2 size={48} className="text-emerald-400" />
                    <p className="font-semibold text-emerald-400 text-lg">
                      {isSpanish ? '¡Guardado!' : 'Saved!'}
                    </p>
                    <p className="text-zinc-400 text-sm">
                      {isSpanish ? 'El agente ya usa la nueva configuración.' : 'The agent now uses the new config.'}
                    </p>
                  </div>
                ) : (
                  <>
                    {/* URL base del proveedor */}
                    <div className="space-y-1.5">
                      <label className="text-zinc-400 text-xs font-semibold px-1">
                        {isSpanish ? 'URL base' : 'Base URL'}
                      </label>
                      <input
                        type="text"
                        value={baseUrlInput}
                        onChange={(e) => { setBaseUrlInput(e.target.value); setProviderError(''); }}
                        placeholder="https://openrouter.ai/api/v1"
                        className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-[#FF7A1A] text-[14px] font-mono"
                        autoComplete="off" autoCorrect="off" autoCapitalize="none"
                      />
                    </div>

                    {/* Modelo */}
                    <div className="space-y-1.5">
                      <label className="text-zinc-400 text-xs font-semibold px-1">
                        {isSpanish ? 'Modelo' : 'Model'}
                      </label>
                      <input
                        type="text"
                        value={modelInput}
                        onChange={(e) => { setModelInput(e.target.value); setProviderError(''); }}
                        placeholder="z-ai/glm-5.2"
                        className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-3 text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-[#FF7A1A] text-[14px] font-mono"
                        autoComplete="off" autoCorrect="off" autoCapitalize="none"
                      />
                    </div>

                    {/* API key (no se muestra la guardada; vacío = no cambiar) */}
                    <div className="space-y-1.5">
                      <label className="text-zinc-400 text-xs font-semibold px-1">
                        API Key {config?.hasApiKey && <span className="text-emerald-500">· {isSpanish ? 'ya configurada' : 'already set'}</span>}
                      </label>
                      <div className="relative">
                        <input
                          type={apiKeyVisible ? 'text' : 'password'}
                          value={apiKeyInput}
                          onChange={(e) => { setApiKeyInput(e.target.value); setProviderError(''); }}
                          placeholder={config?.hasApiKey ? (isSpanish ? 'Dejar vacío para no cambiarla' : 'Leave blank to keep current') : 'sk-or-v1-...'}
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
                    </div>

                    {providerError && (
                      <div className="flex items-center gap-2 text-red-400 text-sm">
                        <AlertCircle size={16} />
                        <span>{providerError}</span>
                      </div>
                    )}

                    <button
                      type="button"
                      disabled={providerSaving || (!baseUrlInput.trim() && !modelInput.trim() && !apiKeyInput.trim())}
                      onClick={handleSaveProvider}
                      className="w-full bg-[#E8660D] hover:bg-[#FF7A1A] disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold py-3.5 rounded-xl transition-colors"
                    >
                      {providerSaving ? (isSpanish ? 'Guardando…' : 'Saving…') : (isSpanish ? 'Guardar' : 'Save')}
                    </button>

                    {config?.hasApiKey && (
                      <button
                        type="button"
                        onClick={handleClearApiKey}
                        className="w-full bg-zinc-800 hover:bg-zinc-700 text-red-400 font-semibold py-3 rounded-xl transition-colors text-sm"
                      >
                        {isSpanish ? 'Borrar la API key guardada' : 'Clear saved API key'}
                      </button>
                    )}
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
