import type { Tone } from '@/components/ui';

export const IMPORT_TERMINAL = new Set(['ready', 'rejected', 'cancelled', 'needs_configuration', 'failed']);

export function importTone(status: string): Tone {
  switch (status) {
    case 'ready':
      return 'success';
    case 'needs_configuration':
      return 'warning';
    case 'failed':
    case 'rejected':
      return 'error';
    case 'cancelled':
      return 'neutral';
    default:
      return 'info';
  }
}

export function stepTone(status: string): Tone {
  return status === 'succeeded' ? 'success' : status === 'failed' ? 'error' : status === 'running' ? 'info' : 'neutral';
}

export function templateTone(status: string): Tone {
  return status === 'published' ? 'success' : status === 'archived' ? 'neutral' : 'warning';
}
