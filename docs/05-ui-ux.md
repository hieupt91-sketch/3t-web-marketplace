# 05. Yêu cầu UI/UX toàn hệ thống

## 1. Cách sử dụng tài liệu

Đây là đặc tả màn hình và tương tác để designer/dev dựng giao diện thực tế; không phải bộ ảnh mockup đã hoàn thiện. Mỗi mã UI phải có thiết kế desktop/mobile, dữ liệu thật qua API, phân quyền và kiểm thử. Các màn dùng chung component vẫn phải đáp ứng trạng thái theo ngữ cảnh.

Năm khu vực: **cửa hàng**, **tài khoản khách**, **quản trị 3T**, **cổng CTV**, **quản trị website thành phẩm**. Header demo là shell riêng trên origin an toàn. UI không hiển thị SQL, Docker, queue hoặc tên adapter cho người mua thông thường; admin nhập source có thể xem các chi tiết kỹ thuật cần thiết.

## 2. Design system nền tảng

| Token/đặc tính | Quy định triển khai |
|---|---|
| Tone | Sạch, rõ, tin cậy; nhiều khoảng trắng, card mẫu có ảnh thật, hạn chế trang trí |
| Primary | `#1D4ED8`, hover `#1E40AF`, text trên nút trắng |
| Surface | `#FFFFFF`, nền ứng dụng `#F8FAFC`, border `#CBD5E1` |
| Text | chính `#0F172A`, phụ `#475569`; không dùng xám quá nhạt cho thông tin bắt buộc |
| Success / warning / danger | `#166534` / `#92400E` / `#B91C1C`, kèm icon + nhãn |
| Font | Font hệ thống hỗ trợ tiếng Việt; tùy chọn font được phép phân phối, self-host |
| Type | body 16/24 px; label 14/20; H1 36–48 desktop/28–32 mobile; số tiền tabular |
| Spacing | Scale 4/8/12/16/24/32/48/64 px |
| Radius | Input 8 px, card/modal 12 px; shadow nhẹ, không thay border |
| Container | Store max-width 1280 px; dashboard fluid có lề 24; form max-width 760 |
| Header/sidebar | Header 64 px; sidebar 240 px desktop; mobile drawer có focus trap |
| Breakpoint | <640 mobile; 640–1023 tablet; ≥1024 desktop; kiểm tra 360/390/768/1440 |
| Button | Cao ít nhất 44 px, label động từ; tối đa một primary chính mỗi vùng |
| Motion | 150–200 ms, tôn trọng prefers-reduced-motion; không spinner vô hạn |
| Dark mode | Không bắt buộc v1; token tách biệt để thêm sau |

Màu là định hướng, designer phải kiểm contrast WCAG 2.2 AA trên cặp màu sử dụng thực tế. Không dùng icon không nhãn cho “Mua”, “Xóa”, “Tải”. Language switch ghi “Tiếng Việt / English”, không chỉ dùng cờ quốc gia.

## 3. Component chuẩn

| Component | Biến thể bắt buộc | Hành vi |
|---|---|---|
| TemplateCard | ảnh/giá/mode/locale, skeleton, unavailable | Click card xem detail; hai CTA demo và xem gói |
| PriceBreakdown | one-time, recurring, tax/discount | Ghi rõ kỳ đầu và kỳ sau, không che phí hosting |
| StatusBadge | neutral/info/success/warning/error | Nhãn text có bản dịch, không chỉ màu |
| DataTable | paging/filter/sort/empty/error | URL giữ filter; selection không mất khi mở detail |
| FormField | text/select/number/textarea | Label, hint, error liên kết aria-describedby |
| UploadZone | idle/drag/upload/paused/failed/done | MIME/size trước tải, cancel, progress bytes thật |
| JobTimeline | queued/running/succeeded/failed | Bước thật, elapsed, retry theo quyền, mã hỗ trợ |
| ConfirmDialog | destructive/money/restore | Tác động, resource name, cancel mặc định; không chỉ “OK” |
| LocaleTabs | vi/en/missing/stale | Dirty state theo locale, báo thiếu bản dịch |
| SecretField | chưa cấu hình/đã cấu hình/rotate | Không đọc lại secret; tạo key có copy-once |
| DomainCard | waiting/verified/tls/active/error | Copy DNS value riêng từng ô, giải thích TTL |
| CodeSnippet | JS/cURL, dark code surface | Chỉ placeholder, không chèn key thật vào analytics |
| EmptyState | lần đầu / lọc không có kết quả | CTA đúng nguyên nhân, không ép mua sai ngữ cảnh |
| ErrorState | retryable/forbidden/not found | Request ID, retry hoặc hướng dẫn; không stack trace |
| Notification | toast/inline/banner/inbox | Lỗi quan trọng ở inline/banner, không chỉ toast mất nhanh |
| Stepper | current/done/error | Back giữ form, validate step trước tiến |
| Money / DateTime | locale-aware | Tiền/currency nhất quán; timezone rõ trong báo cáo |
| RichText | limited headings/lists/links/media | Sanitized, preview, không script tùy ý |
| ResourcePicker | images/products/pages | Search, chọn nhiều, alt, permission |
| AuditTimeline | actor/action/time | Diff đã che secrets, không sửa trực tiếp |

