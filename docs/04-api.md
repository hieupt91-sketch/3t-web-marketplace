# 04. Hợp đồng API và quy tắc đồng bộ

## 1. Quy ước

Base path `/api/v1`; JSON UTF-8; HTTPS production. Auth trình duyệt dùng session cookie host-only `HttpOnly`, `Secure`, `SameSite=Lax` cùng kiểm tra Origin/CSRF cho mutation. Portal/API cùng origin sau reverse proxy. CTV gọi server-to-server bằng `Authorization: Bearer <partner-secret>`. Không dùng partner secret trong JavaScript công khai.

- Tất cả object có `id`, không lộ internal DB/storage path. ISO 8601 UTC cho thời gian; `locale` dùng code chuẩn, v1 `vi`/`en`.
- List: cursor opaque, `limit` mặc định 20, tối đa 100, sort/filter allowlist. Response `{data:[],page:{next_cursor,has_more}}`.
- Resource detail: `{data:{...},meta:{request_id,revision}}`.
- Tiền: `{amount_minor:"1500000",currency:"VND"}`; không gửi float. Ví dụ giá trong tài liệu là dữ liệu minh họa.
- Task dài: HTTP 202 `{data:{job_id,resource_id,status,progress_url}}`. Không giữ HTTP request chờ build xong.
- Locale ưu tiên tham số explicit → user setting → Accept-Language → vi; trả `Content-Language`. Error code không dịch; message UI dịch theo code.
- Mutation tạo đơn/thanh toán/site/gia hạn/import/payout yêu cầu `Idempotency-Key`, UUID do caller tạo. Giữ kết quả tối thiểu 24h; dedupe event payment lâu dài bằng unique DB. Cùng key khác body → 409.
- Optimistic lock: GET trả ETag/revision, PATCH có If-Match. Revision cũ → 412, UI cho tải bản mới/giữ bản nháp; không ghi đè lặng lẽ.
- Session bị thu hồi → 401. Thiếu quyền → 403. Tài nguyên không thuộc phạm vi → 404 để tránh tiết lộ. Quota/rate limit → 429 + Retry-After.
- 400 lỗi cú pháp; 422 validation/nghiệp vụ có trường lỗi; 409 trạng thái xung đột; 503 tạm không khả dụng. Không trả stack trace.

```json
{
  "error": {
    "code": "domain.dns_not_ready",
    "message": "Tên miền chưa trỏ đúng cấu hình.",
    "field_errors": [{"field": "hostname", "code": "dns_mismatch"}],
    "request_id": "req_example",
    "retryable": true
  }
}
```

## 2. API công khai và tài khoản

| Method/path | Quyền | Input/Output chính |
|---|---|---|
| GET /config/public | Public | Locale, brand, capability công khai; không secret |
| GET /categories | Public | locale, category tree |
| GET /templates | Public | q/category/capabilities/mode/locale/sort; chỉ published |
| GET /templates/{slug} | Public | localized metadata, plans, capabilities, demo availability |
| GET /templates/{id}/versions | Public | Changelog công khai, không object_key |
| GET /plans/{id} | Public | Giá/currency/chu kỳ/quyền hiện hành |
| POST /auth/register | Public rate-limited | email/password/locale; gửi xác minh, response không tiết lộ tài khoản |
| POST /auth/verify-email | Token | Token một lần, hết hạn, tạo trạng thái verified |
| POST /auth/login | Public rate-limited | email/password/(MFA), set cookie |
| POST /auth/logout | Session + CSRF | Revoke phiên hiện tại |
| POST /auth/forgot-password | Public rate-limited | Luôn trả câu chung |
| POST /auth/reset-password | Token | Mật khẩu mới, revoke session theo policy |
| GET /me | Session | Profile, roles, locale |
| PATCH /me | Session | Tên/locale/timezone; đổi email quy trình verify riêng |
| GET /me/sessions | Session | Danh sách thiết bị, last active |
| DELETE /me/sessions/{id} | Owner + CSRF | Thu hồi phiên |
| GET /me/notifications | Session | Unread, pagination |
| PATCH /me/notifications/{id} | Owner | Mark read |
| POST /support/tickets | Session | subject/body/site_id?/attachments |
| GET /support/tickets | Owner/staff | Danh sách theo quyền |
| GET /support/tickets/{id} | Owner/assigned staff | Detail + messages |
| POST /support/tickets/{id}/messages | Owner/assigned staff | Text/file refs, không HTML không kiểm soát |

## 3. Demo, thương mại và tải xuống

