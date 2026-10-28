-- 0015 Allow deletion of pure draft template versions (delete-failed-import feature).
--
-- Invariant change, deliberately narrow (ADR-003 invariant 8):
--   * Published and withdrawn versions stay immutable: DELETE is still
--     refused unless the version status is 'ready' (never published).
--   * Reference safety does NOT rely on this function alone: plain
--     foreign keys (templates.published_version_id, order_items,
--     entitlements, download_events, sites, deployments, demo_sessions,
--     previews, template_capabilities, imports.version_id) already
--     refuse deleting any version another row points at.
--   * The API delete flow additionally refuses when the template has
--     other versions, is not a draft, or is referenced by a live
--     (non failed/cancelled) import, and it deletes children first.
-- Idempotent: CREATE OR REPLACE FUNCTION re-applies cleanly.
CREATE OR REPLACE FUNCTION template_versions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'ready' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'template_versions are immutable' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.template_id <> OLD.template_id OR NEW.semver <> OLD.semver OR NEW.manifest_json <> OLD.manifest_json
     OR NEW.source_sha <> OLD.source_sha OR NEW.artifact_id <> OLD.artifact_id
     OR NEW.source_artifact_id <> OLD.source_artifact_id OR NEW.adapter <> OLD.adapter THEN
    RAISE EXCEPTION 'template_versions are immutable' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
