# NovaClaw — Android Plugins

Plugins Capacitor integrados en el APK.  
**Sin dependencias externas. Sin Termux. 100% autónomo.**

## Plugins

### ShellPlugin.kt
Ejecuta comandos de shell usando `/system/bin/sh` de Android via `ProcessBuilder`.
- Workspace en `/data/data/com.novaclaw.app/files/workspace/`
- `run(command, cwd, timeoutMs?)` — ejecuta un comando
- `writeFile(path, content)` — escribe archivo directamente desde Kotlin
- `readFile(path)` — lee archivo directamente desde Kotlin
- `isReady()` — verifica si el workspace está inicializado
- `getWorkspaceRoot()` — devuelve la ruta del workspace

### RuntimeInstallerPlugin.kt
Configura el workspace en el primer arranque. Sin descargas, sin paquetes externos.
- `checkInstalled()` — verifica si el workspace existe
- `install()` — crea estructura de directorios y archivos de bienvenida
- Emite eventos `progress` y `done` para el frontend

### SecureKeyPlugin.kt
Guarda la API key en Android Keystore (AES-256/GCM hardware-backed).
- `store({ value })` — guarda la clave
- `has()` — verifica si hay clave guardada
- `getForDebug()` — recupera la clave (solo debug builds)

## Cómo compilar

```bash
npm install
npx cap sync android
# Abrir android/ en Android Studio → Run
# O compilar desde línea de comandos:
cd android && ./gradlew assembleDebug
```

El APK generado estará en:
`android/app/build/outputs/apk/debug/app-debug.apk`

## Flujo de primer arranque

1. El usuario instala el APK.
2. Abre NovaClaw → Home.
3. Presiona **Iniciar Agente**.
4. `RuntimeInstallerPlugin.install()` crea el workspace (~1 segundo).
5. Va a **Ajustes → API Key** e introduce su clave de opencode.ai.
6. Vuelve al chat y empieza a hablar con el agente.