| Method/path | Quyền | Input/Output chính |
|---|---|---|
| POST /demo-sessions | Verified user | template_version_id, mode; trả job hoặc URL public readonly |
| GET /demo-sessions/{id} | Owner | status, expires_at, demo_url nếu ready |
| POST /demo-sessions/{id}/admin-launch | Owner | Token exchange một lần, chỉ runtime cùng session |
| POST /demo-sessions/{id}/reset | Owner | 202, reset dữ liệu phiên này |
| DELETE /demo-sessions/{id} | Owner | Revoke + cleanup 202 |
| POST /quotes | User | plan_id/currency/coupon?/quantity=1, backend tính |
| POST /orders | Verified user | quote_id, terms_version, deployment_preferences? |
| GET /orders | User | Chỉ đơn thuộc buyer |
| GET /orders/{id} | Owner | items, money, payment, fulfillment tách trạng thái |
| POST /orders/{id}/payment-sessions | Owner | provider, allowed return route; không amount client |
| POST /orders/{id}/cancel | Owner | Chỉ unpaid; late payment vào đối soát |
| POST /payments/webhooks/{provider} | Provider signature | Raw body xác minh, dedupe, enqueue |
| GET /me/entitlements | User | Quyền + mode + updates_until + usage |
| POST /entitlements/{id}/download-links | Owner | version_id đủ quyền, loại source/install |
| GET /me/downloads | User | Lịch sử, không trả link cũ còn hiệu lực |
| POST /orders/{id}/refund-requests | Owner | reason; yêu cầu, không tự coi refund thành công |
| POST /checkout-sessions/{id}/claim | Verified buyer + claim token | Gắn người mua sau review đơn |

Ví dụ tạo đơn (giá không nằm trong request):

```json
{"quote_id":"quote_example","terms_version":"terms-2026-10","deployment_preferences":{"mode":"hosted","locale":"vi"}}
```

`download-links` response chỉ sau server authorize: `url`, `expires_at`, `sha256`, `filename`, `size_bytes`. Link ngắn hạn tối đa 5 phút đề xuất; storage private. Nếu yêu cầu link một lần, dùng gateway redeem server thay vì nói signed URL tự có tính một lần. Mỗi lần tải lại phải kiểm quyền mới.

## 4. Site, domain và quản trị người mua

| Method/path | Quyền | Input/Output chính |
|---|---|---|
| POST /sites | Entitlement owner | entitlement_id, name, subdomain, locale, seed_mode |
| GET /sites | User | Sites theo membership |
| GET /sites/{id} | Member | Status, version, subscription, usage |
| PATCH /sites/{id} | Site owner | Display name, default locale; ETag |
| POST /sites/{id}/admin-launch | Authorized member | One-time exchange sang runtime |
| POST /sites/{id}/deployments | Owner/ops | Target version đủ quyền; job backup/update |
| GET /sites/{id}/deployments | Member | History, status; logs sanitized |
| POST /sites/{id}/domains | Owner | hostname; trả DNS record + token |
| GET /sites/{id}/domains | Member | Status/primary/TLS |
| POST /sites/{id}/domains/{domainId}/verify | Owner | Enqueue DNS check, rate limit |
| POST /sites/{id}/domains/{domainId}/make-primary | Owner | Domain phải active; redirect canonical |
| DELETE /sites/{id}/domains/{domainId} | Owner | Step-up, giữ đường truy cập thay thế |
| POST /sites/{id}/renewal-orders | Owner | plan/cycle; quote và đơn gia hạn |
| GET /sites/{id}/backups | Owner | Metadata, trạng thái, retention |
| POST /sites/{id}/backups | Owner theo plan | Enqueue snapshot nhất quán |
| POST /sites/{id}/restores | Owner + step-up | backup_id, confirm; maintenance + job |
| POST /sites/{id}/data-exports | Owner | Xuất dữ liệu; không tự bao gồm source |
| POST /sites/{id}/deletion-requests | Owner + step-up | Lịch xóa, cảnh báo mất dữ liệu |
| DELETE /sites/{id}/deletion-requests/{requestId} | Owner | Hủy trước thời điểm purge |
| GET/POST /sites/{id}/members | Owner | Xem/mời quản trị, scope rõ |
| PATCH/DELETE /sites/{id}/members/{memberId} | Owner | Thay quyền/thu hồi, không xóa owner cuối |
| GET /jobs/{id} | Owner/scope staff | state/step/progress/error; không payload secret |

