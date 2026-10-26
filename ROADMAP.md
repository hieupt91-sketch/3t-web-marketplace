# Kế hoạch triển khai 3T Web Marketplace

Tài liệu theo dõi **các bước cần làm** và **tiêu chí cần đạt** cho từng mốc. Căn cứ: backlog M0–M8, 27 ticket DEV và 60 kịch bản nghiệm thu trong [docs/10](docs/10-backlog-va-nghiem-thu.md). Đọc cùng [PROJECT_STATUS.md](PROJECT_STATUS.md) (trạng thái hiện tại) và [DECISIONS.md](DECISIONS.md) (ADR).

## Nguyên tắc làm việc

- **Xong mốc nào commit mốc đó.** Mỗi mốc là một (hoặc vài) commit có mô tả rõ, kèm test và cập nhật `PROJECT_STATUS.md`.
- **Định nghĩa "xong"** (docs/10 §1): có schema/migration, API có quyền + validation, UI đủ trạng thái, i18n VI/EN, test nghiệp vụ, và bằng chứng chạy. Không tính "xong" nếu chỉ có giao diện.
- **Không tự bỏ phạm vi.** Phần chưa làm phải ghi rõ ở `PROJECT_STATUS.md`, không giả nút/giá/thành công.
- **Không phát sinh tiền/hạ tầng thật** khi chưa có người có thẩm quyền duyệt (docs/01 §5): dùng adapter sandbox/mock có nhãn.
- Mỗi PR/commit ghi REQ/UI/AT liên quan; `pnpm run check` phải xanh trước khi commit.

## Trạng thái tổng quan

| Mốc | Phạm vi | Trạng thái |
|---|---|---|
| M0 SPEC | Đặc tả, defaults, repo, manifest, UI IDs | ✅ Xong |
| M1 FOUNDATION | Monorepo, API, SQL, auth/RBAC, i18n, design tokens | ✅ Xong (còn MFA, staff mgmt) |
| M2 IMPORT | Nhập ZIP an toàn, nhận diện, build/demo, job | ✅ Executor cách ly + 4 adapter + GitHub + demo isolated + retry checkpoint (26/10/2026) |
| M3 CATALOG | Biên tập mẫu, bản dịch, giá, cổng công bố, cửa hàng | ✅ Đóng đủ: A07 versions, A26 support tickets, filter category/price (26/10/2026) |
| M4 COMMERCE | Báo giá, đơn, thanh toán sandbox, quyền, bộ cài | 🟡 Backend + UI checkout (B01–B04) + C02 xong; còn refund, reconciliation admin, B05 |
| M5 HOSTING | Runtime agent, site, domain/TLS, backup, gia hạn | ✅ Saga provisioning + domain + backup/restore + renewal/lifecycle + UI C05–C15/A15–A19 (26/10/2026) |
| M6 PARTNER | CTV: key, catalog API, attribution, hoa hồng, payout | ✅ Partner API + ledger append-only + payout evidence + webhook ký HMAC + UI R01–R12/A20–A21 (26/10/2026) |
| M7 LOCALIZE | Hoàn chỉnh VI/EN mọi UI/mail/nội dung/SEO | 🟡 Theo từng mốc |
| M8 RELEASE | E2E/security/load/a11y, runbook, drill, nghiệm thu | ⬜ Chưa |

---

## M1 — FOUNDATION ✅

**Mục tiêu:** đăng nhập + portal trống chạy thật trên nền tảng API/SQL/RBAC/i18n.

Các bước: monorepo pnpm/TS · migration nền tảng (identity, RBAC, catalog draft, jobs, outbox, idempotency, audit) · auth đầy đủ + phiên · RBAC ở API · idempotency/ETag · i18n VI/EN + kiểm khóa · design tokens · docs CI.

Đạt: AT-13 (token replay/hết hạn), AT-51 (ETag cũ → 412), AT-49 (clone máy khác chạy được), đăng nhập + `/account` trống thật. **Còn nợ:** MFA/step-up, quản lý nhân sự (A24), rate-limit dùng store chung cho nhiều instance.

## M2 — IMPORT 🟡

**Mục tiêu:** tải gói → URL demo + log.

Đã đạt (HTML tĩnh): AT-02, AT-03, AT-05, AT-06, AT-30, AT-58 (quét bí mật); job lease/fencing/dedupe (AT-08 một phần). **Còn làm để khép mốc:**

1. Executor build cách ly (VM/sandbox riêng, quota CPU/RAM/PID/time, proxy dependency allowlist) — tiền đề cho mọi adapter cần build. → AT-07, AT-08.
2. Adapter `vite-static` (DEV-09) rồi `node-http`/`next-standalone` (DEV-10); demo isolated admin + token exchange (REQ-08) → AT-09, AT-10, AT-11, AT-12, AT-55.
3. Nhập GitHub: App đọc repo, ghim commit, webhook dedupe, path filter (REQ-03) → AT-04, AT-57.
4. Retry theo checkpoint từng bước (hiện chạy lại cả pipeline tĩnh).

