-- 0003 catalog search: diacritic-insensitive search for Vietnamese (docs/07 §5) and
-- indexes supporting published-catalog filtering by capability.

CREATE EXTENSION IF NOT EXISTS unaccent;

-- Published templates filtered by capability use a GIN index on the version manifest capabilities.
CREATE INDEX template_versions_capabilities_idx
  ON template_versions USING gin ((manifest_json -> 'capabilities') jsonb_path_ops);

-- Active plans are looked up by (template, deployment_mode) for the mode filter.
CREATE INDEX plans_template_mode_idx ON plans (template_id, deployment_mode) WHERE status = 'active';
