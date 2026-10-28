-- 0017 Step-by-step guides: build a static landing page, build a dynamic one.
-- Idempotent. No prices, rates or providers are invented here; free-tier
-- limits repeat the values already used by the hosting advisor.

INSERT INTO platform_pages (slug, kind, status) VALUES
  ('help-build-static', 'help', 'published'),
  ('help-build-dynamic', 'help', 'published')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO platform_page_translations (page_id, locale, title, body, status)
SELECT id, 'vi', 'Xây dựng landing page tĩnh từng bước', $$## Mẫu tĩnh là gì
- Mẫu tĩnh chỉ gồm file web (HTML, CSS, ảnh, JavaScript chạy trên trình duyệt), không có máy chủ, không có database.
- 96 mẫu đang bán trên sàn đều là mẫu tĩnh. Gói tải về có thư mục **site** chứa toàn bộ file web.
- Vì chỉ là file nên mẫu tĩnh chạy được ở bất cứ hosting file tĩnh nào, và không cần ai chăm máy chủ.

## Các bước xây dựng, từ lúc mua tới lúc web chạy

### Bước 1: Mua và tải gói về
- Mua mẫu rồi vào trang tải xuống của bạn. Mỗi mẫu có 2 bản tải: bản **demo** (giữ nguyên nội dung mẫu để xem) và bản **sạch** (đã gỡ số điện thoại demo, để bạn điền thông tin thật).
- Nếu bạn định đăng lên mạng thì tải bản sạch. Giải nén ra sẽ thấy thư mục **site** và file README hướng dẫn thay nội dung.

### Bước 2: Thay thông tin demo bằng thông tin thật
- Mở file index.html, tìm khu vực đánh dấu CONFIG ở đầu file: tên quán/công ty, số điện thoại, địa chỉ, giờ mở cửa.
- Số điện thoại trong bản demo là số của 3T, bắt buộc phải thay bằng số của bạn trước khi đăng lên mạng.
- Các form trong mẫu chỉ là form mẫu để xem giao diện, chưa lưu dữ liệu thật. Muốn nhận thông tin khách gửi thì gắn form vào dịch vụ form, hoặc xem hướng dẫn động.

### Bước 3: Nén ảnh trước khi đăng
- Ảnh gốc từ máy ảnh thường nặng vài MB, đăng nguyên sẽ làm web chậm.
- Dùng [tool resize](/resize-tool.html) chạy ngay trên trình duyệt, không tải ảnh của bạn lên đâu: chọn ảnh, chọn khung (hero 1600×900, thẻ 800×600, avatar 400×400), xuất WebP hoặc JPG.
- Quy tắc: hero dưới 300KB, ảnh thẻ dưới 200KB, avatar dưới 100KB; tên file không dấu, không khoảng trắng; chỉ dùng ảnh bạn có quyền sử dụng.

### Bước 4: Đưa lên mạng miễn phí bằng Cloudflare Pages
- Cloudflare Pages miễn phí: băng thông không giới hạn, 500 lần deploy mỗi tháng, 20.000 file mỗi web, 100 tên miền riêng, SSL tự động miễn phí.
- Cách nhanh nhất: vào Pages, kéo thả toàn bộ file trong thư mục **site** lên. Cách bền hơn: đẩy code lên GitHub rồi nối repo vào Pages, mỗi lần sửa chỉ cần đẩy code mới là web tự deploy lại.
- Gắn tên miền riêng (nếu có) theo hướng dẫn của Pages, hoặc dùng tạm địa chỉ miễn phí *.pages.dev. Sau này mua tên miền thì gắn thêm, không phải làm lại web.

### Bước 5: Nhiều ảnh thì để ảnh riêng ở R2
- Nếu web có nhiều ảnh sản phẩm, để ảnh ở Cloudflare R2 (10GB miễn phí, không tính phí băng thông) và chỉ lưu đường dẫn ảnh trong trang, để khỏi chạm giới hạn 20.000 file của Pages.
- Ảnh đăng kèm vẫn nén bằng tool resize trước rồi mới tải lên R2.

### Bước 6: Đăng bài thường xuyên thì làm thế nào
- Mẫu tĩnh không có sẵn trang quản trị. Muốn có chỗ đăng bài/sản phẩm mà không cần máy chủ thì gắn thêm CMS chạy trên Git (ví dụ Decap CMS, miễn phí): mỗi lần lưu bài là nội dung lưu thành file và web tự deploy lại.
- Lưu ý: mỗi lần lưu là một lần deploy, gói miễn phí giới hạn 500 lần mỗi tháng. Đăng nhiều thì gom bài theo đợt rồi deploy một lần.

