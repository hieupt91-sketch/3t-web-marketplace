-- 0027 Bank-transfer payments (owner proposal, 2026-10-30).
--
-- The owner configures bank transfer in admin (settings key
-- 'payment.bank_transfer', same pattern as 'subdomain.fee'): bank name,
-- account number, account holder, an enabled flag and the API key of the
-- bank-transaction hub (SePay-compatible) that reports incoming transfers
-- to the platform webhook. Nothing here invents account data: the seed is
-- disabled and empty until the owner fills it in.
--
-- payment_attempts gains an instructions snapshot so a buyer's transfer
-- instructions (bank details + content code) never change retroactively
-- when the owner later edits the settings.
INSERT INTO settings (key, value_json) VALUES
  ('payment.bank_transfer', '{"enabled": false, "bank_name": "", "account_number": "", "account_holder": "", "hub_api_key": ""}'::jsonb)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS instructions_json jsonb;
