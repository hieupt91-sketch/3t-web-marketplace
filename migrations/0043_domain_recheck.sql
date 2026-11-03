-- Audit payments L6: a verified custom domain used to stay valid forever,
-- even after the owner removed the `_3t-verify` TXT record — the
-- site-router serves any row with status='verified', so removal of the
-- proof never removed service. The worker now re-resolves the TXT record
-- periodically (see revalidateVerifiedDomains in apps/worker order-jobs):
--   last_recheck_at      — when the worker last completed a conclusive
--                          re-check (success or definitive failure);
--                          transient DNS errors never stamp it, so an
--                          inconclusive domain is retried next sweep.
--   recheck_fail_since   — when the current run of consecutive definitive
--                          failures (record missing or token mismatch)
--                          began; NULL while the record checks out.
-- After a 7-day grace from recheck_fail_since the row leaves 'verified'
-- for the new buyer-visible status 'verification_lost'. Like 'released',
-- that status is outside the domains_hostname_active_uq partial unique
-- index, so the hostname can be attached again afterwards.
ALTER TABLE domains ADD COLUMN last_recheck_at timestamptz;
ALTER TABLE domains ADD COLUMN recheck_fail_since timestamptz;
ALTER TABLE domains DROP CONSTRAINT domains_status_check;
ALTER TABLE domains ADD CONSTRAINT domains_status_check
  CHECK (status IN ('pending', 'verified', 'released', 'verification_lost'));
CREATE INDEX domains_verified_recheck_idx ON domains (last_recheck_at)
  WHERE status = 'verified';
