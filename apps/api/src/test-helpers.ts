import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { LocalObjectStore, MockPaymentProvider, hashPassword, loadConfig, type Db, type PlatformConfig } from '@3t/core';
import { createTestDatabase } from '@3t/core/testing';
import { buildApp } from './app.ts';
import { MemoryMailer } from './mail.ts';

export const ORIGIN = 'http://localhost:3000';

export interface TestContext {
  app: FastifyInstance;
  db: Db;
  dbUrl: string;
  config: PlatformConfig;
  store: LocalObjectStore;
  mailer: MemoryMailer;
  payment: MockPaymentProvider;
  close: () => Promise<void>;
}

export async function createTestContext(overrides: Partial<PlatformConfig> = {}): Promise<TestContext> {
  const { pool, url, drop } = await createTestDatabase();
  const base = await mkdtemp(join(tmpdir(), 'mp-api-'));
  const config = loadConfig({
    env: 'test',
    databaseUrl: url,
    storageDir: join(base, 'storage'),
    workDir: join(base, 'work'),
    portalOrigin: ORIGIN,
    mailTransport: 'disabled',
    passwordHashCost: 1024,
    ...overrides,
  });
  const store = new LocalObjectStore(config.storageDir);
  const mailer = new MemoryMailer();
  const payment = new MockPaymentProvider(config.mockPaymentSecret, config.portalOrigin);
  const app = await buildApp({ config, db: pool, store, mailer, payment });
  return {
    app,
    db: pool,
    dbUrl: url,
    config,
    store,
    mailer,
    payment,
    close: async () => {
      await app.close();
      await drop();
    },
  };
}

export function sessionCookie(res: LightMyRequestResponse): string {
  const cookie = res.cookies.find((c) => c.name === 'mp_session');
  if (!cookie) throw new Error('no session cookie');
  return `mp_session=${cookie.value}`;
}

/** Create a verified user directly (optionally with a role) and return a logged-in cookie. */
export async function createUser(ctx: TestContext, email: string, role?: string): Promise<{ id: string; cookie: string }> {
  const password = 'correct horse battery staple';
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO users (email_normalized, display_name, password_hash, verified_at) VALUES ($1, 'Test', $2, now()) RETURNING id`,
    [email, await hashPassword(password, 1024)],
  );
  const id = rows[0]!.id;
  if (role) await ctx.db.query('INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2', [id, role]);
  const res = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: ORIGIN }, payload: { email, password } });
  if (res.statusCode !== 200) throw new Error(`login failed ${res.statusCode} ${res.body}`);
  return { id, cookie: sessionCookie(res) };
}
