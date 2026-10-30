-- 0029 Storefront pageview statistics (owner request, 2026-10-30).
--
-- First-party, privacy-light analytics for the admin Statistics page:
-- the storefront sends one beacon per page view and the API stores only
-- the path, an optional template slug, and a daily-rotating visitor hash
-- (sha256 of ip + user-agent + date). Raw IP addresses are never stored,
-- and the hash changes every day so visitors cannot be tracked across
-- days.
CREATE TABLE IF NOT EXISTS pageviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  path text NOT NULL,
  template_slug text,
  visitor_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pageviews_created_idx ON pageviews (created_at DESC);
CREATE INDEX IF NOT EXISTS pageviews_path_idx ON pageviews (path);
