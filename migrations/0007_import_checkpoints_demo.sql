-- 0007 import checkpoints (M2 retry), GitHub webhook dedupe, demo sessions (D02-D04).
-- Checkpoint: the worker saves its pipeline state here after each step from `detect`
-- onward. A retry restores state up to the checkpoint instead of re-running the whole
-- pipeline; steps before `record` still re-run their (cheap, deterministic) checks and
-- the build re-runs unless the site artifact is already recorded.

ALTER TABLE imports ADD COLUMN checkpoint_json jsonb;

-- Runtime bundles (node-http / next-standalone) are artifacts too.
ALTER TABLE artifacts DROP CONSTRAINT artifacts_kind_check;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_kind_check
  CHECK (kind IN ('source_archive', 'static_site', 'screenshot', 'runtime_bundle'));

-- GitHub push webhook deliveries, deduplicated by delivery id (at-least-once safe).
CREATE TABLE github_webhook_deliveries (
  delivery_id text PRIMARY KEY,
  repo text NOT NULL,
  commit_sha text NOT NULL,
  import_id uuid REFERENCES imports(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Isolated demo sessions (docs/03 §8, D02-D04). A session owns one demo: for static
-- adapters a preview row, for runtime adapters a spawned server (port recorded here).
-- content_kept tracks whether the visitor chose to keep demo content on purchase.
CREATE TABLE demo_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id uuid NOT NULL REFERENCES template_versions(id),
  user_id uuid REFERENCES users(id),
  preview_label text,
  runtime_port integer,
  runtime_pid integer,
  admin_token_hash bytea,
  admin_token_expires_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'cancelled')),
  content_kept boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX demo_sessions_version_idx ON demo_sessions (version_id, status);
CREATE INDEX demo_sessions_expires_idx ON demo_sessions (expires_at) WHERE status = 'active';
