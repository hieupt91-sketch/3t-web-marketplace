import { createPool, loadConfig } from '@3t/core';
import { createSiteRouterServer } from './server.ts';

const config = loadConfig();
const db = createPool(config.databaseUrl, 5);
const server = createSiteRouterServer({
  config,
  db,
  sitesUpstreamHost: process.env.SITE_ROUTER_SITES_HOST ?? '127.0.0.1',
  sessionsUpstreamHost: process.env.SITE_ROUTER_SESSIONS_HOST ?? '127.0.0.1',
});
const port = Number(process.env.SITE_ROUTER_PORT ?? 4200);
server.listen(port, process.env.SITE_ROUTER_HOST ?? '127.0.0.1', () => {
  console.log(JSON.stringify({ service: 'site-router', status: 'listening', port, base_domain: config.siteBaseDomain }));
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => server.close(() => void db.end().then(() => process.exit(0))));
}
