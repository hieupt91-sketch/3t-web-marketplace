-- 0001 foundation: identity/RBAC, catalog drafts, ingestion, jobs/outbox, idempotency, audit.
-- Forward-only policy: a released migration is never edited; corrections ship as a new file
-- (see migrations/README.md). All timestamps are timestamptz stored in UTC.


-- Shared trigger helpers ------------------------------------------------------------------

CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only table %: % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'P0001';
END $$;

-- Identity ---------------------------------------------------------------------------------

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_normalized text NOT NULL,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  password_hash text,
  verified_at timestamptz,
  preferred_locale text NOT NULL DEFAULT 'vi' CHECK (preferred_locale IN ('vi', 'en')),
  timezone text NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'locked', 'disabled')),
  row_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_normalized_uq UNIQUE (email_normalized),
  CONSTRAINT users_email_lower CHECK (email_normalized = lower(email_normalized))
);
CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  token_hash bytea NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT sessions_token_hash_uq UNIQUE (token_hash)
);
CREATE INDEX sessions_user_idx ON sessions (user_id, expires_at);

CREATE TABLE auth_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  purpose text NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  token_hash bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_tokens_hash_uq UNIQUE (token_hash)
);
CREATE INDEX auth_tokens_user_purpose_idx ON auth_tokens (user_id, purpose) WHERE used_at IS NULL AND revoked_at IS NULL;

CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  description text NOT NULL
);

CREATE TABLE permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE
);

CREATE TABLE user_roles (
  user_id uuid NOT NULL REFERENCES users(id),
  role_id uuid NOT NULL REFERENCES roles(id),
  granted_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE role_permissions (
  role_id uuid NOT NULL REFERENCES roles(id),
  permission_id uuid NOT NULL REFERENCES permissions(id),
  PRIMARY KEY (role_id, permission_id)
);

-- Settings (non-secret values only; secrets are references) ---------------------------------

CREATE TABLE settings (
  key text PRIMARY KEY,
  value_json jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Artifacts and catalog -------------------------------------------------------------------

CREATE TABLE artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_key text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  media_type text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('source_archive', 'static_site', 'screenshot')),
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private')),
  retention_class text NOT NULL CHECK (retention_class IN ('permanent', 'standard', 'short')),
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT artifacts_object_key_uq UNIQUE (object_key)
);
CREATE TRIGGER artifacts_immutable BEFORE UPDATE OR DELETE ON artifacts FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE template_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  parent_id uuid REFERENCES template_categories(id),
  CONSTRAINT template_categories_not_self CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE TABLE templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL CHECK (slug ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'),
  owner_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  category_id uuid REFERENCES template_categories(id),
  published_version_id uuid,
  row_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT templates_slug_uq UNIQUE (slug)
);
CREATE INDEX templates_status_idx ON templates (status, category_id);
CREATE TRIGGER templates_touch BEFORE UPDATE ON templates FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE template_translations (
  template_id uuid NOT NULL REFERENCES templates(id),
  locale text NOT NULL CHECK (locale IN ('vi', 'en')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  summary text,
  description text,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  seo_title text,
  seo_description text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'reviewed', 'published', 'stale')),
  source_revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (template_id, locale),
  CONSTRAINT template_translations_locale_slug_uq UNIQUE (locale, slug)
);
CREATE TRIGGER template_translations_touch BEFORE UPDATE ON template_translations FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE template_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES templates(id),
  semver text NOT NULL CHECK (semver ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$'),
  schema_version integer NOT NULL CHECK (schema_version = 1),
  manifest_json jsonb NOT NULL,
  adapter text NOT NULL,
  source_sha text NOT NULL CHECK (source_sha ~ '^[0-9a-f]{64}$'),
  source_artifact_id uuid NOT NULL REFERENCES artifacts(id),
  artifact_id uuid NOT NULL REFERENCES artifacts(id),
  import_id uuid,
  status text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'published', 'withdrawn')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT template_versions_semver_uq UNIQUE (template_id, semver)
);

