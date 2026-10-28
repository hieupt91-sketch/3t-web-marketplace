-- 0018 Menu guides: one detailed article per buyer journey step, in the
-- buyer's language (ThemeForest/Shopify/Envato pattern: homepage stays light,
-- explanations live in the help center, one task per article).
-- Idempotent. No prices, rates or providers are invented here.

INSERT INTO platform_pages (slug, kind, status) VALUES
  ('help-find-template', 'help', 'published'),
  ('help-buy', 'help', 'published'),
  ('help-after-buy', 'help', 'published'),
  ('help-account', 'help', 'published'),
  ('help-partner', 'help', 'published')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO platform_page_translations (page_id, locale, title, body, status)
SELECT id, 'vi', 'Tìm và chọn mẫu website', $$## Cách tìm nhanh nhất
1. Vào [Mẫu website](/vi/templates), bấm 1 trong 8 thẻ mục đích (quán ăn, làm đẹp, bất động sản...) để lọc ngay theo ngành.
2. Hoặc gõ nhu cầu bằng tiếng Việt, có dấu hay không dấu đều được ("cần web cho tiệm nail", "can web cho tiem nail"). Trợ lý chỉ chọn ngành khi chắc chắn, còn không sẽ tìm theo từ khóa chứ không đoán bừa.
3. Thu hẹp thêm bằng ô tìm kiếm, danh mục, chế độ (tự host hoặc 3T host) và khoảng giá.

## Trước khi mua, kiểm tra 4 điểm trên trang chi tiết
1. **Xem demo thật**: bấm vào bản xem trước để xem đúng mẫu sẽ mua, thử nút chuyển VI | EN ngay trong mẫu.
2. **Đọc tư vấn hosting**: khung tư vấn ở trang chi tiết hỏi bạn 5 câu rồi gợi ý nơi đăng phù hợp, kèm dung lượng gói thật.
3. **Xem kích thước gói**: gói càng nhiều ảnh thì càng nặng, cần hosting đủ chỗ.
4. **Chưa chọn được**: gửi yêu cầu qua [Liên hệ](/vi/contact) để 3T gợi ý mẫu gần nhất hoặc báo giá làm riêng.

## Xem tiếp
- [Mua và thanh toán](/vi/help/help-buy)
- [Chọn hosting](/vi/help/help-hosting-choice)
- [Sau khi mua thì sao?](/vi/help/help-after-buy)
$$, 'published' FROM platform_pages WHERE slug = 'help-find-template'
ON CONFLICT DO NOTHING;

INSERT INTO platform_page_translations (page_id, locale, title, body, status)
SELECT id, 'en', 'Find and choose a template', $$## The fastest way to find one
1. Open [Templates](/en/templates) and tap one of the 8 purpose cards (food, beauty, real estate...) to filter by industry at once.
2. Or type your need in plain language, with or without diacritics. The assistant only picks an industry when the match is clear; otherwise it falls back to keyword search instead of guessing.
3. Narrow further with search, category, hosting mode (self-host or 3T hosting) and price range.

## Before buying, check 4 things on the detail page
1. **See the real demo**: open the preview to see exactly what you are buying, and try the VI | EN switch inside the template.
2. **Read the hosting advice**: the advisor on the detail page asks 5 questions, then recommends where to publish, based on the real package size.
3. **Check the package size**: more photos means a heavier package that needs enough hosting room.
4. **Still unsure**: send a request through [Contact](/en/contact) and 3T will suggest the closest template or quote a custom build.

## Read next
- [Buy and pay](/en/help/help-buy)
- [Choose hosting](/en/help/help-hosting-choice)
- [What happens after you buy?](/en/help/help-after-buy)
$$, 'published' FROM platform_pages WHERE slug = 'help-find-template'
ON CONFLICT DO NOTHING;

