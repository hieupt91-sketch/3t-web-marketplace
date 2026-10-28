# Acceptance report — 3T Web Marketplace M8 release candidate

Branch: `feat/foundation`. Head at M8 commit (see git log). Test command:
`pnpm run check` (docs validation, typecheck, lint, unit, integration).
All counts below are from that command on 2026-10-27 unless stated.

## Verdict

**Release candidate for staging, NOT a production release.** No P0
(crash, data loss, security) item is open. Two P1 items block a
production deploy and are owned outside code: (1) the owner must approve
the selling policies, prices, and commission rates — the seeded partner
policy (10% / 14-day hold / 500,000 minimum) is a placeholder example
from the spec, not a business commitment; (2) the CI workflow exists and
is SHA-pinned but has not executed on GitHub yet — run it green there
first. Real payment, mail, DNS, and storage providers are not configured;
sandbox/mock stays labelled until then (see RUNBOOK.md §2).

## Test totals (full `pnpm run check`, green)

- i18n: 4; core: 10; template-sdk: 30; preview: 12; api: 14;
  integration: 75 (40 baseline + 5 refund + 8 adapter/GitHub/demo + 2 M3
  + 6 hosting + 6 partner + 5 M7 + 1 E2E + 2 load).
- Total: **145 tests, 0 failed.** Docs validation: 19+ markdown files,
  95 UI screens, 30 requirements, 60 scenarios, all unique. i18n: 994
  keys in each locale, parity enforced by lint. Web lint: 754 keys /
  114 files.
- Load (docs/10 §5, test environment, in-process inject, no WAN):
  catalog with 1,000 published templates, 50 concurrent reads:
  p95 388 ms (budget 500 ms; per-request cost is ~8 ms, the aggregate
  is single-event-loop serialization of 50 concurrent injects).
  Order list over 10,000 rows: p95 13 ms (budget 800 ms).
- E2E: one continuous journey (register, verify, login, import,
  publish, quote, order, mock pay, entitlement, one-time download with
  replay rejected, support ticket + staff reply) passes in
  `tests/integration/release-e2e.test.ts`.

## Security gate (docs/10 §8, audited 2026-10-27)

- RBAC/tenant: permissions enforced in the API (`requirePermission`);
  site access is owner-or-member with 404 for strangers (AT-24);
  partner data is scoped to the partner (AT-33); staff grants never
  exceed the granter (M7).
- SQLi: no interpolated values in queries — grep over `db.query` /
  `client.query` template literals found zero `${}` value interpolations;
  all queries are parameterized.
- XSS: zero `dangerouslySetInnerHTML` in the web app (React escaping);
  demo iframes are sandboxed without `allow-same-origin` on a separate
  preview origin, and session cookies are HttpOnly (AT-55).
- CSRF: Origin/Sec-Fetch-Site check on cookie routes; server-to-server
  Bearer routes (payment webhooks, GitHub webhook, Partner API) are
  exempt by design and signature- or key-authenticated.
- SSRF: partner webhook URLs must be public HTTPS (or dev/test
  loopback), private/reserved IPs are rejected at creation and again
  after DNS re-resolution at send time (AT-43); GitHub repo names match
  a strict `owner/name` pattern and the API base URL is server config.
- Archive safety: quarantine, traversal/symlink/bomb/duplicate-name
  checks run before execution (AT-03); secret scan flags secret files
  and patterns without returning values (AT-58).
- No secret in bundle: production mode refuses to start without
  MOCK_PAYMENT_SECRET, PARTNER_WEBHOOK_KEY, MFA_KEY, and
  PARTNER_LINK_SECRET (dev defaults exist only outside production);
  webhook secrets are AES-256-GCM encrypted at rest, API keys are
  hashed, and both are shown exactly once.
- Setup takeover: registration cannot create privileged roles; roles
  come only from the staff flow (staff:manage + step-up). See AT-21
  below for the self-host bundle scope note.
- Partner scope/signature: per-key scopes enforced per call, unknown
  body fields rejected (AT-34), HMAC `v1=` with 5-minute skew and
  replay-safe delivery dedupe (AT-42).

## Accessibility (REQ-26, AT-50)

Present and spot-checked: skip link to `#main`, `main` landmarks on
layouts, labelled images (alt on every `img`), 67 form label
associations, 43 role/tabIndex uses, 6 responsive `@media` rules.
**Not done:** no automated axe run (no axe in the toolchain) and no
live-browser keyboard/mobile pass at 360/390/768/1440 — that pass is
deferred to the parent for browser delegation (see the UI/UX review
note at the end of this report). AT-50 is therefore marked partial.

## Requirements mapping (docs/01, 30 REQ)

