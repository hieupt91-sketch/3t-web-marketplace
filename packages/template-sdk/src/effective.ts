import type { DetectionResult } from './detect.ts';
import type { TemplateManifest } from './manifest.ts';

/**
 * Admin-editable configuration fields (PATCH /admin/imports/{id}/configuration).
 * Only these keys may be overridden; everything else comes from the package.
 */
export interface ConfigurationOverrides {
  slug?: string;
  version?: string;
  name?: Record<string, string>;
  summary?: Record<string, string>;
  adapter?: TemplateManifest['adapter'];
  projectRoot?: string;
  entry?: string;
  spaFallback?: boolean;
  defaultLocale?: string;
  supportedLocales?: string[];
}

export const OVERRIDE_KEYS: readonly (keyof ConfigurationOverrides)[] = [
  'slug',
  'version',
  'name',
  'summary',
  'adapter',
  'projectRoot',
  'entry',
  'spaFallback',
  'defaultLocale',
  'supportedLocales',
];

export interface EffectiveManifest {
  manifest: Record<string, unknown>;
  /** JSON pointers whose values were inferred by the system instead of declared. */
  inferred: string[];
}

export function slugFromName(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[0-9-]+/, '');
  return slug.slice(0, 60).replace(/-+$/, '') || 'template';
}

/**
 * Build the manifest the pipeline will use. The declared manifest always wins over inference;
 * admin overrides win over both and are stored as a separate configuration revision.
 */
export function buildEffectiveManifest(
  detection: DetectionResult,
  declared: Record<string, unknown> | null,
  hints: { nameHint: string },
  overrides: ConfigurationOverrides = {},
): EffectiveManifest {
  const inferred: string[] = [];
  let manifest: Record<string, unknown>;
  if (declared) {
    manifest = structuredClone(declared);
  } else if (detection.adapter === 'static-html' && detection.projectRoot) {
    const title = hints.nameHint.trim() || 'Template';
    manifest = {
      schemaVersion: 1,
      slug: slugFromName(title),
      version: '0.1.0',
      name: { vi: title },
      summary: { vi: title },
      adapter: 'static-html',
      projectRoot: detection.projectRoot,
      runtime: { entry: 'index.html', spaFallback: false },
      database: { engine: 'none' },
      demo: { mode: 'publicReadonly', ttlHours: 24 },
      locales: { default: 'vi', supported: ['vi'], contentMode: 'static' },
      capabilities: ['landing'],
      env: [],
      export: { modes: ['selfhost', 'hosted'], sourceRoot: '.' },
    };
    inferred.push('/slug', '/version', '/name', '/summary', '/projectRoot', '/runtime', '/locales', '/capabilities', '/export');
  } else {
    manifest = { schemaVersion: 1 };
    if (detection.adapter) manifest.adapter = detection.adapter;
    if (detection.projectRoot) manifest.projectRoot = detection.projectRoot;
  }

  const runtime = (manifest.runtime ?? {}) as Record<string, unknown>;
  const locales = (manifest.locales ?? {}) as Record<string, unknown>;
  if (overrides.slug !== undefined) manifest.slug = overrides.slug;
  if (overrides.version !== undefined) manifest.version = overrides.version;
  if (overrides.name !== undefined) manifest.name = overrides.name;
  if (overrides.summary !== undefined) manifest.summary = overrides.summary;
  if (overrides.adapter !== undefined) manifest.adapter = overrides.adapter;
  if (overrides.projectRoot !== undefined) manifest.projectRoot = overrides.projectRoot;
  if (overrides.entry !== undefined) runtime.entry = overrides.entry;
  if (overrides.spaFallback !== undefined) runtime.spaFallback = overrides.spaFallback;
  if (overrides.defaultLocale !== undefined) locales.default = overrides.defaultLocale;
  if (overrides.supportedLocales !== undefined) locales.supported = overrides.supportedLocales;
  if (Object.keys(runtime).length) manifest.runtime = runtime;
  if (Object.keys(locales).length) manifest.locales = locales;
  const overridden = new Set<string>(
    Object.entries(overrides)
      .filter(([, v]) => v !== undefined)
      .map(([k]) => `/${k}`),
  );
  return { manifest, inferred: inferred.filter((p) => !overridden.has(p)) };
}
