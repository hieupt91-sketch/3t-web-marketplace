-- 0022 Rebrand: the platform's public name is "webmaket" (the domain and
-- logo already say so); seeded content and plan names still said "3T".
-- Replace the brand token in published CMS/guide text and in the hosted
-- plan names created by the 2026-10-29 ops script. Idempotent: replace()
-- is a no-op once no '3T' remains.

UPDATE platform_page_translations
SET title = replace(title, '3T', 'webmaket'),
    body = replace(body, '3T', 'webmaket')
WHERE title LIKE '%3T%' OR body LIKE '%3T%';

UPDATE plans
SET name_json = '{"vi": "Gói Hosting webmaket", "en": "webmaket hosting package"}'::jsonb,
    updated_at = now()
WHERE code = 'hosted' AND name_json::text LIKE '%3T%';