## 4. Trạng thái chung cho mọi màn hình

Mỗi UI có tối thiểu: loading; loaded; empty; validation error; server/network error; quyền không đủ; session hết hạn; mobile. Màn mutation thêm saving, success, conflict revision và tránh double-submit. Khi mất mạng giữ draft local **không chứa secret**, cho retry với cùng idempotency key, không tự gửi thanh toán lần hai.

Điều hướng về sau login giữ return path nội bộ đã allowlist. Form có thay đổi chưa lưu cảnh báo trước rời trang. Nút bị disable có giải thích. API fail không xóa dữ liệu người dùng đang nhập. Skeleton không giả số doanh thu, ảnh hay thành công.

## 5. Cửa hàng công khai

Các route public có prefix `/{locale}`. Đường dẫn dưới đây dùng `/:locale` để chỉ biến.

| UI | Route / người dùng | Khối nội dung và hành động | Validation/trạng thái riêng | API |
|---|---|---|---|---|
| P01 | `/:locale` / public | Header logo, tìm mẫu, ngành, cách mua, CTV, language, login; hero tìm mẫu; mẫu nổi bật; so sánh hai gói; FAQ; footer | Search enter mở danh sách; không hiển thị mẫu archived; thiếu ảnh có fallback | config/public, templates |
| P02 | `/:locale/templates` / public | Search debounce, ngành, giá, website/landing, selfhost/hosting, locale, features, sort; grid 3 desktop/2 tablet/1 mobile | Filter query trên URL; reset; empty search khác chưa có mẫu | GET templates |
| P03 | `/:locale/templates/:slug` / public | Gallery, tên/mô tả, tính năng, trang kèm, yêu cầu, changelog, quyền, hai CTA; plan selector bên phải | Giá backend; badge locale thật; mẫu ngừng bán giữ trang thông báo, khách cũ có link tải | GET templates/{slug}, plans |
| P04 | `/:locale/plans/compare` / public | Bảng tải về/hosting, việc ai phụ trách, phí, cập nhật, hỗ trợ, FAQ; chọn gói | Mobile thành card có cùng hàng nội dung; không dùng checkbox mơ hồ cho source | plans |
| P05 | `/:locale/how-it-works` / public | 4 bước mua, video/ảnh nếu có, demo, domain DNS, download VPS | Giải thích nhập domain cần DNS; link trợ giúp | pages/public |
| P06 | `/:locale/help[/:slug]` / public | Search tài liệu, mục lục, bài, liên hệ hỗ trợ | Nội dung theo locale, fallback gắn nhãn | pages/public |
| P07 | `/:locale/partners` / public | Lợi ích CTV, cách bán API/link, chính sách, đăng ký | Không công bố mức hoa hồng chưa cấu hình; trạng thái đang chờ duyệt | partner public config |
| P08 | `/:locale/policies/:slug` / public | Điều khoản, bảo mật, hoàn tiền, hosting, quyền tài nguyên; version/effective date | Đúng version đã áp dụng cho đơn; bản dịch chưa duyệt gắn nhãn | policy documents |
| P09 | `/:locale/contact` / public | Tên/email/nội dung, liên hệ doanh nghiệp, consent | Chống spam; thành công không nhầm đã tạo đơn | contact/support public |

Các API nội dung `pages/public`, policy/contact được dev triển khai trong module CMS nền tảng và đưa vào OpenAPI; không dùng dữ liệu hardcode không thể quản trị để lấp màn hình.

## 6. Đăng nhập và tài khoản

