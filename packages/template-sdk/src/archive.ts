import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createGunzip } from 'node:zlib';
import yauzl from 'yauzl';
import { collisionKey, normalizeEntryPath } from './paths.ts';

export interface ArchiveLimits {
  /** Maximum total bytes after extraction (docs/01 §5 default 500 MiB). */
  maxTotalUncompressedBytes: number;
  maxEntryBytes: number;
  maxFiles: number;
  /** Compression ratio above which large entries are treated as a bomb. */
  maxCompressionRatio: number;
  /** Ratio check only applies to entries at least this large. */
  ratioCheckMinBytes: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxTotalUncompressedBytes: 500 * 1024 * 1024,
  maxEntryBytes: 100 * 1024 * 1024,
  maxFiles: 20_000,
  maxCompressionRatio: 200,
  ratioCheckMinBytes: 1024 * 1024,
};

export type ArchiveErrorCode = 'archive_unsafe' | 'archive_too_large' | 'archive_invalid';

export interface ArchiveIssue {
  code: ArchiveErrorCode;
  /** Machine-readable reason, e.g. parent_segment, symlink, encrypted. */
  reason: string;
  /** Raw entry name as stored in the archive (never a host path). */
  entry?: string;
}

export class ArchiveError extends Error {
  constructor(
    public readonly code: ArchiveErrorCode,
    public readonly issues: ArchiveIssue[],
  ) {
    super(`${code}: ${issues.map((i) => `${i.reason}${i.entry ? ` (${i.entry})` : ''}`).join(', ')}`);
  }
}

export interface ArchiveFile {
  /** Path relative to the project workspace after wrapper stripping. */
  path: string;
  size: number;
}

export interface ArchiveInspection {
  files: ArchiveFile[];
  totalUncompressedBytes: number;
  strippedPrefix: string | null;
  /** Entries kept in the source archive but excluded from the build workspace. */
  excluded: { path: string; reason: 'os_metadata' | 'git_history' }[];
}

interface PlannedEntry {
  rawName: string;
  path: string;
  isDirectory: boolean;
  size: number;
}

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    // decodeStrings:false so hostile names reach our own validator instead of a generic yauzl error.
    yauzl.open(file, { lazyEntries: true, autoClose: false, decodeStrings: false, validateEntrySizes: true }, (err, zip) => {
      if (err || !zip) reject(new ArchiveError('archive_invalid', [{ code: 'archive_invalid', reason: 'unreadable_zip' }]));
      else resolve(zip);
    });
  });
}

function readEntries(zip: yauzl.ZipFile, limits: ArchiveLimits): Promise<yauzl.Entry[]> {
  return new Promise((resolve, reject) => {
    const entries: yauzl.Entry[] = [];
    zip.on('entry', (entry: yauzl.Entry) => {
      entries.push(entry);
      if (entries.length > limits.maxFiles + 1000) {
        reject(new ArchiveError('archive_too_large', [{ code: 'archive_too_large', reason: 'too_many_entries' }]));
        return;
      }
      zip.readEntry();
    });
    zip.on('end', () => resolve(entries));
    zip.on('error', () => reject(new ArchiveError('archive_invalid', [{ code: 'archive_invalid', reason: 'corrupt_central_directory' }])));
    zip.readEntry();
  });
}

/** Names are UTF-8 when general purpose bit 11 is set; otherwise treat as latin1 (CP437 approximation). */
function entryName(entry: yauzl.Entry): string {
  const raw = entry.fileName as unknown as Buffer | string;
  if (typeof raw === 'string') return raw;
  return raw.toString((entry.generalPurposeBitFlag & 0x800) !== 0 ? 'utf8' : 'latin1');
}

function isExcluded(path: string): 'os_metadata' | 'git_history' | null {
  const segments = path.split('/');
  if (segments[0] === '__MACOSX' || segments.includes('.DS_Store') || segments.includes('Thumbs.db')) return 'os_metadata';
  if (segments.includes('.git')) return 'git_history';
  return null;
}

/**
 * Validate every entry from the central directory before writing anything (AT-03).
 * Throws ArchiveError listing all problems found.
 */
