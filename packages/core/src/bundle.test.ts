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

  it('packages a next-standalone runtime tree with compose, Dockerfile and env example', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bundle-rt-'));
    const app = join(dir, 'app');
    await mkdir(app, { recursive: true });
    await writeFile(join(app, 'server.js'), 'console.log("up")');
    await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'shop', dependencies: {} }));
    await writeFile(join(app, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }));
    const meta = {
      slug: 'shop', version: '2.0.0', title: 'Shop',
      manifest: {
        schemaVersion: 1, adapter: 'next-standalone',
        runtime: { start: ['node', 'server.js'], port: 3000 },
        database: { engine: 'postgres', migrate: ['npm run migrate'] },
        env: [{ name: 'SHOP_NAME', scope: 'server', required: true, secret: false, description: 'Shop display name', defaultValue: 'My shop' }],
      },
    };
    const out = join(dir, 'b.zip');
    const r = await buildSelfhostBundle(app, out, meta);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    const files = await entries(out);
    expect(Object.keys(files).sort()).toEqual(['.env.example', 'CHECKSUMS.txt', 'Dockerfile', 'LICENSE-ASSETS.md', 'README.md', 'app/package-lock.json', 'app/package.json', 'app/server.js', 'docker-compose.yml', 'template.manifest.json']);
    expect(files['Dockerfile']!.toString()).toContain('npm ci --omit=dev');
    expect(files['Dockerfile']!.toString()).toContain('CMD ["node","server.js"]');
    expect(files['docker-compose.yml']!.toString()).toContain('db:');
    expect(files['docker-compose.yml']!.toString()).toContain('3000:3000');
    expect(files['.env.example']!.toString()).toContain('DATABASE_URL=postgres://app:app@db:5432/appdb');
    expect(files['.env.example']!.toString()).toContain('SHOP_NAME=My shop');
    expect(files['README.md']!.toString()).toContain('docker compose up -d --build');
    expect(files['README.md']!.toString()).toContain('docker compose exec web npm run migrate');
    expect(files['CHECKSUMS.txt']!.toString()).toContain('app/server.js');
  });

  it('packages a node-http runtime tree with a sqlite volume and no db service', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bundle-sqlite-'));
    const app = join(dir, 'app');
    await mkdir(join(app, 'data'), { recursive: true });
    await writeFile(join(app, 'server.js'), 'console.log("up")');
    const meta = {
      slug: 'blog', version: '1.0.0', title: 'Blog',
      manifest: {
        schemaVersion: 1, adapter: 'node-http',
        runtime: { entry: 'server.js' },
        database: { engine: 'sqlite', fileName: 'data/app.db' },
        env: [],
      },
    };
    const out = join(dir, 'b.zip');
    await buildSelfhostBundle(app, out, meta);
    const files = await entries(out);
    expect(files['docker-compose.yml']!.toString()).not.toContain('db:');
    expect(files['docker-compose.yml']!.toString()).toContain('appdata:/app/data');
    expect(files['Dockerfile']!.toString()).not.toContain('RUN ');
    expect(files['README.md']!.toString()).toContain('Docker volume');
  });
});