| UI | Route / vai trò | Nội dung + CTA | Validation/trạng thái riêng | API |
|---|---|---|---|---|
| U01 | `/auth/register` / guest | Tên, email, password, locale, đồng ý điều khoản; tạo tài khoản | Email chuẩn hóa; password policy hiện trước; password manager hoạt động; không tiết lộ email tồn tại | auth/register |
| U02 | `/auth/login` / guest | Email/password, show password, quên mật khẩu; đăng nhập | Rate-limit/captcha chỉ khi policy, thông báo chung; return path an toàn | auth/login |
| U03 | `/auth/verify` / user/token | Trạng thái xác minh, resend có cooldown | Token dùng rồi/hết hạn/không hợp lệ; không vòng lặp vô hạn | verify-email/resend |
| U04 | `/auth/forgot-password` / public | Email, gửi link | Câu trả lời giống nhau cho email có/không tài khoản | forgot-password |
| U05 | `/auth/reset-password` / token | Password mới/confirm, checklist | Token hết hạn, thành công dẫn login; không auto reuse token | reset-password |
| U06 | `/account/security` / user | Đổi mật khẩu quy trình riêng, thiết bị, revoke session, MFA cho staff | Step-up, cảnh báo phiên hiện tại; recovery codes chỉ hiện khi tạo | sessions/MFA endpoints |

## 7. Demo

| UI | Route | Nội dung + CTA | Validation/trạng thái riêng | API |
|---|---|---|---|---|
| D01 | `/demo/:templateVersionId` | Thanh tên mẫu, desktop/tablet/mobile preview width, locale, mở tab, mua; iframe origin riêng | Iframe lỗi có open-tab; không truyền auth platform; đổi width không gọi đó là kiểm thử thiết bị thật | demo public URL |
| D02 | `/demo/start/:versionId` | Tạo phiên riêng, tiến trình, dự kiến hết hạn, quay lại | Queue/capacity, 429, cancel; reload khôi phục job | POST demo-sessions |
| D03 | `/demo/sessions/:id` | URL demo, vào admin, countdown, reset, mua/giữ nội dung | Ready mới admin-launch; session của người khác 404; reset có xác nhận | session/admin-launch/reset |
| D04 | `/demo/sessions/:id/expired` | Đã hết hạn, tạo lại hoặc chọn mua, policy dữ liệu | Không giả giữ dữ liệu đã xóa; API expired ngay cả tab còn mở | session status |

## 8. Chọn gói và thanh toán

| UI | Route | Nội dung + CTA | Validation/trạng thái riêng | API |
|---|---|---|---|---|
| B01 | `/checkout/configure` | Mẫu, radio tự deploy/hosting, cycle, currency, coupon, quyền source, locale; tiếp tục | Không nhầm phí một lần với recurring; plan unavailable → báo và chọn lại | quotes |
| B02 | `/checkout/:sessionId/review` | Thông tin buyer, chi tiết giá/thuế, chính sách, tên CTV nếu có; xác nhận đơn | Xác minh email trước cấp quyền; quote expired reprice có confirm | claim/orders |
| B03 | `/checkout/orders/:id/pay` | QR/provider redirect, tổng tiền, mã đơn, hạn, đổi phương thức | Poll trạng thái máy chủ; nút đã chuyển tiền chỉ yêu cầu kiểm tra; không mark paid | payment-sessions/order |
| B04 | `/checkout/orders/:id/result` | Paid + đang bàn giao/ready, unpaid/failed/expired; tải hoặc tạo website | Không tin `?success=true`; callback chậm hiển thị pending; tránh trả tiền lặp | GET order |
| B05 | `/checkout/orders/:id/issue` | Lỗi thanh toán/thiếu-thừa/late, hướng dẫn, mã hỗ trợ, retry hợp lệ | Không expose bank logs; giữ đơn và attempt history | order/refund-request |

## 9. Portal người mua