function plan(entries: yauzl.Entry[], limits: ArchiveLimits): { planned: PlannedEntry[]; total: number } {
  const issues: ArchiveIssue[] = [];
  const planned: PlannedEntry[] = [];
  const seen = new Map<string, string>();
  let total = 0;
  let files = 0;

  for (const entry of entries) {
    const rawName = entryName(entry);
    const normalized = normalizeEntryPath(rawName);
    if (!normalized.ok) {
      issues.push({ code: 'archive_unsafe', reason: normalized.reason, entry: rawName });
      continue;
    }
    const mode = (entry.externalFileAttributes >>> 16) & S_IFMT;
    const isDirectory = normalized.isDirectory || mode === S_IFDIR;
    if (mode === S_IFLNK) {
      issues.push({ code: 'archive_unsafe', reason: 'symlink', entry: rawName });
      continue;
    }
    if (mode !== 0 && mode !== S_IFREG && mode !== S_IFDIR) {
      issues.push({ code: 'archive_unsafe', reason: 'special_file', entry: rawName });
      continue;
    }
    if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
      issues.push({ code: 'archive_unsafe', reason: 'encrypted_entry', entry: rawName });
      continue;
    }
    const key = collisionKey(normalized.path);
    const previous = seen.get(key);
    if (previous !== undefined) {
      // Directories may legitimately repeat; files colliding with anything do not.
      if (!(isDirectory && previous === 'dir')) {
        issues.push({ code: 'archive_unsafe', reason: 'name_collision', entry: rawName });
        continue;
      }
    }
    seen.set(key, isDirectory ? 'dir' : 'file');
    if (!isDirectory) {
      files += 1;
      const size = entry.uncompressedSize;
      if (size > limits.maxEntryBytes) issues.push({ code: 'archive_too_large', reason: 'entry_too_large', entry: rawName });
      if (
        size >= limits.ratioCheckMinBytes &&
        (entry.compressedSize === 0 || size / entry.compressedSize > limits.maxCompressionRatio)
      ) {
        issues.push({ code: 'archive_unsafe', reason: 'compression_ratio', entry: rawName });
      }
      total += size;
    }
    planned.push({ rawName, path: normalized.path, isDirectory, size: isDirectory ? 0 : entry.uncompressedSize });
  }

  // A file and a directory prefix with the same name (a vs a/b) collide on disk.
  for (const item of planned) {
    const parts = item.path.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (seen.get(collisionKey(parts.slice(0, i).join('/'))) === 'file') {
        issues.push({ code: 'archive_unsafe', reason: 'name_collision', entry: item.rawName });
        break;
      }
    }
  }
  if (files > limits.maxFiles) issues.push({ code: 'archive_too_large', reason: 'too_many_files' });
  if (total > limits.maxTotalUncompressedBytes) issues.push({ code: 'archive_too_large', reason: 'total_size' });
  if (files === 0) issues.push({ code: 'archive_invalid', reason: 'empty_archive' });

  if (issues.length) {
    const code = issues.some((i) => i.code === 'archive_unsafe')
      ? 'archive_unsafe'
      : issues.some((i) => i.code === 'archive_too_large')
        ? 'archive_too_large'
        : 'archive_invalid';
    throw new ArchiveError(code, issues);
  }
  return { planned, total };
}

/** One outer directory is stripped once when it is the only top-level item (docs/03 §3). */
function wrapperPrefix(planned: PlannedEntry[]): string | null {
  const relevant = planned.filter((p) => isExcluded(p.path) === null);
  const tops = new Set(relevant.map((p) => p.path.split('/')[0]));
  if (tops.size !== 1) return null;
  const [top] = [...tops] as [string];
  const hasRootFile = relevant.some((p) => p.path === top && !p.isDirectory);
  return hasRootFile ? null : `${top}/`;
}

function byteLimiter(limit: number, onExceeded: () => Error): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, callback) {
      seen += chunk.length;
      if (seen > limit) callback(onExceeded());
      else callback(null, chunk);
    },
  });
}

