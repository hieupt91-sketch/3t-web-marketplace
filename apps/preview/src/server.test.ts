import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Db, LocalObjectStore } from '@3t/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPreviewServer, safeRequestPath } from './server.ts';

describe('safeRequestPath', () => {
  it.each([
    ['/', ''],
    ['/details.html?x=1', 'details.html'],
    ['/a/b/', 'a/b/'],
    ['/a/./b.css', 'a/b.css'],
  ])('maps %s', (input, expected) => expect(safeRequestPath(input)).toBe(expected));

  it.each(['/../etc/passwd', '/%2e%2e/secret', '/a/%2e%2e/%2e%2e/x', '/a\\b', '/%00', '/.env', '/x/.git/config', '/%E0%A4%A'])(
    'rejects %s',
    (input) => expect(safeRequestPath(input)).toBeNull(),
  );
});

const LABEL = 'a1b2c3d4e5f6a7b8c9d0e1f2'; // 24 chars: valid label shape
const UNKNOWN_LABEL = 'z9y8x7w6v5u4t3s2r1q0p9o8';
const BASE = 'preview.localhost';

function get(port: number, host: string, path: string): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = request({ hostname: '127.0.0.1', port, path, method: 'GET', headers: { host } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk as Buffer));
      res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', rejectPromise);
    req.end();
  });
}

describe('preview server label modes', () => {
  let server: Server;
  let port: number;
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'preview-modes-'));
    await writeFile(join(root, 'index.html'), '<!doctype html><title>demo</title><link rel="stylesheet" href="styles.css">');
    await writeFile(join(root, 'styles.css'), 'body { color: red; }');
    const db = {
      query: async (_sql: string, params: unknown[]) => ({
        rows: params[0] === LABEL ? [{ entry: 'index.html', spa_fallback: false, object_key: 'site-key' }] : [],
      }),
    } as unknown as Db;
    const store = { pathFor: (_key: string) => root } as unknown as LocalObjectStore;
    server = createPreviewServer({ config: { previewBaseDomain: BASE, portalOrigin: 'http://localhost:3000' }, db, store, cacheMs: 0 });
    await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    await rm(root, { recursive: true, force: true });
  });

  describe('path mode (Host == base domain)', () => {
    it('serves the entry document by path label', async () => {
      const res = await get(port, BASE, `/${LABEL}/`);
      expect(res.status).toBe(200);
      expect(res.body).toContain('<title>demo</title>');
    });

    it('serves assets below the label prefix', async () => {
      const res = await get(port, BASE, `/${LABEL}/styles.css`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/css');
      expect(res.body).toContain('color: red');
    });

    it('redirects /{label} to /{label}/', async () => {
      const res = await get(port, BASE, `/${LABEL}`);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(`/${LABEL}/`);
    });

    it('rejects malformed labels', async () => {
      expect((await get(port, BASE, '/short/')).status).toBe(404);
      expect((await get(port, BASE, `/${'A'.repeat(24)}/`)).status).toBe(404);
      expect((await get(port, BASE, '/')).status).toBe(404);
    });

    it('404s unknown labels like host mode', async () => {
      const res = await get(port, BASE, `/${UNKNOWN_LABEL}/`);
      expect(res.status).toBe(404);
      expect(res.body).toContain('Preview not found');
    });
  });

  describe('host mode (Host == <label>.base domain) stays unchanged', () => {
    it('serves the entry document at the root', async () => {
      const res = await get(port, `${LABEL}.${BASE}`, '/');
      expect(res.status).toBe(200);
      expect(res.body).toContain('<title>demo</title>');
    });

    it('serves assets at the root', async () => {
      const res = await get(port, `${LABEL}.${BASE}`, '/styles.css');
      expect(res.status).toBe(200);
      expect(res.body).toContain('color: red');
    });

    it('404s unknown labels', async () => {
      const res = await get(port, `${UNKNOWN_LABEL}.${BASE}`, '/');
      expect(res.status).toBe(404);
      expect(res.body).toContain('Preview not found');
    });
  });
});
