import { LocalObjectStore, createPool, loadConfig } from '@3t/core';
import { createPreviewServer } from './server.ts';

const config = loadConfig();
const db = createPool(config.databaseUrl, 5);
const server = createPreviewServer({ config, db, store: new LocalObjectStore(config.storageDir) });
const port = Number(process.env.PREVIEW_PORT ?? 4100);
server.listen(port, process.env.PREVIEW_HOST ?? '127.0.0.1', () => {
  console.log(JSON.stringify({ service: 'preview', status: 'listening', port, base_domain: config.previewBaseDomain }));
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => server.close(() => void db.end().then(() => process.exit(0))));
}