| UI | Route / vai trò | Nội dung + CTA | Validation/trạng thái riêng | API |
|---|---|---|---|---|
| C01 | `/account` / user | Quyền đã mua, site, đơn chờ, gia hạn sắp đến, hướng dẫn bắt đầu | Empty first-use; banner sự cố liên quan | me/entitlements/sites/orders |
| C02 | `/account/purchases` / user | Card mẫu/mode/version/quyền cập nhật, tải hoặc setup | Khóa theo entitlement, không chỉ disable UI | entitlements |
| C03 | `/account/purchases/:id/downloads` / owner | Chọn version đủ quyền, checksum, size, hướng dẫn; tải | Link expired xin link mới; revoked hỗ trợ; không liệt kê version không đủ quyền | download-links |
| C04 | `/account/orders[/:id]` / owner | List filter và detail timeline, tiền, phương thức, CTV, bàn giao, refund request | Paid và fulfillment độc lập; chứng từ chưa có không gọi hóa đơn hợp lệ | orders |
| C05 | `/account/sites/new` / entitlement owner | 4 bước: quyền/mẫu → tên/locale → subdomain/seed → xác nhận | Subdomain 3–40 ký tự, lower kebab, reserved words; quota; demo expired | POST sites |
| C06 | `/account/sites/:id/creating` / owner | Checklist khởi tạo, tiến trình thật, elapsed, retry/support | Paid/provision_failed không yêu cầu mua lại; reload resume | job/site |
| C07 | `/account/sites/:id` / member | Site URL, admin, trạng thái, version, hạn, quota, task gần nhất | Suspended cho thanh toán/export theo policy; không che nguyên nhân | site/deployments |
| C08 | `/account/sites/:id/domains` / owner | Danh sách domain, primary, TLS, thêm; wizard DNS | Normalize IDN/punycode, không scheme/path/IP; verify pending | domains |
| C09 | `/account/sites/:id/billing` / owner | Plan, ngày bắt đầu/kết thúc, cycle, gia hạn, lịch sử | Hiển thị giá kỳ mới trước trả; quota downgrade có xử lý | renewal-orders/subscription |
| C10 | `/account/sites/:id/backups` / owner | Mốc backup/size/status; tạo, restore | Restore xác nhận tên site, maintenance; failed không chọn được | backups/restores |
| C11 | `/account/sites/:id/updates` / owner | Current/available, changelog, compatibility, backup gate | Không update ngược schema không tương thích; progress/rollback | deployments |
| C12 | `/account/sites/:id/members` / owner | Email invite, role, pending, revoke | Không bỏ owner cuối, không CTV auto-access, email verify | members |
| C13 | `/account/settings` / user | Tên, email verify, locale, timezone, notification preferences | Dirty form, locale đổi UI giữ resource, không đổi currency đơn | me/settings |
| C14 | `/account/support[/:id]` / owner | Ticket list/detail/new, attachments, status, reply | File type/size, link site thuộc user, unsent draft | support/tickets |
| C15 | `/account/sites/:id/data` / owner | Export data, retention, delete schedule, cancel delete | Source export riêng quyền; step-up; không purge ngay sau nút đầu | data-exports/deletion-requests |

## 10. Quản trị nền tảng 3T

