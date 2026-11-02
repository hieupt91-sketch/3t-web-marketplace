-- v46 (audit UI-HIGH-01 / code M-04): a demo session is bound to an
-- anonymous owner identity — only the SHA-256 hash of a bearer token
-- (HttpOnly cookie mp_demo_owner, minted at first demo create) is
-- stored, so reset / cancel / admin-launch can verify the caller is
-- the browser that started the demo. last_reset_at drives the
-- per-session reset cooldown on top of the route rate limit.
ALTER TABLE demo_sessions ADD COLUMN owner_token_hash bytea;
ALTER TABLE demo_sessions ADD COLUMN last_reset_at timestamptz;
