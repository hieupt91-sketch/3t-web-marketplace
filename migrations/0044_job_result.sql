-- H2 gating fix 1 (admin-setup token hand-off): request/response jobs
-- need a result channel. The worker publishes a job's outcome into
-- result_json while the job is still running (setJobResult in
-- @3t/core jobs); the requester polls the row, reads the result once
-- the job succeeds, then scrubs it (clearJobResult). Secrets cross this
-- channel only in encrypted form (core encryptSecret envelope) — the
-- first user is site.setup-token, whose result carries a site's
-- one-time admin setup token sealed with the platform envelope key.
ALTER TABLE jobs ADD COLUMN result_json jsonb;
