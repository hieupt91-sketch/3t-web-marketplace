import { mkdtemp, readdir, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArchiveError, DEFAULT_ARCHIVE_LIMITS, extractArchive } from './archive.ts';
import { buildZip, type RawZipEntry } from './testing/zip-writer.ts';

async function setup(entries: RawZipEntry[]) {
  const dir = await mkdtemp(join(tmpdir(), 'sdk-archive-'));
  const zip = join(dir, 'in.zip');
  await writeFile(zip, buildZip(entries));
  const out = join(dir, 'out');
  await mkdir(out);
  return { dir, zip, out };
}

async function rejection(entries: RawZipEntry[], limits = DEFAULT_ARCHIVE_LIMITS) {
  const { zip, out, dir } = await setup(entries);
  const error = await extractArchive(zip, out, limits).then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ArchiveError);
  // AT-03: nothing written when the central directory is rejected.
  expect(await readdir(out)).toEqual([]);
  expect(existsSync(join(dir, 'escape.txt'))).toBe(false);
  return error as ArchiveError;
}

describe('extractArchive', () => {
  it('extracts a valid archive and strips a single wrapper directory once', async () => {
    const { zip, out } = await setup([
      { name: 'landing/' },
      { name: 'landing/index.html', data: '<h1>x</h1>' },
      { name: 'landing/css/a.css', data: 'body{}', deflate: true },
      { name: '__MACOSX/landing/._index.html', data: 'junk' },
      { name: 'landing/.DS_Store', data: 'junk' },
    ]);
    const result = await extractArchive(zip, out);
    expect(result.strippedPrefix).toBe('landing/');
    expect(result.files.map((f) => f.path)).toEqual(['css/a.css', 'index.html']);
    expect(result.excluded.map((e) => e.reason)).toEqual(['os_metadata', 'os_metadata']);
    expect(existsSync(join(out, 'index.html'))).toBe(true);
  });

  it('excludes .git history from the workspace', async () => {
    const { zip, out } = await setup([
      { name: 'index.html', data: 'x' },
      { name: '.git/config', data: '[core]' },
    ]);
    const result = await extractArchive(zip, out);
    expect(result.files.map((f) => f.path)).toEqual(['index.html']);
    expect(result.excluded).toEqual([{ path: '.git/config', reason: 'git_history' }]);
  });

  it.each([
    ['../escape.txt', 'parent_segment'],
    ['a/../../escape.txt', 'parent_segment'],
    ['/etc/passwd', 'absolute'],
    ['C:\\Windows\\x.txt', 'drive_letter'],
    ['..\\escape.txt', 'parent_segment'],
    ['a/\u0000b', 'control_character'],
  ])('rejects unsafe path %s', async (name, reason) => {
    const error = await rejection([{ name: 'index.html', data: 'ok' }, { name, data: 'bad' }]);
    expect(error.code).toBe('archive_unsafe');
    expect(error.issues.map((i) => i.reason)).toContain(reason);
  });

  it('rejects symlinks, encrypted and special entries', async () => {
    const error = await rejection([
      { name: 'index.html', data: 'ok' },
      { name: 'link', data: '/etc/passwd', mode: 0o120777 },
      { name: 'secret.bin', data: 'x', encrypted: true },
      { name: 'fifo', data: '', mode: 0o010644 },
    ]);
    expect(error.issues.map((i) => i.reason).sort()).toEqual(['encrypted_entry', 'special_file', 'symlink']);
  });

  it('rejects names that collide after normalisation', async () => {
    const error = await rejection([
      { name: 'Index.html', data: 'a' },
      { name: 'index.html', data: 'b' },
    ]);
    expect(error.issues[0]?.reason).toBe('name_collision');
    const nfc = await rejection([
      { name: 'caf\u00e9.html', data: 'a' },
      { name: 'cafe\u0301.html', data: 'b' },
    ]);
    expect(nfc.issues[0]?.reason).toBe('name_collision');
    const fileVsDir = await rejection([
      { name: 'a', data: 'a' },
      { name: 'a/b.html', data: 'b' },
    ]);
    expect(fileVsDir.issues[0]?.reason).toBe('name_collision');
  });

  it('rejects compression bombs by ratio', async () => {
    const error = await rejection([{ name: 'bomb.txt', data: Buffer.alloc(4 * 1024 * 1024), deflate: true }]);
    expect(error.issues.map((i) => i.reason)).toContain('compression_ratio');
  });

  it('enforces totals and file counts after extraction size, not upload size', async () => {
    const limits = { ...DEFAULT_ARCHIVE_LIMITS, maxTotalUncompressedBytes: 10, maxFiles: 2 };
    const error = await rejection(
      [
        { name: 'a.html', data: '123456' },
        { name: 'b.html', data: '123456' },
        { name: 'c.html', data: '1' },
      ],
      limits,
    );
    expect(error.code).toBe('archive_too_large');
    expect(error.issues.map((i) => i.reason).sort()).toEqual(['too_many_files', 'total_size']);
  });

  it('fails when the stream is larger than the declared size', async () => {
    const { zip, out } = await setup([{ name: 'index.html', data: 'x'.repeat(100), declaredSize: 5, deflate: true }]);
    await expect(extractArchive(zip, out)).rejects.toBeInstanceOf(ArchiveError);
  });

  it('rejects garbage input as archive_invalid', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sdk-archive-'));
    await writeFile(join(dir, 'x.zip'), 'not a zip');
    await mkdir(join(dir, 'out'));
    await expect(extractArchive(join(dir, 'x.zip'), join(dir, 'out'))).rejects.toMatchObject({ code: 'archive_invalid' });
  });
});

