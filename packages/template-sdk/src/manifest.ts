import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv2020Import from 'ajv/dist/2020.js';
import type { ErrorObject } from 'ajv/dist/2020.js';
import { isSafeRelativePath, joinRelative } from './paths.ts';

export const MANIFEST_FILE = 'template.manifest.json';

export type Adapter = 'static-html' | 'vite-static' | 'next-standalone' | 'node-http';

export const ADAPTERS: readonly Adapter[] = ['static-html', 'vite-static', 'next-standalone', 'node-http'];

/** Adapters whose build/run pipeline is implemented and tested in this release. */
export const IMPLEMENTED_ADAPTERS: readonly Adapter[] = ['static-html', 'vite-static', 'node-http', 'next-standalone'];

export interface TemplateManifest {
  schemaVersion: 1;
  slug: string;
  version: string;
  name: Record<string, string>;
  summary: Record<string, string>;
  adapter: Adapter;
  projectRoot: string;
  build?: { script: string; outputDir: string; toolchain: string; packageManager: 'npm' | 'pnpm' | 'yarn'; lockfile: string };
  runtime: {
    entry?: string;
    spaFallback?: boolean;
    port?: number;
    start?: string[];
    healthPath?: string;
    writePaths?: string[];
  };
  database: { engine: 'none' | 'sqlite' | 'postgres'; fileName?: string; migrate?: string[]; seedDemo?: string[] };
  demo: { mode: 'publicReadonly' | 'isolatedAdmin'; ttlHours: number; seedProfile?: string };
  locales: { default: string; supported: string[]; contentMode: 'static' | 'runtime' };
  capabilities: string[];
  env: { name: string; scope: 'public' | 'server'; required: boolean; secret: boolean; description: string; defaultValue?: string }[];
  export: { modes: ('selfhost' | 'hosted')[]; sourceRoot: string };
}

export interface ManifestIssue {
  /** RFC 6901 JSON pointer into the manifest ("" is the document root). */
  pointer: string;
  code: string;
  /** Developer-facing detail in English; UI translates by code. */
  detail: string;
}

const schemaPath = fileURLToPath(new URL('../../../contracts/template-manifest.schema.json', import.meta.url));
export const MANIFEST_SCHEMA = JSON.parse(readFileSync(schemaPath, 'utf8')) as Record<string, unknown>;

// ajv ships CommonJS; under NodeNext the class is the namespace's default export.
const Ajv2020 = Ajv2020Import.default;
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, strictTypes: false, allowUnionTypes: false });
const validateSchema = ajv.compile(MANIFEST_SCHEMA);