| REQ | Status | Evidence / note |
| REQ-01 Store | Done | Catalog list/detail, category subtree + price filters (M3); load test 1,000 templates. |
| REQ-02 ZIP import | Done | Upload sessions, progress, per-step errors, source kept (M2). |
| REQ-03 GitHub import | Done | Pinned commit, tarball re-pack, webhook dedupe (M2, AT-04/57). |
| REQ-04 Adapter detection | Done | Detection with confidence + missing fields; needs-configuration (M2, AT-05). |
| REQ-05 Manifest | Done | Schema-validated manifest, adapters, demo, export, locales (M2). |
| REQ-06 Isolated build | Partial | Scrubbed env, argv-only, no shell, timeouts, caps, network isolation via unshare when available. Process-level only — no VM, no unprivileged-uid builds, no dependency-proxy allowlist (production hardening owed). |
| REQ-07 Public demo | Done | Preview origin URLs, responsive viewer, simulation warning (M2). |
| REQ-08 Isolated admin demo | Partial | Runtime sessions isolated per user with TTL + cleanup (M2). Static demos share the version preview label (documented); session expiry is enforced on session read, while the preview URL stays reachable to holders of its label. |
| REQ-09 Accounts | Done | Verify, login, reset, session revoke, MFA, step-up, password change (M7). |
| REQ-10 Orders/payment | Done | Backend pricing, signed webhooks, idempotency, reconciliation (M4). |
| REQ-11 Entitlement | Done | Unpaid cannot download or run paid sites; version-pinned downloads (M4, AT-18/19/59). |
| REQ-12 Self-host bundle | Partial | Complete ZIP streams with title/manifest (E2E). Clean-VPS install drill not run (AT-20 gap). |
| REQ-13 Hosting | Done | Quota-locked creation, saga, retry same site id (M5). |
| REQ-14 Domains | Partial | Subdomain + DNS TXT verify, primary, release/re-attach (M5). Real ACME issuance not built (verify stamps +90 days); IPv6/CAA error display not built (AT-26 gap). |
| REQ-15 Renewal | Done | Renewal exactly once, grace/suspend/purge sweep with owner recovery (M5). |
| REQ-16 Template admin | Done | Draft/review/publish, versions with SHA, immutable versions (M3, AT-30). |
| REQ-17 Platform admin | Done | Orders, customers, jobs, statuses, tickets, audit log (M4/M5/M7). |
| REQ-18 Site admin by capability | Partial | Capabilities recorded in manifest; no CMS surface exists for static templates, so nothing unprovided is advertised (AT-32). No dedicated capability-gating test. |
| REQ-19 Partner API | Done | Catalog, demo links, checkout, partner orders (M6). |
| REQ-20 Commission | Done | Append-only ledger, hold, eligibility, FIFO payout, reversal (M6). |
| REQ-21 Partner keys/webhooks | Done | Scopes, limits, rotation by revoke + reissue, signed webhooks (M6). Delivery worker not built: sends happen on test/admin action (M6 note). |
| REQ-22 i18n | Done | 994 keys VI/EN parity, locale mail, SEO canonical/hreflang, fallback detail noindex (M7). |
| REQ-23 SQL via API | Done | No SQL credentials reach the browser; all queries parameterized (security gate). |
| REQ-24 Backup/restore | Done | Site backup zip + checksum + staged restore with rollback (M5, AT-47 same-node). |
| REQ-25 GitHub multi-machine | Done | Docs + CI + lockfile discipline; clone-and-check documented (AT-49). CI not yet run on GitHub (P1). |
| REQ-26 Accessibility | Partial | Skip link, landmarks, labels, alt, responsive rules; no axe run, no live-browser pass (AT-50). |
| REQ-27 Consistency | Done | Idempotency keys, optimistic locking (ETag/If-Match), transactions, outbox (M4/M5/M6). |
| REQ-28 Observability | Partial | Correlation ids, clean logs (no secret values), admin jobs view. No alert channel wired (RUNBOOK §7, P2). |
| REQ-29 Data export | Partial | Exports are scoped to the owner's own site directory. A license-aware export filter (excluding template source when the plan lacks source rights) is not built (AT-53 gap). |
| REQ-30 Content rights | Partial | Uploader rights confirmation gate on upload. Per-asset rights registry not built (AT-54 gap). |

## Acceptance scenarios mapping (docs/10, AT-01..AT-60)

Legend: Done = automated evidence in the suite; Partial = implemented
with a stated limit; Gap = not built or not verified.

