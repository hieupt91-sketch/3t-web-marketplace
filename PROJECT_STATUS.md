# Trạng thái dự án

Ngày cập nhật: 23/10/2026 (Asia/Ho_Chi_Minh). Đặc tả 1.0. Nhánh: `feat/foundation` (M1–M3).

## Đã triển khai và kiểm thử

**M1 — Foundation (một phần lớn)**

- Monorepo pnpm/TypeScript, Node 22, lockfile; cấu trúc theo docs/09 §2 (chưa có `apps/admin`/`apps/partner` riêng: admin nằm trong `apps/web`, route `/admin`).
- `migrations/0001_foundation.sql`: users/sessions/auth_tokens, roles/permissions (5 vai trò seed), settings, artifacts (bất biến), templates/translations/versions (version bất biến bằng trigger), upload_sessions, imports/steps/logs, build_runs, previews, jobs, outbox, idempotency, audit_logs (append-only bằng trigger).
- Auth: đăng ký (không lộ email tồn tại), xác minh email một lần, đăng nhập/đăng xuất, quên/đặt lại mật khẩu (thu hồi mọi phiên), danh sách/thu hồi phiên. Mật khẩu scrypt. Cookie host-only HttpOnly SameSite=Lax. CSRF bằng kiểm Origin/Sec-Fetch-Site. Rate-limit trong bộ nhớ.
- RBAC kiểm ở API (`requirePermission`), lỗi theo hợp đồng docs/04 §1 (code + message dịch + request_id), Idempotency-Key, ETag/If-Match (412/428), phân trang cursor.
- i18n VI/EN: 400 khóa, kiểm tra trùng khóa/placeholder (`packages/i18n` lint) và khóa dùng trong web (`apps/web` lint). Design tokens theo docs/05 §2.

**M2 — Lát cắt nhập mẫu tĩnh (docs/11 §4)**

- Upload ZIP qua upload session có SHA-256 + kích thước khai báo, kiểm chữ ký ZIP, lưu private (không mất source).
- Worker: kiểm tra gói (Zip Slip, symlink, tệp đặc biệt, mã hóa, va chạm tên NFC/hoa-thường, zip bomb, giới hạn sau giải nén, đếm byte khi stream), bỏ `.git`/`__MACOSX`, quét bí mật (không in giá trị), nhận diện không thực thi code, manifest hiệu lực + JSON pointer, chính sách (adapter đã triển khai, tệp thực thi), kiểm tra output tĩnh, lưu artifact theo digest, tạo bản xem trước, health + smoke qua origin preview, chụp ảnh desktop/mobile (Chromium, chặn mọi request ngoài origin preview), bản nháp template + version bất biến.
- Job queue SQL: claim `SKIP LOCKED`, lease + heartbeat, fencing token, retry backoff có jitter, dead-letter; hủy giữa các bước.
- Preview server: origin riêng theo hostname ngẫu nhiên 160-bit, chặn `..`/dotfile, không liệt kê thư mục, noindex, `frame-ancestors` chỉ portal.
- UI: P01–P03 (chỉ dữ liệu đã publish; chưa có mẫu publish nên hiển thị trạng thái rỗng thật), U01–U05, U06 (phiên; đổi mật khẩu qua email), C01 (trạng thái rỗng), A01 (chỉ số liệu có thật), A02, A03 (ZIP; GitHub ghi rõ chưa triển khai), A04 (form cấu hình allowlist), A05 (timeline, lỗi, preview iframe sandbox, ảnh chụp, log, manifest).

**M3 — Catalog (lát cắt công bố, 23/10/2026)**

