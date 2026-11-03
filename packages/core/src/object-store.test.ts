import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { LocalObjectStore, SHARED_STORAGE_GID } from './object-store.ts';

/**
 * H2 gating fix 3 — the shared-storage ownership model. The root worker
 * creates most objects; after the non-root cutover the API/preview
 * (uid/gid 10001) must still read them, and directories one service
 * creates must accept writes from the others. The store enforces:
 * putStream files 0640 + shared group, store-created dirs 02750
 * (setgid → group inheritance) + shared group, putTree artifacts
 * unchanged (0444/0555). Group assertions only bind when the suite runs
 * as root (the VM/CI does): a non-root runner cannot chown, and the
 * fixups are best-effort by design.
 */
const IS_ROOT = typeof process.geteuid === 'function' && process.geteuid() === 0;

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o7777;
}
async function gidOf(path: string): Promise<number> {
  return (await stat(path)).gid;
}

describe('LocalObjectStore shared-storage discipline', () => {
  it('lands putStream files group-readable under shared, setgid directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mp-store-'));
    const store = new LocalObjectStore(root);
    const stored = await store.putStream('backups/site-1/b1.zip', Readable.from([Buffer.from('zip-bytes')]), 1024);
    expect(stored.size).toBe(9);

    const file = join(root, 'backups', 'site-1', 'b1.zip');
    expect(await modeOf(file)).toBe(0o640);
    expect(await modeOf(join(root, 'backups'))).toBe(0o2770);
    expect(await modeOf(join(root, 'backups', 'site-1'))).toBe(0o2770);
    expect(await modeOf(root)).toBe(0o2770);
    if (IS_ROOT) {
      expect(await gidOf(file)).toBe(SHARED_STORAGE_GID);
      expect(await gidOf(join(root, 'backups', 'site-1'))).toBe(SHARED_STORAGE_GID);
    }
    // The bytes still round-trip through the store.
    const chunks: Buffer[] = [];
    for await (const chunk of store.read('backups/site-1/b1.zip')) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('zip-bytes');
  });

  it('shares the putTree parent chain but leaves artifact modes untouched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mp-store-'));
    const src = await mkdtemp(join(tmpdir(), 'mp-tree-src-'));
    await mkdir(join(src, 'assets'), { recursive: true });
    await writeFile(join(src, 'index.html'), '<h1>x</h1>');
    await writeFile(join(src, 'assets', 'a.css'), 'body{}');
    const store = new LocalObjectStore(root);
    await store.putTree('runtime-bundles/hash1', src);

    expect(await modeOf(join(root, 'runtime-bundles'))).toBe(0o2770);
    // The artifact tree itself stays immutable/read-only by design.
    expect(await modeOf(join(root, 'runtime-bundles', 'hash1'))).toBe(0o555);
    expect(await modeOf(join(root, 'runtime-bundles', 'hash1', 'index.html'))).toBe(0o444);
  });

  it('honours sharedGroupId: null (single-user store keeps private modes)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mp-store-'));
    const store = new LocalObjectStore(root, { sharedGroupId: null });
    await store.putStream('private/note.txt', Readable.from(['x']), 16);
    expect(await modeOf(join(root, 'private', 'note.txt'))).toBe(0o600);
  });
});
