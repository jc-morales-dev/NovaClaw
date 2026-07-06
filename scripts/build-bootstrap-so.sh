#!/usr/bin/env bash
# ============================================================================
# build-bootstrap-so.sh — Construye el .so del bootstrap ZIP para embeber en el APK
#
# Este script replica la técnica de Termux para embeber un archivo grande
# dentro del APK como una "librería nativa" compartida (.so).
#
# Pasos:
# 1. Descarga el bootstrap ZIP de Termux (o usa uno local)
# 2. Lo convierte a un archivo objeto (.o) con ld -r -b binary
# 3. Compila el JNI bridge (novaclaw_bootstrap_jni.c) linkeando el .o
# 4. Copia el .so resultante a jniLibs/ para cada ABI
#
# Uso:
#   bash scripts/build-bootstrap-so.sh                    # descarga bootstrap de Termux
#   bash scripts/build-bootstrap-so.sh /path/to/my.zip    # usa un ZIP local
#
# Requisitos:
#   - Android NDK instalado (ANDROID_NDK_HOME o ndk-build en PATH)
#   - ld (binutils) para el paso de objcopy
#   - Para cross-compilar el .o: usar el NDK toolchain o objcopy del host
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CPP_DIR="$PROJECT_ROOT/android/app/src/main/cpp"
JNI_LIBS_DIR="$PROJECT_ROOT/android/app/src/main/jniLibs"

# ── Configuración ────────────────────────────────────────────────────────────

TERMUX_BOOTSTRAP_TAG="bootstrap-2026.05.10-r1+apt.android-7"
TERMUX_BOOTSTRAP_URL_AARCH64="https://github.com/termux/termux-packages/releases/download/${TERMUX_BOOTSTRAP_TAG}/bootstrap-aarch64.zip"
TERMUX_BOOTSTRAP_URL_ARM="https://github.com/termux/termux-packages/releases/download/${TERMUX_BOOTSTRAP_TAG}/bootstrap-arm.zip"
TERMUX_BOOTSTRAP_URL_X86_64="https://github.com/termux/termux-packages/releases/download/${TERMUX_BOOTSTRAP_TAG}/bootstrap-x86_64.zip"
TERMUX_BOOTSTRAP_URL_I686="https://github.com/termux/termux-packages/releases/download/${TERMUX_BOOTSTRAP_TAG}/bootstrap-i686.zip"

# ── Argumentos ───────────────────────────────────────────────────────────────

CUSTOM_ZIP="${1:-}"

if [[ -n "$CUSTOM_ZIP" ]]; then
    echo "📦 Usando ZIP local: $CUSTOM_ZIP"
    BOOTSTRAP_ZIP="$CUSTOM_ZIP"
else
    echo "📦 Descargando bootstrap de Termux (aarch64)..."
    BOOTSTRAP_ZIP="$PROJECT_ROOT/tmp/novaclaw-bootstrap.zip"
    mkdir -p "$(dirname "$BOOTSTRAP_ZIP")"

    if command -v curl &>/dev/null; then
        curl -fSL -o "$BOOTSTRAP_ZIP" "$TERMUX_BOOTSTRAP_URL_AARCH64"
    elif command -v wget &>/dev/null; then
        wget -q -O "$BOOTSTRAP_ZIP" "$TERMUX_BOOTSTRAP_URL_AARCH64"
    else
        echo "❌ Necesitas curl o wget para descargar el bootstrap."
        exit 1
    fi
    echo "✅ Bootstrap descargado: $(du -h "$BOOTSTRAP_ZIP" | cut -f1)"
fi

if [[ ! -f "$BOOTSTRAP_ZIP" ]]; then
    echo "❌ No se encontró el archivo ZIP: $BOOTSTRAP_ZIP"
    exit 1
fi

# ── Paso 1: Convertir ZIP a archivo objeto (.o) ─────────────────────────────

echo ""
echo "🔧 Convirtiendo ZIP a archivo objeto (.o)..."

OBJ_FILE="$CPP_DIR/novaclaw_bootstrap_zip.o"

# En Windows (MSYS2/Git Bash), ld puede no soportar -b binary.
# Intentamos con el NDK toolchain si está disponible.
if command -v ld &>/dev/null; then
    ld -r -b binary \
        -o "$OBJ_FILE" \
        "$BOOTSTRAP_ZIP" \
        --defsym _binary_novaclaw_bootstrap_zip_start=0 \
        2>/dev/null || true
