-- 0012 CMS seed content: how-it-works / partners pages, help articles, terms
-- and privacy policies, and empty contact channels. All copy describes only
-- flows that exist in the code; no prices, rates, providers or deadlines are
-- invented here — those are set by the owner in the admin UI.
-- Idempotent: every insert is guarded by ON CONFLICT DO NOTHING so the file
-- can be re-applied safely.

INSERT INTO platform_pages (slug, kind, status) VALUES
  ('how-it-works', 'page', 'published'),
  ('partners', 'page', 'published'),
  ('help-buying', 'help', 'published'),
  ('help-selfhost', 'help', 'published'),
  ('help-hosting', 'help', 'published'),
  ('help-demo', 'help', 'published'),
  ('help-support', 'help', 'published')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO platform_page_translations (page_id, locale, title, body, status)
SELECT id, 'vi', 'Cách hoạt động', $$Web Marketplace là nơi bạn chọn mẫu website, xem demo thật rồi mới mua, sau đó nhận web theo một trong hai cách: tự triển khai trên máy chủ của bạn hoặc dùng hosting của sàn.

## Chọn mẫu
- Mở [danh mục mẫu](/vi/templates) và dùng bộ lọc bên trái để chọn theo hình thức triển khai, tính năng, danh mục và khoảng giá.
- Mỗi mẫu ghi rõ các tính năng đi kèm và các ngôn ngữ nội dung được hỗ trợ.

## Xem demo trước khi mua
- Bấm **Xem demo** ở thẻ mẫu hoặc trang chi tiết để mở bản demo chạy thật trên tên miền riêng.
- Trong demo, biểu mẫu, thanh toán và email chỉ là mô phỏng, không gửi thật.

## Chọn cách nhận web
- **Tự triển khai:** sau khi mua, bạn tải gói web về và chạy trên máy chủ của mình theo hướng dẫn đi kèm trong gói.
- **Hosting của sàn:** sàn triển khai web cho bạn và bạn quản lý site trong tài khoản của mình.

## Thanh toán và bàn giao
- Chọn gói, xem báo giá rồi đặt hàng. Báo giá do hệ thống tính từ giá hiện hành của gói và được giữ nguyên trong thời gian hiệu lực của báo giá.
- Sau khi thanh toán, đơn tự triển khai cho phép tải gói về, đơn hosting được sàn triển khai thành site cho bạn.
- Cần hỗ trợ thêm, hãy gửi yêu cầu qua [trang liên hệ](/vi/contact).$$, 'published'
FROM platform_pages WHERE slug = 'how-it-works'
ON CONFLICT (page_id, locale) DO NOTHING;

INSERT INTO platform_page_translations (page_id, locale, title, body, status)
SELECT id, 'en', 'How it works', $$Web Marketplace is where you pick a website template, try a real demo before buying, and then receive the site in one of two ways: deploy it on your own server, or use the platform hosting.

## Pick a template
- Open the [template catalog](/en/templates) and use the filters on the left to choose by deployment mode, capability, category and price range.
- Each template lists its included capabilities and supported content languages.

## Try the demo before buying
- Click **View demo** on a template card or detail page to open a real running demo on a separate domain.
- In the demo, forms, payments and emails are simulated and never sent for real.

## Choose how to receive the site
- **Self-host:** after purchase, download the site bundle and run it on your own server following the guide included in the bundle.
- **Platform hosting:** the platform deploys the site for you and you manage it from your account.

## Payment and delivery
- Pick a plan, review the quote and place the order. The quote is calculated from the plan current price and stays fixed for the quote validity period.
- After payment, a self-host order allows downloading the bundle and a hosted order is deployed as a site for you.
- For further help, send a request through the [contact page](/en/contact).$$, 'published'
FROM platform_pages WHERE slug = 'how-it-works'
ON CONFLICT (page_id, locale) DO NOTHING;

INSERT INTO platform_page_translations (page_id, locale, title, body, status)
SELECT id, 'vi', 'Chương trình đối tác', $$Sàn cho phép đối tác giới thiệu và bán mẫu website qua liên kết và API danh mục của mình, trong khi sàn là bên thu tiền và xử lý bàn giao.

## Cách tham gia
- Gửi đơn đăng ký đối tác và chờ sàn xét duyệt.
- Sau khi được duyệt, bạn nhận khóa API và liên kết giới thiệu trong cổng đối tác.

