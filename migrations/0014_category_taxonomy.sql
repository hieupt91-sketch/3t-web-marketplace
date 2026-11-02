-- 0014 Category taxonomy (docs/10): one clear level under the 'website' root.
-- Existing codes (landing, store, blog, portfolio) are kept untouched so
-- already-assigned templates keep working; only new siblings are added.
-- Labels live in i18n ui.category.<code>; the catalog filter lists every
-- code, so every code inserted here MUST have a label in both locales.
-- Idempotent: ON CONFLICT DO NOTHING.
INSERT INTO template_categories (code, parent_id)
SELECT code, (SELECT id FROM template_categories WHERE code = 'website')
FROM (VALUES ('business'), ('food'), ('realestate'), ('beauty')) AS v(code)
ON CONFLICT (code) DO NOTHING;
