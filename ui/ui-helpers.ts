import { ProtonAuthStatus } from '../proton/auth/ProtonSessionService';

export function toLoginLabel(state: ProtonAuthStatus): string {
  switch (state) {
    case 'connected':
      return 'Connected';
    case 'connecting':
      return 'Connecting';
    case 'error':
      return 'Error';
    case 'disconnected':
    default:
      return 'Disconnected';
  }
}

export function toLoginIcon(state: ProtonAuthStatus): string {
  switch (state) {
    case 'connected':
      return '🟢';
    case 'connecting':
      return '⏳';
    case 'error':
      return '⚠️';
    case 'disconnected':
    default:
      return '⚫';
  }
}