## Cách bán
- Chia sẻ liên kết giới thiệu hoặc dùng API danh mục để hiển thị mẫu trên kênh của bạn.
- Khách mua qua liên kết hoặc phiên thanh toán của bạn sẽ được sàn ghi nhận cho bạn.

## Hoa hồng và chi trả
- Sàn thu tiền đơn hàng, giữ tiền theo thời gian giữ của chính sách đối tác đang áp dụng, rồi chi trả hoa hồng cho bạn.
- Mức hoa hồng, thời gian giữ tiền và mức chi trả tối thiểu do sàn quy định và hiển thị trong cổng đối tác. Chính sách áp dụng cho một đơn là chính sách được ghi nhận tại thời điểm đơn phát sinh.
- Bạn theo dõi đơn, hoa hồng và lịch sử chi trả trong cổng đối tác.

## Lưu ý
- Đối tác không tự thu tiền của khách và không tự hứa mức giá hay ưu đãi ngoài chính sách của sàn.
- Cần hỗ trợ, hãy gửi yêu cầu qua [trang liên hệ](/vi/contact).$$, 'published'
FROM platform_pages WHERE slug = 'partners'
ON CONFLICT (page_id, locale) DO NOTHING;

INSERT INTO platform_page_translations (page_id, locale, title, body, status)
SELECT id, 'en', 'Partner program', $$The platform lets partners introduce and sell website templates through referral links and the catalog API, while the platform collects payment and handles delivery.

## How to join
- Submit a partner application and wait for platform review.
- Once approved, you receive an API key and referral links in the partner portal.

## How to sell
- Share your referral links or use the catalog API to show templates on your own channel.
- Customers who buy through your links or checkout sessions are credited to you by the platform.

## Commission and payout
- The platform collects order payment, holds it for the hold period of the partner policy in effect, then pays out your commission.
- The commission rate, hold period and minimum payout are set by the platform and shown in the partner portal. The policy applied to an order is the one recorded when the order was created.
- You track orders, commission and payout history in the partner portal.

## Notes
- Partners do not collect money from customers directly and do not promise prices or offers outside platform policy.
- For help, send a request through the [contact page](/en/contact).$$, 'published'
FROM platform_pages WHERE slug = 'partners'
ON CONFLICT (page_id, locale) DO NOTHING;

INSERT INTO platform_page_translations (page_id, locale, title, body, status)
SELECT id, 'vi', 'Mua mẫu như thế nào', $$## Các bước mua
- Mở [danh mục mẫu](/vi/templates), chọn mẫu và bấm **Xem demo** để thử trước.
- Ở trang chi tiết, bấm **Chọn gói** để chọn hình thức tự triển khai hoặc hosting của sàn.
- Xem báo giá, tick đồng ý điều khoản rồi đặt hàng và thanh toán.

## Sau khi mua
- Đơn tự triển khai: vào mục đơn mua của bạn để xin link tải gói về.
- Đơn hosting: sàn triển khai thành site và bạn quản lý site trong tài khoản của mình.
- Báo giá đã tạo sẽ giữ nguyên giá trong thời gian hiệu lực của báo giá, kể cả khi giá gói thay đổi sau đó.

## Cần giúp đỡ
- Gửi yêu cầu qua [trang liên hệ](/vi/contact) hoặc mở ticket trong mục hỗ trợ của tài khoản. $$, 'published'
FROM platform_pages WHERE slug = 'help-buying'
ON CONFLICT (page_id, locale) DO NOTHING;

INSERT INTO platform_page_translations (page_id, locale, title, body, status)
SELECT id, 'en', 'How to buy a template', $$## Buying steps
- Open the [template catalog](/en/templates), pick a template and click **View demo** to try it first.
- On the detail page, click **Choose plan** to pick self-host or platform hosting.
- Review the quote, accept the terms and place the order, then pay.

## After purchase
- Self-host order: open your purchases to request a download link for the bundle.
- Hosted order: the platform deploys it as a site and you manage the site from your account.
- A quote that was already created keeps its price for the quote validity period, even if the plan price changes afterwards.

## Need help
- Send a request through the [contact page](/en/contact) or open a ticket in your account support section. $$, 'published'
FROM platform_pages WHERE slug = 'help-buying'
ON CONFLICT (page_id, locale) DO NOTHING;