INSERT INTO platform_page_translations (page_id, locale, title, body, status)
SELECT id, 'vi', 'Mua và thanh toán từng bước', $$## Các bước mua, từ chọn mẫu tới cầm gói trên tay
### Bước 1: Chọn mẫu và gói
- Ở trang chi tiết, chọn gói phù hợp (tự host để tự tải về đăng lên hosting của bạn, hoặc 3T host để 3T lo phần chạy web).
- Giá hiển thị là giá 3T đang công bố trong trang quản trị. Nếu 3T đổi giá sau, đơn và báo giá bạn đã tạo vẫn giữ giá lúc tạo.

### Bước 2: Tạo báo giá, rồi đặt đơn
- Tạo báo giá để chốt giá và gói, sau đó đặt đơn từ báo giá đó.
- Kiểm tra lại tên mẫu, gói và tổng tiền trước khi thanh toán.

### Bước 3: Thanh toán
- Thanh toán bằng phương thức đang bật ở trang thanh toán.
- Thanh toán xong, đơn chuyển sang đã thanh toán và quyền tải gói được kích hoạt.

### Bước 4: Tải gói về
- Vào Tài khoản, mục Gói đã mua, bấm Tải xuống. Mỗi mẫu có 2 bản: bản **demo** (giữ nguyên nội dung mẫu để xem) và bản **sạch** (đã gỡ số điện thoại demo, để điền thông tin thật).
- Link tải chỉ dùng được trong thời gian ngắn, hết hạn thì bấm tạo link mới. Nếu định đăng lên mạng thì tải bản sạch.

## Xem tiếp
- [Sau khi mua thì sao?](/vi/help/help-after-buy)
- [Tài khoản và gói đã mua](/vi/help/help-account)
$$, 'published' FROM platform_pages WHERE slug = 'help-buy'
ON CONFLICT DO NOTHING;

INSERT INTO platform_page_translations (page_id, locale, title, body, status)
SELECT id, 'en', 'Buy and pay step by step', $$## From choosing a template to holding the package
### Step 1: Pick a template and a plan
- On the detail page, pick the plan that fits (self-host to download and publish on your own hosting, or 3T hosting where 3T runs the site).
- The price shown is the price 3T currently publishes in admin. If 3T changes a price later, quotes and orders you already created keep the price from creation time.

### Step 2: Create a quote, then place the order
- Create a quote to lock the price and plan, then place the order from that quote.
- Double-check the template name, plan and total before paying.

### Step 3: Pay
- Pay with a method enabled at checkout.
- Once payment succeeds, the order becomes paid and your download entitlement is activated.

### Step 4: Download the package
- Go to Account, then Purchases, and press Download. Each template has 2 variants: a **demo** build (keeps the sample content for viewing) and a **clean** build (demo phone number removed, ready for your real info).
- A download link only works for a short time; when it expires, generate a new one. If you plan to publish, download the clean build.

## Read next
- [What happens after you buy?](/en/help/help-after-buy)
- [Account and purchases](/en/help/help-account)
$$, 'published' FROM platform_pages WHERE slug = 'help-buy'
ON CONFLICT DO NOTHING;

INSERT INTO platform_page_translations (page_id, locale, title, body, status)
SELECT id, 'vi', 'Sau khi mua thì sao?', $$## 3 việc sau khi mua: tên miền, nơi đăng, tải gói
### 1. Chọn tên miền
- **Tên miền riêng của bạn**: dùng tên miền bạn đã có, trỏ về nơi đăng web.
- **Tên miền phụ của 3T**: dạng <tên>.webmaket.com. Phí tên miền phụ do 3T công bố trong trang quản trị, không có số cố định trong bài này.
- **Địa chỉ miễn phí của nơi host**: khi đăng lên hosting miễn phí, bạn nhận địa chỉ dạng tên-miễn-phí của nơi đó.

