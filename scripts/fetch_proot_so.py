#!/usr/bin/env python3
"""
fetch_proot_so.py — Puebla android-native/app/src/main/jniLibs con proot.

Equivalente portable de fetch-proot-so.sh que NO depende de `ar`/`tar` externos:
descarga el paquete `proot` ya compilado de Termux, desarma el .deb (formato ar)
y el data.tar.{zst,xz,gz} con la stdlib de Python (+ el módulo zstandard si el
tarball viene en zstd), y copia proot + loader a jniLibs con nombre lib*.so.

Uso:
  python scripts/fetch_proot_so.py                 # arm64-v8a + x86_64
  python scripts/fetch_proot_so.py aarch64         # solo arm64
"""
import io
import os
import sys
import tarfile
import urllib.request

# Windows usa cp1252 por defecto y rompe con los emojis del log. Forzamos UTF-8.
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except (AttributeError, ValueError):
    pass

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JNILIBS = os.path.join(PROJECT_ROOT, "android-native", "app", "src", "main", "jniLibs")
TERMUX_MAIN = "https://packages.termux.dev/apt/termux-main"

# ABI de Android → arquitectura de Termux.
ABI_TO_TERMUX = {"arm64-v8a": "aarch64", "x86_64": "x86_64"}
ALIASES = {"aarch64": "arm64-v8a", "arm64": "arm64-v8a", "x64": "x86_64"}


def http_get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "NovaClaw-fetch-proot/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def parse_ar(data: bytes):
    """Devuelve {nombre: bytes} de un archivo ar (formato .deb)."""
    assert data[:8] == b"!<arch>\n", "no es un archivo ar/.deb"
    out, off = {}, 8
    while off + 60 <= len(data):
        header = data[off:off + 60]
        name = header[0:16].decode("ascii", "replace").strip()
        size = int(header[48:58].decode("ascii").strip())
        start = off + 60
        out[name.rstrip("/")] = data[start:start + size]
        off = start + size + (size & 1)  # padding a byte par
    return out


def open_inner_tar(name: str, blob: bytes) -> tarfile.TarFile:
    if name.endswith(".zst"):
        try:
            import zstandard
        except ImportError:
            sys.exit("Este .deb usa zstd. Instalá el módulo: pip install zstandard")
        raw = zstandard.ZstdDecompressor().decompress(blob, max_output_size=512 * 1024 * 1024)
        return tarfile.open(fileobj=io.BytesIO(raw))
    # xz/gz/bz2/tar los abre tarfile por el sufijo del stream.
    return tarfile.open(fileobj=io.BytesIO(blob))


def resolve_deb_url(termux_arch: str) -> str:
    pkgs = http_get(f"{TERMUX_MAIN}/dists/stable/main/binary-{termux_arch}/Packages").decode("utf-8", "replace")
    filename = None
    for block in pkgs.split("\n\n"):
        if any(line.strip() == "Package: proot" for line in block.splitlines()):
            for line in block.splitlines():
                if line.startswith("Filename:"):
                    filename = line.split(":", 1)[1].strip()
                    break
            break
    if not filename:
        sys.exit(f"No encontré proot en el índice de {termux_arch}")
    return f"{TERMUX_MAIN}/{filename}"


def fetch_for_abi(abi: str) -> None:
    termux_arch = ABI_TO_TERMUX[abi]
    print(f"\n── {abi} (Termux {termux_arch}) ─────────────────────")
    url = resolve_deb_url(termux_arch)
    print(f"   {url}")
    deb = parse_ar(http_get(url))
    data_name = next((k for k in deb if k.startswith("data.tar")), None)
    if not data_name:
        sys.exit(f"El .deb de {termux_arch} no tiene data.tar.*")

    prefix = "data/data/com.termux/files/usr"
    wanted = {
        f"{prefix}/bin/proot": "libproot.so",
        f"{prefix}/libexec/proot/loader": "libproot-loader.so",
        f"{prefix}/libexec/proot/loader32": "libproot-loader32.so",
    }
    out_dir = os.path.join(JNILIBS, abi)
    os.makedirs(out_dir, exist_ok=True)

    with open_inner_tar(data_name, deb[data_name]) as tar:
        members = {m.name.lstrip("./"): m for m in tar.getmembers()}
        if wanted_key(members, f"{prefix}/bin/proot") is None:
            sys.exit(f"No hay bin/proot dentro del .deb de {termux_arch}")
        for src, so_name in wanted.items():
            key = wanted_key(members, src)
            if key is None:
                continue
            f = tar.extractfile(members[key])
            if f is None:
                continue
            dest = os.path.join(out_dir, so_name)
            with open(dest, "wb") as w:
                w.write(f.read())
            print(f"   ✅ {so_name} ({os.path.getsize(dest) // 1024} KB)")


def wanted_key(members: dict, path: str):
    """Encuentra la entrada del tar tolerando el prefijo ./ y variantes."""
    for cand in (path, "./" + path, path.lstrip("/")):
        if cand in members:
            return cand
    return None


def main() -> None:
    args = sys.argv[1:] or ["arm64-v8a", "x86_64"]
    abis = []
    for a in args:
        abi = ALIASES.get(a, a)
        if abi not in ABI_TO_TERMUX:
            print(f"⚠️  ABI no soportado: {a} (salteado)")
            continue
        abis.append(abi)

    print("📦 Poblando jniLibs con proot (prebuilt de Termux)…")
    for abi in abis:
        fetch_for_abi(abi)

    print("\n✅ Listo. jniLibs poblado:")
    for root, _dirs, files in os.walk(JNILIBS):
        for fn in files:
            if fn.startswith("libproot"):
                p = os.path.join(root, fn)
                print(f"   {os.path.getsize(p) // 1024} KB  {os.path.relpath(p, PROJECT_ROOT)}")


if __name__ == "__main__":
    main()