Đạt mốc: 4 adapter có smoke fixture; adapter chưa pass không bật "supported"; gói độc hại bị chặn trước khi chạy.

## M3 — CATALOG ✅ (lát cắt công bố)

**Mục tiêu:** xem mẫu/demo/gói bằng dữ liệu API.

Đã đạt: migration plans/plan_prices (khoảng giá không chồng lấn); biên tập metadata + bản dịch (slug unique/locale); gói + đổi giá hiệu lực; cổng công bố (demo/dịch/giá/export) chặn gate đỏ; publish/archive; cửa hàng P02/P03 kèm giá, P04 so sánh; phân quyền giá nháp vs công bố. AT-01, AT-30, AT-32 có test; 7 test tích hợp catalog.

Đã bổ sung (24/10/2026): D01 demo công khai (iframe origin riêng, device width, open-tab, noindex); demo info trong public API; filter catalog theo mode/capability; tìm không dấu (unaccent, migration 0003); SEO sitemap.xml + robots.txt + hreflang (chỉ locale đã publish).

Đã bổ sung (24/10/2026, đợt 2): module CMS nền tảng (migration 0004: `platform_pages`, `policy_versions` bất biến, `contact_requests`); API công khai `/pages/public/{slug}`, `/pages/help`, `/policies/{code}[/versions/{version}]`, `POST /contact-requests` (honeypot + consent + rate-limit); API quản trị content/policy CRUD + publish (A27); web P05 (how-it-works), P06 (help index + detail), P07 (partners), P08 (policies), P09 (contact form), renderer markdown an toàn, footer liên kết, admin content hub + editor trang/chính sách.

**Còn làm để khép mốc:**

1. D02–D04: demo isolated admin (tạo phiên riêng, token exchange, countdown TTL, hết hạn) — cần runtime adapter của M2 (REQ-08) → AT-10, AT-11, AT-12.
2. A07 màn versions đầy đủ; filter theo ngành (category) khi có cây category; lọc giá; A26 ticket support đầy đủ.

---

## M4 — COMMERCE 🟡

**Mục tiêu:** mua sandbox → tải bộ cài và cài trên VPS sạch. Phụ thuộc M3; cần chốt provider thanh toán (dùng sandbox/mock trước) và email.

Đã làm (M4a backend, 24/10/2026): migration 0005 (quotes, orders, order_items, payment_attempts, payment_events, entitlements, download_events); `PaymentProvider` + `MockPaymentProvider` (HMAC sandbox); API `/quotes`, `/orders`, `/orders/{id}/payment-sessions|cancel`, `/payments/mock/{ref}/confirm` (sandbox), `/payments/webhooks/{provider}`, `/me/entitlements`, `/entitlements/{id}/download-links`, `/downloads/{token}`, `/me/downloads`; sinh bộ cài self-host từ artifact tĩnh; 9 test commerce (AT-14/15/16/17/18/19) + unit payment/bundle. Đã làm (M4b UI): B01 configure, B02 review (terms snapshot), B03 pay (sandbox, nhãn rõ, không tin redirect), B04 result, C02 purchases + tải bộ cài; `GET /quotes/{id}`, `terms_version` trong /config/public; đã chạy trình duyệt mua → tải zip hợp lệ. **Còn:** B05 issue/refund UI; refund/chargeback backend (AT-56); reconciliation admin (A12); hosted provisioning (M5).

**Các bước**

1. `PaymentProvider` interface (createSession, verifyWebhook, queryTransaction, refund, normalizeStatus) + adapter mock có nhãn (docs/08 §1). DEV-13.
2. SQL: `quotes`, `orders`, `order_items`, `payment_attempts`, `payment_events`, `entitlements`, `entitlement_allocations`, `download_events`, `refunds` (docs/02 §5) + invariants §6.
3. API: `POST /quotes` (backend tính tiền, không tin client), `POST /orders` (snapshot terms_version + quote), `POST /orders/{id}/payment-sessions`, `POST /payments/webhooks/{provider}` (verify raw body, dedupe, outbox `order.paid`), `GET /me/entitlements`, `POST /entitlements/{id}/download-links` (gateway redeem, link ngắn hạn). DEV-13/14.
4. Bộ cài self-host: sinh bundle từ file whitelist + lockfile + migration + seed sạch + `.env.example` + compose + README + checksum; setup token một lần (docs/08 §6). DEV-15.
5. UI B01–B05 (checkout/cấu hình/review/pay/result/issue), C02–C04 (purchases/downloads/orders).

**Cần đạt (AT):** AT-14 (client sửa total → backend từ chối), AT-15 (redirect success giả → vẫn unpaid), AT-16 (webhook trùng/sai thứ tự → một entitlement, không quay paid→pending), AT-17 (tiền/currency sai, late → needs_reconciliation), AT-18/19 (download chưa trả tiền / token hết hạn bị chặn), AT-20 (cài bundle trên VPS sạch, không phụ thuộc DB 3T), AT-21 (setup takeover bị chặn), AT-56 (refund failed rồi confirmed → đảo đúng một lần), AT-59 (tải version ngoài updates_until bị từ chối). Bất biến kế toán §6 có test.

