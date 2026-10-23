-- 0002 catalog pricing: plans and effective-dated prices (docs/02 §5, docs/08).
-- Prices are integer minor units + ISO currency; language never changes currency (docs/02 §4).

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES templates(id),
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'),
  deployment_mode text NOT NULL CHECK (deployment_mode IN ('selfhost', 'hosted')),
  name_json jsonb NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  -- selfhost: {instance_limit, updates_months, support_months}
  -- hosted:   {instance_limit, storage_mb, grace_days, retention_days}
  limits_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  row_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plans_template_code_uq UNIQUE (template_id, code)
);
CREATE INDEX plans_template_idx ON plans (template_id, status);
CREATE TRIGGER plans_touch BEFORE UPDATE ON plans FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE plan_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES plans(id),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  interval text NOT NULL CHECK (interval IN ('one_time', 'monthly', 'yearly')),
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plan_prices_range CHECK (effective_to IS NULL OR effective_to > effective_from),
  -- No two prices for the same plan/currency/interval may cover the same instant (docs/02 §5).
  CONSTRAINT plan_prices_no_overlap EXCLUDE USING gist (
    plan_id WITH =, currency WITH =, interval WITH =,
    tstzrange(effective_from, effective_to) WITH &&
  )
);
CREATE INDEX plan_prices_current_idx ON plan_prices (plan_id, currency, interval, effective_from DESC);

-- Terms version snapshotted onto orders at purchase time (docs/04 §3). Owner changes it via settings.
INSERT INTO settings (key, value_json) VALUES ('terms.version', '{"current": "terms-2026-10"}'::jsonb);