## 5. API quản trị nền tảng

Tất cả dưới `/admin`, kiểm permission theo module và audit actor. Hành động tiền, quyền, keys, xóa cần step-up authentication. GET không gây side effect.

| Method/path | Permission | Nội dung |
|---|---|---|
| GET /admin/overview | report:read | Số liệu tổng hợp có currency/timezone |
| POST /admin/imports/upload-sessions | template:import | Create constrained upload + checksum |
| POST /admin/imports | template:import | object ref hoặc repo/ref/subdir; async |
| GET /admin/imports/{id} | template:read | Detection, effective manifest, stages/errors |
| PATCH /admin/imports/{id}/configuration | template:import | Chỉ trường cho phép; tạo config revision |
| POST /admin/imports/{id}/retry | template:import | Chạy lại checkpoint, giữ import lineage |
| POST /admin/imports/{id}/cancel | template:import | Graceful cancel |
| GET /admin/imports/{id}/logs | template:read | Sanitized cursor/SSE, giới hạn retention |
| GET/POST /admin/templates | template:read/write | List/create draft |
| PATCH /admin/templates/{id} | template:write | Metadata gốc, ETag |
| PUT /admin/templates/{id}/translations/{locale} | translation:write | title/slug/SEO/body, source revision |
| POST /admin/templates/{id}/publish | template:publish | Gates demo, artifact, price, terms, translation |
| POST /admin/templates/{id}/archive | template:publish | Dừng bán mới, giữ quyền khách cũ |
| GET/POST /admin/templates/{id}/versions | template:write | Version immutable |
| GET/POST /admin/templates/{id}/plans | pricing:write | Plan + limits; sửa giá có effective time |
| PATCH /admin/plans/{id} | pricing:write | Không sửa snapshot đơn cũ |
| GET /admin/orders | order:read | Filter status/buyer/partner/time |
| GET /admin/orders/{id} | order:read | Timeline payment/fulfillment/audit |
| POST /admin/orders/{id}/manual-payment-confirmations | payment:confirm | Evidence ref, amount/currency/bank tx UQ |
| POST /admin/payments/{id}/refunds | payment:refund | Amount/reason; async provider result |
| GET /admin/reconciliation | payment:read | Unmatched/late/short/overpayment |
| GET/PATCH /admin/users/{id} | user:read/manage | Status; không trả secret/session token |
| GET /admin/sites | site:read | Node/status/quota |
| POST /admin/sites/{id}/operations | site:operate | action allowlist, reason, expected state |
| GET /admin/jobs | ops:read | Queue/dead-letter |
| POST /admin/jobs/{id}/retry | ops:execute | Dedupe/fencing, retry reason |
| GET /admin/audit-logs | audit:read | Cursor/filter, redacted |
| GET/PATCH /admin/settings/{group} | settings:manage | Non-secret values + secret configured flags |
| GET/POST /admin/staff | staff:manage | Invite/role, không mời tự động qua tài liệu |
| GET /admin/translations | translation:read | Missing/stale/review queue |
| POST /admin/translations/{id}/review | translation:publish | Review/source revision match |

## 6. Partner API

Đường dẫn `/partner/v1` là namespace riêng, còn HTTP semantics theo mục 1. Các scope và payload chi tiết ở tài liệu 06.

| Method/path | Scope | Mục đích |
|---|---|---|
| GET /catalog/templates | catalog:read | Mẫu được phép bán theo locale |
| GET /catalog/templates/{id} | catalog:read | Detail, capabilities, localized plans |
| POST /demo-links | demo:link | Link demo/referral, không admin credentials |
| POST /quotes | checkout:create | Giá có thời hạn; partner không tự sửa tiền |
| POST /checkout-sessions | checkout:create | checkout_url để buyer xác minh và trả tiền |
| GET /checkout-sessions/{id} | orders:read | Status của đúng partner |
| GET /orders | orders:read | Đơn attributable, thông tin tối thiểu |
| GET /orders/{id} | orders:read | payment/fulfillment status, tiền và hoa hồng |
| GET /commissions | commissions:read | Entries của partner |
| GET /balance | commissions:read | Pending/eligible/reserved/paid/negative |
| GET /webhook-events/{id} | events:read | Dùng đối chiếu event đã được gửi |

Quản lý API key, webhook endpoint và payout qua portal CTV sử dụng session + step-up, không mặc định cấp scope tạo key cho chính partner key.

