/**
 * i18n gate for the web app (docs/07 §9): every literal translation key used in src/ must exist
 * in both vi and en, and every enumerated dynamic key family must be complete.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MESSAGES } from '@3t/i18n';
import { IMPORT_STEPS, IMPORT_ERROR_OUTCOME } from '../../../packages/core/src/ingestion.ts';

const root = new URL('../src', import.meta.url).pathname;
const files: string[] = [];
(function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(tsx?|ts)$/.test(name)) files.push(full);
  }
})(root);

const used = new Set<string>();
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/\b(?:t|translate\(locale,)\s*\(?\s*'((?:ui|error|import|mail)\.[a-z0-9_.]+)'/g)) used.add(m[1]!);
  for (const m of text.matchAll(/labelKey: '([a-z0-9_.]+)'/g)) used.add(m[1]!);
  for (const m of text.matchAll(/\['(?:100%|768px|390px)', '([a-z0-9_.]+)'\]/g)) used.add(m[1]!);
}
const families: Record<string, string[]> = {
  'ui.import.status': ['received', 'inspecting', 'needs_configuration', 'queued', 'building', 'provisioning', 'validating', 'ready', 'failed', 'rejected', 'cancelled'],
  'ui.import.step': [...IMPORT_STEPS],
  'ui.import.error': [...Object.keys(IMPORT_ERROR_OUTCOME), 'internal_error', 'screenshot_failed', 'cancelled'],
  'ui.template.status': ['draft', 'published', 'archived'],
  'ui.job.status': ['queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled'],
  'ui.step.status': ['pending', 'running', 'succeeded', 'failed', 'skipped'],
  'ui.import.confidence': ['declared', 'high', 'medium', 'low'],
  'ui.import.stepper': ['resource', 'configure', 'build', 'check', 'state_done', 'state_current', 'state_todo', 'state_error'],
  'ui.capability': ['landing', 'catalog', 'cms_pages', 'cms_products', 'cms_articles', 'cms_media', 'cms_translations', 'admin', 'contact', 'shop_cart', 'shop_checkout'],
  'ui.auth.field': ['display_name', 'email', 'password', 'new_password', 'confirm_password', 'locale', 'accept_terms'],
};
for (const [prefix, members] of Object.entries(families)) for (const m of members) used.add(`${prefix}.${m}`);

const missing: string[] = [];
for (const key of [...used].sort()) for (const locale of ['vi', 'en'] as const) if (!(key in MESSAGES[locale])) missing.push(`${locale}: ${key}`);
if (missing.length) {
  console.error(`Missing translation keys:\n${missing.join('\n')}`);
  process.exit(1);
}
console.log(JSON.stringify({ status: 'PASS', keys_checked: used.size, files: files.length }));