INSERT INTO platform_page_translations (page_id, locale, title, body, status)
SELECT id, 'vi', 'Tự triển khai mẫu lên máy chủ của bạn', $$## Lấy gói về
- Sau khi mua gói tự triển khai, vào mục đơn mua của bạn và xin link tải gói.
- Link tải chỉ dùng được một lần và hết hạn sau một thời gian ngắn, nếu hết hạn bạn xin link mới từ cùng trang đó.

## Chạy web
- Giải nén gói, thư mục **site** chứa toàn bộ file web đã build.
- Trỏ bất kỳ web server tĩnh nào (Nginx, Caddy hoặc CDN) vào thư mục **site** là web chạy, không cần build lại.
- File **README** đi kèm trong gói ghi rõ cách chạy và file **CHECKSUMS** liệt kê mã băm của từng file để bạn đối chiếu.
- Mẫu chạy trên máy chủ Node cần chạy server Node theo hướng dẫn trong file README đi kèm gói.

## Lưu ý
- Gói tải về không chứa secret, database hay backend quản trị của sàn.
- Cần hỗ trợ, hãy gửi yêu cầu qua [trang liên hệ](/vi/contact). $$, 'published'
FROM platform_pages WHERE slug = 'help-selfhost'
ON CONFLICT (page_id, locale) DO NOTHING;

INSERT INTO platform_page_translations (page_id, locale, title, body, status)
SELECT id, 'en', 'Deploy a template on your own server', $$## Get the bundle
- After buying a self-host plan, open your purchases and request a download link for the bundle.
- A download link can be used once and expires after a short time; if it expires, request a new link from the same page.

## Run the site
- Unzip the bundle. The **site** folder contains the complete built website files.
- Point any static web server (Nginx, Caddy or a CDN) at the **site** folder and the site runs, with no rebuild needed.
- The **README** included in the bundle explains how to run it, and **CHECKSUMS** lists the hash of every file for verification.
- Templates that run on a Node server need their Node server started following the README included in the bundle.

## Notes
- The downloaded bundle contains no secrets, database or platform admin backend.
- For help, send a request through the [contact page](/en/contact). $$, 'published'
FROM platform_pages WHERE slug = 'help-selfhost'
ON CONFLICT (page_id, locale) DO NOTHING;

INSERT INTO platform_page_translations (page_id, locale, title, body, status)
SELECT id, 'vi', 'Dùng hosting của sàn', $$## Cách hoạt động
- Khi mua gói hosting, bạn không cần máy chủ riêng: sàn triển khai mẫu thành site cho bạn.
- Sau khi triển khai, site xuất hiện trong mục site của tài khoản của bạn.

## Quản lý site
- Trong trang quản trị site, bạn có thể khởi động lại site, gắn tên miền, tạo bản sao lưu, cập nhật phiên bản mẫu và quản lý thành viên.
- Bạn cũng có thể yêu cầu xuất dữ liệu hoặc xóa site từ trang dữ liệu của site.

## Cần giúp đỡ
- Gửi yêu cầu qua [trang liên hệ](/vi/contact) hoặc mở ticket trong mục hỗ trợ của tài khoản. $$, 'published'
FROM platform_pages WHERE slug = 'help-hosting'
ON CONFLICT (page_id, locale) DO NOTHING;

INSERT INTO platform_page_translations (page_id, locale, title, body, status)
SELECT id, 'en', 'Using platform hosting', $$## How it works
- When you buy a hosted plan, you need no server of your own: the platform deploys the template as a site for you.
- After deployment, the site appears in your account sites section.

## Manage the site
- On the site management page you can restart the site, attach domains, create backups, update the template version and manage members.
- You can also request a data export or a site deletion from the site data page.

## Need help
- Send a request through the [contact page](/en/contact) or open a ticket in your account support section. $$, 'published'
FROM platform_pages WHERE slug = 'help-hosting'
ON CONFLICT (page_id, locale) DO NOTHING;

INSERT INTO platform_page_translations (page_id, locale, title, body, status)
SELECT id, 'vi', 'Xem demo mẫu', $$## Mở demo
- Bấm **Xem demo** ở thẻ mẫu hoặc trang chi tiết để mở bản demo.
- Demo chạy trên tên miền riêng, tách khỏi sàn, nên code trong demo không đọc được thông tin đăng nhập của bạn.

