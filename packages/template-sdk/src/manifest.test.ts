import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fileExistenceIssues, validateManifest } from './manifest.ts';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const fixture = JSON.parse(readFileSync(`${repo}examples/static-landing/template.manifest.json`, 'utf8'));

describe('validateManifest', () => {
  it('accepts the bundled fixture and contract examples', () => {
    expect(validateManifest(fixture)).toMatchObject({ ok: true });
    for (const file of readdirSync(`${repo}contracts/examples`)) {
      const data = JSON.parse(readFileSync(`${repo}contracts/examples/${file}`, 'utf8'));
      expect(validateManifest(data), file).toMatchObject({ ok: true });
    }
  });

  it('reports JSON pointers for schema errors (AT-06)', () => {
    const bad = { ...fixture, schemaVersion: 2, extra: true, projectRoot: '../escape' };
    delete (bad as Record<string, unknown>).version;
    const result = validateManifest(bad);
    expect(result.ok).toBe(false);
    const pointers = result.issues.map((i) => `${i.pointer}:${i.code}`);
    expect(pointers).toContain('/schemaVersion:unsupported_schema_version');
    expect(pointers).toContain('/version:required');
    expect(pointers).toContain('/extra:unknown_field');
    expect(pointers).toContain('/projectRoot:invalid_pattern');
  });

  it('rejects secrets with defaults and public secrets', () => {
    const result = validateManifest({
      ...fixture,
      env: [{ name: 'KEY', scope: 'public', secret: true, required: true, description: 'x', defaultValue: 'v' }],
    });
    expect(result.ok).toBe(false);
  });

  it('applies semantic rules', () => {
    const result = validateManifest({ ...fixture, locales: { default: 'en', supported: ['vi'], contentMode: 'static' } });
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['default_locale_unsupported']));
    const cms = validateManifest({ ...fixture, capabilities: ['landing', 'cms.pages'] });
    expect(cms.issues.map((i) => i.code)).toContain('capability_not_supported_by_adapter');
  });

  it('checks declared paths against package contents', () => {
    const issues = fileExistenceIssues(fixture, new Set(['site/other.html']), new Set(['site']));
    expect(issues.map((i) => i.pointer)).toEqual(['/runtime/entry']);
  });
});
