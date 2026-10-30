-- 0023 Rebrand follow-up: migration 0022 replaced the '3T' brand token, but
-- seeded CMS/guide text also carried the older English brand name
-- 'Web Marketplace' (e.g. the how-it-works article opens with it). The
-- public brand is 'webmaket' everywhere. Idempotent replace, both locales.

UPDATE platform_page_translations
SET title = replace(title, 'Web Marketplace', 'webmaket'),
    body = replace(body, 'Web Marketplace', 'webmaket')
WHERE title LIKE '%Web Marketplace%' OR body LIKE '%Web Marketplace%';
