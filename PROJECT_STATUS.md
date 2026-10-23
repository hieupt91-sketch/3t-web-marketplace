# Trạng thái dự án

Ngày cập nhật: 23/10/2026 (Asia/Ho_Chi_Minh). Đặc tả 1.0. Nhánh: `feat/foundation`.

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

## Bằng chứng kiểm thử (máy dev, PostgreSQL 16 cục bộ)

`pnpm run check` PASS: docs validator; typecheck mọi package; i18n lint; 82 test (sdk 30, core 6, i18n 4, preview 12, api 14, tích hợp 16). `next build` PASS.

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
2. M3: A06/A08/A09 (bản dịch, giá, publish gates) để mẫu đầu tiên xuất hiện ở P02/P03; D01 shell demo công khai.
3. Thiết kế executor build cách ly (VM/sandbox riêng) trước khi bật `vite-static`.
4. Chốt nhà cung cấp email và thanh toán sandbox cho M4.

## Quyết định chưa chốt

Xem `DECISIONS.md` (ADR-013 trở đi) và docs/11 §3: provider thanh toán/email, domain thương hiệu và domain preview, giá/hoa hồng, quota hosting.