| UI | Route / permission | Nội dung + CTA | Validation/trạng thái riêng | API |
|---|---|---|---|---|
| A01 | `/admin` / report:read | Doanh thu theo currency, đơn lỗi, demo queue, site cảnh báo, partner payout | Date/timezone rõ; không cộng các currency thành một số | admin/overview |
| A02 | `/admin/templates` / template:read | List ảnh/tên/version/adapter/locales/status/giá; tạo/import/edit | Filter status/category, empty state, archived giữ lịch sử | admin/templates |
| A03 | `/admin/imports/new` / template:import | Tabs ZIP/GitHub; file/repo/ref/subdir; upload + scan | 100MiB policy, digest, consent quyền asset; Git repo chỉ installation được cấp | upload-sessions/imports |
| A04 | `/admin/imports/:id/configure` / template:import | Candidate adapter, confidence, root/build/output/env/DB/locales; raw manifest view | Highlight missing JSON pointer; secret nhập vault, không manifest; không tự execute config | configuration |
| A05 | `/admin/imports/:id` / template:read | Stage timeline/logs, detected config, preview, screenshots, retry/cancel | Step-specific errors, redacted logs, copy request ID; preview không phải publish | imports/logs/retry |
| A06 | `/admin/templates/:id/edit` / template:write | Tabs metadata, screenshots, capabilities, docs/assets, localized content | Title/slug required, alt, rights checklist; source immutable | templates/translations |
| A07 | `/admin/templates/:id/versions` / template:write | Versions, SHA, manifest, artifacts, demo; nhập version | Trùng semver khác hash → reject; không replace release | versions/imports |
| A08 | `/admin/templates/:id/plans` / pricing:write | Selfhost/hosting plans, price/currency/cycle, limits, updates/support policy | Amount integer nonnegative; effective dates; preview checkout snapshot | plans/prices |
| A09 | `/admin/templates/:id/publish` / template:publish | Gate checklist demo/build/license/locale/giá/export; preview public; publish/archive | Gate đỏ chặn; archive chỉ ngừng bán mới, ghi rõ tác động | publish/archive |
| A10 | `/admin/orders` / order:read | Search order/buyer/partner, status, money, create date; export quyền phù hợp | Filter riêng payment/fulfillment; PII theo role | admin/orders |
| A11 | `/admin/orders/:id` / order:read | Timeline, quote snapshot, events, entitlement, site, note; retry fulfill/manual confirm | Manual confirm cần evidence/tx UQ/reason, step-up; không nút đổi trạng thái tùy ý | order/manual-payment |
| A12 | `/admin/payments/reconciliation` / payment:read | Callback lỗi, unmatched, thiếu-thừa, late; match/resolve | Đối soát tiền/currency; thao tác có audit, không sửa raw event | reconciliation |
| A13 | `/admin/refunds` / payment:refund | Request, amounts available, reason, provider result, ảnh hưởng entitlement/commission | Partial/full, chưa settle không báo đã hoàn; giữ lịch sử | refunds |
| A14 | `/admin/customers[/:id]` / user:manage | Account, orders/sites/tickets, lock account, sessions | Reauth cho lock, reason, không xem password; phân biệt user lock/site suspend | users |
| A15 | `/admin/sites[/:id]` / site:operate | Runtime/node, quota, version, subscription, domain, health, logs; restart/update/suspend | Action allowlist + reason + expected state; không terminal tùy ý ở web | sites/operations |
| A16 | `/admin/domains` / site:operate | Pending DNS/TLS failures/expiring, owner/site, retry | Không chuyển domain sang site khác khi chưa verify lại | domain operations |
| A17 | `/admin/demos` / ops:read | Sessions/TTL/resource, reset/expire/cancel jobs | Không cleanup promotion locked; giới hạn thao tác hàng loạt | demo admin |
| A18 | `/admin/jobs` / ops:execute | Queue, age, steps, attempts, dead-letter; retry | Không retry job đang chạy lease còn hợp lệ; concurrency guard | jobs |
| A19 | `/admin/backups` / site:operate | Theo node/site, failed jobs, retention, restore history | Không purge bản đang restore; show checksum status | backups |
| A20 | `/admin/partners[/:id]` / partner:manage | Applications, domain bán, API status, policy, orders, suspend | Approve/reject reason; suspend key không revoke quyền khách đã mua | partners/review/policy |
| A21 | `/admin/payouts[/:id]` / payout role | Available/reserved, batch request, review, payment evidence, settle | Người duyệt/chi theo role; không đánh dấu paid nếu thiếu evidence | payouts |
| A22 | `/admin/translations` / translation role | Matrix resource × locale, missing/stale/review, editor | Source revision đổi → stale; không publish bài rỗng | translations |
| A23 | `/admin/settings` / settings:manage | Brand/locales/domains/mail/payment/GitHub/storage/retention/rate/commission | Secret masked; test connection an toàn; save từng nhóm; change audit | settings |
| A24 | `/admin/staff` / staff:manage | Staff/roles/permissions, invite/revoke/MFA status | Không cấp quyền vượt actor, không xóa owner cuối | staff |
| A25 | `/admin/audit` / audit:read | Time/actor/resource/action/filter/detail redacted | Chỉ read, export role; retention hiển thị | audit-logs |
| A26 | `/admin/support[/:id]` / support role | Queue/assignment/SLA/reply, liên kết order/site | Nội dung không kích hoạt thao tác ngoài; response theo locale khách | support |
| A27 | `/admin/content` / content role | Help/FAQ/policy/contact data, version và bản dịch | Terms không overwrite version đơn cũ; review trước publish | content admin |

## 11. Cổng cộng tác viên