/**
 * Inspect then extract a ZIP into `destination` (which must exist and be empty).
 * Byte counts are enforced while streaming, independent of header values.
 */
export async function extractArchive(
  zipPath: string,
  destination: string,
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): Promise<ArchiveInspection> {
  const zip = await openZip(zipPath);
  try {
    const entries = await readEntries(zip, limits);
    const { planned, total } = plan(entries, limits);
    const prefix = wrapperPrefix(planned);
    const root = await realpath(destination);
    const byRaw = new Map(entries.map((e) => [entryName(e), e]));
    const files: ArchiveFile[] = [];
    const excluded: ArchiveInspection['excluded'] = [];
    let written = 0;

    for (const item of planned) {
      const relPath = prefix && item.path.startsWith(prefix) ? item.path.slice(prefix.length) : item.path;
      if (relPath === '' || (prefix && `${item.path}/` === prefix)) continue;
      const exclusion = isExcluded(relPath);
      if (exclusion) {
        if (!item.isDirectory) excluded.push({ path: relPath, reason: exclusion });
        continue;
      }
      const target = join(root, ...relPath.split('/'));
      const rel = relative(root, target);
      if (rel.startsWith('..') || rel.includes(`..${sep}`)) {
        throw new ArchiveError('archive_unsafe', [{ code: 'archive_unsafe', reason: 'path_escape', entry: item.rawName }]);
      }
      if (item.isDirectory) {
        await mkdir(target, { recursive: true });
        continue;
      }
      await mkdir(dirname(target), { recursive: true });
      const parentReal = await realpath(dirname(target));
      if (parentReal !== root && !parentReal.startsWith(root + sep)) {
        throw new ArchiveError('archive_unsafe', [{ code: 'archive_unsafe', reason: 'path_escape', entry: item.rawName }]);
      }
      const entry = byRaw.get(item.rawName);
      if (!entry) throw new ArchiveError('archive_invalid', [{ code: 'archive_invalid', reason: 'entry_missing', entry: item.rawName }]);
      const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) =>
        zip.openReadStream(entry, (err, s) => (err || !s ? reject(err ?? new Error('no stream')) : resolve(s))),
      );
      const remaining = limits.maxTotalUncompressedBytes - written;
      const tooLarge = () =>
        new ArchiveError('archive_too_large', [{ code: 'archive_too_large', reason: 'stream_exceeded', entry: item.rawName }]);
      try {
        await pipeline(
          stream,
          byteLimiter(Math.min(limits.maxEntryBytes, remaining), tooLarge),
          createWriteStream(target, { flags: 'wx', mode: 0o644 }),
        );
      } catch (error) {
        if (error instanceof ArchiveError) throw error;
        throw new ArchiveError('archive_invalid', [{ code: 'archive_invalid', reason: 'entry_corrupt', entry: item.rawName }]);
      }
      written += item.size;
      files.push({ path: relPath, size: item.size });
    }
    files.sort((a, b) => (a.path < b.path ? -1 : 1));
    return { files, totalUncompressedBytes: total, strippedPrefix: prefix, excluded };
  } finally {
    zip.close();
  }
}

/* ------------------------------------------------------------------ *
 * Gzipped tar extraction with the same guarantees as extractArchive.
 * The GitHub template import used to shell out to the system tar
 * (audit code H-03): tar follows symlinks, honours ../ segments and
 * device entries. This extractor is fully in-process and mirrors the
 * zip discipline — plan first (validate every name and type, enforce
 * limits), then write with realpath containment.
 * ------------------------------------------------------------------ */

interface TarPlanned extends PlannedEntry {
  dataOffset: number;
}

function tarInvalid(reason: string): ArchiveError {
  return new ArchiveError('archive_invalid', [{ code: 'archive_invalid', reason }]);
}

function tarCString(block: Buffer, start: number, end: number): string {
  let stop = start;
  while (stop < end && block[stop] !== 0) stop++;
  return block.toString('utf8', start, stop);
}

