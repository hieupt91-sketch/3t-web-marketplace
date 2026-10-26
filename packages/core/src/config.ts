import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export interface PlatformConfig {
  env: 'development' | 'test' | 'production';
  databaseUrl: string;
  /** Root of the private object store (local filesystem driver). Never served directly. */
  storageDir: string;
  /** Scratch space for import workspaces; wiped per job. */
  workDir: string;
  /** Public origin of storefront/portal/API (same origin behind the reverse proxy). */
  portalOrigin: string;
  /** Preview origin template, e.g. http://{label}.preview.localhost:4100 — a different registrable domain in production. */
  previewOriginTemplate: string;
  /** Base domain used by the preview server to map Host → label. */
  previewBaseDomain: string;
  /** Where the worker reaches the preview server for smoke checks. */
  previewInternalUrl: string;
  cookieSecure: boolean;
  sessionTtlHours: number;
  mailTransport: 'file' | 'disabled';
  mailDir: string;
  chromiumPath: string | null;
  screenshotsEnabled: boolean;
  /** scrypt cost; lowered only in tests. */
  passwordHashCost: number;
  /** Base URL for the GitHub REST API (overridable for tests / GHES). */
  githubApiBaseUrl: string;
  /** HMAC secret for GitHub push webhooks; empty disables the webhook endpoint. */
  githubWebhookSecret: string;
  /** Cap on concurrently active demo sessions (D02 capacity). */
  demoMaxActiveSessions: number;
  /** Dev/test only: domain verification may accept the presented TXT value as
   * control proof. Production must use real DNS reads (default false). */
  dnsVerifyBodyProof: boolean;
  /** Platform selling currency (VND). */
  currency: string;
  /** Sandbox payment secret; a real provider replaces the mock at the integration milestone. */
  mockPaymentSecret: string;
  /** Minutes a payment window stays open for an order. */
  paymentWindowMinutes: number;
}

function env(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value !== undefined && value !== '') return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable ${name}`);
}

export function loadConfig(overrides: Partial<PlatformConfig> = {}): PlatformConfig {
  const mode = env('APP_ENV', 'development');
  if (mode !== 'development' && mode !== 'test' && mode !== 'production') throw new Error('APP_ENV must be development|test|production');
  const runtimeData = resolve(REPO_ROOT, 'runtime-data');
  const config: PlatformConfig = {
    env: mode,
    databaseUrl: env('DATABASE_URL', mode === 'production' ? undefined : 'postgres://marketplace@127.0.0.1:55432/marketplace'),
    storageDir: resolve(env('STORAGE_DIR', resolve(runtimeData, 'storage'))),
    workDir: resolve(env('WORK_DIR', resolve(runtimeData, 'work'))),
    portalOrigin: env('PORTAL_ORIGIN', mode === 'production' ? undefined : 'http://localhost:3000'),
    previewOriginTemplate: env('PREVIEW_ORIGIN_TEMPLATE', mode === 'production' ? undefined : 'http://{label}.preview.localhost:4100'),
    previewBaseDomain: env('PREVIEW_BASE_DOMAIN', mode === 'production' ? undefined : 'preview.localhost'),
    previewInternalUrl: env('PREVIEW_INTERNAL_URL', 'http://127.0.0.1:4100'),
    cookieSecure: env('COOKIE_SECURE', mode === 'production' ? 'true' : 'false') === 'true',
    sessionTtlHours: Number(env('SESSION_TTL_HOURS', '336')),
    mailTransport: env('MAIL_TRANSPORT', mode === 'production' ? 'disabled' : 'file') as 'file' | 'disabled',
    mailDir: resolve(env('MAIL_DIR', resolve(runtimeData, 'dev-mail'))),
    chromiumPath: process.env.CHROMIUM_PATH || null,
    screenshotsEnabled: env('SCREENSHOTS', 'off') === 'on',
    passwordHashCost: Number(env('PASSWORD_HASH_COST', '131072')),
    currency: env('PLATFORM_CURRENCY', 'VND'),
    mockPaymentSecret: env('MOCK_PAYMENT_SECRET', mode === 'production' ? undefined : 'dev-mock-payment-secret'),
    paymentWindowMinutes: Number(env('PAYMENT_WINDOW_MINUTES', '30')),
    githubApiBaseUrl: env('GITHUB_API_BASE_URL', 'https://api.github.com'),
    githubWebhookSecret: env('GITHUB_WEBHOOK_SECRET', ''),
    demoMaxActiveSessions: Number(env('DEMO_MAX_ACTIVE_SESSIONS', '20')),
    dnsVerifyBodyProof: env('DNS_VERIFY_BODY_PROOF', 'false') === 'true' && mode !== 'production',
    ...overrides,
  };
  if (config.env === 'production' && !config.cookieSecure) throw new Error('COOKIE_SECURE must be true in production');
  if (config.env === 'production' && config.mailTransport === 'file') throw new Error('MAIL_TRANSPORT=file is development only');
  const portalHost = new URL(config.portalOrigin).hostname;
  if (portalHost === config.previewBaseDomain || portalHost.endsWith(`.${config.previewBaseDomain}`)) {
    throw new Error('Preview base domain must differ from the portal host (ADR-005)');
  }
  return config;
}

export function previewOrigin(config: PlatformConfig, label: string): string {
  return config.previewOriginTemplate.replace('{label}', label);
}