| Method/path | Quyền portal | Chức năng |
|---|---|---|
| POST /partners/applications | Verified user | Đăng ký CTV |
| GET /partners/me | Partner session | Status/policy |
| GET/POST /partners/me/api-keys | Active partner + step-up để tạo | Scope, expiry; secret một lần |
| DELETE /partners/me/api-keys/{id} | Owner + step-up | Revoke ngay |
| GET/POST /partners/me/webhooks | Active partner | Khai báo URL/events, challenge |
| PATCH/DELETE /partners/me/webhooks/{id} | Owner + step-up | Thay/thu hồi endpoint |
| GET /partners/me/webhooks/{id}/deliveries | Owner | Sanitized response/time/status |
| POST /partners/me/webhooks/{id}/test | Owner | Synthetic event, có rate-limit |
| POST /partners/me/webhook-deliveries/{id}/replay | Owner | Cùng event id, attempt mới |
| GET/POST /partners/me/payouts | Active partner | List/request, reserve balance |
| GET/PATCH /partners/me/payout-profile | Owner + step-up | Masked bank data, verify change |
| GET /admin/partners | partner:read | Application/status |
| POST /admin/partners/{id}/review | partner:manage | Approve/reject/suspend + reason |
| PATCH /admin/partners/{id}/policy | partner:manage | Effective policy, không đổi đơn cũ |
| GET /admin/payouts | payout:read | Queue/reserved |
| POST /admin/payouts/{id}/approve | payout:approve | Chỉ duyệt, không giả lập chuyển tiền |
| POST /admin/payouts/{id}/settle | payout:settle | Evidence/provider ref và đối soát |

## 7. Runtime API của website thành phẩm

Namespace `/api/v1` trên domain site, khác host với API nền tảng. Site nhỏ tiêu chuẩn hỗ trợ bảng dưới; mẫu external phải khai báo khả năng tương ứng và không quảng cáo điều chưa tích hợp.

| Method/path | Quyền | Yêu cầu |
|---|---|---|
| GET /healthz | Nội bộ/public tối thiểu | Liveness, không lộ DSN |
| GET /readyz | Agent | DB + migration ready |
| POST /setup/complete | Setup token | Tạo admin đầu, domain, locale; khóa endpoint sau |
| POST /auth/login/logout | Site user | Cookie riêng |
| GET /settings/public | Public | Brand/contact/locales đã xuất bản |
| GET /pages/{slug} | Public | locale, published blocks |
| GET /products và /products/{slug} | Public | Filter/search, published |
| GET /categories | Public | Locale tree |
| GET /articles và /articles/{slug} | Public | Content, SEO |
| POST /contact-requests | Public rate-limited | Honeypot/consent/validation; demo mô phỏng |
| GET/POST/PATCH/DELETE /admin/pages[/{id}] | Content role | Draft/publish, locale, ETag |
| GET/POST/PATCH/DELETE /admin/products[/{id}] | Product role | SKU/slug/translation/media/category |
| GET/POST/PATCH/DELETE /admin/categories[/{id}] | Product role | Chống vòng lặp, xử lý sản phẩm đang gắn |
| GET/POST/PATCH/DELETE /admin/articles[/{id}] | Content role | Publish permissions |
| GET/POST/PATCH/DELETE /admin/banners[/{id}] | Content role | Schedule, image alt, link allowlist |
| GET/POST/DELETE /admin/media[/{id}] | Media role | MIME/quota/usage guard |
| GET/PATCH /admin/settings | Site owner | Public settings/secret_refs tách |
| GET/PATCH /admin/menus | Content role | Order/locale/valid URLs |
| GET/PATCH /admin/contact-requests[/{id}] | Lead role | Status/export consent |
| GET/POST/PATCH/DELETE /admin/users[/{id}] | Site owner | Role/invite/revoke, owner guard |
| GET /admin/audit | Site owner | Redacted |

Ký hiệu `[/{id}]` chỉ diễn tả collection/item; OpenAPI triển khai phải khai báo từng route thật, không dùng dấu ngoặc trong URL.

## 8. Định nghĩa object tối thiểu

| Object | Required fields | Điều cấm |
|---|---|---|
| TemplateSummary | id, slug, locale, title, preview_image, modes, starting_prices, capabilities | Không source_url |
| Quote | id, expires_at, currency, line_items, discount/tax/total, policy_revision | Không thay tiền sau accept |
| Order | id, buyer_status, payment_status, fulfillment_status, items, totals, created_at | Không lộ full bank/card data |
| Site | id, display_name, status, locale, primary_url, version_id, subscription_summary | Không admin password |
| Job | id, status, step, completed_steps, total_steps, retryable, error_code | Không shell command chứa secrets |
| PartnerOrder | id, external_reference, template_id, mode, payment/fulfillment, total, commission_summary | Buyer email/phone mặc định masked/omitted |
| Import | id, detected_adapter, confidence, missing_fields, steps, draft_id, preview_status | Không Git access token |

