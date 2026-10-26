-- M5 hosting: sites, members, deployments, domains, subscriptions, renewals, backups.
-- Paid-but-provision-failed keeps the entitlement: sites are never deleted on
-- provision failure (status provision_failed, same id retried by the owner).
ALTER TABLE artifacts DROP CONSTRAINT artifacts_kind_check;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_kind_check
  CHECK (kind IN ('source_archive', 'static_site', 'screenshot', 'runtime_bundle', 'site_backup'));

CREATE TABLE sites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id),
  entitlement_id uuid REFERENCES entitlements(id),
  template_version_id uuid NOT NULL REFERENCES template_versions(id),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  subdomain text CHECK (subdomain ~ '^[a-z0-9][a-z0-9-]{2,39}$'),
  default_locale text NOT NULL DEFAULT 'vi' CHECK (default_locale IN ('vi', 'en')),
  status text NOT NULL DEFAULT 'creating' CHECK (status IN ('creating', 'active', 'provision_failed', 'suspended', 'grace', 'delete_scheduled', 'purged')),
  previous_status text,
  demo_session_id uuid REFERENCES demo_sessions(id),
  runtime_kind text CHECK (runtime_kind IN ('static', 'runtime')),
  runtime_port integer CHECK (runtime_port IS NULL OR (runtime_port BETWEEN 1 AND 65535)),
  runtime_pid integer,
  node_id text NOT NULL DEFAULT 'local',
  purge_at timestamptz,
  row_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sites_subdomain_uq ON sites (subdomain) WHERE subdomain IS NOT NULL;
CREATE INDEX sites_owner_idx ON sites (owner_id, status);
CREATE INDEX sites_entitlement_idx ON sites (entitlement_id) WHERE entitlement_id IS NOT NULL;
CREATE TRIGGER sites_touch BEFORE UPDATE ON sites FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE site_members (
  site_id uuid NOT NULL REFERENCES sites(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('owner', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, user_id)
);

CREATE TABLE backups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id),
  artifact_id uuid REFERENCES artifacts(id),
  kind text NOT NULL DEFAULT 'backup' CHECK (kind IN ('backup', 'export')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  checksum text,
  schema_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz
);
CREATE INDEX backups_site_idx ON backups (site_id, created_at DESC);

CREATE TABLE deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id),
  version_id uuid NOT NULL REFERENCES template_versions(id),
  artifact_id uuid NOT NULL REFERENCES artifacts(id),
  backup_id uuid REFERENCES backups(id),
  operation text NOT NULL CHECK (operation IN ('provision', 'update', 'rollback', 'restore')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  previous_deployment_id uuid REFERENCES deployments(id),
  job_id uuid REFERENCES jobs(id),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX deployments_site_idx ON deployments (site_id, created_at DESC);

CREATE TABLE domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id),
  hostname_ascii text NOT NULL CHECK (length(hostname_ascii) BETWEEN 1 AND 253),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'released')),
  verification_token_hash text NOT NULL,
  verified_at timestamptz,
  last_verify_at timestamptz,
  is_primary boolean NOT NULL DEFAULT false,
  cert_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX domains_hostname_active_uq ON domains (hostname_ascii) WHERE status IN ('pending', 'verified');
CREATE UNIQUE INDEX domains_primary_uq ON domains (site_id) WHERE is_primary;
CREATE INDEX domains_site_idx ON domains (site_id, created_at DESC);

CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id),
  plan_id uuid NOT NULL REFERENCES plans(id),
  current_period_start timestamptz NOT NULL,
  current_period_end timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'grace', 'suspended', 'cancelled')),
  policy_snapshot jsonb NOT NULL DEFAULT '{"period_days": 365, "grace_days": 7, "retention_days": 30}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX subscriptions_active_site_uq ON subscriptions (site_id) WHERE status = 'active';
CREATE TRIGGER subscriptions_touch BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE renewal_applications (
  order_item_id uuid PRIMARY KEY REFERENCES order_items(id),
  subscription_id uuid NOT NULL REFERENCES subscriptions(id),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

