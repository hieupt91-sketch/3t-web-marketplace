import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import yauzl from 'yauzl';
import { buildCleanSiteTree, buildSelfhostBundle, toCleanVariantText } from './bundle.ts';

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

describe('toCleanVariantText', () => {
  it('replaces the demo phone with the right placeholder per language and strips markers', () => {
    const input = '<p data-vi="0967 136 099 (số demo)" data-en="0967 136 099 (demo number)">0967 136 099 (số demo)</p>';
    expect(toCleanVariantText(input)).toBe('<p data-vi="Số điện thoại của bạn" data-en="Your phone number">Số điện thoại của bạn</p>');
  });

  it('replaces bare digits (comments, README prose) with the Vietnamese placeholder', () => {
    expect(toCleanVariantText('Liên hệ demo: 0967 136 099, Zalo: 0967136099.')).toBe('Liên hệ demo: Số điện thoại của bạn, Zalo: Số điện thoại của bạn.');
  });

  it('removes stale 3T demo-warning sentences in both languages', () => {
    const vi = 'Giữ nguyên. Riêng số demo 0967 136 099 là số demo của 3T: nếu quên thay, khách sẽ gọi nhầm. Hết.';
    expect(toCleanVariantText(vi)).toBe('Giữ nguyên. Hết.');
    const en = 'Keep this. The demo number 0967 136 099 belongs to 3T: replace it before publishing. Done.';
    expect(toCleanVariantText(en)).toBe('Keep this. Done.');
  });

  it('rewrites the CONFIG comment parenthetical as a fill-in instruction', () => {
    const input = '- Điện thoại demo: 0967 136 099 (số demo của 3T — người mua thay bằng số thật trước khi đăng)';
    expect(toCleanVariantText(input)).toBe('- Điện thoại demo: Số điện thoại của bạn (thay bằng số thật trước khi đăng)');
  });

  it('leaves text without the demo phone untouched', () => {
    const input = '<p data-vi="0900 xxx xxx (số mẫu)" data-en="0900 xxx xxx (sample)">0900 xxx xxx (số mẫu)</p>';
    expect(toCleanVariantText(input)).toBe(input);
  });

  it('buildCleanSiteTree transforms html/md and copies the rest byte-for-byte', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bundle-clean-'));
    const src = join(dir, 'src');
    const dest = join(dir, 'dest');
    await mkdir(src, { recursive: true });
    await writeFile(join(src, 'index.html'), '<p data-vi="0967 136 099 (số demo)" data-en="0967 136 099 (demo number)">x</p>');
    await writeFile(join(src, 'styles.css'), 'body{color:red}');
    await buildCleanSiteTree(src, dest);
    expect(await readFile(join(dest, 'index.html'), 'utf8')).toBe('<p data-vi="Số điện thoại của bạn" data-en="Your phone number">x</p>');
    expect(await readFile(join(dest, 'styles.css'), 'utf8')).toBe('body{color:red}');
  });
});
