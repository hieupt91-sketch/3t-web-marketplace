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
- UI: P01–P03 (chỉ dữ liệu đã publish; chưa có mẫu publish nên hiển thị trạng thái rỗng thật), U01–U05, U06 (phiên; đổi mật khẩu qua email), C01 (trạng thái rỗng), A01 (chỉ số liệu có thật), A02, A03 (ZIP + GitHub, xem M2 close bên dưới), A04 (form cấu hình allowlist), A05 (timeline, lỗi, preview iframe sandbox, ảnh chụp, log, manifest).

**M2 close — executor, adapter runtime, GitHub, demo isolated, retry checkpoint (26/10/2026, commit M2)**

- `migrations/0007_import_checkpoints_demo.sql`: `imports.checkpoint_json`, `github_webhook_deliveries` (dedupe theo delivery id), `demo_sessions` (port/pid/token hash/TTL), `artifacts` thêm kind `runtime_bundle`.
- Executor (`apps/worker/src/executor.ts`): argv-only, env đã lọc (không secret host), timeout 10 phút + kill cả process group, cap output 1 MiB, `unshare -n` khi có (báo `networkIsolated`), `prlimit` khi có (báo `limitsApplied`). Ghi rõ giới hạn: đây là cách ly mức process, CHƯA phải VM; production còn nợ chạy bằng uid không đặc quyền + VM/sandbox thật + allowlist dependency-proxy.
- Adapter: `vite-static` (build script trong executor, output thành site root), `node-http` (start argv hoặc package.json main), `next-standalone` (yêu cầu `.next/standalone/server.js`, copy `public/` + `.next/static/` nếu có). Runtime bundle: stage tree trừ `node_modules`, digest, lưu `runtime-bundles/<digest>` kind `runtime_bundle`; runtime cài lại deps từ lockfile khi provision (giả định đã ghi). `IMPLEMENTED_ADAPTERS` đủ 4 adapter; 3 test unit kỳ vọng cũ (`not_implemented`) đã sửa theo sự thật mới.
- Checkpoint resume: checkpoint chỉ tin khi `sourceArchiveDigest` + `configRevision` khớp; `inspect_archive`/`resolve_root`/`secret_scan` luôn chạy lại; `build` chỉ bỏ qua khi checkpoint ≥ `record`; runtime adapter không bao giờ bỏ qua `provision_preview`/`health`/`smoke`/`screenshots` khi resume; checkpoint lưu sau mỗi bước thành công, xóa khi `ready`; lỗi mới `install_failed`/`build_failed`/`build_timeout` (timeout retryable).
- GitHub (REQ-03, AT-04/AT-57): `POST /admin/imports/github` (public repo, ghim commit qua API commits rồi tải tarball tại SHA, giải nén bằng `tar`, lọc subdir, đóng lại ZIP bằng `zip` rồi chạy pipeline thường; `GITHUB_API_BASE_URL` mặc định `https://api.github.com`, override được cho test/GHES; không lưu token). Webhook `POST /api/v1/admin/imports/github-webhook` (HMAC `X-Hub-Signature-256` khi có `GITHUB_WEBHOOK_SECRET`, dedupe delivery id, chỉ tạo import mới cho repo đã từng nhập; lưu ý: verify hiện re-serialize JSON body, giống webhook thanh toán — cần raw bytes ở tầng HTTP để cứng hơn). UI A03: tab GitHub thật (repo/ref/subdir/rights) thay cho thông báo "chưa triển khai".
- Demo isolated (REQ-08, AT-10/11/12, D02–D04): `POST /demo-sessions` (ẩn danh, rate-limit 10/giờ, cap `DEMO_MAX_ACTIVE_SESSIONS` mặc định 20; static dùng lại preview active của version, runtime spawn server riêng ghi port/pid), `GET /demo-sessions/:id` (kèm `template_slug`), `admin-launch` (token một lần 10 phút, chỉ khi `demo.mode = isolatedAdmin`), `reset` (restart runtime / xóa token), `cancel`, sweep hết hạn khi đọc; `GET /admin/demos` + `POST /admin/demos/:id/expire` (A17 API). UI: `/demo/start/:versionId` (D02), `/demo/session/:id` (D03 + trạng thái hết hạn D04: tạo lại hoặc mua, không giả vờ dữ liệu còn). Giới hạn đã ghi: preview static dùng chung label ngẫu nhiên (không có preview row riêng theo session vì unique-active theo import); token admin-launch là affordance demo, demo app không validate token với tài khoản thật.
- Fixture mới: `examples/vite-landing`, `examples/node-service`, `examples/next-standalone` (server.js mô phỏng standalone + build stamp). i18n: 673 khóa mỗi locale (thêm demo/github + 3 khóa lỗi import còn thiếu).
- Test M2: `tests/integration/adapter-flow.test.ts` (4: vite, node, next, checkpoint resume) + `tests/integration/github-demo.test.ts` (4: GitHub pin + webhook dedupe + repo sai, static session, runtime session admin-launch/reset). Full `pnpm run check` xanh: 123 test (i18n 4, core 10, template-sdk 30, preview 12, api 14, integration 53).