## Thao tác trong demo
- Bạn bấm, chuyển trang và dùng thử các tính năng hiển thị như trên web thật.
- Biểu mẫu, thanh toán và email trong demo chỉ là mô phỏng, không gửi thật và không tạo đơn thật.
- Trên khung demo có nút chuyển xem ở máy tính, máy tính bảng và điện thoại, nút mở tab mới, nút về trang chi tiết và nút chọn gói mua.
- Với mẫu chạy trên máy chủ riêng, demo được mở dưới dạng phiên có thời hạn thay vì demo công khai.

## Cần giúp đỡ
- Gửi yêu cầu qua [trang liên hệ](/vi/contact). $$, 'published'
FROM platform_pages WHERE slug = 'help-demo'
ON CONFLICT (page_id, locale) DO NOTHING;

INSERT INTO platform_page_translations (page_id, locale, title, body, status)
SELECT id, 'en', 'Viewing a template demo', $$## Open the demo
- Click **View demo** on a template card or detail page to open the demo.
- The demo runs on a separate domain, apart from the platform, so demo code cannot read your login information.

## Interacting with the demo
- You click, navigate and try the displayed features just like on a real site.
- Forms, payments and emails in the demo are simulated only: nothing is sent for real and no real order is created.
- Above the demo frame there are buttons to preview on desktop, tablet and mobile, open in a new tab, go back to the detail page and choose a plan.
- For templates that run on their own server, the demo opens as a time-limited session instead of a public demo.

## Need help
- Send a request through the [contact page](/en/contact). $$, 'published'
FROM platform_pages WHERE slug = 'help-demo'
ON CONFLICT (page_id, locale) DO NOTHING;

INSERT INTO platform_page_translations (page_id, locale, title, body, status)
SELECT id, 'vi', 'Liên hệ hỗ trợ', $$## Gửi yêu cầu qua form
- Mở [trang liên hệ](/vi/contact), điền tên, email và nội dung rồi tick đồng ý trước khi gửi.
- Hệ thống trả lời chung chung cho mọi yêu cầu để không lộ thông tin đơn hàng của người khác.

## Ticket trong tài khoản
- Nếu bạn đã có tài khoản, hãy mở ticket trong mục hỗ trợ của tài khoản để trao đổi tiếp về đơn hoặc site của mình.
- Nút liên hệ nổi ở góc trang luôn hiện trên mọi trang để bạn mở nhanh trang liên hệ, gọi điện hoặc chat qua kênh mà sàn đã cấu hình. $$, 'published'
FROM platform_pages WHERE slug = 'help-support'
ON CONFLICT (page_id, locale) DO NOTHING;

INSERT INTO platform_page_translations (page_id, locale, title, body, status)
SELECT id, 'en', 'Contacting support', $$## Send a request through the form
- Open the [contact page](/en/contact), fill in your name, email and message, and accept before sending.
- The system replies generically to every request so that no other customer order information is revealed.

## Tickets in your account
- If you already have an account, open a ticket in your account support section to continue discussing your own order or site.
- The floating contact button at the corner of the page is always visible on every page so you can quickly open the contact page, call, or chat through the channels the platform has configured. $$, 'published'
FROM platform_pages WHERE slug = 'help-support'
ON CONFLICT (page_id, locale) DO NOTHING;

INSERT INTO policy_versions (code, version, status, effective_at) VALUES
  ('terms', 'terms-2026-10', 'published', '2026-10-01T00:00:00Z'),
  ('privacy', 'privacy-2026-10', 'published', '2026-10-01T00:00:00Z')
ON CONFLICT (code, version) DO NOTHING;

INSERT INTO policy_translations (policy_version_id, locale, title, body, review_status)
SELECT id, 'vi', 'Điều khoản sử dụng', $$## 1. Sàn và tài khoản
- Web Marketplace là sàn bán mẫu website. Sàn cung cấp danh mục mẫu, demo, thanh toán, bàn giao và hosting theo gói mà bạn mua.
- Bạn chịu trách nhiệm bảo mật tài khoản của mình và mọi hoạt động phát sinh từ tài khoản đó.

## 2. Mẫu và giấy phép sử dụng
- Khi mua một mẫu, bạn được quyền sử dụng mẫu đó cho các site của mình trong giới hạn của gói đã mua, bao gồm giới hạn số lượng site nếu gói có quy định.
- Bạn không được bán lại, phân phối lại hay công bố mã nguồn của mẫu như một sản phẩm của riêng bạn, trừ khi gói đã mua cho phép rõ ràng.

