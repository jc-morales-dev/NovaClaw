import React, { createContext, useContext, useState, useEffect } from 'react';

type SettingsContextType = {
  appLanguage: string;
  setAppLanguage: (lang: string) => void;
};

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

// 'appSettingsV2': la clave vieja ('appSettings') guardaba 'English' como
// default implícito, no elegido por nadie; se ignora una sola vez para que
// todos arranquen en Español y la elección explícita se respete de ahí en más.
const SETTINGS_KEY = 'appSettingsV2';

const getInitialSettings = () => {
  const saved = localStorage.getItem(SETTINGS_KEY);
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
  const [appLanguage, setAppLanguage] = useState(initial.appLanguage || 'Español');

  useEffect(() => {
    const settings = { appLanguage };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
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
