# NovaClaw v2 — Plan de construcción (basado en el teardown de AnyClaw)

> Fecha: 5 de julio de 2026
> Autor del análisis: Claude (para Julio)
> Fuente: ingeniería inversa de la APK **AnyClaw** (`gptos.intelligence.assistant`, v2.1.565)
> + estudio de su código abierto: `github.com/friuns2/openclaw-android-assistant` (licencia MIT).

---

## 0. TL;DR (lo esencial en 6 líneas)

- AnyClaw **no inventó nada mágico**: mete un **Linux real dentro de la app** y lo corre con **proot** (sin root).
- El agente (Codex) es un **proceso Node.js corriendo dentro de ese Linux**.
- El acceso al teléfono se logra con **termux-\* + Shizuku + intents** (Shizuku = permisos nivel ADB sin root).
- **Es open source con licencia MIT.** Podemos copiar la parte más difícil (el arranque de proot) legalmente.
- NovaClaw **ya tiene** lo caro de hacer: UI React + runtime de agente en TypeScript. Solo le falta el "host" Android.
- **Plan: adoptar el módulo Android de openclaw + meter NUESTRO agente adentro del proot.** Nada de reinventar.

---

## 1. Cómo funciona AnyClaw por dentro (confirmado con su código)

### 1.1 El truco central: proot + un Linux embebido

Android moderno (API 29+) **prohíbe ejecutar binarios** guardados en la carpeta de datos de la app.
Por eso Termux quedó clavado en Android 9. AnyClaw lo esquiva así:

1. Empaqueta el **cargador de proot como si fuera una librería** (`libproot.so`, `libproot-loader.so`)
   dentro de la carpeta de librerías nativas. A esa carpeta **Android SÍ le da permiso de ejecución**.
2. proot usa **ptrace** (una técnica de depuración del kernel) para interceptar las llamadas al sistema
   y "engañar" a los binarios haciéndoles creer que están en un Linux normal.
3. Resultado: puede correr un **Ubuntu/Debian/Termux completo**, con `apt`, `node`, `python`, etc.,
   todo dentro del sandbox privado de la app, apuntando a **Android 15 (targetSdk 35)**.

### 1.2 Dos estrategias de empaquetado (elegimos una)

| Estrategia | Qué trae el APK | Primer arranque | Tamaño APK | Datos |
|---|---|---|---|---|
| **A. Liviana** (la del repo open source) | Solo el bootstrap de Termux (~40 MB) | Descarga node/proot/agente por `apt` + `npm` (necesita internet) | **~50-90 MB** | ~1-2 GB |
| **B. Pesada** (la de Google Play que viste) | Un `rootfs.tar.zst` ya armado (**1.24 GB**) | Solo descomprime (sin internet) | **~1.3 GB** | **~10 GB** |

**Recomendación para NovaClaw: empezar con la A.** Es un APK chico, se sube a GitHub Releases sin problemas,
y el primer arranque bajando lo necesario está bien para un MVP. La B la dejamos para "modo offline" más adelante.

### 1.3 El código real que hace el trabajo (paquete `com.codex.mobile`, solo 4 clases)

- **`BootstrapInstaller.kt`** — extrae el `bootstrap-aarch64.zip` de los assets a
  `/data/data/<pkg>/files/usr`, reescribe rutas `com.termux`→nuestro package, crea los symlinks
  de `SYMLINKS.txt`, y hace `chmod 0700` a binarios y `.so`.
- **`CodexServerManager.kt`** — hace `apt-get download` de `nodejs npm proot libtalloc`, los extrae
  con `dpkg-deb`, instala el agente por `npm`, y crea wrappers en `bin/` (node, codex, npm).
  Después levanta el servidor web local del agente como proceso Node.
- **`CodexForegroundService.kt`** — servicio en primer plano para que Android no mate el proceso.
- **`MainActivity.kt`** — carga la UI web (WebView) y coordina el arranque.

### 1.4 Cómo accede al teléfono (skill `android` — 4 vías)

1. **`termux-*`** → cámara, GPS, portapapeles, notificaciones, batería, TTS, linterna, vibración.
2. **`intent`** → lanzar apps, servicios y broadcasts de Android con extras tipados.
3. **`bsh` (BeanShell)** → ejecutar **Java directo** contra la API de Android (context, PackageManager, sensores).
4. **`shizuku`** → **shell con permisos de ADB, sin root**. Esto es lo que da "casi todo":
   - instalar/desinstalar apps (`pm install`), cambiar ajustes del sistema (`settings put`),
   - leer `/data` y `/system`, `dumpsys`, `appops`,
   - **automatizar la UI de cualquier app**: `input tap`, `input swipe`, `input text`, `uiautomator dump`, `screencap`.

