'use client';

import { useEffect, useSyncExternalStore } from 'react';

/**
 * CAT-09 compare selection: up to three template slugs, kept in
 * localStorage so the choice survives navigation between the catalog,
 * the saved list and the compare page. Selection is by slug because the
 * compare page URL (/{locale}/templates/compare?slugs=…) is shareable.
 */
const KEY = 'wm_compare_templates_v1';
export const COMPARE_MAX = 3;

interface CompareState { slugs: string[] }
let state: CompareState = { slugs: [] };
let hydrated = false;
const listeners = new Set<() => void>();

function emit(slugs: string[]) {
  state = { slugs };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(slugs));
  } catch {
    /* in-memory only for this session */
  }
  listeners.forEach((fn) => fn());
}

function hydrate() {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (Array.isArray(parsed)) {
      const slugs = parsed.filter((x): x is string => typeof x === 'string').slice(0, COMPARE_MAX);
      if (slugs.length > 0) state = { slugs };
    }
  } catch {
    /* start empty */
  }
}

/** Returns true when the toggle was applied; false when the list is full. */
export function toggleCompare(slug: string): boolean {
  hydrate();
  if (state.slugs.includes(slug)) {
    emit(state.slugs.filter((s) => s !== slug));
    return true;
  }
  if (state.slugs.length >= COMPARE_MAX) return false;
  emit([...state.slugs, slug]);
  return true;
}

export function clearCompare(): void {
  hydrate();
  emit([]);
}

export function useCompare(): CompareState {
  const current = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
    () => state,
  );
  useEffect(() => {
    hydrate();
    // Re-emit so subscribers pick up the hydrated selection.
    emit([...state.slugs]);
  }, []);
  return current;
}
