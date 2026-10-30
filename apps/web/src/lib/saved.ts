'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { api } from './api';

/**
 * CAT-08 saved templates, one shared client store.
 *
 * Guests: the list lives in localStorage (template ids only — nothing
 * sensitive). Signed-in customers: the server list is the source of truth;
 * the first load after sign-in merges any guest list through
 * POST /me/saved-templates/merge (the documented CAT-08 merge flow) and
 * clears the local copy so the two never drift apart.
 */
const GUEST_KEY = 'wm_saved_templates_v1';

export interface SavedEntry { template_id: string; slug: string; saved_at: string; template_status: string; available: boolean }
interface SavedState { ids: ReadonlySet<string>; ready: boolean }

let state: SavedState = { ids: new Set(), ready: false };
let mode: 'unknown' | 'guest' | 'server' = 'unknown';
let loadStarted = false;
const listeners = new Set<() => void>();

function emit(ids: ReadonlySet<string>, ready = true) {
  state = { ids, ready };
  listeners.forEach((fn) => fn());
}

function readGuest(): string[] {
  try {
    const raw = window.localStorage.getItem(GUEST_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeGuest(ids: string[]) {
  try {
    window.localStorage.setItem(GUEST_KEY, JSON.stringify(ids));
  } catch {
    /* private mode etc.: the in-memory state still works for the session */
  }
}

async function load(): Promise<void> {
  const res = await api<SavedEntry[]>('/me/saved-templates');
  if (!res.ok) {
    // 401 (or offline): fall back to the guest list on this browser.
    mode = 'guest';
    emit(new Set(readGuest()));
    return;
  }
  mode = 'server';
  const guest = readGuest();
  if (guest.length > 0) {
    const merged = await api<SavedEntry[]>('/me/saved-templates/merge', { method: 'POST', body: { template_ids: guest } });
    if (merged.ok) {
      writeGuest([]);
      emit(new Set(merged.data.map((e) => e.template_id)));
      return;
    }
  }
  emit(new Set(res.data.map((e) => e.template_id)));
}

export function ensureSavedLoaded(): void {
  if (loadStarted) return;
  loadStarted = true;
  void load().catch(() => {
    mode = 'guest';
    emit(new Set(readGuest()));
  });
}

export async function toggleSaved(templateId: string): Promise<void> {
  const wasSaved = state.ids.has(templateId);
  const next = new Set(state.ids);
  if (wasSaved) next.delete(templateId);
  else next.add(templateId);
  emit(next);
  if (mode === 'server') {
    const res = wasSaved
      ? await api(`/me/saved-templates/${templateId}`, { method: 'DELETE' })
      : await api('/me/saved-templates', { method: 'POST', body: { template_id: templateId } });
    if (!res.ok) {
      // Revert the optimistic change and resync from the server.
      loadStarted = false;
      ensureSavedLoaded();
    }
  } else {
    writeGuest([...next]);
  }
}

export function useSaved(): SavedState {
  const current = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
    () => state,
  );
  useEffect(() => {
    ensureSavedLoaded();
  }, []);
  return current;
}