## 9. Webhook và realtime

Incoming provider: xác minh đúng raw body, signature/timestamp theo provider, kiểm event transaction ở backend và dedupe. Return 2xx sau lưu durable; không chờ provision.

Outgoing partner: event envelope ở tài liệu 06; HMAC signature, retry at-least-once, sequence/revision. Receiver phải idempotent và xử lý event đến sai thứ tự bằng GET nguồn hiện tại. SSE không được truy cập job của người khác; reconnect từ last_event_id, polling là fallback.

## 10. Bàn giao API khi code

Dev phải xuất OpenAPI cho **toàn bộ route thực hiện**, examples success/error, role/scope, schema và tests từ cùng contract. Tài liệu này là hợp đồng chức năng v1; không tuyên bố đã có server API hoặc OpenAPI sinh tự động trong bộ bàn giao tài liệu. Contract test phải phát hiện field bị bỏ/đổi type; breaking change dùng v2 hoặc migration có thông báo.

## 11. API bổ sung cho các UI dùng chung

Các route này hoàn thiện mapping UI 05, dùng cùng auth/validation/pagination ở mục 1.

| Method/path | Quyền | Chức năng |
|---|---|---|
| GET /pages/public/{slug} | Public | Help, how-it-works, contact metadata theo locale |
| GET /policies/{slug}/versions/{version} | Public | Bản điều khoản bất biến, locale/fallback rõ |
| POST /contact-requests | Public rate-limited | Nội dung liên hệ và consent, chống spam |
| POST /auth/resend-verification | Public rate-limited | Response chung, cooldown |
| POST /me/password-change | User + step-up | Đổi password, revoke sessions theo policy |
| POST /me/email-change-requests | User + step-up | Verify email mới, không đổi trực tiếp bằng PATCH profile |
| POST /me/mfa/enrollments | User + step-up | Bắt đầu TOTP/WebAuthn theo cơ chế được triển khai |
| POST /me/mfa/enrollments/{id}/confirm | Owner | Kiểm challenge, bật MFA, recovery codes một lần |
| DELETE /me/mfa/methods/{id} | Owner + step-up | Thu hồi theo policy, staff không tắt trái yêu cầu |
| POST /auth/step-up | Session | Chứng thực mới cho tác vụ nhạy cảm, TTL ngắn |
| GET/PATCH /me/notification-preferences | User | Channel/event preferences; security mail bắt buộc theo policy |
| GET /admin/demos | ops:read | Filter TTL/version/status/owner |
| POST /admin/demos/{id}/operations | ops:execute | Action expire/reset, reason và promotion lock guard |
| GET /admin/domains | site:read | DNS/TLS queue |
| POST /admin/domains/{id}/verify | site:operate | Retry check có rate-limit |
| GET /admin/backups | site:read | Global backup status |
| GET/POST /admin/content/pages | content:read/write | CMS help/FAQ/pages |
| GET/PATCH /admin/content/pages/{id} | content:read/write | Locale content, ETag |
| POST /admin/content/pages/{id}/publish | content:publish | Review/publish gates |
| GET/POST /admin/content/policies | policy:manage | Tạo phiên bản điều khoản, không overwrite bản đã có |
| POST /admin/staff/{id}/invitations | staff:manage | Invite có người nhận đã xác định, scope rõ |
| PATCH /admin/staff/{id}/roles | staff:manage + step-up | Thay quyền, audit, owner guard |
| GET/PATCH /partners/me/settings | Partner session | Locale/domain allowlist/preferences |
| GET /partners/me/summary | Partner session | Counts/balances có currency |
| POST /admin/plans/{id}/prices | pricing:write | Giá hiệu lực mới, tránh overlap |

Runtime bổ sung: `GET /admin/summary`, `GET /admin/system`, `GET /admin/translations`, `PUT /admin/translations/{resourceType}/{resourceId}/{locale}` có enum resource allowlist; `POST /auth/forgot-password` và `POST /auth/reset-password` chỉ khi runtime có email/reset adapter. Selfhost không cấu hình email phải có hướng dẫn khôi phục operator an toàn, không hiển thị form gửi mail giả.