> **Realidad sobre "acceso total al teléfono":** acceso *root* puro es imposible sin rootear.
> Pero **con Shizuku se llega al 90%** de lo que uno imagina como "control total" (automatizar apps,
> instalar, tocar la pantalla, leer contactos/SMS, cambiar ajustes). Es más que suficiente para tu visión.
> Shizuku es una app aparte gratuita que el usuario activa una vez (por ADB inalámbrico o con root si tiene).

---

## 2. Qué tiene NovaClaw hoy (lo que NO hay que rehacer)

- ✅ **UI React** completa (Home, Chat, Terminal, Settings, Logs) — se reaprovecha entera.
- ✅ **Runtime de agente en TypeScript** portable: `types`, `modelAction` (parser+repair),
  `safety` (gate de aprobación), `tools` (terminal/file/workspace), `runtime` (loop + compactación).
- ✅ **`platform.ts`** — la frontera web↔Capacitor ya pensada.
- ✅ **`server.ts`** (Express) — el backend que hoy corre en la PC.
- ✅ Esquema de key embebida, tests, `docs/APK_MIGRATION_PLAN.md`.

**Diferencia clave con AnyClaw:** ellos corren **Codex** (un agente ajeno) dentro del Linux.
Nosotros vamos a correr **NUESTRO propio agente** (`server.ts` + `src/agent/`) dentro del Linux.
Eso es exactamente tu idea: *"un Codex propio mío"*.

---

## 3. Arquitectura objetivo de NovaClaw v2

```
┌───────────────────────────────────────────────────────────┐
│  APK NovaClaw (Kotlin, forkeado de openclaw-android)        │
│                                                             │
│  MainActivity ──► WebView ──► UI React (la actual)          │
│       │                                                     │
│       ├─ BootstrapInstaller ──► extrae Termux a files/usr   │
│       ├─ RuntimeManager ──► instala node + proot + agente   │
│       └─ ForegroundService ──► mantiene vivo el proceso     │
│                                                             │
│   proot (ptrace, sin root)                                  │
│   └── Linux (Termux/Debian)                                 │
│         ├── node                                            │
│         ├── NUESTRO agente = server.ts + src/agent/         │
│         │      (el mismo runtime TS que ya tenés)           │
│         └── acceso a dispositivo: termux-* / shizuku / intent│
└───────────────────────────────────────────────────────────┘
```

La UI habla con el agente por **HTTP local** (`http://127.0.0.1:PORT`), igual que hoy en la PC.
No hay que reescribir la comunicación: `platform.ts` ya abstrae eso.

---

## 4. Plan por fases (concreto y ordenado)

### Fase 0 — Preparación (medio día)
- [ ] Fork/estudio del módulo `android/` de `openclaw-android` (MIT, tenemos derecho a copiarlo citando la licencia).
- [ ] Copiar a NovaClaw las 4 clases Kotlin base y `scripts/download-bootstrap.sh`.
- [ ] Confirmar que `capacitor.config.ts` y el `android/` que ya tenés se pueden fusionar con este enfoque
      (o decidir ir 100% nativo con WebView en vez de Capacitor).

### Fase 1 — Arranque del Linux embebido (el corazón) (3-5 días)
- [ ] `download-bootstrap.sh` → bajar `bootstrap-aarch64.zip` de Termux a `assets/`.
- [ ] Portar `BootstrapInstaller.kt` con NUESTRO package name (`app.novaclaw` o el que elijas).
- [ ] Empaquetar `libproot.so` + loaders (se sacan del `.deb` de proot de Termux).
- [ ] **Hito:** abrir la app y que `proot sh -c 'uname -a'` devuelva un Linux funcionando en el teléfono.

### Fase 2 — Node + nuestro agente adentro (3-4 días)
- [ ] `RuntimeManager.kt` (adaptado de `CodexServerManager.kt`): instalar `nodejs npm` por apt.
- [ ] Empaquetar el bundle de `server.ts` (ya lo generás con esbuild) + `src/agent/` como un tarball en assets,
      o instalarlo por npm desde un paquete propio.
- [ ] Levantar `node server.cjs` dentro del proot, escuchando en `127.0.0.1:PORT`.
- [ ] **Hito:** la UI React (en WebView) chatea con el agente corriendo dentro del teléfono, sin PC.

### Fase 3 — Herramientas de dispositivo (4-6 días)
- [ ] Copiar la skill `android` de AnyClaw (termux-* + intent + bsh + shizuku) como referencia.
- [ ] Integrar `termux-*` (vienen con el bootstrap de Termux) en el registro de tools del agente.
- [ ] Integrar **Shizuku** (SDK `dev.rikka.shizuku:api`) para el shell privilegiado.
- [ ] Puente `intent` (una clase Kotlin que reciba JSON y dispare intents).
- [ ] **Hito:** el agente saca una foto, lee el portapapeles, y automatiza otra app con `input tap`.