**M3 close — A07, A26, filter mở rộng (26/10/2026, commit M3)**

- `migrations/0008_support_categories.sql`: `support_tickets` (status open/assigned/waiting/resolved/closed, assigned_to, order_id FK, site_label text, sla_due_at = tạo + 24h) + `support_ticket_messages` (sender customer/staff, locale); seed category tree `website` → `landing`/`store`/`blog`/`portfolio`.
- A07: `GET /admin/templates/:id/versions` (SHA, manifest, artifact kind/size/key, import_id, demo_url, is_published; same-semver-different-hash vẫn bị từ chối ở bước record — AT-30) + UI `/admin/templates/[id]/versions` (link từ trang chi tiết mẫu).
- A26: ticket khách hàng (`POST /support/tickets` — order_id phải thuộc về người tạo, 422 nếu không; site chỉ là label text vì bảng sites thuộc M5), `GET /support/tickets[/:id]`, reply khách (waiting → open), close; admin `GET /admin/support[/:id]` (lọc status), assign (người nhận phải có `support:reply`, 422 nếu không), reply nhân viên (lưu đúng locale của ticket, open/assigned → waiting), status resolved/closed/open; reply trên ticket closed → 409. Tin nhắn chỉ là text lưu trữ — không trigger email/webhook/hoàn tiền/site change. UI: `/admin/support[/:id]` + `/account/support[/:id]` + nav entries.
- Filter: `GET /templates` thêm `category` (bao cả cây con qua recursive CTE) và `min_price`/`max_price` (so với giá khởi điểm thấp nhất hiện hành, VND minor units); `GET /categories` công khai đã có sẵn (id/code/parent_id) được dùng cho select lọc; UI trang templates thêm select category + 2 input giá. i18n: 735 khóa mỗi locale.
- Test M3: `tests/integration/m3-close.test.ts` (2: publish template có category + giá rồi kiểm tra versions + category cha/con + 3 khoảng giá; vòng ticket assign/reply/resolve/close + SLA + phân quyền). Full `pnpm run check` xanh: 125 test (integration 55).

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

- **Nhập/Build (nợ production):** executor mới cách ly mức process — còn nợ uid không đặc quyền, VM/sandbox thật, proxy dependency allowlist; webhook GitHub/payment verify bằng JSON re-serialize (cần raw bytes ở tầng HTTP).
- **Catalog M3 còn lại:** không còn — A07, A26, filter mở rộng đã xong trong M3 close (xem dưới).
- **M4 còn lại:** chỉ provisioning hosted (thuộc M5); còn lại đã xong (refund/chargeback, A12, B05, C03/C04).
- **M5–M8:** hosting/domain/TLS/backup/gia hạn (runtime agent mTLS, saga provisioning), CTV API/hoa hồng/payout/webhook, email provider thật, MFA/step-up, staff management, observability/alert, staging/production, báo cáo nghiệm thu AT-01..AT-60.
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
- Còn: hosted provisioning (M5).
- Khép M4 (26/10/2026): migration 0006 `refunds` + `refund_events` (dedupe provider event, AT-56) và sửa lỗi tiềm ẩn 0005 (bảng `entitlements` thiếu cột `updated_at` dù có trigger `entitlements_touch` — mọi UPDATE entitlement trước đây đều lỗi 42703); API buyer yêu cầu hoàn tiền + xem attempts (B05), admin duyệt/từ chối (payment:refund), sandbox confirm/fail cho refund, webhook hoàn tiền có chữ ký, đối soát A12 (liệt kê needs_reconciliation + unmatched events, resolve paid qua `fulfillOrder` dùng chung hoặc cancelled, ghi audit, không sửa raw event); UI B05 `/checkout/orders/:id/issue`, C03 `/account/purchases/:id/downloads`, C04 `/account/orders[/:id]`, A12 `/admin/payments/reconciliation`, `/admin/payments/refunds`. Test mới `refund-flow` 5 test (AT-56, A12, AT-31). `pnpm run check` xanh: 115 test.
