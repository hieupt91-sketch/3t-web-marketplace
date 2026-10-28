import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, cp, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export class ObjectTooLargeError extends Error {
  constructor() {
    super('object exceeds size limit');
  }
}

/**
 * Private object store with a local filesystem driver. Keys are opaque strings such as
 * `quarantine/<uuid>.zip`; they are never returned to API clients (docs/04 §1).
 * Production swaps this for S3-compatible private storage behind the same interface.
 */
export class LocalObjectStore {
  constructor(private readonly root: string) {}

  /** Absolute path for a key; throws if the key would escape the store root. */
  pathFor(key: string): string {
    if (!/^[a-z0-9][a-z0-9/_.-]*$/i.test(key) || key.includes('..')) throw new Error('invalid object key');
    const full = join(this.root, ...key.split('/'));
    const rel = relative(this.root, full);
    if (rel.startsWith('..') || rel.startsWith(sep)) throw new Error('invalid object key');
    return full;
  }

  /** Stream into `key`, enforcing `maxBytes` while writing; returns size and sha256. */
  async putStream(key: string, input: Readable, maxBytes: number): Promise<{ size: number; sha256: string }> {
    const target = this.pathFor(key);
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.${randomUUID()}.part`;
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > maxBytes) return cb(new ObjectTooLargeError());
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(input, meter, createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    return { size, sha256: hash.digest('hex') };
  }

  /** Copy a directory tree into an immutable prefix (read-only files). */
  async putTree(key: string, sourceDir: string): Promise<void> {
    const target = this.pathFor(key);
    if (await this.exists(key)) return; // content-addressed: same key means same content
    const temp = `${target}.${randomUUID()}.part`;
    await mkdir(dirname(target), { recursive: true });
    await cp(sourceDir, temp, { recursive: true, errorOnExist: true, force: false, dereference: false, verbatimSymlinks: true });
    // A previous attempt (or a concurrent worker) may have completed the rename
    // while this attempt was copying; re-check before renaming so a stale temp
    // is never left behind and a completed target is never clobbered.
    if (await this.exists(key)) {
      await removeTreeWritable(temp).catch(() => undefined);
      return;
    }
    // Rename BEFORE sealing read-only: macOS refuses to rename a directory
    // the owner cannot write to (EACCES), while Linux allows it. The stored
    // tree ends up read-only either way; only the order differs. (Proven on
    // macOS 2026-10-28: `mv` of a 0o555 directory fails with "Permission
    // denied" where a writable directory renames fine.)
    try {
      await rename(temp, target);
    } catch (error) {
      // The temp tree is still writable at this point, but restore write bits
      // anyway so cleanup can never leave a .part behind, and never let a
      // cleanup failure mask the original error.
      await removeTreeWritable(temp).catch(() => undefined);
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
      return;
    }
    await makeReadOnly(target);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }

  async move(fromKey: string, toKey: string): Promise<void> {
    const to = this.pathFor(toKey);
    await mkdir(dirname(to), { recursive: true });
    await rename(this.pathFor(fromKey), to);
  }

  read(key: string): Readable {
    return createReadStream(this.pathFor(key));
  }

  async remove(key: string): Promise<void> {
    await rm(this.pathFor(key), { recursive: true, force: true });
  }
}

async function makeReadOnly(path: string): Promise<void> {
  const { readdir } = await import('node:fs/promises');
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) {
      await makeReadOnly(full);
      await chmod(full, 0o555);
    } else if (entry.isFile()) {
      await chmod(full, 0o444);
    }
  }
  await chmod(path, 0o555);
}

/**
 * Remove a tree that may already be read-only (the putTree temp tree is, by
 * the time a rename fails). Unlinking entries inside a 0o555 directory fails,
 * so a plain recursive rm leaves the tree behind; restore write bits first.
 * Symlinks are left alone (rm removes the link itself; chmod would follow it).
 * Exported for tests; callers must still tolerate a cleanup failure.
 */
export async function removeTreeWritable(path: string): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = join(path, entry.name);
    if (entry.isDirectory()) {
      await removeTreeWritable(full).catch(() => undefined);
      await chmod(full, 0o755).catch(() => undefined);
    } else {
      await chmod(full, 0o644).catch(() => undefined);
    }
  }
  await chmod(path, 0o755).catch(() => undefined);
  await rm(path, { recursive: true, force: true });
}
