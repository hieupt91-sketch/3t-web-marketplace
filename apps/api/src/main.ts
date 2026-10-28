import { LocalObjectStore, MockPaymentProvider, createPool, loadConfig } from '@3t/core';
import { buildApp } from './app.ts';
import { DisabledMailer, FileMailer } from './mail.ts';

const config = loadConfig();
const db = createPool(config.databaseUrl);
const app = await buildApp(
  { config, db, store: new LocalObjectStore(config.storageDir), mailer: config.mailTransport === 'file' ? new FileMailer(config.mailDir) : new DisabledMailer(),
    payment: new MockPaymentProvider(config.mockPaymentSecret, config.portalOrigin) },
  { logger: true },
);
const port = Number(process.env.API_PORT ?? 4000);
await app.listen({ port, host: process.env.API_HOST ?? '127.0.0.1' });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => db.end()).then(() => process.exit(0));
  });
}
