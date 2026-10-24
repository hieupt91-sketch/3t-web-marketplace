import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import yauzl from 'yauzl';
import { buildSelfhostBundle } from './bundle.ts';

function entries(zipPath: string): Promise<Record<string, Buffer>> {
  return new Promise((resolve, reject) => {
    const out: Record<string, Buffer> = {};
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      zip.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName.endsWith('/')) return zip.readEntry();
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return reject(e);
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c)).on('end', () => { out[entry.fileName] = Buffer.concat(chunks); zip.readEntry(); });
        });
      });
      zip.on('end', () => resolve(out));
      zip.readEntry();
    });
  });
}

describe('buildSelfhostBundle', () => {
  it('packages the site plus README, manifest and checksums deterministically', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bundle-'));
    const site = join(dir, 'site');
    await mkdir(join(site, 'css'), { recursive: true });
    await writeFile(join(site, 'index.html'), '<h1>Hi</h1>');
    await writeFile(join(site, 'css', 'a.css'), 'body{}');
    const meta = { slug: 'demo', version: '1.0.0', title: 'Demo', manifest: { schemaVersion: 1 } };
    const out1 = join(dir, 'b1.zip');
    const out2 = join(dir, 'b2.zip');
    const r1 = await buildSelfhostBundle(site, out1, meta);
    const r2 = await buildSelfhostBundle(site, out2, meta);
    expect(r1.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Fixed mtimes make the bundle content-stable for the same inputs.
    expect(r1.sha256).toBe(r2.sha256);
    const files = await entries(out1);
    expect(Object.keys(files).sort()).toEqual(['CHECKSUMS.txt', 'LICENSE-ASSETS.md', 'README.md', 'site/css/a.css', 'site/index.html', 'template.manifest.json']);
    expect(files['site/index.html']!.toString()).toBe('<h1>Hi</h1>');
    expect(files['CHECKSUMS.txt']!.toString()).toContain('site/index.html');
    expect(JSON.parse(files['template.manifest.json']!.toString())).toEqual({ schemaVersion: 1 });
  });
});