function tarNumber(block: Buffer, start: number, end: number): number {
  // GNU base-256 (binary) encoding when the high bit of the first byte is set.
  if ((block[start]! & 0x80) !== 0) {
    let value = block[start]! & 0x7f;
    for (let i = start + 1; i < end; i++) value = value * 256 + block[i]!;
    return value;
  }
  const text = block.toString('latin1', start, end).replace(/[\0 ]+$/, '').trim();
  if (text === '') return 0;
  const value = parseInt(text, 8);
  if (Number.isNaN(value) || value < 0) throw tarInvalid('corrupt_header');
  return value;
}

function tarChecksumOk(block: Buffer): boolean {
  let stored: number;
  try {
    stored = tarNumber(block, 148, 156);
  } catch {
    return false;
  }
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < 512; i++) {
    const b = i >= 148 && i < 156 ? 0x20 : block[i]!;
    unsigned += b;
    signed += b > 127 ? b - 256 : b;
  }
  return stored === unsigned || stored === signed;
}

/** Extract the `path` override from a pax extended header payload. */
function paxPath(data: Buffer): string | null {
  const text = data.toString('utf8');
  let path: string | null = null;
  let i = 0;
  while (i < text.length) {
    const sp = text.indexOf(' ', i);
    if (sp === -1) break;
    const len = parseInt(text.slice(i, sp), 10);
    if (!Number.isFinite(len) || len <= 0 || i + len > text.length + 1) break;
    const record = text.slice(sp + 1, i + len - 1);
    const eq = record.indexOf('=');
    if (eq > 0 && record.slice(0, eq) === 'path') path = record.slice(eq + 1);
    i += len;
  }
  return path;
}

interface RawTarEntry {
  name: string;
  size: number;
  type: string;
  dataOffset: number;
}