## Giới hạn của mẫu tĩnh — và khi nào cần xem hướng dẫn động
- Mẫu tĩnh không có database, tài khoản người dùng, giỏ hàng, đơn hàng hay thanh toán, kể cả khi đã gắn CMS.
- Cần những thứ đó thì bạn cần web động: xem [hướng dẫn xây dựng landing page động](/vi/help/help-build-dynamic).
- Chưa biết mẫu của mình thuộc loại nào thì xem [cách chọn hosting](/vi/help/help-hosting-choice). $$, 'published'
FROM platform_pages WHERE slug = 'help-build-static'
ON CONFLICT (page_id, locale) DO NOTHING;

INSERT INTO platform_page_translations (page_id, locale, title, body, status)
SELECT id, 'en', 'Build a static landing page step by step', $$## What a static template is
- A static template is only website files (HTML, CSS, images, JavaScript that runs in the browser). No server, no database.
- All 96 templates sold on this store are static. The download bundle has a **site** folder with the whole website.
- Because it is only files, a static template runs on any static file hosting, and nobody needs to tend a server.

## Steps, from purchase to a live site

### Step 1: Buy and download the bundle
- Buy the template, then open your downloads page. Each template has 2 downloads: a **demo** bundle (keeps the sample content for viewing) and a **clean** bundle (demo phone number removed, ready for your real information).
- If you plan to publish, download the clean bundle. Unzipping it shows the **site** folder and a README explaining how to replace content.

### Step 2: Replace demo information with your real information
- Open index.html and find the CONFIG area at the top of the file: shop/company name, phone number, address, opening hours.
- The demo phone number belongs to 3T; you must replace it with your own number before publishing.
- Forms in the template are samples for viewing the interface; they do not save real data yet. To receive messages from visitors, connect a form to a form service, or see the dynamic guide.

### Step 3: Compress images before publishing
- Original camera photos are often several MB; publishing them as-is makes the site slow.
- Use the [resize tool](/resize-tool.html), which runs in your browser and never uploads your photos anywhere: pick an image, pick a frame (hero 1600×900, card 800×600, avatar 400×400), export WebP or JPG.
- Rules: hero under 300KB, card images under 200KB, avatars under 100KB; filenames without diacritics or spaces; only use images you have the rights to use.

### Step 4: Publish for free with Cloudflare Pages
- Cloudflare Pages is free: unlimited bandwidth, 500 deploys a month, 20,000 files per site, 100 custom domains, automatic free SSL.
- Fastest way: open Pages and drag the whole contents of the **site** folder onto it. More durable way: push the code to GitHub and connect the repo to Pages; each later edit only needs a new push and the site redeploys itself.
- Connect your own domain (if you have one) following the Pages guide, or use a free *.pages.dev address for now. You can attach a domain later without rebuilding the site.

### Step 5: Many images? Keep them separately in R2
- If the site has many product photos, keep them in Cloudflare R2 (10GB free, zero egress fees) and store only image URLs in the pages, so you never hit the Pages 20,000-file limit.
- Compress attached images with the resize tool before uploading them to R2.

### Step 6: Posting often? How that works on a static site
- A static template has no built-in admin panel. To get a place for posting articles/products without a server, attach a Git-based CMS (for example free Decap CMS): each save stores content as a file and the site redeploys itself.
- Note: each save is one deploy, and the free plan allows 500 a month. If you post a lot, batch posts and deploy once.

## Limits of a static template — and when to read the dynamic guide
- A static template has no database, user accounts, cart, orders or payments, even with a CMS attached.
- If you need those, you need a dynamic site: see [how to build a dynamic landing page](/en/help/help-build-dynamic).
- Not sure which kind your template is? See [how to choose hosting](/en/help/help-hosting-choice). $$, 'published'
FROM platform_pages WHERE slug = 'help-build-static'
ON CONFLICT (page_id, locale) DO NOTHING;

INSERT INTO platform_page_translations (page_id, locale, title, body, status)
SELECT id, 'vi', 'Xây dựng landing page động từng bước', $$## "Động" nghĩa là gì — xác định đúng mức bạn cần
- Mức 1, chỉ đăng bài/sản phẩm: mẫu tĩnh + CMS chạy trên Git là đủ, không cần máy chủ. Xem hướng dẫn tĩnh.
- Mức 2, cần tài khoản, dữ liệu riêng, quản trị nâng cao: cần backend (máy chủ + database).
- Mức 3, đơn hàng và thanh toán: bắt buộc backend thật, mẫu tĩnh (kể cả gắn CMS) không làm được.
- Bản tĩnh không biến thành động chỉ bằng cách up lên chỗ khác. Loại web nằm ở bản thân mẫu, không nằm ở hosting.
- Danh mục hiện tại chủ yếu là mẫu tĩnh; nếu bạn cần web động ngay thì đặt làm dự án riêng có backend.

## Lựa chọn 1: Gói hosting của sàn (đơn giản nhất)
- Nếu bạn chọn mẫu chạy máy chủ của sàn kèm gói hosting của sàn, sàn triển khai và vận hành site cho bạn, bạn chỉ quản lý site trong tài khoản của mình.
- Phù hợp nhất với người không rành kỹ thuật.

