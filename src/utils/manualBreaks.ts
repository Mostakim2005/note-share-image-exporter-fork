import type { App } from 'obsidian';

const STORAGE_PREFIX = 'note-share-image-exporter:manual-breaks:v1:';

export interface ManualBreakState {
  enabled: boolean;
  breaks: number[];
  contentHeight: number;
  updatedAt: number;
}

function storageKey(app: App, filePath: string): string {
  return `${STORAGE_PREFIX}${app.vault.getName()}:${filePath}`;
}

export function loadManualBreakState(app: App, filePath: string): ManualBreakState | undefined {
  try {
    const raw = window.localStorage.getItem(storageKey(app, filePath));
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return undefined;
    const value = parsed as Partial<ManualBreakState>;
    if (!Array.isArray(value.breaks) || typeof value.enabled !== 'boolean') return undefined;
    const breaks = value.breaks
      .filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
      .sort((a, b) => a - b);
    return {
      enabled: value.enabled,
      breaks,
      contentHeight: typeof value.contentHeight === 'number' ? value.contentHeight : 0,
      updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
    };
  } catch {
    return undefined;
  }
}

export function saveManualBreakState(app: App, filePath: string, state: ManualBreakState): void {
  try {
    window.localStorage.setItem(storageKey(app, filePath), JSON.stringify({
      ...state,
      breaks: [...state.breaks].sort((a, b) => a - b),
      updatedAt: Date.now(),
    }));
  } catch {
    // localStorage can be unavailable in restricted environments. Export still works.
  }
}

export function clearManualBreakState(app: App, filePath: string): void {
  try {
    window.localStorage.removeItem(storageKey(app, filePath));
  } catch {
    // Ignore storage failures.
  }
}
