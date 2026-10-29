-- 0020 Per-template translation lookup index (catalog read-path fix).
--
-- template_translations only had its primary key and the UNIQUE
-- (locale, slug) constraint, so nothing could probe translations by
-- template. With planner statistics the catalog list query still picks
-- hash joins and stays fast, but on a table whose statistics are missing
-- or stale (freshly imported/seeded data, before autovacuum analyzes)
-- the planner estimates ~1 row and serves the requested-locale LEFT JOIN
-- as a nested-loop JOIN FILTER over the whole table: measured 162ms vs
-- 4ms for the same query on a 1,000-template seed, which serialized the
-- 50-concurrent catalog load test behind the DB pool (p95 ~5.15s against
-- a 500ms budget). With this index the same cold plan probes per template
-- instead (measured 8ms with statistics still absent), so the read path
-- no longer depends on statistics being warm.
CREATE INDEX template_translations_template_locale_idx
  ON template_translations (template_id, locale, status);
