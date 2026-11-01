-- 0034: storage-based hosting. The owner prices storage per GB (settings
-- hosting.storage_price); a hosted purchase records how many GB were
-- bought on the entitlement, and each site created from it carries the
-- same quota — the auditable basis for storage billing and later
-- enforcement. Default 1 GB keeps pre-existing entitlements whole.
ALTER TABLE entitlements ADD COLUMN storage_gb integer NOT NULL DEFAULT 1 CHECK (storage_gb >= 1);
ALTER TABLE sites ADD COLUMN storage_quota_gb integer CHECK (storage_quota_gb IS NULL OR storage_quota_gb >= 1);
