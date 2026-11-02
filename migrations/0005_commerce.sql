-- 0005 commerce: quotes, orders, payments, entitlements, downloads (docs/02 §5-6, docs/04 §3, docs/08).
-- Money is integer minor units + ISO currency; totals are derived and constrained, never trusted
-- from the client (docs/02 §4, invariant §6.1). Payment state comes from verified events only.

CREATE TABLE quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id uuid REFERENCES users(id),
  partner_id uuid,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor >= 0),
  discount_minor bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  tax_minor bigint NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  snapshot_json jsonb NOT NULL,
  signature_hash text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quotes_total_matches CHECK (total_minor = subtotal_minor - discount_minor + tax_minor)
);
CREATE INDEX quotes_buyer_idx ON quotes (buyer_id, created_at DESC);

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id uuid NOT NULL REFERENCES users(id),
  quote_id uuid NOT NULL REFERENCES quotes(id),
  partner_id uuid,
  status text NOT NULL DEFAULT 'awaiting_payment' CHECK (status IN (
    'awaiting_payment', 'paid', 'cancelled', 'expired', 'needs_reconciliation',
    'refund_pending', 'partially_refunded', 'refunded')),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor >= 0),
  discount_minor bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  tax_minor bigint NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  locale text NOT NULL DEFAULT 'vi' CHECK (locale IN ('vi', 'en')),
  terms_version text NOT NULL,
  payment_window_expires_at timestamptz,
  paid_at timestamptz,
  row_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orders_total_matches CHECK (total_minor = subtotal_minor - discount_minor + tax_minor)
);
CREATE INDEX orders_buyer_idx ON orders (buyer_id, created_at DESC);
CREATE INDEX orders_status_idx ON orders (status) WHERE status = 'awaiting_payment';
CREATE TRIGGER orders_touch BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  template_id uuid NOT NULL REFERENCES templates(id),
  version_id uuid NOT NULL REFERENCES template_versions(id),
  plan_id uuid NOT NULL REFERENCES plans(id),
  deployment_mode text NOT NULL CHECK (deployment_mode IN ('selfhost', 'hosted')),
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity = 1),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  discount_minor bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  tax_minor bigint NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  snapshot_json jsonb NOT NULL
);
CREATE INDEX order_items_order_idx ON order_items (order_id);

CREATE TABLE payment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  provider text NOT NULL,
  provider_ref text,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'pending', 'settled', 'failed', 'cancelled')),
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_attempts_ref_uq UNIQUE (provider, provider_ref)
);
CREATE INDEX payment_attempts_order_idx ON payment_attempts (order_id);

-- Verified provider events; dedupe is by (provider, provider_event_id) long-term (docs/08 §1).
CREATE TABLE payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  raw_body_hash text NOT NULL,
  order_id uuid REFERENCES orders(id),
  received_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  processing_status text NOT NULL DEFAULT 'received' CHECK (processing_status IN ('received', 'processed', 'ignored', 'needs_reconciliation')),
  CONSTRAINT payment_events_provider_event_uq UNIQUE (provider, provider_event_id)
);

-- One entitlement per order item (invariant §6.3): a duplicated payment event cannot duplicate it.
CREATE TABLE entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_item_id uuid NOT NULL REFERENCES order_items(id),
  user_id uuid NOT NULL REFERENCES users(id),
  template_id uuid NOT NULL REFERENCES templates(id),
  version_id uuid NOT NULL REFERENCES template_versions(id),
  mode text NOT NULL CHECK (mode IN ('selfhost', 'hosted')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'suspended', 'revoked', 'expired')),
  instance_limit integer NOT NULL DEFAULT 1 CHECK (instance_limit >= 1),
  updates_until timestamptz,
  runtime_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  row_version integer NOT NULL DEFAULT 1,
  CONSTRAINT entitlements_order_item_uq UNIQUE (order_item_id)
);
CREATE INDEX entitlements_user_idx ON entitlements (user_id, created_at DESC);
CREATE TRIGGER entitlements_touch BEFORE UPDATE ON entitlements FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Short-lived download grants redeemed through a gateway; the token is stored hashed (docs/04 §3).
CREATE TABLE download_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entitlement_id uuid NOT NULL REFERENCES entitlements(id),
  artifact_id uuid NOT NULL REFERENCES artifacts(id),
  version_id uuid NOT NULL REFERENCES template_versions(id),
  user_id uuid NOT NULL REFERENCES users(id),
  token_hash bytea NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz,
  expires_at timestamptz NOT NULL,
  CONSTRAINT download_events_token_uq UNIQUE (token_hash)
);
CREATE INDEX download_events_entitlement_idx ON download_events (entitlement_id, issued_at DESC);