## 3. Đặt hàng và thanh toán
- Giá hiển thị là giá hiện hành của gói tại thời điểm bạn xem. Báo giá do hệ thống tạo sẽ giữ nguyên trong thời gian hiệu lực của báo giá.
- Đơn hàng chỉ được xử lý sau khi thanh toán được xác nhận. Sàn là bên thu tiền và xuất chứng từ cho đơn hàng qua sàn.

## 4. Tự triển khai và hosting
- Gói tự triển khai: bạn nhận gói tải về và tự chịu trách nhiệm vận hành máy chủ của mình sau khi nhận bàn giao.
- Gói hosting: sàn triển khai và vận hành site cho bạn trong phạm vi dịch vụ hosting của gói. Bạn quản lý site trong tài khoản của mình.

## 5. Đối tác
- Đối tác bán mẫu qua liên kết và API của sàn theo chương trình đối tác. Sàn thu tiền đơn hàng và chi trả hoa hồng theo chính sách đối tác đang áp dụng, được ghi nhận tại thời điểm đơn phát sinh.

## 6. Hoàn tiền
- Yêu cầu hoàn tiền được gửi qua hỗ trợ và xử lý theo chính sách hoàn tiền áp dụng cho gói và phương thức thanh toán của đơn.
- Gói đã tải về hoặc site đã triển khai và sử dụng vẫn có thể bị từ chối hoàn tiền nếu việc sử dụng đã hoàn tất phần giá trị chính của gói.

## 7. Trách nhiệm
- Sàn không chịu trách nhiệm với nội dung, dữ liệu hay hoạt động kinh doanh mà bạn đưa lên site của mình.
- Demo trên sàn chỉ nhằm xem trước, biểu mẫu, thanh toán và email trong demo không tạo giao dịch thật.

## 8. Thay đổi điều khoản
- Sàn có thể cập nhật điều khoản này bằng cách công bố phiên bản mới. Phiên bản mới áp dụng cho các giao dịch phát sinh sau thời điểm có hiệu lực của phiên bản đó.

## 9. Liên hệ
- Mọi thắc mắc về điều khoản, hãy gửi yêu cầu qua [trang liên hệ](/vi/contact). $$, 'published'
FROM policy_versions WHERE code = 'terms' AND version = 'terms-2026-10'
ON CONFLICT (policy_version_id, locale) DO NOTHING;

INSERT INTO policy_translations (policy_version_id, locale, title, body, review_status)
SELECT id, 'en', 'Terms of use', $$## 1. Platform and accounts
- Web Marketplace is a marketplace selling website templates. The platform provides the template catalog, demos, payment, delivery and hosting under the plan you buy.
- You are responsible for keeping your account secure and for all activity under your account.

## 2. Templates and license
- When you buy a template, you may use it for your own sites within the limits of the plan you bought, including any site count limit the plan sets.
- You may not resell, redistribute or publish a template source code as your own product, unless the plan you bought expressly allows it.

## 3. Orders and payment
- Displayed prices are the plan current prices at the time you view them. A quote created by the system stays fixed for the quote validity period.
- An order is processed only after payment is confirmed. The platform collects payment for orders placed through the platform.

## 4. Self-host and hosting
- Self-host plan: you receive the download bundle and are responsible for operating your own server after delivery.
- Hosted plan: the platform deploys and operates the site for you within the hosting service of the plan. You manage the site from your account.

## 5. Partners
- Partners sell templates through platform links and APIs under the partner program. The platform collects order payment and pays commission under the partner policy in effect, recorded at the time the order was created.

## 6. Refunds
- Refund requests are sent through support and handled under the refund policy that applies to the plan and payment method of the order.
- A downloaded bundle or a deployed and used site may still be refused a refund where the main value of the plan has already been consumed.

## 7. Liability
- The platform is not responsible for content, data or business activity you put on your own sites.
- Demos on the platform are previews only: forms, payments and emails in a demo create no real transaction.

## 8. Changes to these terms
- The platform may update these terms by publishing a new version. A new version applies to transactions created after its effective time.

## 9. Contact
- For any question about these terms, send a request through the [contact page](/en/contact). $$, 'published'
FROM policy_versions WHERE code = 'terms' AND version = 'terms-2026-10'
ON CONFLICT (policy_version_id, locale) DO NOTHING;

