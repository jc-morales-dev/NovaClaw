#!/usr/bin/env bash
# ============================================================================
# fetch-proot-so.sh — Puebla android-native/app/src/main/jniLibs con proot.
#
# Por qué: en targetSdk ≥ 29 (Android 10+) SELinux bloquea ejecutar binarios
# desde el data dir de la app (W^X). La salida es correr todo bajo `proot`,
# cuyo binario + loader deben vivir en nativeLibraryDir — el único lugar que
# el instalador extrae y deja EJECUTABLE en cualquier targetSdk. Android solo
# extrae ahí archivos que se llamen lib*.so dentro de jniLibs/<abi>/.
#
# Este script es un wrapper fino de fetch_proot_so.py (extractor portable que
# no depende de `ar`/`tar`/`zstd` externos — solo Python 3). Se mantiene el
# nombre .sh por costumbre; en Windows corré directamente:
#     python scripts/fetch_proot_so.py
#
# Uso:
#   bash scripts/fetch-proot-so.sh                 # arm64-v8a + x86_64
#   bash scripts/fetch-proot-so.sh aarch64         # solo arm64
# ============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PY="$(command -v python3 || command -v python || true)"
[[ -n "$PY" ]] || { echo "❌ Falta Python 3 en el PATH."; exit 1; }
exec "$PY" "$SCRIPT_DIR/fetch_proot_so.py" "$@"