| AT | Status | Evidence / note |
| AT-01 Catalog filter | Done | m3-close: category subtree + price bounds, pagination cursors. |
| AT-02 Valid ZIP | Done | import-flow + adapter-flow: static/vite/node/next reach ready with demo URL. |
| AT-03 Malicious archive | Done | Archive inspection tests: traversal, absolute paths, symlinks, bombs, duplicate normalized names blocked before execution. |
| AT-04 GitHub webhook x3 | Done | github-demo: same delivery id creates one logical import, pinned commit. |
| AT-05 Multi-framework / missing lockfile | Done | Needs-configuration path; pipeline does not guess adapters (M2). |
| AT-06 Bad schema | Done | Manifest validator with JSON-pointer errors; UI surfaces them (M2). |
| AT-07 Build reaching prod env/socket | Done | Executor scrubs env and never passes host sockets; process-level scope per REQ-06. |
| AT-08 Build timeout/OOM/crash | Done | Executor timeout + group SIGKILL; checkpoint retry resumes (adapter-flow). |
| AT-09 Demo HTML/Vite/Node/Next | Done | adapter-flow covers all four adapters end to end. |
| AT-10 Two users, admin demo | Partial | Runtime sessions isolated (github-demo). Static demos share the version preview (REQ-08 note). |
| AT-11 TTL expiry, tab open | Done | Session expiry enforced on read; expired UI state (D04); runtime killed on sweep. |
| AT-12 Promotion + cleanup race | Partial | Promotion copies the runtime directory verbatim, then cancels the session. A concurrent promotion/cleanup race has no dedicated test. |
| AT-13 Login/reset replay | Done | auth tests: verify once, replay rejected, reset expiry, session revoke on password change (M7). |
| AT-14 Client tampers totals | Done | Backend repricing via computeCharge; client totals ignored (commerce). |
| AT-15 Fake redirect success | Done | Payment state only from verified events; unpaid stays unpaid, no entitlement (M4). |
| AT-16 Duplicate/out-of-order webhook | Done | Dedupe by provider event id; paid never returns to pending (M4). |
| AT-17 Wrong amount / late payment | Done | Mismatch goes to needs_reconciliation, never auto-fulfilled (M4, A12). |
| AT-18 Download unpaid | Done | Entitlement checks: unpaid has no entitlement; download-links 404/403 by scope (M4). |
| AT-19 Expired/foreign token | Done | Token is one-time, 5-minute, session-bound; E2E replay returns 409. |
| AT-20 Clean-VPS install | Gap | Bundle streams and is complete (E2E), but no install drill on a clean VPS was run. |
| AT-21 Setup before owner input | Partial | No server-side setup endpoint exists inside bundles, so no admin can be created from a bundle. A token-gated setup page as literally specified is not built. |
| AT-22 Concurrent site creation | Done | Entitlement row lock + quota check; second create 409 (hosting-flow, AT-22). |
| AT-23 Paid, provision fails, retry | Done | Same site id, entitlement kept, retry to active (hosting-flow). |
| AT-24 Cross-tenant access | Done | Non-owner/non-member site access returns 404 (hosting-flow). |
| AT-25 Wrong TXT, right DNS | Done | Verify requires the exact token; wrong TXT leaves the domain unverified (hosting-flow). |
| AT-26 IPv6/CAA/TLS errors | Gap | No ACME issuance and no IPv6/CAA error display; subdomain path unaffected (documented M5 limit). |
| AT-27 Domain release + re-attach | Done | Release frees the hostname; re-add mints a fresh token and re-verifies (hosting-flow). |
| AT-28 Renewal at expiry | Done | Apply exactly once (PK on order item); renewed site is not suspended (hosting-flow). |
| AT-29 Grace/suspend/purge | Done | Sweep timeline per policy_snapshot; owner delete/cancel recovery (hosting-flow). |
| AT-30 Same semver, different hash | Done | Record-time conflict; old version immutable (M3). |
| AT-31 Staff calling refund/secrets | Done | Permission-gated admin routes; buyer forbidden from admin approve (refund-flow). |
| AT-32 Static template, no CMS | Partial | No CMS surface exists for static templates; capability gating has no dedicated test. |
| AT-33 Partner A reads B | Done | Partner scoping + masked buyer email; cross-partner 404 (partner-flow). |
| AT-34 Partner forges is_paid/total | Done | Unknown body fields rejected 422; quotes are backend-priced (partner-flow). |
| AT-35 Foreign buyer claims session | Done | Claim requires the buyer's own session + token; partner cannot claim (partner-flow). |
| AT-36 External reference retry | Done | Same details return the same session (200); different details 409 (partner-flow). |
| AT-37 Policy rate changes after paid | Done | Attribution stores the policy snapshot at order creation (M6 ledger). |
| AT-38 Repeated partial then full refund | Done | Cumulative reversal nets to zero; rounding by floor (partner-flow). |
| AT-39 Refund after paid payout | Done | Paid allocation stays; reversal reduces available, never paid history (partner-flow). |
| AT-40 Concurrent payouts | Done | Row locks + per-entry remainders; no over-reserve (partner-flow). |
| AT-41 Key revoke/expire/suspend | Done | Revoke 401, suspend blocks new calls, buyer site untouched (partner-flow). |
| AT-42 Bad signature/timestamp/replay | Done | HMAC + skew check; delivery dedupe by (endpoint, event) (partner-flow). |
| AT-43 Webhook to internal IP | Done | SSRF guard at creation and at send (DNS re-resolution) (partner-flow). |
| AT-44 Full journey VI/EN | Done | E2E journey in English; locale mail + error keys verified across suites (M7). |
| AT-45 Catalog missing EN, UI EN | Partial | Fallback translation serves (vi fallback join); fallback detail pages are noindexed. Fallback is not labelled on catalog cards. |
| AT-46 Locale change at partner checkout | Partial | Order is built from the quote snapshot, so money and partner survive a locale change; but the partner order locale is fixed to vi, not the checkout locale. |
| AT-47 Restore to another node | Partial | Backup + staged restore + checksum + smoke pass on the same node (hosting-flow). Cross-node restore not run (local runtime only). |
| AT-48 Incompatible DB upgrade | Gap | No startup schema-compatibility gate; procedure is restore-from-backup (RUNBOOK §6), not a simple app rollback. |
| AT-49 Clone from home machine | Done | Docs + reproduce sequence + CI workflow; CI not yet run on GitHub (P1). |
| AT-50 Keyboard/mobile/long strings | Partial | Forms are standard labelled inputs with responsive rules; no live-browser pass at 360/390/768/1440 (deferred, see below). |
| AT-51 Stale ETag PATCH | Done | If-Match required; stale row_version returns 412 (admin templates/content tests). |
| AT-52 Paid-but-pending alert | Gap | No alert channel wired; jobs are visible in admin jobs view (RUNBOOK §7, P2). |
| AT-53 Export without source license | Partial | Exports are scoped to the owner's site directory; no license-aware source filter (REQ-29 note). |
| AT-54 Asset with unclear rights | Partial | Uploader rights-confirmation gate; no per-asset rights registry (REQ-30 note). |
| AT-55 XSS demo / postMessage | Done | Sandboxed iframe without allow-same-origin, separate origin, HttpOnly cookies; no postMessage listener on the portal. |
| AT-56 Refund failed then confirmed | Done | Failed event leaves the refund failed; later confirmed event applies exactly once (refund-flow). |
| AT-57 GitHub push, new source | Done | Webhook creates a new import/version; production (published version) does not auto-switch (M2/M6). |
| AT-58 Commercial ZIP scan | Done | Secret scan step flags secret files/patterns without returning values (detect tests). |
| AT-59 Download outside updates_until | Done | Download endpoint is pinned to the purchased version id — no other version can be fetched through it, and the purchased version stays available. A newer-version picker (eligible versions) is not built. |
| AT-60 Demo contact/payment/mail | Done | Demo sessions contain no payment or mail submission; buy links leave the demo (D03). |

