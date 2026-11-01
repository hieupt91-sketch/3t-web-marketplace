-- v29: the partner wallet runs on POINTS — 1 point = 1,000 VND — so
-- partners work with small round numbers. VND stays the settlement
-- currency underneath: a top-up transfers points x 1,000 VND, a sale's
-- order total is price_points x 1,000 VND, and the exact VND cost is
-- kept on the sale row for accounting. Wallet tables were created in
-- 0035 and are still empty in production; conversions divide by 1000
-- defensively for any environment that already has rows.
ALTER TABLE partner_wallets ADD COLUMN balance_points bigint NOT NULL DEFAULT 0 CHECK (balance_points >= 0);
UPDATE partner_wallets SET balance_points = balance_minor / 1000;
ALTER TABLE partner_wallets DROP COLUMN balance_minor;

-- The entries ledger is append-only; lift the guard just for the backfill.
DROP TRIGGER partner_wallet_entries_append_only ON partner_wallet_entries;
ALTER TABLE partner_wallet_entries ADD COLUMN amount_points bigint;
ALTER TABLE partner_wallet_entries ADD COLUMN balance_after_points bigint;
UPDATE partner_wallet_entries SET amount_points = amount_minor / 1000, balance_after_points = balance_after_minor / 1000;
ALTER TABLE partner_wallet_entries ALTER COLUMN amount_points SET NOT NULL;
ALTER TABLE partner_wallet_entries ALTER COLUMN balance_after_points SET NOT NULL;
ALTER TABLE partner_wallet_entries ADD CHECK (amount_points <> 0);
ALTER TABLE partner_wallet_entries ADD CHECK (balance_after_points >= 0);
ALTER TABLE partner_wallet_entries DROP COLUMN amount_minor;
ALTER TABLE partner_wallet_entries DROP COLUMN balance_after_minor;
CREATE TRIGGER partner_wallet_entries_append_only BEFORE UPDATE OR DELETE ON partner_wallet_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE partner_topups ADD COLUMN amount_points bigint;
UPDATE partner_topups SET amount_points = amount_minor / 1000;
ALTER TABLE partner_topups ALTER COLUMN amount_points SET NOT NULL;
ALTER TABLE partner_topups ADD CHECK (amount_points > 0);
ALTER TABLE partner_topups DROP COLUMN amount_minor;
-- paid_amount_minor stays: the exact VND that actually arrived.

ALTER TABLE partner_prices ADD COLUMN amount_points bigint;
UPDATE partner_prices SET amount_points = amount_minor / 1000;
ALTER TABLE partner_prices ALTER COLUMN amount_points SET NOT NULL;
ALTER TABLE partner_prices ADD CHECK (amount_points > 0);
ALTER TABLE partner_prices DROP COLUMN amount_minor;

ALTER TABLE partner_wallet_sales ADD COLUMN cost_points bigint NOT NULL DEFAULT 0;
ALTER TABLE partner_wallet_sales ADD COLUMN price_points bigint NOT NULL DEFAULT 0;
