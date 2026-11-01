-- v28 partner wallet (docs/06 §11): reseller model next to the referral
-- commission model. The owner sets a discount cut on the listed retail
-- price per partner policy; partners set their own selling prices freely,
-- top the wallet up in advance, and each direct sale deducts the cost
-- (listed - cut) from the wallet automatically.
ALTER TABLE partner_policies
  ADD COLUMN reseller_discount_bps integer NOT NULL DEFAULT 1000
  CHECK (reseller_discount_bps BETWEEN 0 AND 9000);

CREATE TABLE partner_wallets (
  partner_id uuid PRIMARY KEY REFERENCES partner_accounts(id),
  balance_minor bigint NOT NULL DEFAULT 0 CHECK (balance_minor >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER partner_wallets_touch BEFORE UPDATE ON partner_wallets
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Append-only wallet ledger: credits positive, debits negative.
CREATE TABLE partner_wallet_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partner_accounts(id),
  kind text NOT NULL CHECK (kind IN ('topup', 'sale_deduction', 'sale_refund', 'adjustment')),
  amount_minor bigint NOT NULL CHECK (amount_minor <> 0),
  balance_after_minor bigint NOT NULL CHECK (balance_after_minor >= 0),
  ref_type text NOT NULL DEFAULT '',
  ref_id uuid,
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX partner_wallet_entries_partner_idx ON partner_wallet_entries (partner_id, created_at DESC);
CREATE TRIGGER partner_wallet_entries_append_only BEFORE UPDATE OR DELETE ON partner_wallet_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- A top-up is the partner's own bank transfer carrying a WT content code;
-- bank webhooks settle it straight into the wallet.
CREATE TABLE partner_topups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partner_accounts(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  paid_amount_minor bigint,
  code text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz
);
CREATE INDEX partner_topups_partner_idx ON partner_topups (partner_id, created_at DESC);

-- The partner's own selling price per plan; no row = the listed price.
CREATE TABLE partner_prices (
  partner_id uuid NOT NULL REFERENCES partner_accounts(id),
  plan_id uuid NOT NULL REFERENCES plans(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (partner_id, plan_id)
);
CREATE TRIGGER partner_prices_touch BEFORE UPDATE ON partner_prices
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- One row per wallet direct sale: the audit trail linking wallet debit,
-- order and buyer, and the dedupe key for partner retries.
CREATE TABLE partner_wallet_sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partner_accounts(id),
  order_id uuid UNIQUE REFERENCES orders(id),
  external_reference text NOT NULL CHECK (length(external_reference) BETWEEN 1 AND 200),
  buyer_id uuid NOT NULL REFERENCES users(id),
  plan_id uuid NOT NULL REFERENCES plans(id),
  listed_minor bigint NOT NULL,
  cut_bps integer NOT NULL,
  cost_minor bigint NOT NULL,
  price_minor bigint NOT NULL,
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'refunded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (partner_id, external_reference)
);
