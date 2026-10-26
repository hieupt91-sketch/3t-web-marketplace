-- M6 partner: accounts, keys, checkout sessions, attribution, commission ledger,
-- payouts, webhook endpoints/deliveries. Ledger is append-only (same guard as audit_logs).
CREATE TABLE partner_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  rate_bps integer NOT NULL CHECK (rate_bps BETWEEN 0 AND 10000),
  hold_days integer NOT NULL DEFAULT 14 CHECK (hold_days >= 0),
  payout_min_minor bigint NOT NULL DEFAULT 500000 CHECK (payout_min_minor >= 0),
  applies_to text NOT NULL DEFAULT 'new' CHECK (applies_to IN ('new', 'renewal', 'both')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Placeholder commercial rate (docs/06 §7 example). The owner must confirm real
-- rates before any real selling (M8 owner approval); nothing here is a price promise.
INSERT INTO partner_policies (code, rate_bps, hold_days, payout_min_minor, applies_to)
VALUES ('default', 1000, 14, 500000, 'new') ON CONFLICT (code) DO NOTHING;

CREATE TABLE partner_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES users(id),
  code text NOT NULL UNIQUE,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  channel text NOT NULL DEFAULT '' CHECK (length(channel) <= 500),
  domain text NOT NULL DEFAULT '' CHECK (length(domain) <= 253),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'rejected', 'suspended')),
  terms_version text NOT NULL DEFAULT '',
  locale text NOT NULL DEFAULT 'vi' CHECK (locale IN ('vi', 'en')),
  timezone text NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  policy_id uuid REFERENCES partner_policies(id),
  return_domains text[] NOT NULL DEFAULT '{}',
  reviewed_by uuid REFERENCES users(id),
  review_reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER partner_accounts_touch BEFORE UPDATE ON partner_accounts FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE partner_api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partner_accounts(id),
  prefix text NOT NULL,
  key_hash text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX partner_api_keys_prefix_idx ON partner_api_keys (prefix);

CREATE TABLE checkout_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partner_accounts(id),
  quote_id uuid NOT NULL REFERENCES quotes(id),
  external_reference text NOT NULL,
  return_url text NOT NULL DEFAULT '',
  campaign text NOT NULL DEFAULT '',
  locale text NOT NULL DEFAULT 'vi' CHECK (locale IN ('vi', 'en')),
  status text NOT NULL DEFAULT 'awaiting_buyer' CHECK (status IN ('awaiting_buyer', 'claimed', 'completed', 'expired', 'cancelled')),
  claim_token_hash text,
  buyer_id uuid REFERENCES users(id),
  order_id uuid REFERENCES orders(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (partner_id, external_reference)
);

CREATE TABLE attributions (
  order_id uuid PRIMARY KEY REFERENCES orders(id),
  partner_id uuid NOT NULL REFERENCES partner_accounts(id),
  source text NOT NULL CHECK (source IN ('session', 'link')),
  policy_snapshot jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE commission_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partner_accounts(id),
  order_id uuid NOT NULL REFERENCES orders(id),
  order_item_id uuid NOT NULL REFERENCES order_items(id),
  kind text NOT NULL CHECK (kind IN ('accrued', 'eligible', 'reserved', 'paid', 'reversal', 'adjustment')),
  status text NOT NULL CHECK (status IN ('pending', 'eligible', 'reserved', 'paid', 'reversed')),
  amount_minor bigint NOT NULL,
  base_minor bigint NOT NULL DEFAULT 0,
  rate_bps integer NOT NULL DEFAULT 0,
  policy_version text NOT NULL DEFAULT 'default',
  eligible_at timestamptz,
  related_entry_id uuid REFERENCES commission_entries(id),
  reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX commission_entries_partner_idx ON commission_entries (partner_id, created_at DESC);
CREATE INDEX commission_entries_order_idx ON commission_entries (order_id);
-- One accrual per order item: settlement is idempotent, so a second accrual
-- attempt for the same item is a no-op rather than double commission.
CREATE UNIQUE INDEX commission_entries_accrual_uq ON commission_entries (order_id, order_item_id) WHERE kind = 'accrued';
CREATE TRIGGER commission_entries_append_only BEFORE UPDATE OR DELETE ON commission_entries FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE payout_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partner_accounts(id),
  account_label text NOT NULL CHECK (length(account_label) BETWEEN 1 AND 120),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payout_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partner_accounts(id),
  profile_id uuid NOT NULL REFERENCES payout_profiles(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'processing', 'paid', 'failed')),
  evidence_ref text,
  approved_by uuid REFERENCES users(id),
  settled_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER payout_requests_touch BEFORE UPDATE ON payout_requests FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE payout_allocations (
  payout_id uuid NOT NULL REFERENCES payout_requests(id),
  entry_id uuid NOT NULL REFERENCES commission_entries(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  PRIMARY KEY (payout_id, entry_id)
);

CREATE TABLE webhook_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partner_accounts(id),
  url text NOT NULL CHECK (length(url) BETWEEN 1 AND 1000),
  events text[] NOT NULL DEFAULT '{}',
  secret_hash text NOT NULL,
  -- AES-256-GCM ciphertext of the signing secret: the platform must re-sign
  -- every event with it, so a one-way hash alone cannot work. The key is the
  -- server-side PARTNER_WEBHOOK_KEY (never stored in the database).
  secret_enc text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id uuid NOT NULL REFERENCES webhook_endpoints(id),
  event_id text NOT NULL,
  event_type text NOT NULL,
  payload_json jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed', 'dead')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  response_status integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (endpoint_id, event_id)
);
CREATE INDEX webhook_deliveries_endpoint_idx ON webhook_deliveries (endpoint_id, created_at DESC);
