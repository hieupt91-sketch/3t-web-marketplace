import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectAdapter } from './detect.ts';
import { scanForSecrets } from './secrets.ts';
import { inspectStaticSite, treeDigest } from './static-site.ts';
import { buildEffectiveManifest, slugFromName } from './effective.ts';
import { validateManifest } from './manifest.ts';

async function tree(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'sdk-detect-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return { root, paths: Object.keys(files) };
}

describe('detectAdapter', () => {
  it('detects plain HTML with high confidence', async () => {
    const { root, paths } = await tree({ 'index.html': '<a href="b.html">', 'b.html': '' });
    const result = await detectAdapter(root, paths);
    expect(result).toMatchObject({ status: 'detected', adapter: 'static-html', projectRoot: '.', confidence: 'high', adapterImplemented: true });
  });

  it('finds a single nested site root with medium confidence', async () => {
    const { root, paths } = await tree({ 'README.md': '', 'site/index.html': '', 'site/details.html': '' });
    expect(await detectAdapter(root, paths)).toMatchObject({ status: 'detected', projectRoot: 'site', confidence: 'medium' });
  });

  it('asks for a root when several are equally plausible', async () => {
    const { root, paths } = await tree({ 'a/index.html': '', 'b/index.html': '' });
    expect(await detectAdapter(root, paths)).toMatchObject({ status: 'needs_configuration', reason: 'project_root_ambiguous', missingFields: ['/projectRoot'] });
  });

  it('does not treat index.html inside a Vite project as deployable output (AT-05)', async () => {
    const { root, paths } = await tree({
      'index.html': '',
      'package.json': JSON.stringify({ scripts: { build: 'vite build' }, devDependencies: { vite: '1' } }),
    });
    const result = await detectAdapter(root, paths);
    expect(result).toMatchObject({ status: 'needs_configuration', adapter: 'vite-static', adapterImplemented: false });
    expect(result.missingFields).toContain('/build/lockfile');
  });

  it('needs configuration for multiple frameworks or lockfiles', async () => {
    const pkg = JSON.stringify({ dependencies: { next: '1', vite: '1' } });
    const multi = await tree({ 'package.json': pkg, 'package-lock.json': '{}' });
    expect(await detectAdapter(multi.root, multi.paths)).toMatchObject({ status: 'needs_configuration', reason: 'multiple_frameworks', adapter: null });
    const locks = await tree({ 'package.json': JSON.stringify({ devDependencies: { vite: '1' } }), 'package-lock.json': '{}', 'yarn.lock': '' });
    expect(await detectAdapter(locks.root, locks.paths)).toMatchObject({ reason: 'multiple_lockfiles' });
  });

  it('reports PHP, Dockerfile-only and image-only packages as unsupported', async () => {
    const php = await tree({ 'index.php': '<?php', 'index.html': '' });
    expect(await detectAdapter(php.root, php.paths)).toMatchObject({ status: 'unsupported', reason: 'framework_unsupported' });
    const docker = await tree({ Dockerfile: 'FROM x' });
    expect(await detectAdapter(docker.root, docker.paths)).toMatchObject({ status: 'unsupported', reason: 'container_recipe_unreviewed' });
    const images = await tree({ 'design.png': '', 'dump.sql': '' });
    expect(await detectAdapter(images.root, images.paths)).toMatchObject({ status: 'unsupported', reason: 'no_executable_entry' });
  });

  it('builds a valid effective manifest for detected static sites', async () => {
    const { root, paths } = await tree({ 'site/index.html': '' });
    const detection = await detectAdapter(root, paths);
    const effective = buildEffectiveManifest(detection, null, { nameHint: 'Mẫu Đẹp 2026' });
    expect(effective.manifest.slug).toBe('mau-dep-2026');
    expect(validateManifest(effective.manifest)).toMatchObject({ ok: true });
    expect(effective.inferred).toContain('/slug');
    const overridden = buildEffectiveManifest(detection, null, { nameHint: 'x' }, { slug: 'custom', version: '1.2.3' });
    expect(overridden.manifest).toMatchObject({ slug: 'custom', version: '1.2.3' });
    expect(overridden.inferred).not.toContain('/slug');
  });

  it('slugifies Vietnamese names', () => {
    expect(slugFromName('Cửa hàng Đà Lạt')).toBe('cua-hang-da-lat');
    expect(slugFromName('123')).toBe('template');
  });
});

describe('scanForSecrets', () => {
  it('flags secret files and patterns without returning values', async () => {
    const { root, paths } = await tree({
      '.env': 'A=1',
      '.env.example': 'A=',
      'id_rsa': 'x',
      'config.js': 'const k = "AKIAABCDEFGHIJKLMNOP";',
      'index.html': 'clean',
    });
    const findings = await scanForSecrets(root, paths.map((path) => ({ path, size: 100 })));
    expect(findings).toEqual(
      expect.arrayContaining([
        { path: '.env', rule: 'dotenv_file' },
        { path: 'id_rsa', rule: 'private_key_file' },
        { path: 'config.js', rule: 'aws_access_key' },
      ]),
    );
    expect(findings.find((f) => f.path === '.env.example')).toBeUndefined();
    expect(JSON.stringify(findings)).not.toContain('AKIA');
  });
});

describe('inspectStaticSite', () => {
  it('finds broken references, denied files and entry assets', async () => {
    const { root, paths } = await tree({
      'index.html': '<link href="style.css"><img src="img/missing.png"><a href="https://x.example">x</a><a href="sub/">s</a>',
      'style.css': 'body{background:url("bg.png")}',
      'sub/index.html': '<a href="../index.html">',
      'tool.exe': '',
    });
    const result = await inspectStaticSite(root, paths, 'index.html');
    expect(result.entryExists).toBe(true);
    expect(result.brokenReferences).toEqual([
      { file: 'index.html', reference: 'img/missing.png' },
      { file: 'style.css', reference: 'bg.png' },
    ]);
    expect(result.deniedFiles).toEqual(['tool.exe']);
    expect(result.entryAssets).toEqual(['style.css', 'sub/index.html']);
  });

  it('computes a content digest independent of file order', async () => {
    const { root } = await tree({ 'a.txt': '1', 'b.txt': '2' });
    const one = await treeDigest(root, ['a.txt', 'b.txt']);
    const two = await treeDigest(root, ['b.txt', 'a.txt']);
    expect(one.digest).toBe(two.digest);
  });
});
