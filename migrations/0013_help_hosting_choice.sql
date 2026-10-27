-- 0013 Help article: choosing hosting for a template. Idempotent.
-- No prices, rates or providers are invented here.

INSERT INTO platform_pages (slug, kind, status) VALUES
  ('help-hosting-choice', 'help', 'published')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO platform_page_translations (page_id, locale, title, body, status)
SELECT id, 'vi', 'Chọn hosting nào cho mẫu của bạn', $$## Bạn có cần chọn hosting trước khi tải không
- Không. Gói tải về được hệ thống đóng gói đúng theo mẫu và gói bạn đã mua, bạn không chọn loại gói tải về lúc tải.
- Việc bạn cần chọn trước là **loại hosting** sẽ chạy web, vì mỗi loại mẫu cần một loại hosting khác nhau.

## Cách biết mẫu của bạn thuộc loại nào
- Mở trang chi tiết của mẫu, mục **Yêu cầu hosting** ghi rõ mẫu đó là mẫu tĩnh hay mẫu chạy máy chủ.
- Khi bạn chọn gói tự triển khai ở trang chọn gói, hệ thống cũng hiện lại yêu cầu này trước khi bạn đặt hàng.

## Mẫu tĩnh: hosting nào cũng chạy
- Mẫu tĩnh chỉ gồm file web, gói tải về có thư mục **site**.
- Bạn chỉ cần hosting phục vụ file tĩnh: hosting chia sẻ, Nginx, Caddy hoặc CDN đều chạy được.
- Cách chạy: tải gói về, giải nén, upload toàn bộ file trong thư mục **site** lên thư mục web của hosting (thường là public_html hoặc wwwroot).

## Mẫu chạy máy chủ: bắt buộc hosting Node hoặc Docker
- Mẫu chạy máy chủ cần một tiến trình chạy liên tục, gói tải về có thư mục **app** kèm sẵn Dockerfile và docker-compose.yml.
- Bạn cần VPS hoặc hosting Node chạy được Node.js 22, hoặc hosting chạy được Docker.
- Cách chạy nhanh nhất: giải nén gói, copy file .env.example thành .env rồi điền các giá trị bắt buộc, sau đó chạy `docker compose up -d --build`.
- Hosting chia sẻ chỉ phục vụ file tĩnh sẽ **không** chạy được mẫu này, dù bạn upload đủ file.

## Gói hosting của sàn thì sao
- Nếu bạn mua gói hosting của sàn, bạn không cần lo hosting: sàn triển khai và vận hành site cho bạn, bạn chỉ quản lý site trong tài khoản của mình.

## Lỡ mua rồi mới biết hosting không hợp
- Mẫu đã mua không đổi loại hosting được bằng cách tải lại, vì yêu cầu hosting nằm ở bản thân mẫu.
- Hãy gửi yêu cầu qua [trang liên hệ](/vi/contact) để được tư vấn. Lần mua sau, nếu không muốn lo hosting, bạn có thể chọn gói hosting của sàn thay vì gói tự triển khai. $$, 'published'
FROM platform_pages WHERE slug = 'help-hosting-choice'
ON CONFLICT (page_id, locale) DO NOTHING;

INSERT INTO platform_page_translations (page_id, locale, title, body, status)
SELECT id, 'en', 'Which hosting should you choose for your template', $$## Do you need to pick hosting before downloading
- No. The download bundle is built automatically from the template and the plan you bought; you do not pick a bundle type at download time.
- What you do need to pick in advance is the **kind of hosting** that will run the site, because each template kind needs a different kind of hosting.

## How to tell which kind your template is
- Open the template detail page: the **Hosting requirements** section states whether the template is static or server-based.
- When you pick a self-host plan on the plan page, the system shows this requirement again before you order.

## Static templates: any hosting works
- A static template is only website files; its bundle has a **site** folder.
- Any static file hosting works: shared hosting, Nginx, Caddy or a CDN.
- How to run it: download the bundle, unzip it, and upload everything inside the **site** folder to your hosting web folder (usually public_html or wwwroot).

## Server templates: Node or Docker hosting is required
- A server template needs a continuously running process; its bundle has an **app** folder plus a Dockerfile and docker-compose.yml.
- You need a VPS or Node hosting that runs Node.js 22, or hosting that runs Docker.
- Fastest way to run it: unzip the bundle, copy .env.example to .env and fill in the required values, then run `docker compose up -d --build`.
- Shared hosting that only serves static files **cannot** run this template, even if you upload every file.

## What about the platform hosting plan
- If you buy the platform hosting plan, you do not need to worry about hosting: the platform deploys and operates the site for you, and you manage the site from your account.

## If you already bought and your hosting does not fit
- A bought template cannot change its hosting kind by re-downloading, because the requirement belongs to the template itself.
- Send a request through the [contact page](/en/contact) for advice. Next time, if you do not want to worry about hosting, you can pick the platform hosting plan instead of a self-host plan. $$, 'published'
FROM platform_pages WHERE slug = 'help-hosting-choice'
ON CONFLICT (page_id, locale) DO NOTHING;
