-- 0021 Guide accuracy: the store sells dynamic templates too.
-- The build-static guide claimed every template on the store is static,
-- which stopped being true when dynamic templates (with an admin page)
-- were published. Rewrite only those sentences, in both locales, via
-- replace() so any other wording is left untouched. Idempotent.

UPDATE platform_page_translations t
SET body = replace(
  body,
  '- 96 mẫu đang bán trên sàn đều là mẫu tĩnh. Gói tải về có thư mục **site** chứa toàn bộ file web.',
  '- Sàn có hai loại mẫu: **mẫu tĩnh** (chỉ gồm file web, tải về tự đăng) và **mẫu động** (có trang quản trị, sửa nội dung không cần đụng vào code). Bài này hướng dẫn mẫu tĩnh; mẫu động xem thêm bài hướng dẫn landing page động. Gói tải về của mẫu tĩnh có thư mục **site** chứa toàn bộ file web.'
)
FROM platform_pages p
WHERE p.id = t.page_id AND p.slug = 'help-build-static' AND t.locale = 'vi';

UPDATE platform_page_translations t
SET body = replace(
  body,
  '- All 96 templates sold on this store are static. The download bundle has a **site** folder with the whole website.',
  '- The store sells two kinds of templates: **static** ones (website files only, download and publish them yourself) and **dynamic** ones (with an admin page, so you edit content without touching code). This guide covers static templates; dynamic ones are covered by the dynamic landing page guide. A static template''s download bundle has a **site** folder with the whole website.'
)
FROM platform_pages p
WHERE p.id = t.page_id AND p.slug = 'help-build-static' AND t.locale = 'en';
