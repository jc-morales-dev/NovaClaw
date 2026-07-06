#!/usr/bin/env node
/**
 * build-minimal-bootstrap.mjs — Genera un ZIP mínimo de bootstrap para desarrollo.
 *
 * Crea un bootstrap ZIP con la estructura mínima que RuntimeInstallerPlugin espera.
 * No contiene binarios reales de Termux (para eso usa build-bootstrap-so.sh),
 * pero permite que el instalador complete su flujo sin fallar.
 *
 * Uso:
 *   node scripts/build-minimal-bootstrap.mjs
 *
 * Output:
 *   android/app/src/main/assets/novaclaw-bootstrap.zip
 */

import { execSync } from 'node:child_process';
import {
  mkdirSync, writeFileSync, rmSync, existsSync,
  readFileSync, readdirSync
} from 'node:fs';
import { join, resolve, relative } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const ASSETS_DIR = join(ROOT, 'android', 'app', 'src', 'main', 'assets');
const OUTPUT_ZIP = join(ASSETS_DIR, 'novaclaw-bootstrap.zip');
const TMP_DIR = join(ROOT, 'tmp', 'bootstrap-staging');

// ── Limpiar staging anterior ────────────────────────────────────────────────

if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
mkdirSync(TMP_DIR, { recursive: true });

// ── Crear estructura de directorios ─────────────────────────────────────────

const dirs = [
  'usr/bin',
  'usr/etc/apt/sources.list.d',
  'usr/etc/profile.d',
  'usr/etc/novaclaw',
  'usr/lib',
  'usr/lib/apt/methods',
  'usr/libexec',
  'usr/var/dpkg/info',
  'usr/var/dpkg/updates',
  'usr/var/cache/apt/archives',
  'usr/var/log',
  'usr/tmp',
  'home',
];

for (const d of dirs) {
  mkdirSync(join(TMP_DIR, d), { recursive: true });
}

// ── Archivos de configuración mínima ─────────────────────────────────────────

writeFileSync(join(TMP_DIR, 'SYMLINKS.txt'), [
  '# SYMLINKS.txt — NovaClaw bootstrap symlinks',
  '# Format: target<-linkname',
  '',
].join('\n'), 'utf8');

writeFileSync(join(TMP_DIR, 'usr/etc/apt/sources.list'), [
  '# Termux package repository',
  'deb https://packages.termux.dev/apt/termux-main/ stable main',
  '',
].join('\n'), 'utf8');

writeFileSync(join(TMP_DIR, 'usr/var/dpkg/status'), '', 'utf8');
writeFileSync(join(TMP_DIR, 'usr/var/dpkg/available'), '', 'utf8');
writeFileSync(join(TMP_DIR, 'usr/var/dpkg/lock'), '', 'utf8');

writeFileSync(join(TMP_DIR, 'usr/etc/profile.d/novaclaw.sh'), [
  '#!/usr/bin/env bash',
  'export PREFIX=/data/data/com.novaclaw.app/files/usr',
  'export HOME=/data/data/com.novaclaw.app/files/home',
  'export NOVA_WORKSPACE=/data/data/com.novaclaw.app/files/home/workspace',
  'export PATH=$PREFIX/bin:/system/bin:/system/xbin',
  'export TMPDIR=/data/data/com.novaclaw.app/cache',
  'export TERM=xterm-256color',
  'export LANG=en_US.UTF-8',
  '',
].join('\n'), 'utf8');

writeFileSync(join(TMP_DIR, 'usr/etc/novaclaw/novaclaw.env'), [
  'export PREFIX=/data/data/com.novaclaw.app/files/usr',
  'export HOME=/data/data/com.novaclaw.app/files/home',
  'export NOVA_WORKSPACE=/data/data/com.novaclaw.app/files/home/workspace',
  'export PATH=$PREFIX/bin:/system/bin:/system/xbin',
  'export TMPDIR=/data/data/com.novaclaw.app/cache',
  'export TERM=xterm-256color',
  'export LANG=en_US.UTF-8',
  '',
].join('\n'), 'utf8');