-- Versions are immutable once ready: only status may move forward (ADR-003, invariant 8).
CREATE FUNCTION template_versions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'template_versions are immutable' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.template_id <> OLD.template_id OR NEW.semver <> OLD.semver OR NEW.manifest_json <> OLD.manifest_json
     OR NEW.source_sha <> OLD.source_sha OR NEW.artifact_id <> OLD.artifact_id
     OR NEW.source_artifact_id <> OLD.source_artifact_id OR NEW.adapter <> OLD.adapter THEN
    RAISE EXCEPTION 'template_versions are immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER template_versions_immutable BEFORE UPDATE OR DELETE ON template_versions
  FOR EACH ROW EXECUTE FUNCTION template_versions_guard();

ALTER TABLE templates ADD CONSTRAINT templates_published_version_fk
  FOREIGN KEY (published_version_id) REFERENCES template_versions(id);

CREATE TABLE template_capabilities (
  version_id uuid NOT NULL REFERENCES template_versions(id),
  capability text NOT NULL,
  config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (version_id, capability)
);

-- Ingestion --------------------------------------------------------------------------------

CREATE TABLE upload_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL REFERENCES users(id),
  filename text NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
  declared_size bigint NOT NULL CHECK (declared_size > 0),
  declared_sha256 text NOT NULL CHECK (declared_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'uploaded', 'consumed', 'failed')),
  quarantine_key text,
  failure_code text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER upload_sessions_touch BEFORE UPDATE ON upload_sessions FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL REFERENCES users(id),
  source_kind text NOT NULL CHECK (source_kind IN ('zip', 'github')),
  upload_session_id uuid REFERENCES upload_sessions(id),
  source_artifact_id uuid REFERENCES artifacts(id),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  name_hint text NOT NULL,
  repo_id text,
  commit_sha text,
  subdir text,
  status text NOT NULL DEFAULT 'received' CHECK (status IN (
    'received', 'inspecting', 'needs_configuration', 'queued', 'building', 'provisioning',
    'validating', 'ready', 'failed', 'rejected', 'cancelled')),
  detected_adapter text,
  detection_json jsonb,
  inspection_json jsonb,
  effective_manifest_json jsonb,
  config_overrides_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  config_revision integer NOT NULL DEFAULT 0,
  error_code text,
  errors_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  template_id uuid REFERENCES templates(id),
  version_id uuid REFERENCES template_versions(id),
  cancel_requested_at timestamptz,
  row_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT imports_upload_session_uq UNIQUE (upload_session_id),
  CONSTRAINT imports_source_ref CHECK (
    (source_kind = 'zip' AND upload_session_id IS NOT NULL) OR
    (source_kind = 'github' AND repo_id IS NOT NULL AND commit_sha IS NOT NULL))
);
CREATE INDEX imports_created_idx ON imports (created_at DESC);
CREATE TRIGGER imports_touch BEFORE UPDATE ON imports FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

ALTER TABLE template_versions ADD CONSTRAINT template_versions_import_fk FOREIGN KEY (import_id) REFERENCES imports(id);

CREATE TABLE import_steps (
  import_id uuid NOT NULL REFERENCES imports(id),
  step text NOT NULL,
  position integer NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'skipped')),
  attempt integer NOT NULL DEFAULT 0,
  started_at timestamptz,
  finished_at timestamptz,
  error_code text,
  detail_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (import_id, step)
);

CREATE TABLE import_logs (
  id bigserial PRIMARY KEY,
  import_id uuid NOT NULL REFERENCES imports(id),
  step text,
  level text NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  code text NOT NULL,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX import_logs_import_idx ON import_logs (import_id, id);

CREATE TABLE build_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id uuid NOT NULL REFERENCES imports(id),
  attempt integer NOT NULL,
  adapter text NOT NULL,
  adapter_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  artifact_id uuid REFERENCES artifacts(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT build_runs_attempt_uq UNIQUE (import_id, attempt)
);

-- Preview deployments of import/version artifacts, served on the separate preview origin.
CREATE TABLE previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_label text NOT NULL CHECK (host_label ~ '^[a-z0-9]{20,63}$'),
  import_id uuid NOT NULL REFERENCES imports(id),
  version_id uuid REFERENCES template_versions(id),
  artifact_id uuid NOT NULL REFERENCES artifacts(id),
  entry text NOT NULL,
  spa_fallback boolean NOT NULL DEFAULT false,
  visibility text NOT NULL DEFAULT 'draft' CHECK (visibility IN ('draft', 'public')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT previews_host_label_uq UNIQUE (host_label)
);
CREATE UNIQUE INDEX previews_active_import_uq ON previews (import_id) WHERE status = 'active';

-- Jobs, outbox, idempotency, audit -----------------------------------------------------------

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  payload_json jsonb NOT NULL,
  dedupe_key text NOT NULL,
  resource_type text,
  resource_id uuid,
  owner_id uuid REFERENCES users(id),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  next_run_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_until timestamptz,
  fencing_token bigint NOT NULL DEFAULT 0,
  step text,
  completed_steps integer NOT NULL DEFAULT 0,
  total_steps integer,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT jobs_dedupe_key_uq UNIQUE (dedupe_key)
);
CREATE INDEX jobs_runnable_idx ON jobs (status, next_run_at);
CREATE TRIGGER jobs_touch BEFORE UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  payload_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX outbox_unpublished_idx ON outbox_events (created_at) WHERE published_at IS NULL;

