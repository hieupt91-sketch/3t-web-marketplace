-- M7: MFA, step-up, shared-store rate limiting.
-- Shared rate-limit buckets: one row per (store namespace + key). The
-- fixed-window upsert in the store is atomic, so every API instance counts
-- against the same rows (M1 debt: single-process in-memory limits).
CREATE TABLE rate_limit_buckets (
  key text PRIMARY KEY,
  window_start_ms bigint NOT NULL,
  count integer NOT NULL CHECK (count >= 0)
);

-- Step-up: a session earns a short-lived elevation by re-authenticating.
ALTER TABLE sessions ADD COLUMN step_up_at timestamptz;

-- MFA: one TOTP method per user. The secret is AES-256-GCM encrypted with
-- the server-side PARTNER_WEBHOOK_KEY-equivalent MFA key (MFA_KEY env); the
-- hash column is for lookup-free verification bookkeeping only.
CREATE TABLE user_mfa (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  secret_enc text NOT NULL,
  verified_at timestamptz,
  backup_codes_hash text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Pending MFA login challenges: a login with verified MFA returns a
-- challenge token instead of a session; the token is single-use, 5 minutes.
CREATE TABLE mfa_challenges (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