fi

# Si ld falló, intentamos con objcopy (más portable)
if [[ ! -f "$OBJ_FILE" ]] && command -v objcopy &>/dev/null; then
    # Crear un .o vacío con las secciones correctas
    objcopy -I binary -O elf64-littleaarch64 \
        --rename-section .data=.rodata,alloc,load,readonly,data,contents \
        "$BOOTSTRAP_ZIP" "$OBJ_FILE" 2>/dev/null || true
fi

# Si todo falla, usamos un enfoque alternativo: incrustar el ZIP como
# recurso en assets/ y leerlo desde Java (sin JNI)
if [[ ! -f "$OBJ_FILE" ]]; then
    echo ""
    echo "⚠️  No se pudo crear el .o con ld/objcopy."
    echo "   Usando modo alternativo: ZIP en assets/ + Java puro."
    echo ""

    ASSETS_DIR="$PROJECT_ROOT/android/app/src/main/assets"
    mkdir -p "$ASSETS_DIR"
    cp "$BOOTSTRAP_ZIP" "$ASSETS_DIR/novaclaw-bootstrap.zip"
    echo "✅ ZIP copiado a assets/novaclaw-bootstrap.zip"
    echo "   RuntimeInstallerPlugin usará el modo assets (sin JNI)."

    # Crear un .so stub para que el build no falle
    mkdir -p "$JNI_LIBS_DIR/arm64-v8a" "$JNI_LIBS_DIR/armeabi-v7a" \
              "$JNI_LIBS_DIR/x86_64" "$JNI_LIBS_DIR/x86"

    echo "📝 Creando stub .so para cada ABI..."
    for abi in arm64-v8a armeabi-v7a x86_64 x86; do
        # Un .so mínimo de 4 bytes (ELF header inválido pero suficiente
        # para que Gradle no falle al empaquetar). El código Java maneja
        # el caso donde System.loadLibrary falla.
        : > "$JNI_LIBS_DIR/$abi/libnovaclaw-bootstrap.so"
    done

    echo ""
    echo "✅ Build alternativo completado."
    echo "   El bootstrap se cargará desde assets/, no desde JNI."
    exit 0
fi

echo "✅ Archivo objeto creado: $(du -h "$OBJ_FILE" | cut -f1)"

# ── Paso 2: Compilar el JNI bridge ──────────────────────────────────────────

echo ""
echo "🔧 Compilando JNI bridge con NDK..."

# Buscar ndk-build
NDK_BUILD=""
if [[ -n "${ANDROID_NDK_HOME:-}" ]]; then
    NDK_BUILD="$ANDROID_NDK_HOME/ndk-build"
elif command -v ndk-build &>/dev/null; then
    NDK_BUILD="ndk-build"
else
    echo "❌ No se encontró el NDK. Setea ANDROID_NDK_HOME."
    exit 1
fi

if [[ ! -x "$NDK_BUILD" ]]; then
    # En Windows, puede ser ndk-build.cmd
    NDK_BUILD_CMD="${NDK_BUILD}.cmd"
    if [[ -x "$NDK_BUILD_CMD" ]]; then
        NDK_BUILD="$NDK_BUILD_CMD"
    else
        echo "❌ ndk-build no es ejecutable: $NDK_BUILD"
        exit 1
    fi
fi

cd "$CPP_DIR"

# Compilar para cada ABI
for ABI in arm64-v8a armeabi-v7a x86_64 x86; do
    echo "  Compilando para $ABI..."
    "$NDK_BUILD" \
        NDK_PROJECT_PATH=. \
        APP_BUILD_SCRIPT=Android.mk \
        APP_ABI="$ABI" \
        NDK_LIBS_OUT="$JNI_LIBS_DIR" \
        APP_PLATFORM=android-24 \
        NDK_OUT="$PROJECT_ROOT/tmp/ndk-obj" \
        -j4 2>&1 | tail -1
done

echo ""
echo "✅ Build completado. Archivos .so en jniLibs/:"
find "$JNI_LIBS_DIR" -name "libnovaclaw-bootstrap.so" -exec ls -lh {} \;

echo ""
echo "📋 Próximo paso: compilar el APK con ./gradlew assembleDebug"