| UI | Route / vai trò | Nội dung + CTA | Validation/trạng thái riêng | API |
|---|---|---|---|---|
| R01 | `/partner/apply` / verified user | Tên hiển thị, kênh bán/domain, mô tả, policy consent; đăng ký | Pending/rejected/approved, sửa đơn khi yêu cầu bổ sung | partners/applications |
| R02 | `/partner` / CTV | Đơn mới, paid, tiền chờ/khả dụng/đã chi, quick links | Không gọi pending là số dư rút được; currency tách | partner summary/balance |
| R03 | `/partner/catalog` / CTV | Mẫu được bán, giá, commission basis/rate, locale, copy link/demo | Mẫu archived hoặc partner suspended disable đúng lý do | catalog |
| R04 | `/partner/links` / CTV | Chọn mẫu/locale/campaign, link referral/demo; tạo checkout thử | URL return allowlist, label sandbox; không đặt total client | demo-links/checkout-sessions |
| R05 | `/partner/orders[/:id]` / CTV | external_reference, mẫu/mode, payment/fulfillment, commission | Buyer masked; không download/source/admin-login của khách | partner orders |
| R06 | `/partner/commissions` / CTV | Entries earned/reversed, base/rate, eligible date, dispute hold | Bộ lọc pending/eligible/paid; lịch sử bất biến | commissions |
| R07 | `/partner/payouts` / CTV | Khả dụng, ngưỡng, thông tin nhận, yêu cầu/chi trả history | Amount <= available, step-up, reserved balance tránh double-click | payouts |
| R08 | `/partner/api-keys` / CTV | Keys prefix/scope/expiry/last use, tạo/rotate/revoke | Secret show once, copy xong nhắc lưu; scope min, reauth; không hiện full key sau | api-keys |
| R09 | `/partner/webhooks` / CTV | Endpoint/events/status, challenge, test, rotate secret | Public HTTPS, reject nội bộ; endpoint chưa verify không nhận event thật | webhooks |
| R10 | `/partner/webhooks/:id/deliveries` / CTV | Event ID/attempt/status/response/time, replay | At-least-once nhãn rõ; không raw secrets/buyer PII | deliveries |
| R11 | `/partner/developers` / CTV | Quickstart server-to-server, scopes, examples, errors, limits, sandbox | Snippet chỉ placeholder; phân biệt key backend/public catalog | API docs |
| R12 | `/partner/settings` / CTV | Locale/timezone, domain return allowlist, payout profile, policy | Thay ngân hàng step-up/verify/cooldown policy, version lịch sử | partner settings |

## 12. Trang quản trị website thành phẩm tiêu chuẩn

Các route dưới đây trên domain site, không phải domain nền tảng. Hiện module theo `capabilities`; mẫu thuần HTML không tự có các màn này.

| UI | Route / role | Nội dung + CTA | Validation/trạng thái riêng | API runtime |
|---|---|---|---|---|
| W01 | `/setup` / setup token | Tên site, admin email/password, locale, domain/public URL; hoàn tất | Token một lần, chưa init, secret random; chặn public takeover | setup/complete |
| W02 | `/admin/login` / site user | Login, quên mật khẩu, nhãn demo nếu có | Không dùng cookie portal; demo khác production | auth |
| W03 | `/admin` / site member | Nội dung draft, sản phẩm, contacts, xem site, thao tác nhanh | Số liệu đúng capability; không giả doanh thu ở mẫu catalog | admin summary |
| W04 | `/admin/pages` / editor | Page list, status/locales/updated, tạo/sửa/publish | Slug unique locale, draft preview link scoped | admin/pages |
| W05 | `/admin/pages/:id` / editor | Block editor theo schema, title/body/locale/SEO, reorder, preview | Required block props, URL sanitize, version conflict, publish role | pages/media |
| W06 | `/admin/products` / product role | Search/category/status/SKU/locale, thumbnail; thêm/sửa/archive | Không xóa sản phẩm đang tham chiếu mà không xử lý | products |
| W07 | `/admin/products/:id` / product role | Tên/SKU/danh mục/gallery/price optional/description/spec/SEO/locales | SKU UQ; price integer; ảnh alt; không có cart khi capability off | products/categories/media |
| W08 | `/admin/categories` / product role | Tree/order/name/slug/translations; thêm/sửa | Chống cycle, xử lý items trước xóa; drag có keyboard alternative | categories |
| W09 | `/admin/articles[/:id]` / editor | List/editor, excerpt, cover, tags, SEO, schedule | Publish date/timezone, draft locales, safe rich text | articles |
| W10 | `/admin/banners` / editor | Desktop/mobile images, text, link, order, schedule | Aspect hint, alt/contrast, link allowlist | banners |
| W11 | `/admin/media` / media role | Grid/list search, upload, alt locale, usage, delete | MIME/signature/size/quota; used media warn; SVG sanitize hoặc deny | media |
| W12 | `/admin/menus` / editor | Header/footer tree, localized label, target; reorder | URL scheme allowlist, menu cycle, keyboard move | menus |
| W13 | `/admin/contacts` / lead role | Name/contact/message/time/consent/status, reply action tùy integration | Data retention, spam, export theo quyền; demo fake entries | contact-requests |
| W14 | `/admin/settings` / owner | Brand/logo/contact/social/public URL, locale/SEO/favicon | Domain thay tại portal nếu hosted; không nhập DB secret ở public setting | settings |
| W15 | `/admin/translations` / editor | Field matrix missing/stale, source copy, preview | locale thực có content; font dài/RTL readiness | translation endpoints |
| W16 | `/admin/users[/:id]` / owner | Users/roles/invite/revoke, audit | Không xóa owner cuối, step-up khi đổi quyền | users/audit |
| W17 | `/admin/system` / owner | Version/health, export/backup shortcut, docs | Hosted action dẫn portal; selfhost hướng dẫn operator; không giả có auto-host API | system metadata |