INSERT INTO policy_translations (policy_version_id, locale, title, body, review_status)
SELECT id, 'vi', 'Chính sách bảo mật', $$## 1. Dữ liệu sàn thu thập
- Khi bạn tạo tài khoản, đặt hàng hoặc gửi form liên hệ, sàn thu thập thông tin bạn cung cấp như tên, email, nội dung yêu cầu và thông tin đơn hàng.
- Khi bạn dùng web, sàn ghi nhận dữ liệu vận hành cần thiết như nhật ký truy cập và trạng thái đơn, site để duy trì dịch vụ.

## 2. Mục đích sử dụng
- Dữ liệu được dùng để tạo và quản lý tài khoản, xử lý đơn hàng và thanh toán, triển khai và vận hành site, hiển thị demo và trả lời yêu cầu hỗ trợ.
- Sàn không bán dữ liệu cá nhân của bạn cho bên thứ ba.

## 3. Chia sẻ dữ liệu
- Dữ liệu chỉ được chia sẻ với đơn vị xử lý thanh toán, nhà cung cấp hạ tầng và đối tác liên quan trong phạm vi cần thiết để thực hiện đơn hàng hoặc vận hành dịch vụ.
- Demo chạy trên tên miền riêng, tách khỏi sàn, nên code trong demo không đọc được thông tin đăng nhập của bạn.

## 4. Lưu trữ và bảo vệ
- Dữ liệu được lưu trữ trong thời gian cần thiết cho mục đích thu thập và theo quy định pháp luật hiện hành.
- Sàn áp dụng biện pháp kỹ thuật hợp lý để bảo vệ dữ liệu, bao gồm phân quyền truy cập và ghi nhật ký kiểm toán cho thao tác quản trị.

## 5. Quyền của bạn
- Bạn có thể xem và cập nhật thông tin tài khoản trong mục cài đặt tài khoản của mình.
- Bạn có thể yêu cầu xuất hoặc xóa dữ liệu cá nhân của mình bằng cách gửi yêu cầu qua [trang liên hệ](/vi/contact). Sàn sẽ xử lý yêu cầu trong phạm vi pháp luật cho phép và nghĩa vụ lưu trữ chứng từ.

## 6. Thay đổi chính sách
- Sàn có thể cập nhật chính sách này bằng cách công bố phiên bản mới. Phiên bản mới áp dụng từ thời điểm có hiệu lực của phiên bản đó. $$, 'published'
FROM policy_versions WHERE code = 'privacy' AND version = 'privacy-2026-10'
ON CONFLICT (policy_version_id, locale) DO NOTHING;

INSERT INTO policy_translations (policy_version_id, locale, title, body, review_status)
SELECT id, 'en', 'Privacy policy', $$## 1. Data the platform collects
- When you create an account, place an order or send a contact form, the platform collects the information you provide, such as your name, email, request content and order information.
- When you use the site, the platform records operational data needed to run the service, such as access logs and order and site status.

## 2. Purpose of use
- Data is used to create and manage accounts, process orders and payments, deploy and operate sites, show demos and answer support requests.
- The platform does not sell your personal data to any third party.

## 3. Sharing data
- Data is shared only with the payment processor, infrastructure providers and involved partners to the extent needed to fulfil an order or operate the service.
- Demos run on a separate domain, apart from the platform, so demo code cannot read your login information.

## 4. Storage and protection
- Data is kept for as long as needed for the collection purpose and as required by applicable law.
- The platform applies reasonable technical measures to protect data, including access control and audit logging for admin actions.

## 5. Your rights
- You can view and update your account information in your account settings.
- You can request an export or deletion of your personal data by sending a request through the [contact page](/en/contact). The platform will handle the request within what the law allows and its record-keeping duties.

## 6. Changes to this policy
- The platform may update this policy by publishing a new version. A new version applies from its effective time. $$, 'published'
FROM policy_versions WHERE code = 'privacy' AND version = 'privacy-2026-10'
ON CONFLICT (policy_version_id, locale) DO NOTHING;

INSERT INTO settings (key, value_json) VALUES
  ('contact.channels', '{"phone": "", "zalo": "", "messenger": "", "email": ""}'::jsonb)
ON CONFLICT (key) DO NOTHING;
