-- 0046: visual-edit sessions for hosted STATIC sites (phase 2 of the
-- one-time setup model, 0045). A static site has no admin, so the buyer
-- who bought the installation package may spend their single setup
-- right in one of two doors: the order-page form (0045) or this visual
-- editor, which opens the live site with the demo (seed) strings made
-- replaceable in place. Whichever door finishes first claims the right
-- on the service task (setup_info_submitted_at); this table only carries
-- the editor's short-lived authorization + the candidate snapshot:
--   token_hash      — sha256 hex of the one-time entry token (the
--                     plaintext is shown exactly once, in the mint
--                     response; the router validates the cookie copy);
--   candidates_json — the seed strings/images extracted from the
--                     dynamic twin's seed at mint time and verified to
--                     be present in the static bundle's HTML, so the
--                     router can validate a finalize payload without
--                     reading template storage;
--   job_id          — the site.visual_edit_apply job the finalize
--                     enqueued (worker re-verifies the task claim
--                     before touching any file);
--   consumed_at     — stamped by the finalize claim; a session can
--                     finalize at most once and expires after 2 hours
--                     regardless (expires_at).
CREATE TABLE site_edit_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id),
  buyer_id uuid NOT NULL REFERENCES users(id),
  task_id uuid NOT NULL REFERENCES service_tasks(id),
  token_hash text NOT NULL UNIQUE,
  candidates_json jsonb NOT NULL,
  job_id uuid REFERENCES jobs(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX site_edit_sessions_site_idx ON site_edit_sessions (site_id, created_at DESC);