## 13. Bố cục cụ thể các màn quan trọng

### P02 — thư viện mẫu

Desktop: header 64px; title + số kết quả; hàng search/sort; sidebar filter 240px; phần còn lại grid 3 cột, gap 24. Card ảnh 16:10, tiêu đề tối đa hai dòng, category/locale, giá có chữ “từ” nếu nhiều plan, CTA “Xem demo” và “Chi tiết”. Tablet bỏ sidebar vào drawer, 2 cột. Mobile 1 cột, filter bottom sheet, sort select, pagination cuối; không tự vô hạn làm mất footer.

### P03 — chi tiết mẫu

Desktop 8/4 columns: gallery và tabs nội dung bên trái, plan card sticky bên phải; sticky không che footer. Tabs “Tổng quan”, “Tính năng”, “Bàn giao”, “Phiên bản”, “Hỗ trợ”. Plan card radio hai kiểu mua, breakdown, khả năng hỗ trợ locale, nút demo phụ và mua chính. Mobile plan card sau overview, sticky bottom “Từ … / Chọn gói” cao 64px có safe-area, padding body tương ứng.

### A03–A05 — nhập mẫu

Stepper “Tài nguyên → Cấu hình → Xây demo → Kiểm tra”. Tab ZIP có dropzone 320px desktop, policy ngay dưới. Tab GitHub có installation/repo/ref/subdirectory, commit preview; không nhập token vào query URL. Nhận diện xong hiển thị card kết quả và những trường còn thiếu; không ép admin đọc raw JSON. Advanced drawer có manifest để copy/download. Progress dùng timeline từng bước, log panel monospace có tìm kiếm/redaction, retry riêng và link mở preview. Lỗi chỉ ra path/field, một hành động sửa cụ thể.

### B01–B04 — checkout

Desktop form 7/5 columns, order summary sticky; mobile summary có thể collapse nhưng tổng tiền luôn hiện. Plan type chỉ một radio được chọn. Tổng breakdown = phí mẫu + kỳ đầu − giảm giá + thuế cấu hình. Email đã xác minh, terms checkbox có link/version, CTA “Thanh toán …”. Trang QR giữ mã đơn/copy số tiền/mã tham chiếu; countdown theo server. Khi paid chuyển progress bàn giao, không hiển thị nút trả lại tiền do job chậm.

### C05–C08 — tạo website và domain

Step 1 chọn entitlement còn slot; step 2 tên/logo/locale; step 3 địa chỉ mặc định; step 4 seed mới/giữ demo đủ điều kiện. Sau ready có card URL và “Vào quản trị”. Domain riêng wizard: nhập hostname → bảng DNS type/name/value/TTL → trạng thái verify → HTTPS → primary. Có hướng dẫn riêng apex và www; không yêu cầu khách cung cấp mật khẩu nhà đăng ký. “Kiểm tra lại” có cooldown và timestamp lần kiểm gần nhất.

### A08 — cấu hình gói

Tab tự triển khai/hosting, bảng giá hiệu lực và form chi tiết. Hiển thị các quyền source, số instance, cập nhật đến khi nào, hỗ trợ, quota, hosting period/grace/retention. Bên phải preview nội dung khách thấy. Đổi policy tạo revision; cảnh báo “Áp dụng cho đơn mới từ …”, không sửa đơn đã trả tiền.

### R08–R11 — khu developer CTV

Trang key chỉ list prefix và lần dùng; create modal tên/key scope/expiry, success có secret show once và nút copy. Key không đi vào URL/analytics. Docs có steps lấy catalog → tạo quote → checkout → xác thực webhook; code tabs Node/cURL giữ placeholder. Sandbox badge luôn hiện; tách event test không cộng hoa hồng. Webhook delivery drawer hiển thị event ID, signature header names, body redacted và status; replay không tạo giao dịch kinh tế mới.

### R06–R07 — hoa hồng

