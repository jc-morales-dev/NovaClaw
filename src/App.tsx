import React, { useEffect, useRef, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AnimatePresence } from 'motion/react';
import Home from './pages/Home';
import ChatView from './pages/ChatView';
import Settings from './pages/Settings';
import LogViewer from './pages/LogViewer';
import TerminalView from './pages/TerminalView';
import SplashScreen from './components/SplashScreen';
import { SettingsProvider } from './context/SettingsContext';
import { createBootstrapStatus, isBootstrapBlocking, type BootstrapStatus } from './bootstrap/state';
import { platform } from './platform';

export default function App() {
  const [bootstrapStatus, setBootstrapStatus] = useState<BootstrapStatus>(
    createBootstrapStatus({
      phase: 'checking',
      message: 'Checking runtime...',
    }),
  );
  const [showSplash, setShowSplash] = useState(true);
  const [isRetryingInstall, setIsRetryingInstall] = useState(false);
  const autoInstallStartedRef = useRef(false);

  useEffect(() => {
    let isMounted = true;
    const unsubscribe = platform.subscribeBootstrap((status) => {
      if (isMounted) {
        setBootstrapStatus(status);
      }
    });

    platform.getBootstrapStatus()
      .then((status) => {
        if (isMounted) {
          setBootstrapStatus(status);
        }
      })
      .catch((error: any) => {
        if (isMounted) {
          setBootstrapStatus(
            createBootstrapStatus({
              phase: 'error',
              message: 'Runtime check failed.',
              error: error?.message ?? String(error),
            }),
          );
        }
      });

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (platform.kind === 'capacitor' && bootstrapStatus.phase === 'not_installed' && !autoInstallStartedRef.current) {
      autoInstallStartedRef.current = true;
      setIsRetryingInstall(true);
      platform.installRuntime()
        .finally(() => {
          setIsRetryingInstall(false);
        });
    }

    setShowSplash(isBootstrapBlocking(bootstrapStatus));
  }, [bootstrapStatus]);

  async function handleRetryInstall() {
    setIsRetryingInstall(true);
    try {
      await platform.installRuntime();
      const status = await platform.getBootstrapStatus();
      setBootstrapStatus(status);
    } catch (error: any) {
      setBootstrapStatus(
        createBootstrapStatus({
          phase: 'error',
          message: 'Runtime installation failed.',
          error: error?.message ?? String(error),
        }),
      );
    } finally {
      setIsRetryingInstall(false);
    }
  }

  return (
    <SettingsProvider>
      <div className="min-h-screen bg-black flex items-center justify-center p-0 md:p-4">
        <div className="w-full h-[100dvh] md:h-[850px] md:max-w-[400px] bg-zinc-950 md:rounded-[40px] overflow-hidden relative shadow-2xl md:border-[8px] md:border-zinc-900 ring-1 ring-zinc-800">
          <AnimatePresence>
            {showSplash && (
              <SplashScreen
                status={bootstrapStatus}
                onRetry={handleRetryInstall}
                isRetrying={isRetryingInstall}
              />
            )}
          </AnimatePresence>
          <BrowserRouter>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/chat" element={<ChatView />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/logs" element={<LogViewer />} />
              <Route path="/terminal" element={<TerminalView />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </BrowserRouter>
        </div>
      </div>
    </SettingsProvider>
  );
}