- `migrations/0002_catalog_pricing.sql`: `plans` (deployment_mode selfhost/hosted, status draft/active/archived, limits_json, row_version) và `plan_prices` (giá hiệu lực theo khoảng, exclusion constraint chống chồng lấn cùng plan/currency/interval bằng btree_gist); seed `terms.version`.
- API quản trị: `GET /admin/templates/{id}/detail` (bản dịch, phiên bản, gói+toàn bộ giá, cổng công bố), `PATCH /admin/templates/{id}` (ETag), `PUT /admin/templates/{id}/translations/{locale}` (slug unique theo locale → 409), `GET|POST /admin/templates/{id}/plans`, `PATCH /admin/plans/{id}` (kích hoạt đòi giá hiện hành), `POST /admin/plans/{id}/prices` (đổi giá tự đóng khoảng cũ, chồng lấn → 409), `POST .../publish` (gate đỏ chặn, công bố làm version + demo công khai), `POST .../archive`.
- API công khai: `/templates/{slug}` trả plans + current prices; `/templates` trả `starting_prices`; `GET /plans/{id}`. Giá là chuỗi minor units, VND.
- Cổng công bố (A09): demo_ready, default_translation, has_priced_plan, export_modes. Quyền: `template_editor` được tạo gói/giá nháp (pricing:write = "giá nháp"), chỉ `template:publish` mới công bố.
- UI: A02 danh sách mẫu (link chi tiết), A06/A08/A09 gộp ở `/admin/templates/{id}` (LocaleTabs vi/en, biên tập bản dịch, gói + bảng giá hiệu lực + kích hoạt, checklist cổng + publish/archive). Công khai P02 (giá "từ" trên thẻ), P03 (PriceBreakdown, nhãn chưa có checkout), P04 so sánh gói.
- Demo công khai + catalog (24/10/2026): D01 trang demo (iframe origin riêng sandbox, device width, open-tab, noindex) + CTA "Xem demo"; public API trả `demo {available, mode, url}`; filter catalog theo mode/capability; tìm không dấu VN (`unaccent`, migration 0003); SEO `sitemap.xml` (hreflang chỉ locale đã publish) + `robots.txt`. D02–D04 (demo isolated admin) chờ runtime adapter của M2.
- CMS nội dung (24/10/2026, đợt 2): migration 0004 `platform_pages`/`platform_page_translations`, `policy_versions` (bất biến sau publish bằng trigger)/`policy_translations`, `contact_requests`. API công khai `/pages/public/{slug}`, `/pages/help`, `/policies/{code}[/versions/{version}]` (fallback locale có nhãn), `POST /contact-requests` (honeypot + consent + rate-limit, trả 202 chung). API quản trị content/policy CRUD + publish (gate bản dịch vi), inbox liên hệ (A27). Web P05 how-it-works, P06 help (index + detail), P07 partners, P08 policies, P09 contact; renderer markdown an toàn (escape HTML, allowlist link); footer liên kết; admin content hub + editor trang/chính sách (LocaleTabs).

## Bằng chứng kiểm thử (máy dev, PostgreSQL 16 cục bộ)

`pnpm run check` PASS: docs validator; typecheck mọi package; i18n lint (589 khóa); 106 test (sdk 30, core 6, i18n 4, preview 12, api 14, tích hợp 40 gồm 16 import + 8 catalog + 7 content + 9 commerce). `next build` PASS. Đã chạy lượt trình duyệt: công bố mẫu + giá → P02/P03; tạo + công bố trang CMS → render markdown ở P05; gửi form liên hệ P09.

| Kịch bản | Bằng chứng tự động |
|---|---|
| AT-02 ZIP HTML fixture | `tests/integration/import-flow.test.ts` + chạy trình duyệt thật: ready ~3,8 s gồm chụp ảnh |
| AT-03 gói độc hại | `packages/template-sdk/src/archive.test.ts`, test tích hợp path traversal |
| AT-05 nhiều framework/Vite | `detect.test.ts`, test tích hợp Vite |
| AT-06 manifest sai | JSON pointer trong `manifest.test.ts` và test tích hợp |
| AT-13 token replay/hết hạn | `apps/api/src/auth.test.ts` |
| AT-30 cùng semver khác hash | test tích hợp |
| AT-31 thiếu quyền | test tích hợp (khách, support) |
| AT-51 ETag cũ | `auth.test.ts` (profile), test tích hợp (configuration) |

Một lượt kiểm tra trình duyệt thủ công bằng script (đăng nhập → upload → ready → iframe; 360 px không tràn ngang) đã chạy; script chưa đưa vào CI.

## Chưa triển khai (không tự bỏ khỏi phạm vi)