function escapePointer(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function fromAjv(error: ErrorObject): ManifestIssue | null {
  switch (error.keyword) {
    case 'if':
    case 'allOf':
      return null; // reported through the nested failing keyword
    case 'required': {
      const missing = (error.params as { missingProperty: string }).missingProperty;
      return { pointer: `${error.instancePath}/${escapePointer(missing)}`, code: 'required', detail: 'is required' };
    }
    case 'additionalProperties': {
      const extra = (error.params as { additionalProperty: string }).additionalProperty;
      return { pointer: `${error.instancePath}/${escapePointer(extra)}`, code: 'unknown_field', detail: 'is not allowed' };
    }
    case 'not':
      return { pointer: error.instancePath, code: 'forbidden_combination', detail: 'field combination is not allowed for this adapter/engine' };
    case 'const':
      return { pointer: error.instancePath, code: error.instancePath === '/schemaVersion' ? 'unsupported_schema_version' : 'invalid_value', detail: error.message ?? 'invalid' };
    default:
      return { pointer: error.instancePath, code: `invalid_${error.keyword}`, detail: error.message ?? 'invalid' };
  }
}

function dedupe(issues: ManifestIssue[]): ManifestIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const key = `${i.pointer}|${i.code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Cross-field rules that JSON Schema cannot express (mirrors scripts/validate_docs.py#semantic). */
function semanticIssues(m: TemplateManifest): ManifestIssue[] {
  const issues: ManifestIssue[] = [];
  if (!m.locales.supported.includes(m.locales.default)) {
    issues.push({ pointer: '/locales/default', code: 'default_locale_unsupported', detail: 'default locale must be listed in supported' });
  }
  for (const key of ['name', 'summary'] as const) {
    if (!(m.locales.default in m[key])) {
      issues.push({ pointer: `/${key}/${escapePointer(m.locales.default)}`, code: 'default_locale_missing', detail: 'default locale text is required' });
    }
  }
  const names = new Set<string>();
  m.env.forEach((item, index) => {
    if (names.has(item.name)) issues.push({ pointer: `/env/${index}/name`, code: 'duplicate_env', detail: 'duplicate env name' });
    names.add(item.name);
  });
  if (m.demo.mode === 'isolatedAdmin') {
    if (!m.capabilities.includes('admin')) {
      issues.push({ pointer: '/capabilities', code: 'admin_capability_required', detail: 'isolatedAdmin demo needs admin capability' });
    }
    if (m.adapter !== 'node-http' && m.adapter !== 'next-standalone') {
      issues.push({ pointer: '/demo/mode', code: 'runtime_adapter_required', detail: 'isolatedAdmin demo needs a runtime adapter' });
    }
  }
  if (m.adapter === 'static-html' && m.capabilities.some((c) => c === 'admin' || c.startsWith('cms.') || c.startsWith('shop.'))) {
    issues.push({ pointer: '/capabilities', code: 'capability_not_supported_by_adapter', detail: 'static-html cannot provide admin/cms/shop' });
  }
  for (const [pointer, value] of [
    ['/projectRoot', m.projectRoot],
    ['/runtime/entry', m.runtime.entry],
    ['/build/outputDir', m.build?.outputDir],
    ['/build/lockfile', m.build?.lockfile],
    ['/export/sourceRoot', m.export.sourceRoot],
  ] as const) {
    if (value !== undefined && !isSafeRelativePath(value)) {
      issues.push({ pointer, code: 'unsafe_path', detail: 'must be a relative path without .., drive letters or backslashes' });
    }
  }
  return issues;
}

export type ManifestValidation = { ok: true; manifest: TemplateManifest; issues: [] } | { ok: false; issues: ManifestIssue[] };

export function validateManifest(data: unknown): ManifestValidation {
  if (!validateSchema(data)) {
    const issues = dedupe((validateSchema.errors ?? []).map(fromAjv).filter((i): i is ManifestIssue => i !== null));
    return { ok: false, issues: issues.length ? issues : [{ pointer: '', code: 'invalid', detail: 'manifest does not match schema' }] };
  }
  const manifest = data as TemplateManifest;
  const issues = semanticIssues(manifest);
  return issues.length ? { ok: false, issues } : { ok: true, manifest, issues: [] };
}

/** Check that paths declared by the manifest exist in the extracted workspace. */
export function fileExistenceIssues(m: TemplateManifest, files: ReadonlySet<string>, directories: ReadonlySet<string>): ManifestIssue[] {
  const issues: ManifestIssue[] = [];
  const isDir = (p: string) => p === '.' || directories.has(p);
  if (!isDir(m.projectRoot)) issues.push({ pointer: '/projectRoot', code: 'path_not_found', detail: 'directory not found in package' });
  if (m.runtime.entry && (m.adapter === 'static-html') && !files.has(joinRelative(m.projectRoot, m.runtime.entry))) {
    issues.push({ pointer: '/runtime/entry', code: 'path_not_found', detail: 'entry file not found under projectRoot' });
  }
  if (m.build && !files.has(joinRelative(m.projectRoot, m.build.lockfile))) {
    issues.push({ pointer: '/build/lockfile', code: 'path_not_found', detail: 'lockfile not found under projectRoot' });
  }
  if (!isDir(m.export.sourceRoot)) issues.push({ pointer: '/export/sourceRoot', code: 'path_not_found', detail: 'directory not found in package' });
  return issues;
}

export function parseManifestText(text: string): { ok: true; data: unknown } | { ok: false; issue: ManifestIssue } {
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: false, issue: { pointer: '', code: 'invalid_json', detail: 'manifest is not valid JSON' } };
  }
}