### 2. Chọn nơi đăng
- **Mẫu tĩnh** (toàn bộ 96 mẫu đang bán): đăng miễn phí lên Cloudflare Pages, không giới hạn băng thông, 500 lần build mỗi tháng, 20.000 file, 100 tên miền, SSL miễn phí. Nhiều ảnh thì chứa ảnh trên R2 (10GB miễn phí, không tính phí tải xuống).
- **Mẫu động** (cần quản trị, database, đơn hàng, thanh toán): dùng gói hosting của nền tảng là đơn giản nhất, hoặc tự chạy VPS + Docker nếu bạn rành kỹ thuật. Shared hosting chỉ chạy được mẫu động khi nó chạy Node.js 22 hoặc Docker.
- Chưa biết chọn đâu thì đọc [Chọn hosting](/vi/help/help-hosting-choice).

### 3. Tải gói và làm theo trợ lý cài đặt
- Vào trang tải xuống của gói, trả lời trợ lý 4 bước: tên miền, nơi host, kiểm tra kết nối (chỉ khi tự chạy VPS), rồi tải gói đầy đủ kèm hướng dẫn riêng theo lựa chọn của bạn.
- Muốn tự làm từng bước thì đọc [Xây dựng landing page tĩnh](/vi/help/help-build-static) hoặc [Xây dựng landing page động](/vi/help/help-build-dynamic).

## Xem tiếp
- [Nén ảnh trước khi đăng](/vi/help/help-build-static)
- [Tool resize ảnh](/resize-tool.html)
$$, 'published' FROM platform_pages WHERE slug = 'help-after-buy'
ON CONFLICT DO NOTHING;

INSERT INTO platform_page_translations (page_id, locale, title, body, status)
SELECT id, 'en', 'What happens after you buy?', $$## 3 things after buying: domain, hosting, download
### 1. Pick a domain
- **Your own domain**: use a domain you already own and point it at your hosting.
- **A 3T subdomain**: shaped <name>.webmaket.com. The subdomain fee is published by 3T in admin; no fixed number is stated here.
- **A free host address**: when you publish on free hosting, you get that host's free address.

### 2. Pick where to publish
- **Static templates** (all 96 templates on sale): publish free on Cloudflare Pages — unlimited bandwidth, 500 builds a month, 20,000 files, 100 domains, free SSL. Lots of images go on R2 (10 GB free, zero egress fees).
- **Dynamic templates** (needing admin, a database, orders, payments): the platform hosting plan is simplest, or run your own VPS + Docker if you are technical. Shared hosting only runs dynamic templates if it runs Node.js 22 or Docker.
- Unsure where to go? Read [Choose hosting](/en/help/help-hosting-choice).

### 3. Download and follow the setup assistant
- On the package download page, answer the 4-step assistant: domain, host, connection check (only for self-run VPS), then download the full package with a guide personalized to your choices.
- Prefer doing it step by step yourself? Read [Build a static landing page](/en/help/help-build-static) or [Build a dynamic landing page](/en/help/help-build-dynamic).

## Read next
- [Compress images before publishing](/en/help/help-build-static)
- [Image resize tool](/resize-tool.html)
$$, 'published' FROM platform_pages WHERE slug = 'help-after-buy'
ON CONFLICT DO NOTHING;

INSERT INTO platform_page_translations (page_id, locale, title, body, status)
SELECT id, 'vi', 'Tài khoản và gói đã mua', $$## Tài khoản của bạn có gì
- Đăng ký rồi đăng nhập để mua hàng, xem đơn và tải lại gói bất cứ lúc nào.
- Quên mật khẩu thì dùng chức năng quên mật khẩu ở trang đăng nhập, đừng tạo tài khoản mới trùng email.

## Xem đơn hàng và tải lại gói
1. Vào **Tài khoản**, mục **Gói đã mua** để thấy các gói còn hiệu lực.
2. Bấm **Tải xuống** ở gói cần lấy. Link tải chỉ dùng được trong thời gian ngắn, hết hạn thì bấm tạo link mới.
3. Mục **Đơn hàng** cho biết từng đơn đang ở trạng thái nào (chờ thanh toán, đã thanh toán).
4. Gói 3T host thì mục **Site** cho biết site của bạn và tên miền phụ đã gắn.

## Cần hỗ trợ?
- Gửi yêu cầu qua [Liên hệ](/vi/contact), ghi rõ email tài khoản, tên mẫu và mã đơn để 3T đối chiếu nhanh.

