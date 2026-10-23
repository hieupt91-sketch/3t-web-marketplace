import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, cp, mkdir, rename, rm, stat } from 'node:fs/promises';
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
    await makeReadOnly(temp);
    await rename(temp, target).catch(async (error: NodeJS.ErrnoException) => {
      await rm(temp, { recursive: true, force: true });
      if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error;
    });
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
