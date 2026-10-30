-- 0026 Customer content backups for dynamic sites (docs/12).
--
-- A dynamic template's own backup unit is its data/content.json (the
-- file its built-in admin downloads and restores). The platform stores
-- those JSON backups in the same backups table as whole-tree backups,
-- under a distinct kind so the two restore paths can never be confused:
-- a 'content' backup is applied by site.content-restore (writes the
-- JSON, keeps the previous file as content.json.bak — exactly what the
-- template's own restore does), never by the tree unzip path.
ALTER TABLE backups DROP CONSTRAINT backups_kind_check;
ALTER TABLE backups ADD CONSTRAINT backups_kind_check CHECK (kind IN ('backup', 'export', 'content'));

ALTER TABLE artifacts DROP CONSTRAINT artifacts_kind_check;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_kind_check
  CHECK (kind IN ('source_archive', 'static_site', 'screenshot', 'runtime_bundle', 'site_backup', 'site_content'));