function parseTar(buf: Buffer): RawTarEntry[] {
  const entries: RawTarEntry[] = [];
  let offset = 0;
  let pendingName: string | null = null;
  while (offset + 512 <= buf.length) {
    const block = buf.subarray(offset, offset + 512);
    if (block.every((b) => b === 0)) break; // end-of-archive marker
    if (!tarChecksumOk(block)) throw tarInvalid('corrupt_header');
    const size = tarNumber(block, 124, 136);
    const type = String.fromCharCode(block[156]!);
    const dataOffset = offset + 512;
    if (dataOffset + size > buf.length) throw tarInvalid('truncated_entry');
    const data = buf.subarray(dataOffset, dataOffset + size);
    if (type === 'L') {
      // GNU long name for the next entry.
      pendingName = data.toString('utf8').replace(/\0+$/, '');
    } else if (type === 'x') {
      // pax per-file header: only the path override is honoured.
      pendingName = paxPath(data) ?? pendingName;
    } else if (type === 'g' || type === 'K') {
      // Global pax headers and long link names carry nothing this
      // extractor honours (links are rejected below regardless).
    } else {
      let name = tarCString(block, 0, 100);
      const prefix = tarCString(block, 345, 500);
      if (prefix) name = `${prefix}/${name}`;
      entries.push({ name: pendingName ?? name, size, type, dataOffset });
      pendingName = null;
    }
    offset = dataOffset + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function planTar(entries: RawTarEntry[], limits: ArchiveLimits): { planned: TarPlanned[]; total: number } {
  const issues: ArchiveIssue[] = [];
  const planned: TarPlanned[] = [];
  const seen = new Map<string, string>();
  let total = 0;
  let files = 0;

  for (const entry of entries) {
    const normalized = normalizeEntryPath(entry.name);
    if (!normalized.ok) {
      issues.push({ code: 'archive_unsafe', reason: normalized.reason, entry: entry.name });
      continue;
    }
    const isDirectory = normalized.isDirectory || entry.type === '5';
    if (entry.type === '1' || entry.type === '2') {
      issues.push({ code: 'archive_unsafe', reason: 'symlink', entry: entry.name });
      continue;
    }
    if (!isDirectory && entry.type !== '0' && entry.type !== '\0') {
      issues.push({ code: 'archive_unsafe', reason: 'special_file', entry: entry.name });
      continue;
    }
    const key = collisionKey(normalized.path);
    const prior = seen.get(key);
    if (prior !== undefined && prior !== (isDirectory ? 'dir' : 'file')) {
      issues.push({ code: 'archive_unsafe', reason: 'name_collision', entry: entry.name });
      continue;
    }
    seen.set(key, isDirectory ? 'dir' : 'file');
    if (!isDirectory) {
      const size = entry.size;
      files += 1;
      if (size > limits.maxEntryBytes) {
        issues.push({ code: 'archive_too_large', reason: 'entry_size', entry: entry.name });
        continue;
      }
      total += size;
    }
    planned.push({ rawName: entry.name, path: normalized.path, isDirectory, size: isDirectory ? 0 : entry.size, dataOffset: entry.dataOffset });
  }

  for (const item of planned) {
    const parts = item.path.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (seen.get(collisionKey(parts.slice(0, i).join('/'))) === 'file') {
        issues.push({ code: 'archive_unsafe', reason: 'name_collision', entry: item.rawName });
        break;
      }
    }
  }
  if (files > limits.maxFiles) issues.push({ code: 'archive_too_large', reason: 'too_many_files' });
  if (total > limits.maxTotalUncompressedBytes) issues.push({ code: 'archive_too_large', reason: 'total_size' });
  if (files === 0) issues.push({ code: 'archive_invalid', reason: 'empty_archive' });

  if (issues.length) {
    const code = issues.some((i) => i.code === 'archive_unsafe')
      ? 'archive_unsafe'
      : issues.some((i) => i.code === 'archive_too_large')
        ? 'archive_too_large'
        : 'archive_invalid';
    throw new ArchiveError(code, issues);
  }
  return { planned, total };
}

/**
 * Extract a gzipped tar (e.g. a GitHub repo tarball) into `destination`
 * (which must exist) under exactly the rules extractArchive enforces
 * for zips. The decompressed bytes are capped while gunzipping — header
 * blocks and padding allowance included — so a bomb cannot expand
 * unboundedly before the planner sees it.
 */
export async function extractTarArchive(
  tarPath: string,
  destination: string,
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): Promise<ArchiveInspection> {
  const decompressCap = limits.maxTotalUncompressedBytes + limits.maxFiles * 1024 + 1024 * 1024;
  const chunks: Buffer[] = [];
  let buffered = 0;
  const collector = new Transform({
    transform(chunk: Buffer, _enc, callback) {
      buffered += chunk.length;
      if (buffered > decompressCap) {
        callback(new ArchiveError('archive_too_large', [{ code: 'archive_too_large', reason: 'total_size' }]));
        return;
      }
      chunks.push(chunk);
      callback();
    },
  });
  try {
    await pipeline(createReadStream(tarPath), createGunzip(), collector);
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw tarInvalid('unreadable_tar');
  }
  const buf = Buffer.concat(chunks);
  const entries = parseTar(buf);
  const { planned, total } = planTar(entries, limits);
  const prefix = wrapperPrefix(planned);
  const root = await realpath(destination);
  const files: ArchiveFile[] = [];
  const excluded: ArchiveInspection['excluded'] = [];

  for (const item of planned) {
    const relPath = prefix && item.path.startsWith(prefix) ? item.path.slice(prefix.length) : item.path;
    if (relPath === '' || (prefix && `${item.path}/` === prefix)) continue;
    const excludedReason = isExcluded(relPath);
    if (excludedReason) {
      if (!item.isDirectory) excluded.push({ path: relPath, reason: excludedReason });
      continue;
    }
    const target = join(root, relPath);
    if (item.isDirectory) {
      await mkdir(target, { recursive: true });
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    const parentReal = await realpath(dirname(target));
    if (parentReal !== root && !parentReal.startsWith(root + sep)) {
      throw new ArchiveError('archive_unsafe', [{ code: 'archive_unsafe', reason: 'path_escape', entry: item.rawName }]);
    }
    await writeFile(target, buf.subarray(item.dataOffset, item.dataOffset + item.size), { flag: 'wx', mode: 0o644 });
    files.push({ path: relPath, size: item.size });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { files, totalUncompressedBytes: total, strippedPrefix: prefix, excluded };
}
