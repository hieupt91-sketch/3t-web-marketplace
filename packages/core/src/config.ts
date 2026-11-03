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
  /** Base domain for hosted customer sites: <subdomain>.<siteBaseDomain>. */
  siteBaseDomain: string;
  /** Public origin template for a hosted site, e.g. https://{label}.webmaket.com. */
  siteOriginTemplate: string;
  /** Interface spawned site/demo servers bind to. Loopback for single-host
   * dev; 0.0.0.0 inside the compose stack so the site router (its own
   * container) can reach processes spawned by the worker/api containers.
   * Those ports are never published, so exposure stays inside the stack. */
  runtimeBindHost: string;
  cookieSecure: boolean;
  sessionTtlHours: number;
  /** Absolute session lifetime (hours from creation) for role-holding accounts. See the L-03 policy note in loadConfig. */
  sessionRoleTtlHours: number;
  /** Absolute session lifetime (hours from creation) for plain buyer accounts. */
  sessionBuyerTtlHours: number;
  /** Idle timeout (hours since last_seen_at) for role-holding accounts. */
  sessionRoleIdleHours: number;
  /** Idle timeout (hours since last_seen_at) for plain buyer accounts. */
  sessionBuyerIdleHours: number;
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
  /** HMAC secret for signed partner referral links. */
  partnerLinkSecret: string;
  /** Dev/test only: partner webhook endpoints may point at loopback. */
  partnerWebhookAllowLoopback: boolean;
  /** Server-side key encrypting stored partner webhook secrets at rest. */
  partnerWebhookKey: string;
  /** Server-side key encrypting stored MFA TOTP secrets at rest. */
  mfaKey: string;
  /**
   * Sandbox Phase 0 (audit C-01) — UID fencing for spawned template code.
   * 'auto' (default): per-site UIDs are used when the spawning process runs
   * as root (the production worker container does) and disabled with a loud
   * startup warning otherwise (dev machines, CI). 'on': refuse to run
   * without root. 'off': never fence (explicit operator choice).
   */
  sandboxUidMode: 'auto' | 'on' | 'off';
  /** First UID of the per-site pool; site slots are allocated from here. */
  siteUidBase: number;
  /** Number of UIDs in the per-site pool (deploy images create these users). */
  siteUidPoolSize: number;
  /** Shared primary GID for every sandbox user (sites, demo, import check). */
  siteGid: number;
  /** One shared UID for all demo-session processes (demos hold no tenant data). */
  demoUid: number;
  /** One shared UID for import-pipeline runtime checks (throwaway workspaces). */
  importUid: number;
  /** prlimit caps applied to every spawned site/demo/import-check server. */
  siteLimitCpuSeconds: number;
  /**
   * Address-space cap (RLIMIT_AS via prlimit --as). NOT a small number:
   * a Node 22 server's VmPeak at idle is ~11.6 GiB (V8 pointer-compression
   * + Wasm cage reservations), so a cap near the heap size stops the
   * server from booting at all — measured in the show env: 6 GiB dies in
   * undici's Wasm instantiation, 16 GiB is healthy. 32 GiB leaves real
   * headroom while still bounding virtual-memory runaway. Physical RSS
   * containment is NOT achievable with rlimits (RLIMIT_RSS is a no-op on
   * Linux) — that is the Phase 1 runner's cgroup/watchdog job.
   */
  siteLimitAddressSpaceMb: number;
  siteLimitMaxProcesses: number;
  siteLimitFileSizeMb: number;
  /**
   * Sandbox Phase 1 (audit C-01): base URL of the dedicated site-runner
   * service (e.g. http://site-runner:4300). When set, the worker NEVER
   * spawns template code itself — every spawn/stop goes to the runner,
   * whose environment holds no platform credentials — and fails closed
   * on runner errors instead of falling back to a local spawn. Empty
   * (default) keeps the Phase 0 local-spawn behaviour (dev, show env).
   */
  runtimeAgentUrl: string;
  /** Shared secret authenticating worker → runner calls (x-runner-token). */
  runnerToken: string;
  /**
   * RSS cap (MiB) for spawned site/demo/import-check servers, enforced by
   * the runner's watchdog (Phase 1). RLIMIT_RSS is a no-op on Linux, so
   * this only takes effect in runner mode; it is sent on the wire with
   * every spawn either way.
   */
  siteLimitRssMb: number;
  /** How long the API waits for the worker to spawn a demo session server. */
  demoSpawnWaitMs: number;
  /** How long the API waits for the worker to read a site's admin setup
   *  token out of its fenced tree (site.setup-token job, H2 fix 1). The
   *  read is a stat + small file read, so this is far below the demo
   *  spawn budget; it only ever lapses when the worker is down. */
  adminSetupWaitMs: number;
}