## Xem tiếp
- [Mua và thanh toán](/vi/help/help-buy)
- [Sau khi mua thì sao?](/vi/help/help-after-buy)
$$, 'published' FROM platform_pages WHERE slug = 'help-account'
ON CONFLICT DO NOTHING;

INSERT INTO platform_page_translations (page_id, locale, title, body, status)
SELECT id, 'en', 'Account and purchases', $$## What your account holds
- Register and sign in to buy, view orders and re-download packages any time.
- Forgot your password? Use the forgot-password function on the sign-in page instead of creating a second account with the same email.

## View orders and re-download a package
1. Go to **Account**, then **Purchases**, to see your active entitlements.
2. Press **Download** on the package you need. A download link only works for a short time; when it expires, generate a new one.
3. **Orders** shows each order's status (awaiting payment, paid).
4. For a 3T-hosted plan, **Sites** shows your site and its attached subdomain.

## Need support?
- Send a request through [Contact](/en/contact), stating your account email, the template name and the order code so 3T can match it quickly.

## Read next
- [Buy and pay](/en/help/help-buy)
- [What happens after you buy?](/en/help/help-after-buy)
$$, 'published' FROM platform_pages WHERE slug = 'help-account'
ON CONFLICT DO NOTHING;

INSERT INTO platform_page_translations (page_id, locale, title, body, status)
SELECT id, 'vi', 'Bán mẫu trên nền tảng', $$## Cộng tác viên bán như thế nào
1. Bạn đưa mẫu lên nền tảng qua quy trình nhập mẫu: khai báo manifest, build thử và xem demo trước khi mở bán.
2. Khách mua trên sàn, nền tảng thu tiền rồi trả hoa hồng cho bạn theo cấu hình trong trang quản trị. Nếu chưa cấu hình hoa hồng thì mặc định là 0, không tự sinh số.
3. Mẫu bán ra vẫn giữ nguyên bản đã duyệt; muốn đổi thì nhập phiên bản mới, bản cũ không bị ghi đè.

## Mẫu đạt chuẩn mở bán cần có
- Manifest đúng chuẩn, demo chạy được, nội dung mẫu không dùng thương hiệu hay số liệu giả.
- Ảnh dùng để demo phải là ảnh bạn có quyền sử dụng.
- Ghi rõ mẫu là tĩnh hay động, để khách không mua nhầm loại cần máy chủ.

## Mở tài khoản cộng tác viên
- Gửi yêu cầu qua [Liên hệ](/vi/contact), ghi rõ bạn muốn bán loại mẫu nào. 3T duyệt rồi mở tài khoản đối tác và hướng dẫn gọi API nhập mẫu.

## Xem tiếp
- [Tìm và chọn mẫu website](/vi/help/help-find-template)
- [Cộng tác viên](/vi/partners)
$$, 'published' FROM platform_pages WHERE slug = 'help-partner'
ON CONFLICT DO NOTHING;

INSERT INTO platform_page_translations (page_id, locale, title, body, status)
SELECT id, 'en', 'Sell templates on the platform', $$## How partners sell
1. You list a template through the import flow: declare a manifest, trial-build it and preview the demo before it goes on sale.
2. Customers buy on the store, the platform collects the money and pays your commission per the configuration in admin. If no commission is configured, the default is 0 — no number is invented.
3. A published template keeps its approved version; to change it, import a new version. The old version is never overwritten.

## What a sale-ready template needs
- A valid manifest, a working demo, and no fake brands or numbers in the sample content.
- Demo photos must be images you have the rights to use.
- State clearly whether the template is static or dynamic, so buyers never purchase the wrong server needs.

## Open a partner account
- Send a request through [Contact](/en/contact), stating what kind of templates you want to sell. 3T reviews it, opens the partner account and guides you through the import API.

## Read next
- [Find and choose a template](/en/help/help-find-template)
- [Partners](/en/partners)
$$, 'published' FROM platform_pages WHERE slug = 'help-partner'
ON CONFLICT DO NOTHING;
