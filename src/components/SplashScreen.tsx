import React from 'react';
import { motion } from 'motion/react';
import NovaCircle from './NovaCircle';
import { getBootstrapProgressValue, type BootstrapStatus } from '../bootstrap/state';

type SplashScreenProps = {
  status: BootstrapStatus;
  onRetry: () => void;
  isRetrying: boolean;
};

export default function SplashScreen({ status, onRetry, isRetrying }: SplashScreenProps) {
  const progress = getBootstrapProgressValue(status);
  const showProgress = typeof progress === 'number' && status.phase !== 'error';
  const canRetry = status.phase === 'error' || status.phase === 'not_installed';

  return (
    <motion.div
      initial={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.8, ease: 'easeInOut' }}
      className="absolute inset-0 z-50 bg-black flex flex-col items-center justify-center"
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 1.2, ease: 'easeOut' }}
        className="flex flex-col items-center justify-center space-y-4 px-8 text-center"
      >
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2, duration: 0.8 }}
          className="flex justify-center"
        >
          <h1 className="text-xl md:text-2xl font-light tracking-[0.15em] text-zinc-300 uppercase">
            Bienvenido a
          </h1>
        </motion.div>

        <div
          className="flex items-center justify-center text-[60px] md:text-[90px] leading-none text-white"
          style={{ fontFamily: 'ui-sans-serif, system-ui, sans-serif', fontWeight: 200 }}
        >
          <span className="mr-4 md:mr-6">N</span>
          <NovaCircle className="w-[0.75em] h-[0.75em]" />
          <span className="ml-4 md:ml-6 mr-4 md:mr-6">V</span>
          <span>A</span>
        </div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5, duration: 0.8 }}
          className="w-56 md:w-72 mt-14 flex flex-col items-center gap-4"
        >
          {showProgress && (
            <>
              <div className="w-full h-[2px] bg-zinc-800 rounded-full overflow-hidden">
                <motion.div
                  className="h-full bg-white shadow-[0_0_10px_rgba(255,255,255,0.8)]"
                  style={{ width: `${progress}%` }}
                  transition={{ ease: 'linear' }}
                />
              </div>
              <div className="flex w-full justify-between text-[10px] uppercase tracking-[0.2em] font-mono text-zinc-500">
                <span>{status.phase === 'ready' ? 'Runtime listo' : 'Instalando runtime'}</span>
                <span>{progress}%</span>
              </div>
            </>
          )}

          <div className="space-y-2">
            <p className="text-sm text-zinc-200">{status.message}</p>
            {status.error && (
              <p className="text-xs text-red-400 leading-relaxed">{status.error}</p>
            )}
          </div>

          {canRetry && (
            <button
              type="button"
              onClick={onRetry}
              disabled={isRetrying}
              className="mt-2 rounded-full border border-zinc-700 px-5 py-2 text-sm font-semibold text-zinc-100 transition-colors hover:bg-zinc-900 disabled:opacity-60"
            >
              {isRetrying ? 'Reintentando...' : 'Reintentar instalacion'}
            </button>
          )}
        </motion.div>
      </motion.div>
    </motion.div>
  );
}