### Fase 4 — Terminal real (PTY) (2-3 días)
- [ ] Integrar `com.termux:terminal-emulator` + `terminal-view` (ya lo tenías anotado).
- [ ] Conectar la `TerminalView` de tu UI a una sesión PTY real dentro del proot.
- [ ] **Hito:** `vim`, `htop`, `tail -f` funcionando en la terminal de la app.

### Fase 5 — Seguridad, key y modelo (2-3 días)
- [ ] Mantener el gate de `safety.ts`, pero endurecerlo (ver riesgos abajo).
- [ ] Resolver la key del modelo: **proxy con token por instalación** (no la key embebida XOR).
- [ ] Elegir modelo estable (no depender solo de un free que puede desaparecer).

### Fase 6 — Empaquetado y distribución (2-3 días)
- [ ] `ForegroundService` + notificación persistente (Android mata procesos si no).
- [ ] Firmar el APK (ya tenés `NovaClaw-julio-signed-release.apk`, revisar el keystore).
- [ ] Publicar en **GitHub Releases** (gratis, como hace openclaw) y `friuns2.github.io`-style landing.

**Estimación total realista: 3-4 semanas** de trabajo enfocado (vs. las 6-9 que decía el plan viejo,
porque ahora copiamos la parte difícil en vez de inventarla).

---

## 5. Decisiones que hay que tomar (te las dejo marcadas)

1. **¿Fork directo de openclaw o NovaClaw propio con su módulo Android copiado?**
   - Recomiendo: **NovaClaw propio**, copiando el módulo `android/` (es MIT). Mantenés tu marca y tu agente.
2. **¿Capacitor o WebView nativo?**
   - openclaw usa **WebView nativo puro** (más liviano). Tu repo hoy tiene Capacitor.
   - Recomiendo migrar a WebView nativo para el host, es menos capas y es lo probado.
3. **¿Estrategia A (liviana) o B (rootfs pesado)?**
   - Recomiendo **A** para el MVP, **B** como opción "offline" futura.
4. **¿Qué agente de fondo?** El tuyo (`src/agent/`) — ese es el punto del proyecto.

---

## 6. Riesgos reales (para no engañarnos)

- **Shizuku requiere activación del usuario** (ADB inalámbrico una vez). No es 100% automático. Hay que
  explicarlo bien en el onboarding, con el link de descarga (`shizuku.rikka.app`).
- **Google Play limita el almacenamiento** (`MANAGE_EXTERNAL_STORAGE`). La versión "con acceso total a /sdcard"
  probablemente tenga que distribuirse **por fuera de Play** (GitHub Releases), como hace AnyClaw.
- **El gate de seguridad por regex se puede evadir** (`python -c "os.system('rm -rf ~')"`). Como todo corre
  dentro del proot (sandbox), el daño se limita al Linux embebido — pero cuidado al conectar Shizuku, que sí toca el sistema real.
- **Batería y rendimiento:** proot + node en un teléfono consume. El `ForegroundService` y `WAKE_LOCK` ayudan,
  pero hay que testear en el OPPO real.
- **Key del modelo:** la key embebida se filtra el día uno. Proxy con token, sí o sí, antes de cualquier release público.

---

## 7. Materiales ya recolectados (dónde está todo)

- **APK de AnyClaw extraída:** `E:\PROGRAMACION\apps-movil\anyclaw-teardown\`
  - `base.apk` (código), `split_libs_arm64.apk` (libproot y libs), `split_assets_rootfs.apk` (rootfs 1.24 GB).
  - `base_extracted/assets/skills/` → las skills de AnyClaw (referencia de oro para copiar patrones).
- **Repo open source (MIT):** `github.com/friuns2/openclaw-android-assistant`
  - Módulo Android: `openclaw-android/android/` (las 4 clases Kotlin + scripts).
- **ADB instalado:** `E:\PROGRAMAS\platform-tools\adb.exe` (por si volvemos a conectar el celu).

---

## 8. Próximo paso concreto sugerido

Arrancar por la **Fase 1** con una prueba mínima: un APK de prueba que solo haga bootstrap + `proot uname -a`.
Si eso corre en tu OPPO, **todo el resto del plan es viable** y seguimos. Si no corre, lo sabemos en 2 días
y ajustamos, sin haber gastado semanas.

Cuando quieras, empiezo a portar `BootstrapInstaller.kt` a NovaClaw y a armar el APK de prueba de la Fase 1.
