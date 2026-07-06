import React, { useState, useEffect, useRef } from 'react';
import { ArrowLeft, Terminal as TerminalIcon, RefreshCw, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useSettings } from '../context/SettingsContext';
import { translations } from '../translations';
import { platform } from '../platform';

export default function LogViewer() {
  const navigate = useNavigate();
  const { appLanguage } = useSettings();
  const t = translations[appLanguage as keyof typeof translations] || translations['English'];
  
  const [logs, setLogs] = useState<string[]>([]);
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchLogs();
    const interval = setInterval(fetchLogs, 3000);
    return () => clearInterval(interval);
  }, []);
  
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const fetchLogs = async () => {
    try {
      setLogs(await platform.getLogs());
    } catch {
      // Handle error
    }
  };

  const clearLogs = async () => {
    try {
      await platform.clearLogs();
      setLogs([]);
    } catch {}
  };

  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-100 font-sans relative">
      <div className="flex items-center justify-between px-4 pt-12 pb-4 sticky top-0 bg-zinc-950/80 backdrop-blur-xl z-20 border-b border-zinc-900 shadow-sm">
        <div className="flex items-center gap-1">
          <button 
            onClick={() => navigate(-1)}
            className="p-2 -ml-2 text-zinc-400 hover:text-zinc-100 transition-colors"
          >
            <ArrowLeft size={24} />
          </button>
          <div className="flex items-center gap-3 ml-2">
            <div className="w-10 h-10 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center relative shadow-inner">
              <TerminalIcon size={20} className="text-zinc-300" />
            </div>
            <div>
              <h1 className="text-lg font-bold leading-tight text-zinc-100">{t.viewLogs}</h1>
              <p className="text-zinc-500 text-[13px] font-medium flex items-center gap-1">
                 System & Server Logs
              </p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={fetchLogs} className="p-2 text-zinc-400 hover:text-zinc-100 transition-colors bg-zinc-900 rounded-lg border border-zinc-800">
            <RefreshCw size={18} />
          </button>
          <button onClick={clearLogs} className="p-2 text-red-400 hover:text-red-300 transition-colors bg-zinc-900 rounded-lg border border-zinc-800">
            <Trash2 size={18} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 bg-black font-mono text-[13px] md:text-sm">
        {logs.length === 0 ? (
          <div className="text-zinc-500 text-center mt-10">No logs available.</div>
        ) : (
          logs.map((log, i) => (
            <div key={i} className="mb-1 text-zinc-300 break-words border-b border-zinc-900/50 pb-1">
              <span className="text-zinc-500 select-none mr-3">[{i+1}]</span>
              {log}
            </div>
          ))
        )}
        <div ref={logsEndRef} />
      </div>
    </div>
  );
}