function env(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value !== undefined && value !== '') return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable ${name}`);
}

function sandboxUidMode(): 'auto' | 'on' | 'off' {
  const value = env('SANDBOX_UID_MODE', 'auto');
  if (value !== 'auto' && value !== 'on' && value !== 'off') throw new Error('SANDBOX_UID_MODE must be auto|on|off');
  return value;
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
    siteBaseDomain: env('SITE_BASE_DOMAIN', mode === 'production' ? undefined : 'sites.localhost'),
    siteOriginTemplate: env('SITE_ORIGIN_TEMPLATE', mode === 'production' ? undefined : 'http://{label}.sites.localhost:4200'),
    runtimeBindHost: env('RUNTIME_BIND_HOST', '127.0.0.1'),
    cookieSecure: env('COOKIE_SECURE', mode === 'production' ? 'true' : 'false') === 'true',
    sessionTtlHours: Number(env('SESSION_TTL_HOURS', '168')),
    // Session lifetime policy (audit L-03). Sessions used to live a
    // flat 14 days with no idle timeout, so a leaked cookie stayed
    // useful for two weeks. Role-holding accounts (staff/partner —
    // anyone with ANY role) can move money and change configuration,
    // so their sessions are capped at 72 h absolute and 12 h idle.
    // Plain buyer sessions are lower privilege and get a consumer-
    // friendly 168 h (7 days) absolute / 48 h idle. The caps are
    // enforced on every request in loadSession (apps/api/src/app.ts)
    // against the session's CURRENT role class — a role granted after
    // login tightens an existing session on its next request — and
    // createSession caps expires_at to the same values at issuance.
    // Existing sessions are not bulk-revoked: the loadSession checks
    // simply reject (and revoke) any session past its cap on next use.
    sessionRoleTtlHours: Number(env('SESSION_ROLE_TTL_HOURS', '72')),
    sessionBuyerTtlHours: Number(env('SESSION_BUYER_TTL_HOURS', '168')),
    sessionRoleIdleHours: Number(env('SESSION_ROLE_IDLE_HOURS', '12')),
    sessionBuyerIdleHours: Number(env('SESSION_BUYER_IDLE_HOURS', '48')),
    mailTransport: env('MAIL_TRANSPORT', mode === 'production' ? 'disabled' : 'file') as 'file' | 'disabled',
    mailDir: resolve(env('MAIL_DIR', resolve(runtimeData, 'dev-mail'))),
    chromiumPath: process.env.CHROMIUM_PATH || null,
    screenshotsEnabled: env('SCREENSHOTS', 'off') === 'on',
    passwordHashCost: Number(env('PASSWORD_HASH_COST', '131072')),
    currency: env('PLATFORM_CURRENCY', 'VND'),
    mockPaymentSecret: env('MOCK_PAYMENT_SECRET', mode === 'production' ? undefined : 'dev-mock-payment-secret'),
    paymentWindowMinutes: Number(env('PAYMENT_WINDOW_MINUTES', '15')),
    githubApiBaseUrl: env('GITHUB_API_BASE_URL', 'https://api.github.com'),
    githubWebhookSecret: env('GITHUB_WEBHOOK_SECRET', ''),
    demoMaxActiveSessions: Number(env('DEMO_MAX_ACTIVE_SESSIONS', '20')),
    dnsVerifyBodyProof: env('DNS_VERIFY_BODY_PROOF', 'false') === 'true' && mode !== 'production',
    partnerLinkSecret: env('PARTNER_LINK_SECRET', mode === 'production' ? undefined : 'dev-partner-link-secret'),
    partnerWebhookAllowLoopback: env('PARTNER_WEBHOOK_ALLOW_LOOPBACK', 'false') === 'true' && mode !== 'production',
    partnerWebhookKey: env('PARTNER_WEBHOOK_KEY', mode === 'production' ? undefined : 'dev-partner-webhook-key'),
    mfaKey: env('MFA_KEY', mode === 'production' ? undefined : 'dev-mfa-key'),
    sandboxUidMode: sandboxUidMode(),
    siteUidBase: Number(env('SITE_UID_BASE', '20000')),
    siteUidPoolSize: Number(env('SITE_UID_POOL_SIZE', '500')),
    siteGid: Number(env('SITE_GID', '19990')),
    demoUid: Number(env('DEMO_UID', '19998')),
    importUid: Number(env('IMPORT_UID', '19999')),
    siteLimitCpuSeconds: Number(env('SITE_LIMIT_CPU_SECONDS', '86400')),
    siteLimitAddressSpaceMb: Number(env('SITE_LIMIT_ADDRESS_SPACE_MB', '32768')),
    siteLimitMaxProcesses: Number(env('SITE_LIMIT_MAX_PROCESSES', '256')),
    siteLimitFileSizeMb: Number(env('SITE_LIMIT_FILE_SIZE_MB', '1024')),
    runtimeAgentUrl: env('RUNTIME_AGENT_URL', ''),
    runnerToken: env('RUNNER_TOKEN', ''),
    siteLimitRssMb: Number(env('SITE_LIMIT_RSS_MB', '1024')),
    demoSpawnWaitMs: Number(env('DEMO_SPAWN_WAIT_MS', '30000')),
    adminSetupWaitMs: Number(env('ADMIN_SETUP_WAIT_MS', '10000')),
    ...overrides,
  };
  if (config.env === 'production' && !config.cookieSecure) throw new Error('COOKIE_SECURE must be true in production');
  if (config.env === 'production' && config.mailTransport === 'file') throw new Error('MAIL_TRANSPORT=file is development only');
  if (config.env === 'production' && config.runtimeAgentUrl && !config.runnerToken) {
    throw new Error('RUNNER_TOKEN is required when RUNTIME_AGENT_URL is set in production');
  }
  const portalHost = new URL(config.portalOrigin).hostname;
  if (portalHost === config.previewBaseDomain || portalHost.endsWith(`.${config.previewBaseDomain}`)) {
    throw new Error('Preview base domain must differ from the portal host (ADR-005)');
  }
  if (config.siteBaseDomain === config.previewBaseDomain) {
    throw new Error('Site base domain must differ from the preview base domain');
  }
  if (!config.siteOriginTemplate.includes('{label}')) {
    throw new Error('SITE_ORIGIN_TEMPLATE must contain {label}');
  }
  return config;
}

export function previewOrigin(config: PlatformConfig, label: string): string {
  return config.previewOriginTemplate.replace('{label}', label);
}

/* ---------------- Session lifetime policy (audit L-03) ---------------- */

/** Hard caps applied at session creation, mirroring the loadConfig defaults. */
export const SESSION_ROLE_TTL_HOURS = 72;
export const SESSION_BUYER_TTL_HOURS = 168;

/** last_seen_at is refreshed at most this often, so session use is not a write per request. */
export const SESSION_LAST_SEEN_THROTTLE_MS = 5 * 60_000;

export interface SessionLimits {
  absoluteTtlHours: number;
  idleHours: number;
}

type SessionPolicyConfig = Pick<PlatformConfig, 'sessionRoleTtlHours' | 'sessionBuyerTtlHours' | 'sessionRoleIdleHours' | 'sessionBuyerIdleHours'>;

/** Limits for a session whose user currently holds ANY role (staff/partner) vs a plain buyer. */
export function sessionLimits(config: SessionPolicyConfig, hasRole: boolean): SessionLimits {
  return hasRole
    ? { absoluteTtlHours: config.sessionRoleTtlHours, idleHours: config.sessionRoleIdleHours }
    : { absoluteTtlHours: config.sessionBuyerTtlHours, idleHours: config.sessionBuyerIdleHours };
}

/** 'absolute' | 'idle' when the session must be rejected at `now`, else null. */
export function sessionRejectionReason(limits: SessionLimits, createdAt: Date, lastSeenAt: Date, now: Date): 'absolute' | 'idle' | null {
  if (now.getTime() - createdAt.getTime() >= limits.absoluteTtlHours * 3_600_000) return 'absolute';
  if (now.getTime() - lastSeenAt.getTime() >= limits.idleHours * 3_600_000) return 'idle';
  return null;
}

/** Throttled touch: only write last_seen_at when it is older than the throttle window. */
export function shouldRefreshLastSeen(lastSeenAt: Date, now: Date, throttleMs: number = SESSION_LAST_SEEN_THROTTLE_MS): boolean {
  return now.getTime() - lastSeenAt.getTime() > throttleMs;
}
