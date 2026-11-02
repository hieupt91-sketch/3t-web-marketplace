-- Sandbox Phase 0 (audit C-01): every customer site gets a dedicated
-- unprivileged UID from a fixed pool (see SITE_UID_BASE/SITE_UID_POOL_SIZE),
-- recorded here as the allocation ledger. The worker spawns the site's
-- template code under this UID and fences the site tree to it, so template
-- code can no longer read the platform processes' /proc environ or another
-- tenant's data/ (both were open while everything shared the worker's UID).
-- NULL = not yet allocated (allocated lazily at provision/restart, and for
-- pre-existing sites by the worker's boot backfill). The partial unique
-- index makes double-allocation of one UID to two live sites impossible;
-- the allocator retries on the unique violation.
ALTER TABLE sites ADD COLUMN runtime_uid integer
  CHECK (runtime_uid IS NULL OR (runtime_uid BETWEEN 1024 AND 65535));
CREATE UNIQUE INDEX sites_runtime_uid_uq ON sites (runtime_uid) WHERE runtime_uid IS NOT NULL;
