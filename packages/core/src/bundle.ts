import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, posix, relative, sep } from 'node:path';
import { ZipFile } from 'yazl';

/**
 * Generate a self-host bundle (docs/08 §6) for a static-html template: the served site files under
 * site/, plus README, LICENSE notice, the effective manifest and a checksums file. This is the
 * deliverable the buyer downloads; it is produced from the immutable static_site artifact, never
 * from a live runtime directory. Runtime adapters (Node/Next) add compose/migrations later.
 */
export interface BundleMeta {
  slug: string;
  version: string;
  title: string;
  manifest: unknown;
  /** Third-party asset/license notice text (from the package or a default). */
  licenseNotice?: string;
}

async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? posix.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(root, rel)));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

function readme(meta: BundleMeta): string {
  return [
    `# ${meta.title}`,
    '',
    `Slug: ${meta.slug}`,
    `Version: ${meta.version}`,
    '',
    'Static website bundle from 3T Web Marketplace.',
    '',
    '## Contents',
    '- `site/` — the website files to serve with any static web server.',
    '- `template.manifest.json` — the template manifest.',
    '- `CHECKSUMS.txt` — SHA-256 of every file in `site/`.',
    '- `LICENSE-ASSETS.md` — third-party asset and license notices.',
    '',
    '## Run locally',
    'Serve the `site/` directory with a static server, for example:',
    '',
    '```bash',
    'cd site',
    'python3 -m http.server 8080',
    '```',
    '',
    'Then open http://localhost:8080 . Deploy `site/` to any static host (Nginx, Caddy, a CDN).',
    '',
    'This bundle contains no secrets, database or admin backend.',
    '',
  ].join('\n');
}

/**
 * Write the bundle zip to `outPath`, streaming from `siteDir` (the static_site artifact tree).
 * Returns the bundle's size and sha256.
 */
export async function buildSelfhostBundle(siteDir: string, outPath: string, meta: BundleMeta): Promise<{ size: number; sha256: string }> {
  const files = (await listFiles(siteDir)).sort();
  const zip = new ZipFile();
  const hash = createHash('sha256');
  const checksumLines: string[] = [];
  for (const file of files) {
    const full = join(siteDir, ...file.split('/'));
    // Guard against anything resolving outside the artifact tree.
    const rel = relative(siteDir, full);
    if (rel.startsWith('..') || rel.includes(`..${sep}`)) continue;
    const fileHash = await sha256Of(full);
    checksumLines.push(`${fileHash}  site/${file}`);
    zip.addFile(full, `site/${file}`, { mtime: new Date(0), mode: 0o644 });
  }
  const manifestBuf = Buffer.from(JSON.stringify(meta.manifest, null, 2), 'utf8');
  zip.addBuffer(manifestBuf, 'template.manifest.json', { mtime: new Date(0) });
  zip.addBuffer(Buffer.from(readme(meta), 'utf8'), 'README.md', { mtime: new Date(0) });
  zip.addBuffer(Buffer.from(meta.licenseNotice ?? 'Third-party assets and licenses: see the template documentation.\n', 'utf8'), 'LICENSE-ASSETS.md', { mtime: new Date(0) });
  zip.addBuffer(Buffer.from(checksumLines.join('\n') + '\n', 'utf8'), 'CHECKSUMS.txt', { mtime: new Date(0) });
  zip.end();

  let size = 0;
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(outPath, { flags: 'wx', mode: 0o600 });
    zip.outputStream
      .on('data', (chunk: Buffer) => {
        size += chunk.length;
        hash.update(chunk);
      })
      .on('error', reject)
      .pipe(out)
      .on('error', reject)
      .on('finish', resolve);
  });
  return { size, sha256: hash.digest('hex') };
}

function sha256Of(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => hash.update(c))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

export { stat as statFile };
