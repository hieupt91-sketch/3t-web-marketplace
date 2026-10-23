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
