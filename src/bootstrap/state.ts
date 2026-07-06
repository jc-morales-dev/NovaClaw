export type BootstrapPhase =
  | 'checking'
  | 'not_installed'
  | 'downloading'
  | 'extracting'
  | 'installing'
  | 'ready'
  | 'error';

export type BootstrapStatus = {
  phase: BootstrapPhase;
  message: string;
  progress: number | null;
  error: string | null;
};

export function createBootstrapStatus(input: {
  phase: BootstrapPhase;
  message: string;
  progress?: number | null;
  error?: string | null;
}): BootstrapStatus {
  return {
    phase: input.phase,
    message: input.message,
    progress: typeof input.progress === 'number' ? clampProgress(input.progress) : null,
    error: input.error ?? null,
  };
}

export function isBootstrapBlocking(status: BootstrapStatus): boolean {
  return status.phase !== 'ready';
}

export function getBootstrapProgressValue(status: BootstrapStatus): number | null {
  if (status.phase === 'ready') return 100;
  return typeof status.progress === 'number' ? clampProgress(status.progress) : null;
}

function clampProgress(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}