writeFileSync(join(TMP_DIR, 'home/.bashrc'), [
  '# NovaClaw bashrc',
  'source $PREFIX/etc/profile.d/novaclaw.sh 2>/dev/null',
  'PS1="novaclaw $ "',
  '',
].join('\n'), 'utf8');

writeFileSync(join(TMP_DIR, 'home/.bash_profile'), [
  '# NovaClaw bash_profile',
  'if [ -f ~/.bashrc ]; then source ~/.bashrc; fi',
  '',
].join('\n'), 'utf8');

// ── Generar el ZIP ──────────────────────────────────────────────────────────

console.log('📦 Generando bootstrap ZIP mínimo...');
mkdirSync(ASSETS_DIR, { recursive: true });
if (existsSync(OUTPUT_ZIP)) rmSync(OUTPUT_ZIP);

let zipCreated = false;

// Método 1: PowerShell Compress-Archive (Windows 10+)
if (!zipCreated) {
  try {
    const src = TMP_DIR.replace(/\\/g, '/');
    const dst = OUTPUT_ZIP.replace(/\\/g, '/');
    const psCmd = `Compress-Archive -Path '${src}\\*' -DestinationPath '${dst}' -Force`;
    execSync(`powershell -NoProfile -Command "& { ${psCmd} }"`, {
      stdio: 'pipe',
      windowsHide: true,
      timeout: 30_000,
    });
    zipCreated = existsSync(OUTPUT_ZIP);
    if (zipCreated) console.log('  ✅ ZIP creado con PowerShell');
  } catch {
    console.warn('  ⚠️ PowerShell falló, intentando otro método...');
  }
}

// Método 2: zip nativo (Git Bash, MSYS2, WSL)
if (!zipCreated) {
  try {
    execSync(`cd "${TMP_DIR}" && zip -r "${OUTPUT_ZIP}" .`, {
      stdio: 'pipe',
      windowsHide: true,
      timeout: 30_000,
    });
    zipCreated = existsSync(OUTPUT_ZIP);
    if (zipCreated) console.log('  ✅ ZIP creado con zip nativo');
  } catch {
    console.warn('  ⚠️ zip nativo no disponible');
  }
}

// Método 3: Node.js puro — ZIP manual (PKZIP format, STORE, sin dependencias)
if (!zipCreated) {
  console.log('  📝 Generando ZIP con Node.js puro...');
  try {
    createZipManually(OUTPUT_ZIP, TMP_DIR);
    zipCreated = existsSync(OUTPUT_ZIP);
    if (zipCreated) console.log('  ✅ ZIP creado con Node.js puro');
  } catch (e) {
    console.warn('  ⚠️ Node.js ZIP falló:', e.message);
  }
}

if (!zipCreated) {
  console.error('');
  console.error('❌ No se pudo crear el ZIP.');
  console.error('   Opciones:');
  console.error('   1. Corre desde Git Bash: node scripts/build-minimal-bootstrap.mjs');
  console.error('   2. Instala zip: choco install zip');
  console.error('   3. Crea el ZIP manualmente desde tmp/bootstrap-staging/');
  process.exit(1);
}

console.log(`✅ Bootstrap ZIP creado: ${OUTPUT_ZIP}`);
console.log('');
console.log('📋 Este ZIP es MÍNIMO — no contiene binarios de Termux.');
console.log('   Para un bootstrap completo, usa: bash scripts/build-bootstrap-so.sh');

// ═══════════════════════════════════════════════════════════════════════════
// ZIP manual — Implementación mínima del formato PKZIP (STORE, sin compresión)
// ═══════════════════════════════════════════════════════════════════════════

