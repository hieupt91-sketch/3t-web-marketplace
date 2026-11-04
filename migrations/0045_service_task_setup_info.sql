-- 0045: one-time setup info for static purchases (owner model 2026-11-03):
-- a static template has no admin, so when the buyer adds the installation
-- package (the paid one-time setup) they fill their business info exactly
-- ONCE on the order; staff read it from the service task and bake it into
-- the delivered/hosted files. The right to submit never expires — the
-- single submission itself is the only lock (setup_info_submitted_at).
ALTER TABLE service_tasks ADD COLUMN setup_info_json jsonb;
ALTER TABLE service_tasks ADD COLUMN setup_info_submitted_at timestamptz;
