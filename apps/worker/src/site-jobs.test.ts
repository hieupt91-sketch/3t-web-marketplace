import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { carrySiteData, stripDemoCredentials } from './site-jobs.js';

/**
 * v44: an update swaps the site's whole tree for the new version artifact
 * (code + seed only). carrySiteData moves the customer's live data/ into
 * the staged tree first, so updating never resets their content,
 * bookings, site admin account, uploads or Google Sheet integration.
 */
describe('carrySiteData', () => {
  it('copies the whole data tree, including nested uploads', async () => {
    const base = await mkdtemp(join(tmpdir(), 'mp-carry-'));
    const live = join(base, 'live');
    const staged = join(base, 'staged');
    await mkdir(join(live, 'data', 'uploads'), { recursive: true });
    await mkdir(staged, { recursive: true });
    await writeFile(join(live, 'data', 'content.json'), '{"edited":true}');
    await writeFile(join(live, 'data', 'bookings.json'), '[{"id":"b1"}]');
    await writeFile(join(live, 'data', 'admin.json'), '{"user":"admin"}');
    await writeFile(join(live, 'data', 'integrations.json'), '{"sheet":"https://script.google.com/x"}');
    await writeFile(join(live, 'data', 'uploads', 'a.txt'), 'upload-bytes');

    await carrySiteData(live, staged);

    await expect(readFile(join(staged, 'data', 'content.json'), 'utf8')).resolves.toBe('{"edited":true}');
    await expect(readFile(join(staged, 'data', 'bookings.json'), 'utf8')).resolves.toBe('[{"id":"b1"}]');
    await expect(readFile(join(staged, 'data', 'admin.json'), 'utf8')).resolves.toBe('{"user":"admin"}');
    await expect(readFile(join(staged, 'data', 'integrations.json'), 'utf8')).resolves.toBe('{"sheet":"https://script.google.com/x"}');
    await expect(readFile(join(staged, 'data', 'uploads', 'a.txt'), 'utf8')).resolves.toBe('upload-bytes');
  });

  it('customer data wins over any data/ the artifact ships', async () => {
    const base = await mkdtemp(join(tmpdir(), 'mp-carry-'));
    const live = join(base, 'live');
    const staged = join(base, 'staged');
    await mkdir(join(live, 'data'), { recursive: true });
    await mkdir(join(staged, 'data'), { recursive: true });
    await writeFile(join(live, 'data', 'content.json'), '{"mine":true}');
    await writeFile(join(staged, 'data', 'content.json'), '{"seed":true}');
    await writeFile(join(staged, 'data', 'seed-only.json'), '{}');

    await carrySiteData(live, staged);

    await expect(readFile(join(staged, 'data', 'content.json'), 'utf8')).resolves.toBe('{"mine":true}');
    expect(existsSync(join(staged, 'data', 'seed-only.json'))).toBe(false);
  });

  it('is a no-op when the live site has no data directory', async () => {
    const base = await mkdtemp(join(tmpdir(), 'mp-carry-'));
    const live = join(base, 'live');
    const staged = join(base, 'staged');
    await mkdir(live, { recursive: true });
    await mkdir(staged, { recursive: true });

    await carrySiteData(live, staged);

    expect(existsSync(join(staged, 'data'))).toBe(false);
  });
});

/**
 * Audit H-01: a promoted demo tree carries the demo admin account, whose
 * password is public (admin/Demo1234). stripDemoCredentials removes the
 * account, the session signing key and any stale setup token — so the
 * promoted site boots in first-run state — while the buyer's own demo
 * edits (content, bookings, uploads, integrations) survive untouched.
 */
describe('stripDemoCredentials', () => {
  it('removes credential artefacts but keeps the buyer\u2019s data', async () => {
    const base = await mkdtemp(join(tmpdir(), 'mp-strip-'));
    const site = join(base, 'site');
    await mkdir(join(site, 'data', 'uploads'), { recursive: true });
    await writeFile(join(site, 'data', 'admin.json'), '{"username":"admin","salt":"s","hash":"h"}');
    await writeFile(join(site, 'data', 'session-key'), 'demo-session-key');
    await writeFile(join(site, 'data', 'setup-token.txt'), 'stale-token');
    await writeFile(join(site, 'data', 'content.json'), '{"edited":true}');
    await writeFile(join(site, 'data', 'bookings.json'), '[{"id":"b1"}]');
    await writeFile(join(site, 'data', 'integrations.json'), '{"sheet":"https://script.google.com/x"}');
    await writeFile(join(site, 'data', 'uploads', 'a.txt'), 'upload-bytes');

    await stripDemoCredentials(site);

    expect(existsSync(join(site, 'data', 'admin.json'))).toBe(false);
    expect(existsSync(join(site, 'data', 'session-key'))).toBe(false);
    expect(existsSync(join(site, 'data', 'setup-token.txt'))).toBe(false);
    await expect(readFile(join(site, 'data', 'content.json'), 'utf8')).resolves.toBe('{"edited":true}');
    await expect(readFile(join(site, 'data', 'bookings.json'), 'utf8')).resolves.toBe('[{"id":"b1"}]');
    await expect(readFile(join(site, 'data', 'integrations.json'), 'utf8')).resolves.toBe('{"sheet":"https://script.google.com/x"}');
    await expect(readFile(join(site, 'data', 'uploads', 'a.txt'), 'utf8')).resolves.toBe('upload-bytes');
  });

  it('is a no-op when the credential files are absent', async () => {
    const base = await mkdtemp(join(tmpdir(), 'mp-strip-'));
    const site = join(base, 'site');
    await mkdir(join(site, 'data'), { recursive: true });
    await writeFile(join(site, 'data', 'content.json'), '{"seed":true}');

    await stripDemoCredentials(site);

    await expect(readFile(join(site, 'data', 'content.json'), 'utf8')).resolves.toBe('{"seed":true}');
  });
});