## Open items register (no P0; P1 = production blockers)

- P1 Owner approval: selling policies, prices, commission rates (seeded
  10% / 14-day / 500,000 is a placeholder example).
- P1 CI: first green run on GitHub (workflow exists, actions SHA-pinned).
- P1 Providers: real payment, mail, DNS, storage configuration for
  production (sandbox/mock otherwise).
- P2 Alert channel for jobs/webhooks (RUNBOOK §7).
- P2 Webhook delivery worker (sends currently on test/admin action).
- P2 Remote mTLS runtime agent (local spawn only); real ACME issuance.
- P2 Production executor hardening: VM/unprivileged-uid builds,
  dependency-proxy allowlist (process-level isolation today).
- P2 Clean-VPS install drill (AT-20); cross-node restore drill (AT-47);
  per-asset rights registry (AT-54); license-aware export filter
  (AT-53); startup schema-compatibility gate (AT-48).
- P3 UI/UX visual pass at 360/390/768/1440 across docs/05 screen groups
  (see below); fallback labelling on catalog cards (AT-45); partner
  order locale following checkout locale (AT-46); IPv6/CAA error
  display (AT-26); promotion/cleanup race test (AT-12); setup-token
  page for self-host bundles if the spec's AT-21 reading is required.

## UI/UX visual review note (deferred to parent)

The visual review across all docs/05 screen groups at 360/390/768/1440
needs a live browser (login, upload, import-ready, demo iframe, no
horizontal overflow at 360 px). This session cannot operate a live
browser, so that pass is NOT claimed here. What was verified statically:
skip link, landmarks, labelled forms/images, responsive `@media`
rules, and loading/error/empty states on every page built in M4–M7.
Delegation needed: a browser-capable agent should run the app, walk
each screen group at the four widths, capture overflow/keyboard issues,
and polish layout — referencing other marketplace/SaaS/checkout sites
for layout ideas without copying their content, brand, or code.