- **Nhập/Build:** adapter `vite-static`, `next-standalone`, `node-http` (cần executor/VM cách ly, proxy dependency allowlist); nhập GitHub + webhook (REQ-03); demo isolated admin (REQ-08); retry từng bước bằng checkpoint (hiện chạy lại toàn pipeline tĩnh, các bước idempotent).
- **Catalog M3:** sửa metadata/bản dịch (A06, A22), versions (A07), plans/giá (A08), publish gates (A09), filter ngoài search, P04–P09, D01–D04, sitemap/hreflang đầy đủ, tìm kiếm không dấu.
- **M4–M8:** quote/order/payment, entitlement/download, bộ cài self-host, hosting/domain/TLS/backup/gia hạn, CTV API/hoa hồng/payout/webhook, email provider thật, MFA/step-up, staff management, observability/alert, staging/production.
- Rate limit hiện ở bộ nhớ một process; production nhiều instance cần store chung.
- Object store là driver filesystem cục bộ; production cần storage private (S3-compatible) cùng interface.
- CI workflow `.github/workflows/ci.yml` đã viết nhưng chưa chạy trên GitHub; action đang pin theo tag, cần pin SHA trước release.

## Lệnh

```bash
pnpm install --frozen-lockfile
pnpm db:start && pnpm db:migrate
OWNER_EMAIL=ban@example.com pnpm owner:create
pnpm dev
pnpm run check
```

## Bước tiếp theo đề xuất

1. Review/merge `feat/foundation`; bật CI và xác nhận chạy xanh trên GitHub.
2. Hoàn thiện M3 còn lại: D01–D04 (shell demo công khai), P05–P09 (how-it-works/help/partners/policies/contact — cần module CMS nền tảng), A07 (màn versions đầy đủ), filter catalog ngoài search, sitemap/hreflang.
3. M4 — COMMERCE: quote/order/payment adapter sandbox, entitlement, tải bộ cài. Cần chốt provider thanh toán và email trước.
4. Thiết kế executor build cách ly (VM/sandbox riêng) trước khi bật `vite-static`/`next-standalone`/`node-http`.

## Quyết định chưa chốt

Xem `DECISIONS.md` (ADR-013 trở đi) và docs/11 §3: provider thanh toán/email, domain thương hiệu và domain preview, giá/hoa hồng, quota hosting.

## M4 — Commerce (M4a backend, 24/10/2026)

- migration 0005: quotes/orders/order_items/payment_attempts/payment_events/entitlements/download_events với ràng buộc tổng tiền (invariant §6.1) và entitlement unique theo order_item (§6.3).
- `PaymentProvider` interface + `MockPaymentProvider` sandbox (HMAC + timestamp + dedupe); giá tính 100% ở backend từ giá hiện hành của gói.
- API: POST /quotes (bound buyer, hết hạn 15'), POST /orders (yêu cầu buyer verified + terms hiện hành, idempotent), GET /orders[/{id}], POST /orders/{id}/payment-sessions|cancel, POST /payments/mock/{ref}/confirm (sandbox), POST /payments/webhooks/{provider}, GET /me/entitlements, POST /entitlements/{id}/download-links, GET /downloads/{token} (token một lần, redeem kiểm quyền), GET /me/downloads.
- Bộ cài self-host sinh on-demand từ artifact static_site (site/ + README + manifest + CHECKSUMS, mtime cố định → hash ổn định).
- Test: 9 tích hợp commerce (AT-14 client không đặt giá; AT-15 redirect giả không mở quyền; AT-16 webhook trùng → một entitlement; AT-17 sai tiền → needs_reconciliation; AT-18/19 tải chưa trả tiền/khác user/token hết hạn bị chặn) + unit payment (chữ ký/skew) + bundle. CSRF miễn trừ endpoint webhook (xác thực bằng chữ ký).
- UI (M4b): B01 configure, B02 review (terms snapshot + version), B03 pay (sandbox có nhãn, poll trạng thái, không tin redirect), B04 result, C02 purchases + tải bộ cài; `GET /quotes/{id}`; /config/public trả `terms_version`. Đã chạy trình duyệt: mua → thanh toán sandbox → quyền active → tải zip hợp lệ (PK, ~3KB).
- Còn: B05 issue/refund UI; refund/chargeback backend (AT-56); reconciliation admin (A12); hosted provisioning (M5).