/* ------------------------- tar.gz extraction ------------------------ */

import { gzipSync } from 'node:zlib';
import { extractTarArchive } from './archive.ts';

function tarHeader(name: string, size: number, type: string): Buffer {
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100, 8, 'latin1');
  h.write('0000000\0', 108, 8, 'latin1');
  h.write('0000000\0', 116, 8, 'latin1');
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'latin1');
  h.write('00000000000\0', 136, 12, 'latin1');
  h.write('        ', 148, 8, 'latin1'); // checksum placeholder (spaces)
  h.write(type, 156, 1, 'latin1');
  h.write('ustar\0', 257, 6, 'latin1');
  h.write('00', 263, 2, 'latin1');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'latin1');
  return h;
}

function tarEntry(name: string, data: string | Buffer = '', type = '0'): Buffer {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512, 0);
  body.copy(padded);
  return Buffer.concat([tarHeader(name, body.length, type), padded]);
}

function buildTarGz(parts: Buffer[]): Buffer {
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024, 0)]));
}

async function tarSetup(parts: Buffer[]) {
  const dir = await mkdtemp(join(tmpdir(), 'sdk-tar-'));
  const tgz = join(dir, 'in.tgz');
  await writeFile(tgz, buildTarGz(parts));
  const out = join(dir, 'out');
  await mkdir(out);
  return { dir, tgz, out };
}

describe('extractTarArchive', () => {
  it('extracts a GitHub-shaped tarball and strips the wrapper directory', async () => {
    const { tgz, out } = await tarSetup([
      tarEntry('owner-repo-abc123/', '', '5'),
      tarEntry('owner-repo-abc123/index.html', '<h1>x</h1>'),
      tarEntry('owner-repo-abc123/css/a.css', 'body{}'),
    ]);
    const result = await extractTarArchive(tgz, out);
    expect(result.strippedPrefix).toBe('owner-repo-abc123/');
    expect(result.files.map((f) => f.path)).toEqual(['css/a.css', 'index.html']);
    const { readFile } = await import('node:fs/promises');
    await expect(readFile(join(out, 'index.html'), 'utf8')).resolves.toBe('<h1>x</h1>');
  });

  it('rejects a parent-escaping entry and writes nothing (audit H-03)', async () => {
    const { dir, tgz, out } = await tarSetup([
      tarEntry('repo/index.html', 'ok'),
      tarEntry('repo/../escape.txt', 'pwned'),
    ]);
    const error = await extractTarArchive(tgz, out).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(ArchiveError);
    expect((error as ArchiveError).code).toBe('archive_unsafe');
    expect(await readdir(out)).toEqual([]);
    expect(existsSync(join(dir, 'escape.txt'))).toBe(false);
  });

  it('rejects absolute paths and symlink entries', async () => {
    const abs = await tarSetup([tarEntry('/etc/passwd', 'x')]);
    const absErr = await extractTarArchive(abs.tgz, abs.out).then(() => null, (e: unknown) => e);
    expect(absErr).toBeInstanceOf(ArchiveError);
    expect((absErr as ArchiveError).code).toBe('archive_unsafe');

    const link = await tarSetup([
      tarEntry('repo/index.html', 'ok'),
      tarEntry('repo/link', '/etc/passwd', '2'),
    ]);
    const linkErr = await extractTarArchive(link.tgz, link.out).then(() => null, (e: unknown) => e);
    expect(linkErr).toBeInstanceOf(ArchiveError);
    expect((linkErr as ArchiveError).code).toBe('archive_unsafe');
    expect(await readdir(link.out)).toEqual([]);
  });

  it('rejects an entry over the per-entry limit and a tarball over the total limit', async () => {
    const big = await tarSetup([tarEntry('repo/big.bin', Buffer.alloc(2048, 1))]);
    const err = await extractTarArchive(big.tgz, big.out, { ...DEFAULT_ARCHIVE_LIMITS, maxEntryBytes: 1024 }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ArchiveError);
    expect((err as ArchiveError).code).toBe('archive_too_large');

    const many = await tarSetup([tarEntry('repo/a.txt', 'aaaa'), tarEntry('repo/b.txt', 'bbbb')]);
    const err2 = await extractTarArchive(many.tgz, many.out, { ...DEFAULT_ARCHIVE_LIMITS, maxTotalUncompressedBytes: 4 }).then(() => null, (e: unknown) => e);
    expect(err2).toBeInstanceOf(ArchiveError);
    expect((err2 as ArchiveError).code).toBe('archive_too_large');
  });

  it('rejects a corrupt tarball as archive_invalid', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sdk-tar-'));
    const tgz = join(dir, 'in.tgz');
    await writeFile(tgz, gzipSync(Buffer.from('this is not a tar at all, just some text padded out to look busy........')));
    const out = join(dir, 'out');
    await mkdir(out);
    const err = await extractTarArchive(tgz, out).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ArchiveError);
    expect((err as ArchiveError).code).toBe('archive_invalid');
  });
});
