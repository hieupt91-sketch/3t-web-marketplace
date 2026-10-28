-- 0006 commerce refunds + reconciliation (docs/02 §5-6, docs/04 §3, AT-56).
-- Also fixes a latent 0005 bug: entitlements has an entitlements_touch trigger that
-- writes NEW.updated_at, but the table had no updated_at column, so any entitlement
-- UPDATE (e.g. revocation on full refund) failed with 42703. No code updated
-- entitlements before refunds, which is why it never fired.

ALTER TABLE entitlements ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
-- A refund is requested by the buyer, approved/rejected by staff (payment:refund),
-- then settled by a verified provider event. Provider refund events are deduplicated
-- long-term like payment events, so a failed-then-confirmed sequence reverses the
-- order exactly once (AT-56). Raw provider payloads are never stored, only hashes.

CREATE TABLE refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id),
  buyer_id uuid NOT NULL REFERENCES users(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reason text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'requested' CHECK (status IN (
    'requested', 'pending', 'confirmed', 'failed', 'rejected')),
  provider text NOT NULL DEFAULT 'mock',
  provider_ref text,
  requested_by uuid REFERENCES users(id),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refunds_provider_ref_uq UNIQUE (provider, provider_ref)
);
CREATE INDEX refunds_order_idx ON refunds (order_id, created_at DESC);
CREATE INDEX refunds_status_idx ON refunds (status);
CREATE TRIGGER refunds_touch BEFORE UPDATE ON refunds FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Verified provider refund events; dedupe by (provider, provider_event_id).
CREATE TABLE refund_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  refund_id uuid REFERENCES refunds(id),
  raw_body_hash text NOT NULL,
  processing_status text NOT NULL DEFAULT 'received' CHECK (processing_status IN ('received', 'processed', 'ignored')),
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refund_events_provider_event_uq UNIQUE (provider, provider_event_id)
);
CREATE INDEX refund_events_refund_idx ON refund_events (refund_id);