CREATE TABLE idempotency_records (
  principal_scope text NOT NULL,
  route text NOT NULL,
  key uuid NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('processing', 'completed')),
  response_status integer,
  response_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (principal_scope, route, key)
);
CREATE INDEX idempotency_expires_idx ON idempotency_records (expires_at);

CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'system', 'worker')),
  actor_id uuid,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid,
  trace_id text NOT NULL,
  diff_redacted jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_resource_idx ON audit_logs (resource_type, resource_id, created_at);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Seed: permissions and roles (docs/01 §1, docs/04 §5) -------------------------------------

INSERT INTO permissions (code) VALUES
  ('report:read'), ('template:read'), ('template:write'), ('template:import'), ('template:publish'),
  ('translation:read'), ('translation:write'), ('translation:publish'), ('pricing:write'),
  ('order:read'), ('payment:read'), ('payment:confirm'), ('payment:refund'),
  ('user:read'), ('user:manage'), ('site:read'), ('site:operate'), ('ops:read'), ('ops:execute'),
  ('audit:read'), ('settings:manage'), ('staff:manage'), ('partner:read'), ('partner:manage'),
  ('payout:read'), ('payout:approve'), ('payout:settle'), ('content:read'), ('content:write'),
  ('content:publish'), ('policy:manage'), ('support:read'), ('support:reply');

INSERT INTO roles (code, description) VALUES
  ('platform_owner', 'Chủ nền tảng — mọi quyền, thao tác nhạy cảm cần MFA/step-up'),
  ('template_editor', 'Biên tập mẫu — nhập tài nguyên, mô tả, bản dịch, giá nháp'),
  ('accountant', 'Kế toán — đối soát, hoàn tiền, hoa hồng, chi trả'),
  ('operations', 'Vận hành — build, demo, hosting, domain, backup'),
  ('support', 'Hỗ trợ — ticket và trạng thái đơn/site được phân công');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p WHERE r.code = 'platform_owner';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code = ANY (CASE r.code
  WHEN 'template_editor' THEN ARRAY['template:read', 'template:write', 'template:import', 'translation:read',
                                    'translation:write', 'pricing:write', 'content:read', 'content:write']
  WHEN 'accountant' THEN ARRAY['report:read', 'order:read', 'payment:read', 'payment:confirm', 'payment:refund',
                               'partner:read', 'payout:read', 'payout:approve', 'payout:settle']
  WHEN 'operations' THEN ARRAY['template:read', 'site:read', 'site:operate', 'ops:read', 'ops:execute', 'report:read']
  WHEN 'support' THEN ARRAY['support:read', 'support:reply', 'order:read', 'site:read', 'user:read']
  ELSE ARRAY[]::text[] END)
WHERE r.code <> 'platform_owner';

-- Seed: starting policies (docs/01 §5). Values are proposals the owner can change via settings.
INSERT INTO settings (key, value_json) VALUES
  ('import.policy', '{"max_upload_bytes": 104857600, "max_uncompressed_bytes": 524288000, "max_files": 20000,
                      "max_entry_bytes": 104857600, "max_compression_ratio": 200, "static_auto_continue": true,
                      "upload_session_ttl_minutes": 60}'::jsonb),
  ('demo.policy', '{"admin_ttl_hours": 24, "max_active_per_user_template": 1}'::jsonb),
  ('locale.registry', '{"default": "vi", "enabled": ["vi", "en"]}'::jsonb);