## M5 — HOSTING ⬜

**Mục tiêu:** mua → site + domain chạy; diễn tập restore. Phụ thuộc M4 + cách ly runtime.

**Các bước**

1. Runtime agent qua mTLS, lệnh allowlist, fencing (docs/08 §4); không giữ docker.sock ở API.
2. SQL: `sites`, `deployments`, `domains`, `subscriptions`, `renewal_applications`, `backups`, `demo_sessions` (promotion).
3. Saga provisioning có checkpoint (reserve → volume → runtime → migrate → seed/promotion → health → route → active); rollback bù theo ownership tag.
4. Domain: subdomain reserve atomic; domain khách TXT verify + A/AAAA/CNAME + CAA; On-Demand TLS tra registry (docs/08 §5).
5. Backup/restore (snapshot nhất quán, restore drill), gia hạn/grace/suspend/purge theo lịch (docs/08 §7).
6. UI C05–C15 (tạo site, domain, billing, backups, updates, members, data), A15–A19.

**Cần đạt:** AT-22 (race quota), AT-23 (paid nhưng provision lỗi → giữ quyền, không thu lại), AT-24 (đổi site_id/Host sang tenant khác bị chặn), AT-25/26/27 (domain TXT/IPv6/CAA/gỡ-gắn lại), AT-28/29 (renewal lặp, grace/suspend/purge), AT-47 (restore sang node khác), AT-48 (upgrade không backward-compatible).

## M6 — PARTNER ✅ (26/10/2026)

**Mục tiêu:** CTV tích hợp bán hàng end-to-end. Phụ thuộc M4.

**Các bước**

1. SQL: `partner_accounts`, `partner_api_keys`, `checkout_sessions`, `attributions`, `commission_entries` (append-only), `payout_requests`/`allocations`, `webhook_endpoints`/`deliveries`, `commission_policies`, `payout_profiles`.
2. Đăng ký/duyệt CTV (R01); API key scope + rate limit + kiểm mỗi lần gọi (docs/06 §5).
3. Partner API `/partner/v1`: catalog, demo-links, quotes, checkout-sessions (không tự đặt tiền/partner_id), orders, commissions, balance.
4. Attribution chốt lúc tạo đơn; sổ hoa hồng (accrued/eligible/reserved/paid/reversal) + payout có evidence (docs/06 §7–8).
5. Webhook ký HMAC, retry at-least-once, chống SSRF/DNS rebinding (docs/06 §9).
6. UI R01–R12 (portal CTV + developer center), A20–A21.

**Cần đạt:** AT-33 (A đổi ID sang B bị chặn), AT-34 (CTV gửi is_paid/total thấp vô hiệu), AT-35 (buyer claim hợp lệ, CTV không claim thay), AT-36 (retry external_reference không nhân đôi đơn), AT-37 (đổi rate sau paid: đơn cũ giữ snapshot), AT-38 (partial refund nhiều lần + full → net 0), AT-39/40 (refund sau payout; hai payout đồng thời), AT-41 (revoke key: site vẫn chạy), AT-42/43 (webhook signature/replay/SSRF).

## M7 — LOCALIZE ⬜ (xuyên suốt, gate cuối)

**Mục tiêu:** toàn bộ hành trình VI/EN, không rò key.

**Các bước:** hoàn tất bản dịch mọi UI ID docs/05; email/thông báo theo locale lưu (docs/07 §6); workflow dịch (matrix missing/stale, review) A22/W15; SEO canonical/hreflang/sitemap; runtime locale cho site thành phẩm.

**Cần đạt:** AT-44 (journey mua VI/EN), AT-45 (catalog thiếu EN → fallback có nhãn, không false hreflang), AT-46 (đổi locale ở checkout giữ order/partner/tiền), AT-50 (bàn phím/mobile/chuỗi dài). CI chặn thiếu key required VI/EN.

## M8 — RELEASE ⬜

**Mục tiêu:** release candidate + báo cáo nghiệm thu.

**Các bước:** E2E toàn journey; security gate (RBAC/tenant, SQLi/XSS/CSRF/SSRF, archive, no secret in bundle, setup takeover, partner scope/signature — docs/08 §10); load theo docs/10 §5; accessibility; runbook + alert (observability docs/08 §9); backup/restore drill; cấu hình production; chủ dự án duyệt chính sách bán/giá/hoa hồng.

**Cần đạt:** checklist trước public launch (docs/10 §8) đủ; mọi REQ bắt buộc có bằng chứng và người nghiệm thu; không còn P0/P1 chưa xử lý; provider thanh toán/email/DNS/storage thật đã cấu hình đúng environment.

---

## Thứ tự thực hiện

M1 → M2 → **M3 (đang ở đây, tạm dừng)** → M4 → M5 → M6, với M7 làm liên tục và M8 chốt cuối. Phần build Vite/Next/Node của M2 cần executor cách ly trước khi bật. Các điểm chính sách (thanh toán, domain, giá/hoa hồng, quota) phải chốt trước khi phát sinh tiền/hạ tầng thật (docs/11 §3).
