import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Settings,
  Play,
  ChevronRight,
  Terminal as TerminalIcon,
  Code2,
  Square,
  Home as HomeIcon,
  MessageSquare,
} from 'lucide-react';
import { useSettings } from '../context/SettingsContext';
import { translations } from '../translations';
import NovaCircle from '../components/NovaCircle';
import { platform, type RuntimeSnapshot } from '../platform';

const DEFAULT_RUNTIME_STATUS: RuntimeSnapshot = {
  agent: {
    status: 'stopped',
    mode: 'local',
    label: 'Listo',
  },
  opencode: {
    status: 'stopped',
    installed: false,
    available: false,
    version: null,
    commandPath: null,
    message: 'Comprobando OpenCode…',
    lastExitCode: null,
  },
  terminal: {
    status: 'ready',
    cwd: '~',
  },
};

export default function Home() {
  const navigate = useNavigate();
  const { appLanguage } = useSettings();
  const t = translations[appLanguage as keyof typeof translations] || translations['English'];
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeSnapshot>(DEFAULT_RUNTIME_STATUS);
  const [isRefreshing, setIsRefreshing] = useState(true);
  const [isStartingAgent, setIsStartingAgent] = useState(false);
  const [isTogglingOpenCode, setIsTogglingOpenCode] = useState(false);

  useEffect(() => {
    let isMounted = true;

    async function loadStatus() {
      try {
        const data = await platform.getRuntimeStatus();
        if (isMounted) {
          setRuntimeStatus(data);
        }
      } catch {
        // Keep the current UI state if the runtime is temporarily unavailable.
      } finally {
        if (isMounted) {
          setIsRefreshing(false);
        }
      }
    }

    // El poll consulta al agente y hace setState → re-render de toda la Home.
    // A 2s eso corría incluso con la app en segundo plano o con el usuario en
    // otra pestaña: gasto de CPU y batería por una pantalla que nadie mira.
    // Ahora solo late cuando la pantalla está VISIBLE, y a 4s (el estado del
    // agente cambia por acción del usuario, no solo).
    loadStatus();
    let interval = 0;
    const arrancar = () => {
      if (interval) return;
      interval = window.setInterval(loadStatus, 4000);
    };
    const frenar = () => {
      if (!interval) return;
      window.clearInterval(interval);
      interval = 0;
    };
    const onVisibilidad = () => {
      if (document.visibilityState === 'visible') { loadStatus(); arrancar(); } else { frenar(); }
    };
    onVisibilidad();
    document.addEventListener('visibilitychange', onVisibilidad);

    return () => {
      isMounted = false;
      frenar();
      document.removeEventListener('visibilitychange', onVisibilidad);
    };
  }, []);

  const agentOnline = runtimeStatus.agent.status === 'running';
  const opencodeRunning = runtimeStatus.opencode.status === 'running';
  const opencodeInstalling = runtimeStatus.opencode.status === 'installing';

  const agentTitle = useMemo(() => {
    if (agentOnline) {
      return runtimeStatus.agent.mode === 'remote' ? 'Agente activo' : 'Agente activo (local)';
    }
    return t.agentStatus;
  }, [agentOnline, runtimeStatus.agent.mode, t.agentStatus]);

  const agentSubtitle = agentOnline
    ? runtimeStatus.agent.label
    : t.agentStatusDesc;

  const opencodeStatusLabel = useMemo(() => {
    if (opencodeInstalling) {
      return 'Instalando…';
    }
    if (opencodeRunning) {
      return 'Ejecutándose';
    }
    if (runtimeStatus.opencode.installed) {
      return 'Instalado';
    }
    return 'No instalado';
  }, [opencodeInstalling, opencodeRunning, runtimeStatus.opencode.installed]);

  const terminalStatusLabel = runtimeStatus.terminal.cwd
    ? `Shell lista · ${runtimeStatus.terminal.cwd.replace(/\\/g, '/')}`
    : 'Shell lista';

  async function handleStartAgent() {
    setIsStartingAgent(true);
    try {
      await platform.startAgent();
      const data = await platform.getRuntimeStatus();
      setRuntimeStatus(data);
      navigate('/chat');
    } catch {
      navigate('/chat');
    } finally {
      setIsStartingAgent(false);
    }
  }

  async function handleToggleOpenCode() {
    setIsTogglingOpenCode(true);
    try {
      if (opencodeRunning) {
        await platform.stopOpenCode();
      } else {
        await platform.startOpenCode();
      }
      const data = await platform.getRuntimeStatus();
      setRuntimeStatus(data);
    } finally {
      setIsTogglingOpenCode(false);
    }
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto overflow-x-hidden bg-[#0B0908] text-zinc-100 font-sans relative">
      {/* Resplandor cálido superior */}
      <div className="pointer-events-none absolute -top-36 left-1/2 -translate-x-1/2 w-[480px] h-[340px] bg-[radial-gradient(ellipse_at_center,rgba(255,122,26,0.20),rgba(232,148,26,0.06)_55%,transparent_75%)]" />

      {/* Header */}
      <div className="px-5 pt-12 pb-4 sticky top-0 bg-[#0B0908]/95 z-10 flex justify-between items-center border-b border-white/5">
        <div className="flex items-center gap-2.5">
          <span className="w-9 h-9 rounded-full bg-black border border-[#FF7A1A]/30 shadow-[0_0_14px_rgba(255,122,26,0.35)] flex items-center justify-center overflow-hidden shrink-0">
            <NovaCircle className="w-[135%] h-[135%]" />
          </span>
          <div className="flex flex-col">
            <h1 className="text-[19px] font-bold tracking-tight leading-none bg-gradient-to-r from-orange-300 via-amber-200 to-orange-400 bg-clip-text text-transparent">{t.appName}</h1>
            <p className="text-zinc-500 text-[12px] font-medium mt-1">{t.appSubtitle}</p>
          </div>
        </div>
      </div>

      <div className="px-5 pt-6 space-y-4 relative">
        {/* Tarjeta principal del agente */}
        <div className="rounded-[28px] p-[1px] bg-gradient-to-b from-[#FF7A1A]/45 via-white/5 to-transparent shadow-xl shadow-black/50">
          <div className="rounded-[27px] bg-[#120D09]/95 px-6 pt-8 pb-6 text-center relative overflow-hidden">
            <div className="pointer-events-none absolute inset-x-0 -top-24 h-48 bg-[radial-gradient(ellipse_at_center,rgba(255,122,26,0.15),transparent_70%)]" />

            <div className="nova-orb-glow relative w-24 h-24 mx-auto mb-4 rounded-full bg-black border border-[#FF7A1A]/25">
              <NovaCircle className="w-full h-full" />
              <span
                className={`absolute top-1.5 right-1.5 w-3.5 h-3.5 rounded-full border-[3px] border-[#120D09] ${
                  agentOnline ? 'bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.8)]' : 'bg-zinc-600'
                }`}
              />
            </div>

            <h2 className="text-[22px] font-bold text-zinc-50 leading-tight tracking-tight relative">{agentTitle}</h2>
            <p className="text-zinc-500 text-[13.5px] mt-1 relative truncate">{agentSubtitle}</p>
            {isRefreshing && <p className="text-zinc-600 text-[11px] mt-0.5 relative">Sincronizando…</p>}

            <button
              onClick={handleStartAgent}
              disabled={isStartingAgent}
              className="mt-5 w-full flex items-center justify-center gap-2 rounded-2xl py-4 text-[16px] font-bold text-[#1A0E02] bg-gradient-to-r from-[#FF7A1A] via-[#FF8F3D] to-amber-400 hover:brightness-110 active:scale-[0.98] disabled:opacity-60 transition-all shadow-lg shadow-[#FF7A1A]/30 relative"
            >
              <Play fill="currentColor" size={17} />
              {isStartingAgent ? 'Iniciando…' : agentOnline ? 'Abrir agente' : t.startAgent}
            </button>
          </div>
        </div>

        {/* Estado del entorno */}
        <div className="flex gap-2">
          <EnvChip label="Linux" ok />
          <EnvChip label="Node" ok />
          <EnvChip
            label="Agente"
            ok={agentOnline}
            okText="en línea"
            pendingText="apagado"
          />
        </div>

        <p className="text-zinc-600 text-[11px] font-bold uppercase tracking-[0.22em] pl-1 pt-3">Módulos</p>

        {/* Tarjetas secundarias */}
        <div className="space-y-2.5 pb-6">
          <div onClick={() => navigate('/terminal')}>
            <ModuleCard
              title="Terminal"
              status={terminalStatusLabel}
              statusColor="text-zinc-400"
              icon={<TerminalIcon size={20} className="text-emerald-300" />}
              iconBg="bg-emerald-400/10 border-emerald-400/25"
              action={<ChevronRight size={20} className="text-zinc-600" />}
              isLink
            />
          </div>
        </div>
      </div>

      {/* Barra de navegación inferior */}
      <div className="sticky bottom-0 mt-auto z-10 flex justify-around items-center px-2 pt-3 pb-safe bg-[#0B0908]/95 border-t border-white/5">
        <NavItem icon={<HomeIcon size={20} />} label="Inicio" active />
        <NavItem icon={<MessageSquare size={20} />} label="Chat" onClick={() => navigate('/chat')} />
        <NavItem icon={<TerminalIcon size={20} />} label="Terminal" onClick={() => navigate('/terminal')} />
        <NavItem icon={<Settings size={20} />} label="Ajustes" onClick={() => navigate('/settings')} />
      </div>
    </div>
  );
}

function EnvChip({
  label,
  ok,
  okText = '✓',
  pendingText = '…',
}: {
  label: string;
  ok: boolean;
  okText?: string;
  pendingText?: string;
}) {
  return (
    <div
      className={`flex-1 rounded-xl px-2 py-2.5 text-center text-[11px] font-semibold border ${
        ok
          ? 'bg-emerald-400/[0.07] border-emerald-400/30 text-emerald-200'
          : 'bg-white/[0.04] border-white/10 text-zinc-500'
      }`}
    >
      <span className="block text-[12px] font-bold">{label}</span>
      <span className="mt-0.5 block">{ok ? okText : pendingText}</span>
    </div>
  );
}

function NavItem({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col items-center gap-1 px-4 py-1 text-[10.5px] font-semibold transition-colors ${
        active ? 'text-[#FFB25C]' : 'text-zinc-600 hover:text-zinc-400'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function ModuleCard({ title, status, icon, action, isLink, statusColor = 'text-zinc-500', iconBg = 'bg-black/60 border-white/10' }: any) {
  return (
    <div className={`bg-white/[0.035] border border-white/[0.07] rounded-2xl p-4 flex items-center justify-between transition-colors ${isLink ? 'active:bg-white/[0.08] cursor-pointer hover:bg-white/[0.06]' : ''}`}>
      <div className="flex items-center gap-3.5 min-w-0">
        <div className={`w-11 h-11 rounded-xl flex items-center justify-center border shrink-0 ${iconBg}`}>
          {icon}
        </div>
        <div className="min-w-0">
          <h3 className="font-semibold text-[15px] text-zinc-100">{title}</h3>
          <p className={`${statusColor} text-[12.5px] mt-0.5 truncate`}>{status}</p>
        </div>
      </div>
      <div className="shrink-0 pl-2">{action}</div>
    </div>
  );
}

function ActionButton({
  text,
  onClick,
  disabled,
  icon,
}: {
  text: string;
  onClick?: () => void;
  disabled?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick?.();
      }}
      disabled={disabled}
      className="bg-[#FF7A1A]/12 hover:bg-[#FF7A1A]/20 border border-[#FF7A1A]/30 disabled:opacity-60 text-[#FFC58A] text-[13px] font-semibold px-3.5 py-2 rounded-xl transition-colors active:scale-95 flex items-center gap-1.5"
    >
      {icon}
      {text}
    </button>
  );
}