## Lựa chọn 2: Tự chạy trên VPS bằng Docker
- Dùng khi bạn (hoặc người làm web cho bạn) rành kỹ thuật và muốn tự quản lý máy chủ.
- VPS miễn phí vĩnh viễn duy nhất hiện nay là Oracle Cloud (2 CPU, 12GB RAM, 200GB ổ cứng), nhưng đăng ký cần thẻ Visa/Mastercard và có rủi ro bị thu hồi khi máy chủ nhàn rỗi kéo dài. VPS trả phí thì ổn định hơn.
- Các bước: tải gói mẫu chạy máy chủ (thư mục **app** kèm Dockerfile và docker-compose.yml), copy file .env.example thành .env rồi điền các giá trị bắt buộc, chạy `docker compose up -d --build`, trỏ tên miền về IP máy chủ, bật HTTPS bằng Caddy hoặc certbot.
- Máy chủ tự quản thì bạn phải tự cập nhật bảo mật định kỳ — máy chủ bỏ bê là kém ổn định nhất.

## Lựa chọn 3: Hosting chia sẻ — chỉ khi nó chạy được Node/Docker
- Hosting chia sẻ chỉ phục vụ file tĩnh thì KHÔNG chạy được mẫu máy chủ, dù bạn upload đủ file.
- Chỉ chọn hosting chia sẻ khi nhà cung cấp ghi rõ chạy được Node.js 22 hoặc Docker.
- Người không rành kỹ thuật nên chọn gói hosting của sàn trước, VPS sau — đừng mua hosting chia sẻ rồi mới phát hiện không chạy được.

## Tên miền và tên miền phụ
- Tên miền riêng: gắn vào hosting theo hướng dẫn của nhà hosting, SSL tự động miễn phí.
- Tên miền phụ <tên>.webmaket.com: phí do 3T công bố trong trang quản trị, không có giá cố định trong bài này.
- Chưa có tên miền: dùng địa chỉ miễn phí của nhà hosting trước, sau này mua tên miền thì gắn thêm, không phải làm lại web.

## Xem thêm
- [Hướng dẫn xây dựng landing page tĩnh](/vi/help/help-build-static)
- [Cách chọn hosting](/vi/help/help-hosting-choice) $$, 'published'
FROM platform_pages WHERE slug = 'help-build-dynamic'
ON CONFLICT (page_id, locale) DO NOTHING;

INSERT INTO platform_page_translations (page_id, locale, title, body, status)
SELECT id, 'en', 'Build a dynamic landing page step by step', $$## What "dynamic" means — find the level you actually need
- Level 1, only posting articles/products: a static template + Git-based CMS is enough, no server needed. See the static guide.
- Level 2, accounts, private data, advanced admin: you need a backend (server + database).
- Level 3, orders and payments: a real backend is mandatory; a static template (even with a CMS) cannot do it.
- A static template does not become dynamic just by uploading it somewhere else. The kind of site lives in the template itself, not in the hosting.
- The current catalog is mostly static templates; if you need a dynamic site right away, commission a custom project with a backend.

## Option 1: The platform hosting plan (simplest)
- If you pick a server-run template from the store together with the platform hosting plan, the platform deploys and operates the site for you, and you only manage the site from your account.
- Best fit for people who are not technical.

## Option 2: Run it yourself on a VPS with Docker
- Use this when you (or whoever builds the site for you) are technical and want to manage the server yourself.
- The only free-forever VPS right now is Oracle Cloud (2 CPUs, 12GB RAM, 200GB disk), but signup needs a Visa/Mastercard and there is a risk of reclamation if the server stays idle for a long time. A paid VPS is more stable.
- Steps: download the server-run template bundle (an **app** folder with a Dockerfile and docker-compose.yml), copy .env.example to .env and fill in the required values, run `docker compose up -d --build`, point your domain at the server IP, and enable HTTPS with Caddy or certbot.
- A self-managed server needs regular security updates from you — a neglected server is the least stable option.

## Option 3: Shared hosting — only if it runs Node/Docker
- Shared hosting that only serves static files CANNOT run a server template, even if you upload every file.
- Only pick shared hosting when the provider clearly states it runs Node.js 22 or Docker.
- If you are not technical, pick the platform hosting plan first and a VPS later — do not buy shared hosting first and discover afterwards that it cannot run the site.

## Domains and subdomains
- Own domain: connect it following your hosting provider's guide; SSL is automatic and free.
- Subdomain <name>.webmaket.com: the fee is published by 3T in the admin area; no fixed price is stated in this article.
- No domain yet: use the hosting provider's free address first; you can attach a domain later without rebuilding the site.

## See also
- [How to build a static landing page](/en/help/help-build-static)
- [How to choose hosting](/en/help/help-hosting-choice) $$, 'published'
FROM platform_pages WHERE slug = 'help-build-dynamic'
ON CONFLICT (page_id, locale) DO NOTHING;
