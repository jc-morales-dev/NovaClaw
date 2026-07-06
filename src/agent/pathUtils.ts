function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/');
}

function splitRoot(value: string): { root: string; rest: string } {
  const normalized = normalizeSlashes(value);
  const windowsMatch = normalized.match(/^([a-zA-Z]:)(\/.*)?$/);
  if (windowsMatch) {
    return {
      root: windowsMatch[1],
      rest: windowsMatch[2] ?? '/',
    };
  }

  if (normalized.startsWith('/')) {
    return { root: '/', rest: normalized.slice(1) };
  }

  return { root: '', rest: normalized };
}

function normalizePortablePath(value: string): string {
  const { root, rest } = splitRoot(value);
  const parts: string[] = [];

  for (const segment of rest.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') {
        parts.pop();
      } else if (!root) {
        parts.push('..');
      }
      continue;
    }
    parts.push(segment);
  }

  if (root === '/') {
    return `/${parts.join('/')}`.replace(/\/+$/, '') || '/';
  }

  if (root) {
    const suffix = parts.join('/');
    return suffix ? `${root}/${suffix}` : `${root}/`;
  }

  return parts.join('/') || '.';
}

export function normalizeComparablePath(value: string): string {
  return normalizePortablePath(value).replace(/\/+$/, '').toLowerCase();
}

export function basenamePath(value: string): string {
  const normalized = normalizeSlashes(value).replace(/\/+$/, '');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || normalized;
}

export function resolvePortablePath(cwd: string, inputPath: string): string {
  if (!inputPath) {
    return normalizePortablePath(cwd);
  }

  const normalizedInput = normalizeSlashes(inputPath.trim());

  if (/^(?:\/|[a-zA-Z]:\/)/.test(normalizedInput)) {
    return normalizePortablePath(normalizedInput);
  }

  return normalizePortablePath(`${normalizeSlashes(cwd).replace(/\/+$/, '')}/${normalizedInput}`);
}
