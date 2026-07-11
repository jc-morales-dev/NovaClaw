# targetSdk 34 vía PRoot — fin de la "bomba de tiempo"

## El problema

Hasta la v0.1 NovaClaw dependía de `targetSdk = 28`. Ese es un truco: Android
solo permite **ejecutar binarios desde el directorio de datos de la app** si la
app apunta a `targetSdk ≤ 28`. Desde Android 10 (API 29) SELinux impone **W^X**
(un archivo escribible no puede ser ejecutable) y bloquea ese camino.

Consecuencias de quedarse en 28:
- Fuera de Google Play (Play exige targetSdk reciente).
- Riesgo a futuro: si una versión de Android sube el piso de `targetSdk`
  instalable, o endurece la excepción del W^X, la app deja de funcionar.

## La solución: PRoot desde `nativeLibraryDir`

`nativeLibraryDir` (donde Android extrae las librerías `.so` del APK) es de
**solo lectura y ejecutable en cualquier `targetSdk`**. Es la única superficie
ejecutable que sobrevive a W^X. La técnica (la misma de proot-distro, UserLAnd,
Andronix) es:

1. Empaquetar el binario `proot` + su `loader` como `lib*.so` en `jniLibs/`.
   Android los extrae a `nativeLibraryDir`, donde son ejecutables.
2. Ejecutar **todo bajo proot**: `proot … $PREFIX/bin/sh -c "…"`. proot carga
   los ELF del prefix (que están en el data dir escribible) con **su propio
   loader**, en vez de pedirle al kernel un `execve` que W^X rechazaría.

Así el prefix de Termux (node, sh, coreutils, apt…) corre sin tocar `targetSdk`.

### Dos modos, elegidos solos

`RuntimeManager` detecta el modo en runtime (`detectExecMode`):

| Condición                                   | Modo     | Qué hace |
|---------------------------------------------|----------|----------|
| `targetSdk ≤ 28`                            | `DIRECT` | Ejecuta los binarios del prefix directo (camino histórico, validado en el OPPO). |
| `targetSdk ≥ 29` y proot empaquetado        | `PROOT`  | Envuelve cada exec con `proot` (binario en `nativeLibraryDir`). |
| `targetSdk ≥ 29` sin proot                  | `DIRECT` | Fallback con error claro en el log (funcionará en Android ≤ 9, fallará en 10+). |

El `LD_PRELOAD` de termux-exec se usa **solo en DIRECT**: bajo proot chocaría
(ambos interceptan `execve`). En PROOT se setea `PROOT_LOADER`/`PROOT_LOADER_32`
apuntando a los loaders en `nativeLibraryDir`, y se bindea el prefix sobre la
ruta canónica de Termux para que cualquier shebang/ruta hardcodeada resuelva.

## Cómo compilar el APK de targetSdk 34

```bash
# 1) Poblar jniLibs con proot (prebuilt de Termux — NO necesita NDK).
python scripts/fetch_proot_so.py            # arm64-v8a + x86_64
#   (o:  bash scripts/fetch-proot-so.sh)

# 2) Compilar el APK (targetSdk 34 es el default ahora).
pwsh scripts/build-android.ps1 -Arch arm64 -Release
```

`fetch_proot_so.py` baja el paquete `proot` de los repos de Termux, desarma el
`.deb` y el `data.tar.*` con la stdlib de Python, y copia
`proot` → `libproot.so`, `loader` → `libproot-loader.so`,
`loader32` → `libproot-loader32.so` en `jniLibs/<abi>/`.

### Escape hatch: reproducir el camino DIRECT (validado)

```bash
pwsh scripts/build-android.ps1 -Arch arm64 -Release -- -Pnovaclaw.targetSdk=28
```

Genera el APK legacy (targetSdk 28, sin proot, exec directo) idéntico al que ya
está validado en el OPPO. Útil como red de seguridad mientras se prueba PROOT.

## Estado de validación

Verificado en este repo (sin el teléfono):
- ✅ `fetch_proot_so.py` baja proot **5.1.107** real (arm64 230 KB + loaders; x86_64 245 KB).
- ✅ Kotlin compila (`compileArm64/ X86DebugKotlin`).
- ✅ APK arm64 ensambla (37 MB) con `targetSdkVersion=34` y `extractNativeLibs=true`.
- ✅ `libproot*.so` quedan dentro del APK en `lib/arm64-v8a/`.

Pendiente (requiere el OPPO — mismo modelo de validación que el resto del proyecto):
- ⏳ Instalar el APK de 34 en el OPPO (Android 15) y confirmar que
  `RuntimeManager.execModeName()` reporta `PROOT` y que `node --version` corre
  bajo proot. Si algo falla, el escape hatch de targetSdk 28 sigue disponible.

## Archivos tocados

- `android-native/app/src/main/java/app/novaclaw/RuntimeManager.kt` — detección
  de modo, `wrapForExec`, env de proot.
- `android-native/app/build.gradle.kts` — `targetSdk` (property, default 34),
  `packaging.jniLibs.useLegacyPackaging`.
- `android-native/app/src/main/AndroidManifest.xml` — `extractNativeLibs="true"`.
- `scripts/fetch_proot_so.py` + `scripts/fetch-proot-so.sh` — obtención de proot.
