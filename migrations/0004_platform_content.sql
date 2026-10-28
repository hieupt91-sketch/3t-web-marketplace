-- 0004 platform content: CMS pages (help/how-it-works/partners), policy versions, contact requests
-- (docs/02 §5, docs/04 §11, P05-P09). Content locales are published independently (docs/07).

-- Static/help pages managed by the content team ------------------------------------------------

CREATE TABLE platform_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  kind text NOT NULL DEFAULT 'page' CHECK (kind IN ('page', 'help')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  row_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_pages_slug_uq UNIQUE (slug)
);
CREATE TRIGGER platform_pages_touch BEFORE UPDATE ON platform_pages FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE platform_page_translations (
  page_id uuid NOT NULL REFERENCES platform_pages(id),
  locale text NOT NULL CHECK (locale IN ('vi', 'en')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  -- Body is a restricted markdown subset, rendered with HTML escaped (docs/05 RichText).
  body text NOT NULL DEFAULT '',
  seo_title text,
  seo_description text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'reviewed', 'published', 'stale')),
  source_revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, locale)
);
CREATE TRIGGER platform_page_translations_touch BEFORE UPDATE ON platform_page_translations FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Legal policy documents: a version is immutable once published; orders snapshot the version used.

CREATE TABLE policy_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL CHECK (code ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  version text NOT NULL CHECK (length(version) BETWEEN 1 AND 40),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  effective_at timestamptz,
  body_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT policy_versions_code_version_uq UNIQUE (code, version)
);
CREATE INDEX policy_versions_effective_idx ON policy_versions (code, effective_at DESC) WHERE status = 'published';

CREATE TABLE policy_translations (
  policy_version_id uuid NOT NULL REFERENCES policy_versions(id),
  locale text NOT NULL CHECK (locale IN ('vi', 'en')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body text NOT NULL DEFAULT '',
  review_status text NOT NULL DEFAULT 'draft' CHECK (review_status IN ('draft', 'reviewed', 'published', 'stale')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (policy_version_id, locale)
);
CREATE TRIGGER policy_translations_touch BEFORE UPDATE ON policy_translations FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- A published policy version is immutable; only draft → published transition and effective_at set.
CREATE FUNCTION policy_versions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'published policy versions are immutable' USING ERRCODE = 'P0001'; END IF;
  IF OLD.status = 'published' AND (NEW.code <> OLD.code OR NEW.version <> OLD.version OR NEW.body_hash IS DISTINCT FROM OLD.body_hash) THEN
    RAISE EXCEPTION 'published policy versions are immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER policy_versions_immutable BEFORE UPDATE OR DELETE ON policy_versions FOR EACH ROW EXECUTE FUNCTION policy_versions_guard();

-- Public contact requests (P09): consent + spam status retained, no account implied.

CREATE TABLE contact_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  locale text NOT NULL DEFAULT 'vi' CHECK (locale IN ('vi', 'en')),
  consent_version text NOT NULL,
  spam_status text NOT NULL DEFAULT 'ok' CHECK (spam_status IN ('ok', 'suspected')),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'read', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contact_requests_created_idx ON contact_requests (created_at DESC);