function createZipManually(outputPath, baseDir) {
  const entries = [];
  collectEntries(baseDir, baseDir, entries);

  const parts = [];
  const centralHeaders = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.relativePath, 'utf8');
    const data = entry.isDir ? Buffer.alloc(0) : entry.content;
    const crc = entry.isDir ? 0 : crc32(data);
    const extAttr = entry.isDir ? 0x10 : 0x00;

    // Local file header
    const localHeader = makeLocalFileHeader(nameBytes, data, crc);
    parts.push(localHeader);

    // Central directory header
    const centralHeader = makeCentralDirHeader(nameBytes, data, crc, extAttr, offset);
    centralHeaders.push(centralHeader);

    offset += localHeader.length;
  }

  // Central directory
  const centralDirOffset = offset;
  let centralDirSize = 0;
  for (const ch of centralHeaders) {
    parts.push(ch);
    centralDirSize += ch.length;
  }

  // End of central directory record
  const eocd = makeEndOfCentralDir(entries.length, centralDirSize, centralDirOffset);
  parts.push(eocd);

  writeFileSync(outputPath, Buffer.concat(parts));
}

function collectEntries(base, current, entries) {
  const items = readdirSync(current, { withFileTypes: true });
  // Ordenar: directorios primero, luego archivos
  const sorted = [...items].sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  for (const item of sorted) {
    const fullPath = join(current, item.name);
    const relPath = relative(base, fullPath).replace(/\\/g, '/') +
      (item.isDirectory() ? '/' : '');

    if (item.isDirectory()) {
      entries.push({ relativePath: relPath, isDir: true, content: null });
      collectEntries(base, fullPath, entries);
    } else {
      const content = readFileSync(fullPath);
      entries.push({ relativePath: relPath, isDir: false, content });
    }
  }
}

function makeLocalFileHeader(nameBytes, data, crc) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);   // Local file header signature
  header.writeUInt16LE(20, 4);            // Version needed to extract (2.0)
  header.writeUInt16LE(0, 6);             // General purpose bit flag
  header.writeUInt16LE(0, 8);             // Compression method: STORE
  header.writeUInt16LE(0, 10);            // File last modification time
  header.writeUInt16LE(0x0021, 12);       // File last modification date
  header.writeUInt32LE(crc, 14);          // CRC-32
  header.writeUInt32LE(data.length, 18);  // Compressed size
  header.writeUInt32LE(data.length, 22);  // Uncompressed size
  header.writeUInt16LE(nameBytes.length, 26); // File name length
  header.writeUInt16LE(0, 28);            // Extra field length
  return Buffer.concat([header, nameBytes, data]);
}

function makeCentralDirHeader(nameBytes, data, crc, extAttr, localOffset) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);   // Central directory file header signature
  header.writeUInt16LE(20, 4);            // Version made by
  header.writeUInt16LE(20, 6);            // Version needed to extract
  header.writeUInt16LE(0, 8);             // General purpose bit flag
  header.writeUInt16LE(0, 10);            // Compression method: STORE
  header.writeUInt16LE(0, 12);            // File last modification time
  header.writeUInt16LE(0x0021, 14);       // File last modification date
  header.writeUInt32LE(crc, 16);          // CRC-32
  header.writeUInt32LE(data.length, 20);  // Compressed size
  header.writeUInt32LE(data.length, 24);  // Uncompressed size
  header.writeUInt16LE(nameBytes.length, 28); // File name length
  header.writeUInt16LE(0, 30);            // Extra field length
  header.writeUInt16LE(0, 32);            // File comment length
  header.writeUInt16LE(0, 34);            // Disk number start
  header.writeUInt16LE(0, 36);            // Internal file attributes
  header.writeUInt32LE(extAttr, 38);      // External file attributes
  header.writeUInt32LE(localOffset, 42);  // Relative offset of local header
  return Buffer.concat([header, nameBytes]);
}

function makeEndOfCentralDir(numEntries, centralDirSize, centralDirOffset) {
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);          // End of central dir signature
  eocd.writeUInt16LE(0, 4);                    // Number of this disk
  eocd.writeUInt16LE(0, 6);                    // Disk where central dir starts
  eocd.writeUInt16LE(numEntries, 8);           // Entries on this disk
  eocd.writeUInt16LE(numEntries, 10);          // Total entries
  eocd.writeUInt32LE(centralDirSize, 12);      // Size of central directory
  eocd.writeUInt32LE(centralDirOffset, 16);    // Offset of central directory
  eocd.writeUInt16LE(0, 20);                   // Comment length
  return eocd;
}

// CRC32
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
