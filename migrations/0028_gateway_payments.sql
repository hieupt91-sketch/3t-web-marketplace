-- 0028 Gateway payments: VNPay + MoMo (owner request, 2026-10-30).
--
-- Two fully automatic methods so orders settle at any hour without staff.
-- Merchant credentials are owner-entered in admin (same settings pattern
-- as 0016/0027), never committed to code: both seeds are disabled and
-- empty. sandbox defaults to true so the owner can test with the
-- gateway's test merchant before switching to live keys.
INSERT INTO settings (key, value_json) VALUES
  ('payment.vnpay', '{"enabled": false, "tmn_code": "", "secret_key": "", "sandbox": true}'::jsonb),
  ('payment.momo', '{"enabled": false, "partner_code": "", "access_key": "", "secret_key": "", "sandbox": true}'::jsonb)
ON CONFLICT (key) DO NOTHING;