Bốn card: đang chờ, đủ điều kiện, đang chi, đã chi; bút toán đảo hiển thị dấu âm và lý do hoàn tiền. Table cho xem snapshot rate/base/currency. Rút tiền form amount + payout profile version + available; disable nếu chưa đạt ngưỡng hoặc hold nhưng ghi rõ lý do. Không ghi “thành công” khi chỉ gửi yêu cầu; trạng thái request/approved/processing/paid/failed tách biệt.

### A22/W15 — dịch nội dung

Desktop hai cột: nguồn read-only, ngôn ngữ đích editable; header chọn locale/source revision, badge missing/stale/reviewed. Mobile tabs nguồn/đích có status. Các field title/summary/slug/SEO/body có count/hint nhưng không cắt cứng mọi ngôn ngữ. Save draft, preview, submit review; publish permission riêng. Không giả tự dịch là nội dung đã duyệt.

### W05/W07 — sửa nội dung site

Toolbar breadcrumb + status + preview/save/publish. Main form theo section, sidebar media/category/SEO. LocaleTabs đặt trên vùng nội dung; SKU và ảnh dùng chung nhưng tên/description/alt/slug theo locale. Preview draft dùng token scoped, noindex và TTL. Chuyển locale giữ bản nháp từng ngôn ngữ và báo chưa lưu. Hai người sửa cùng lúc có conflict view, không overwrite người sau.

## 14. Quy tắc responsive và accessibility

- Mọi tác vụ cốt lõi dùng được trên 360px: xem/mua/tải/theo dõi/tạo site/domain/CTV. Admin log/bảng rộng được cuộn ngang có nhãn, các cột chính luôn thấy; không thu chữ thành 9px.
- Tab order theo thứ tự đọc, skip-to-content, heading hierarchy; dialog focus trap/restore, Escape đóng khi an toàn.
- Error summary trên form có link tới field; thông báo status qua aria-live, không đọc lại cả trang khi poll.
- Touch target ≥44px định hướng thiết kế; không chỉ hover. Tooltip không chứa thông tin duy nhất cần mua.
- Không dựa màu để báo trạng thái; biểu đồ có dữ liệu bảng tương đương. Giữ tên tiếng Việt có dấu; search hỗ trợ có/không dấu nhưng không đổi giá trị lưu.
- Tiền, giờ, link dài và nội dung EN dài hơn 30–50% được kiểm thử. Layout dùng logical properties để thêm RTL; v1 chưa công bố hỗ trợ tiếng Ả Rập nếu chưa QA.
- Mọi ảnh nội dung có alt phù hợp; ảnh trang trí alt rỗng; ảnh chụp demo có mô tả locale.

## 15. Nội dung thông báo mẫu VI/EN

| Key | vi | en |
|---|---|---|
| import.ready | Demo đã sẵn sàng. Bạn có thể kiểm tra trước khi công bố mẫu. | Your demo is ready. Review it before publishing the template. |
| import.configuration_required | Cần bổ sung cấu hình để chạy mẫu này. | More configuration is needed to run this template. |
| payment.pending | Hệ thống đang chờ xác nhận thanh toán. | We are waiting for payment confirmation. |
| payment.paid_provisioning | Đã nhận thanh toán. Website đang được khởi tạo. | Payment received. Your website is being created. |
| provisioning.failed | Quyền mua của bạn đã được lưu. Chúng tôi cần xử lý lại bước khởi tạo. | Your purchase is saved. Website setup needs another attempt. |
| domain.waiting_dns | Tên miền chưa trỏ đúng. Hãy kiểm tra bản ghi bên dưới. | The domain is not pointing correctly. Check the records below. |
| demo.expired | Phiên dùng thử đã hết hạn. | This demo session has expired. |
| api_key.once | Khóa chỉ hiển thị một lần. Hãy lưu ở máy chủ của bạn. | This key is shown once. Store it securely on your server. |
| commission.pending | Hoa hồng đang chờ đủ điều kiện chi trả. | Commission is pending eligibility for payout. |
| translation.stale | Nội dung gốc đã thay đổi. Cần kiểm tra lại bản dịch. | The source has changed. Review this translation. |

## 16. Bàn giao UI bắt buộc

Designer: design tokens, component variants, screen map, desktop/mobile cho toàn bộ mã UI, prototype các luồng mua/import/domain/CTV/dịch, error/empty states, annotation field/permission. Dev: route + API mapping, form validation cùng contract server, i18n keys, keyboard checks, data-testid cho journey trọng yếu, ảnh evidence ở staging. Nút/link chưa làm phải được đánh dấu trong backlog; không phát hành nút trông như hoạt động nhưng không có xử lý.
