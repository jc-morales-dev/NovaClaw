import React, { createContext, useContext, useState, useEffect } from 'react';

type SettingsContextType = {
  appLanguage: string;
  setAppLanguage: (lang: string) => void;
};

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

const getInitialSettings = () => {
  const saved = localStorage.getItem('appSettings');
  if (saved) {
    try {
      return JSON.parse(saved);
    } catch (e) {
      return {};
    }
  }
  return {};
};

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const initial = getInitialSettings();
  const [appLanguage, setAppLanguage] = useState(initial.appLanguage || 'English');

  useEffect(() => {
    const settings = { appLanguage };
    localStorage.setItem('appSettings', JSON.stringify(settings));
  }, [appLanguage]);

  return (
    <SettingsContext.Provider value={{ appLanguage, setAppLanguage }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  const context = useContext(SettingsContext);
  if (context === undefined) {
    throw new Error('useSettings must be used within a SettingsProvider');
  }
  return context;
}
