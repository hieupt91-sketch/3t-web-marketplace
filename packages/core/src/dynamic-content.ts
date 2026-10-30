/**
 * Dynamic template family content contract (docs/12 customer backup /
 * restore). A dynamic site's editable content lives in
 * `data/content.json`; the templates' own admin offers exactly this file
 * as its backup download and validates restores against these keys (see
 * `validateContentShape` in any dynamic template's server). The platform
 * reuses the same contract for its customer-facing backup/restore so a
 * file from one surface restores cleanly on the other.
 */
export const DYNAMIC_CONTENT_KEYS = [
  'site',
  'hero',
  'menu',
  'spaces',
  'reviews',
  'faqs',
  'bookingSteps',
  'bookingForm',
  'nav',
  'theme',
  'footer',
] as const;

const ITEM_LIST_KEYS = ['menu', 'spaces', 'reviews', 'faqs'] as const;

/** Returns null when valid, otherwise a machine-readable reason. */
export function validateDynamicContent(content: unknown): string | null {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return 'not_an_object';
  const doc = content as Record<string, unknown>;
  for (const key of DYNAMIC_CONTENT_KEYS) {
    if (doc[key] === null || doc[key] === undefined) return `missing:${key}`;
  }
  for (const key of ITEM_LIST_KEYS) {
    const section = doc[key];
    if (!section || typeof section !== 'object' || !Array.isArray((section as { items?: unknown }).items)) {
      return `items_not_array:${key}`;
    }
  }
  return null;
}
