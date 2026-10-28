-- 0016 Seed the owner-set subdomain fee (post-purchase setup wizard).
--
-- The subdomain fee is owner-configured in admin, never decided by code:
-- amount_minor NULL means "not published yet" (the wizard falls back to
-- the "fee confirmed at handover" note). period is 'once' or 'monthly'.
INSERT INTO settings (key, value_json) VALUES
  ('subdomain.fee', '{"amount_minor": null, "period": "once"}'::jsonb)
ON CONFLICT (key) DO NOTHING;
