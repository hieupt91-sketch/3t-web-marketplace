# Runbook — 3T Web Marketplace (release candidate)

Scope: operating the release candidate on feat/foundation. Sandbox/mock
providers only until the owner configures real ones (see "Production
configuration" below). No real money, mail, DNS, or cloud credentials are
committed anywhere in this repo.

## 1. Architecture in one page

- API: Fastify (`apps/api`), PostgreSQL, local filesystem object store,
  preview origin server, SQL job queue (SKIP LOCKED, lease + heartbeat,
  fencing token, jittered retry, dead-letter).
- Worker (`apps/worker`): import pipeline + site jobs (provision, backup,
  restore, update, restart). The API never runs arbitrary commands and
  never holds docker.sock; site operations go through the runtime agent
  allowlist (restart | suspend | resume) with a written reason.
- Auth: scrypt passwords, host-only HttpOnly SameSite=Lax session cookie
  `mp_session`, Origin/Sec-Fetch-Site CSRF check, TOTP MFA, 10-minute
  step-up for money/permission/key/deletion actions, Postgres-backed rate
  limits shared by all API instances.
- Money: integer minor units + ISO currency, backend-priced, payment state
  only from verified signed events, never from client redirect.
- Partner: Bearer API keys (scoped), HMAC-signed webhooks (5-minute skew,
  retry delays 1/5/30/120/720/1440 minutes, then dead-letter), append-only
  commission ledger, FIFO payout allocation, four-eyes payout settle
  (approver != settler).

## 2. Production configuration checklist

Set these before any production deploy; the app refuses to start in
production mode when a required secret is missing (dev defaults exist
only outside production):

- APP_ENV=production, DATABASE_URL, PORTAL_ORIGIN (public HTTPS origin),
  PREVIEW_ORIGIN (separate origin for demos, never the portal origin).
- MOCK_PAYMENT_SECRET replaced by the real payment provider adapter and
  its webhook secret; PARTNER_WEBHOOK_KEY; MFA_KEY; PARTNER_LINK_SECRET;
  GITHUB_WEBHOOK_SECRET (webhook disabled when empty).
- DNS_VERIFY_BODY_PROOF=false (forced off in production) and
  PARTNER_WEBHOOK_ALLOW_LOOPBACK=false (dev/test only).
- Mail: real provider transport (the test/file transport must not be used
  in production); object store: S3-compatible private storage behind the
  same store interface (the local filesystem driver is dev-only).
- TLS: real ACME issuance (the verify flow only stamps +90 days; it does
  not issue certificates). DNS TXT verification uses real DNS reads in
  production.
- CI: the workflow pins actions to reviewed SHAs; run it green on GitHub
  before the first production deploy (it has not run there yet).

## 3. Routine operations

- Migrations: `pnpm db:migrate` (forward-only; see §6 for rollback).
- Lifecycle sweep (grace/suspend/purge): POST /admin/sites/lifecycle-sweep
  (ops:execute). Schedule it at least daily; it returns
  `{to_grace, suspended, purged}` counts.
- Demo expiry: sessions expire on read (overdue sessions are marked
  expired and runtime processes killed best-effort). No separate sweeper
  is required, but check `GET /admin/demos` for stuck `active` sessions.
- Webhook deliveries: partner deliveries are created on events and sent
  on the partner test action or the admin send endpoint
  (POST /partner/webhooks/deliveries/:id/send, ops:execute). A delivery
  worker (same pattern as site jobs) is the next automation step; until
  then, retry `failed` deliveries from the admin deliveries view.
- Jobs: `GET /admin/jobs` (ops:read) + retry (ops:execute). A running job
  with a valid lease returns 409 `jobs.lease_active`; a succeeded job
  returns 409 `jobs.already_succeeded`.

## 4. Backup and restore drill (AT-47 shape)

1. Customer or admin creates a backup: POST /sites/:id/backups (202, job).
   The worker zips the site directory into the object store
   (`backups/<siteId>/<backupId>.zip`), records a SHA-256 checksum and a
   30-day expiry.
2. Verify: backup status `succeeded`, checksum is 64 hex, and the export
   download streams a ZIP.
3. Restore: POST /sites/:id/backups/:backupId/restore with
   `confirm_name` equal to the site display name (step-up required).
   The worker unzips into staging, swaps trees atomically, and rolls back
   to the previous files (including respawn) on failure.
4. Smoke after restore: site status `active`, home page 200, restore
   deployment `succeeded`.
5. Drill cadence: run steps 1–4 on a non-production site at least monthly
   and record the date, backup id, and checksum in the ops log.
6. Database: back up PostgreSQL with the platform's standard dump
   procedure (pg_dump) on the same cadence; a site backup covers files
   only, not the platform database.

## 5. Incident playbooks

- Paid but pending job past threshold: open `GET /admin/jobs`, filter by
  the order's job; the alert payload must carry request/resource ids and
  no secrets. Retry via `POST /admin/jobs/:id/retry` after checking the
  job error; do not edit raw payment events (reconciliation resolves by
  decision, never by editing history).
- Needs-reconciliation order: `GET /admin/reconciliation`, resolve to
  `paid` (fulfils entitlements + commission) or `cancelled` with a reason
  of at least 3 characters. Re-resolve returns 409.
- Failed provision: the site stays `provision_failed`, the entitlement
  is never clawed back, and retry reuses the same site id
  (POST /sites/:id/retry).
- Partner webhook failing: check the delivery row (status, attempts,
  next_attempt_at, response_status); verify the endpoint URL is public
  HTTPS and the secret was not rotated; re-send from the admin endpoint.
- Rate-limit 429s: check `rate_limit_buckets` for the key; buckets are
  per route and per key (partner keys are keyed per API key). A global
  spike means traffic, not a bug — raise limits deliberately, do not
  disable the limiter.
- Disk full on the object store: site backups and previews are the
  largest consumers; expired backups (30 days) and dead demo sessions
  are the first candidates for cleanup. Never delete a `site_backup`
  artifact that a `succeeded` backup row still references.

## 6. Rollback policy

- Migrations are forward-only. Do not roll the app back across a
  migration boundary; if a deploy must be undone, restore from backup
  (database dump + object store) instead of a simple app rollback.
- Template versions are immutable once ready: a bad release is fixed by
  publishing a new version, never by editing the old one. Same-semver
  different-hash uploads are rejected with a conflict.
- Site updates roll back via the previous tree kept during the swap;
  if the swap itself fails, the old tree is restored and the old server
  respawned best-effort.

## 7. Alerting gap (open, P2)

No alert channel (mail/webhook to ops) is wired yet: paid-but-pending
jobs, dead-letter webhooks, and failed site jobs are visible in the
admin jobs/deliveries views but do not page anyone. Until an alert
channel is configured, check those views at least daily and after every
deploy. The alert payload format is specified (request/resource ids, no
secrets) so wiring it later does not change the data model.

## 8. Security notes for operators

- Never paste a secret into a ticket, log, or chat. Webhook secrets and
  API keys are shown exactly once at creation; afterwards only hashes
  (and, for webhooks, an AES-256-GCM encrypted copy the platform needs
  to re-sign events) exist.
- Staff grants never exceed the granter's own permissions, and the last
  platform_owner cannot be removed. Partner suspension blocks new API
  calls and checkout sessions but never deletes buyer orders,
  entitlements, commissions, or sites.
- Registration cannot create privileged roles; roles are granted only
  through the staff flow (staff:manage + step-up), so there is no
  setup-takeover path via sign-up.
