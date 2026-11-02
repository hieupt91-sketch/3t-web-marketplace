import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';

/** Files a static site may not distribute to visitors (docs/03 §6: executables outside the preset). */
const DENIED_STATIC_EXTENSIONS = /\.(exe|dll|so|dylib|bat|cmd|ps1|sh|msi|com|scr|jar|apk|dmg|app|php|cgi|pl|py)$/i;

export interface StaticInspection {
  entryExists: boolean;
  /** Local href/src references that do not resolve to a file in the site root. */
  brokenReferences: { file: string; reference: string }[];
  deniedFiles: string[];
  htmlFiles: string[];
  /** Assets referenced directly by the entry page, used by the smoke test. */
  entryAssets: string[];
}

const REFERENCE = /\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"']*))\s*\)/gi;

function localTarget(fromFile: string, reference: string): string | null {
  const ref = reference.trim();
  if (ref === '' || ref.startsWith('#') || ref.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(ref)) return null;
  const withoutQuery = ref.split(/[?#]/)[0] ?? '';
  if (withoutQuery === '') return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutQuery);
  } catch {
    decoded = withoutQuery;
  }
  const base = decoded.startsWith('/') ? decoded.slice(1) : posix.join(posix.dirname(fromFile), decoded);
  const normalized = posix.normalize(base);
  if (normalized.startsWith('..')) return `..escape:${decoded}`;
  return normalized.endsWith('/') || normalized === '.' ? posix.join(normalized, 'index.html') : normalized;
}

/** Inspect a static site directory. `files` are paths relative to the site root. */
export async function inspectStaticSite(siteRoot: string, files: string[], entry: string): Promise<StaticInspection> {
  const fileSet = new Set(files);
  const htmlFiles = files.filter((f) => /\.html?$/i.test(f));
  const cssFiles = files.filter((f) => /\.css$/i.test(f));
  const broken: StaticInspection['brokenReferences'] = [];
  const entryAssets = new Set<string>();

  const check = (file: string, reference: string, target: string | null) => {
    if (target === null) return;
    const exists = !target.startsWith('..escape:') && (fileSet.has(target) || fileSet.has(posix.join(target, 'index.html')));
    if (!exists) broken.push({ file, reference });
    else if (file === entry) entryAssets.add(fileSet.has(target) ? target : posix.join(target, 'index.html'));
  };

  for (const file of htmlFiles) {
    const text = await readFile(join(siteRoot, ...file.split('/')), 'utf8');
    for (const match of text.matchAll(REFERENCE)) {
      const reference = match[1] ?? match[2] ?? '';
      check(file, reference, localTarget(file, reference));
    }
  }
  for (const file of cssFiles) {
    const text = await readFile(join(siteRoot, ...file.split('/')), 'utf8');
    for (const match of text.matchAll(CSS_URL)) {
      const reference = match[1] ?? match[2] ?? match[3] ?? '';
      if (reference.startsWith('data:')) continue;
      check(file, reference, localTarget(file, reference));
    }
  }
  return {
    entryExists: fileSet.has(entry),
    brokenReferences: broken,
    deniedFiles: files.filter((f) => DENIED_STATIC_EXTENSIONS.test(f)),
    htmlFiles,
    entryAssets: [...entryAssets].sort(),
  };
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Content digest of a file tree: sha256 over sorted "path\0sha256\n" lines.
 * Independent of ZIP metadata, so re-zipping identical content yields the same digest.
 */
export async function treeDigest(root: string, files: string[]): Promise<{ digest: string; fileDigests: Record<string, string> }> {
  const fileDigests: Record<string, string> = {};
  const hash = createHash('sha256');
  for (const file of [...files].sort()) {
    const digest = await sha256File(join(root, ...file.split('/')));
    fileDigests[file] = digest;
    hash.update(`${file}\0${digest}\n`);
  }
  return { digest: hash.digest('hex'), fileDigests };
}
