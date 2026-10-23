# 08. Thanh toán, bàn giao, tên miền và vận hành

## 1. Thanh toán và cấp quyền

Thiết kế `PaymentProvider` interface: createSession, verifyWebhook(rawBody, headers), queryTransaction, refund, normalizeStatus. Chọn một provider có tài liệu và tài khoản thật tại mốc tích hợp; trước đó dùng sandbox/mock ghi nhãn. Không lưu dữ liệu thẻ; chuyển sang checkout/tokenization của provider phù hợp.

Giá/coupon/tax được tính tại backend và snapshot trong quote/order. Không tin total từ trình duyệt hay CTV. Payment success redirect chỉ mở màn theo dõi; order paid phải đến từ webhook xác minh hoặc đối soát máy chủ. Chuyển khoản thủ công cần bank transaction unique/evidence và quyền kế toán; nút “Đã chuyển tiền” của khách chỉ yêu cầu kiểm tra.

### Transaction xác nhận

1. Xác minh event, dedupe provider/event ID, kiểm transaction thuộc merchant/order.
2. Kiểm số tiền/currency/status captured/settled theo contract provider; không coi authorized là settled nếu provider phân biệt.
3. Khóa order; kiểm chưa fulfilled/paid; ghi payment và trạng thái.
4. Tạo entitlement unique theo order item, attribution snapshot và commission pending khi đủ điều kiện.
5. Ghi outbox `order.paid` và job fulfillment cùng transaction.
6. Commit rồi trả acknowledgement; worker xử lý site/download/email riêng.

Webhook lặp/sai thứ tự không được rollback trạng thái thành công thành pending. Mất webhook → scheduler query các attempt pending với backoff rồi đối soát. Late payment sau expired/cancelled → `needs_reconciliation`, không làm mất khoản tiền hoặc tự tạo order mới.

## 2. Máy trạng thái

| Đối tượng | Trạng thái hợp lệ | Quy tắc chuyển |
|---|---|---|
| Order | draft, awaiting_payment, paid, cancelled, expired, refund_pending, partially_refunded, refunded, needs_reconciliation | Payment/refund là sự kiện kiểm chứng; không PATCH status tùy ý |
| Payment | created, pending, authorized, settled, failed, cancelled, partially_refunded, refunded, disputed | Mapping theo provider, lưu event gốc |
| Entitlement | pending, active, suspended, revoked, expired | Selfhost perpetual không hết vì updates_until |
| Fulfillment | not_started, queued, running, ready, failed, cancelled | paid vẫn tồn tại khi failed |
| Subscription | pending, active, grace, suspended, ended | Tính từ period_end và policy snapshot |
| Site | provisioning, active, updating, maintenance, suspended, failed, deleting, deleted | Transition guard và operation lock |
| Demo | queued, creating, active, expired, cleaning, deleted, failed | TTL server, promotion lock |
| Domain | reserved, waiting_dns, verifying, verified, issuing_tls, active, error, detached | Verified trước routing/TLS production |

Mỗi transition có actor/event, old/new, timestamp, reason, request_id; không dùng một cột status chung cho tất cả.

## 3. Refund và chargeback

Khách gửi refund request → kế toán review theo policy đơn → provider nhận yêu cầu → pending → confirmed settled. Khi xác nhận mới điều chỉnh entitlement/hosting và commission theo mức hoàn. Cần mapping refund amount về order items và component. Partial refund không mặc định thu hồi toàn bộ site; quyết định phải rõ trong policy snapshot.

Đã tải source không thể thu hồi bản đã download. Full refund có thể thu hồi quyền tải/cập nhật/hỗ trợ tiếp theo nhưng không tuyên bố đã xóa source trên VPS khách. Chargeback/dispute đặt hold theo policy, giữ audit và hướng xử lý, không xóa dữ liệu ngay.

## 4. Provisioning hosting

API không chạy Docker trực tiếp và không giữ socket. Worker gửi lệnh allowlist cho runtime agent qua mTLS/service identity; agent có quyền cần thiết trên node và áp dụng policy. Customer input không thành shell string.

Saga: reserve entitlement slot + subdomain + node quota → tạo DB/volume/media prefix riêng → tạo runtime từ immutable artifact → generate secrets/first-admin exchange → migrate → seed sạch hoặc promotion snapshot → health/smoke → đăng ký routing → active → notify. State/checkpoint lưu sau từng bước. Retry trên cùng site_id/deployment_id và idempotency key.

Lỗi trước route → route chưa public. Lỗi sau resource creation → rollback bù owned resource hoặc giữ quarantine có TTL để điều tra; quota reservation giải phóng đúng một lần. Tuyệt đối không dùng `docker compose down -v` trên project chung chứa nhiều khách.

Capacity: node heartbeat, reserved memory/storage, runtime status; scheduler không oversubscribe theo “số khách” cố định. Demo low priority và TTL, site paid ưu tiên. Static có thể share static serving layer với filesystem/object prefix isolated; backend có runtime/database volume riêng.

## 5. Tên miền và HTTPS

### 5.1 Subdomain nền tảng

Ví dụ minh họa `abc.sites.example`, domain demo riêng `session.demo-example.net`; chưa phải domain đã mua. Tên 3–40 ký tự lower-case a–z/0–9/hyphen, không đầu/cuối hyphen, reserved list `admin/api/www/mail/support/billing/...`. Reserve atomically tránh hai khách cùng chọn.

3T chuẩn bị DNS wildcard hoặc bản ghi tự động, certificate và router. Nếu dùng wildcard certificate phải hỗ trợ DNS challenge tương ứng; không giả định wildcard A tự tạo wildcard HTTPS. Runtime tenant không nhận DNS API credential.

### 5.2 Domain khách

1. Normalize hostname lowercase/IDNA; cấm URL scheme/path/port/IP, wildcards v1.
2. Reserve hostname, cấp token TXT ngẫu nhiên theo site/domain; hiển thị record ví dụ `_3t-verification` + giá trị.
3. Khách thêm TXT và A/AAAA/CNAME theo domain apex/subdomain; hướng dẫn theo nhà cung cấp, không yêu cầu mật khẩu DNS.
4. Resolver kiểm ownership TXT và routing records, kể cả IPv6 cũ trỏ sai, CAA có thể ngăn cấp chứng chỉ; lưu last_checked/errors.
5. Ownership đúng và routing hợp lệ → verified; enqueue TLS; chỉ publish route sau ready.
6. Primary domain active → canonical/redirect alias, tôn trọng login callback/CORS.
7. Remove/transfer → step-up, thu hồi route/certificate mapping theo policy, verify lại cho chủ mới; không giải phóng domain đang suspended cho người khác.

Caddy hỗ trợ quản lý và gia hạn HTTPS tự động khi DNS, cổng mạng và cấu hình đáp ứng yêu cầu [S6]. Với On-Demand TLS, endpoint cho phép cấp phải tra registry domain đã verified/authorized; không cấp chứng chỉ cho Host bất kỳ. Caddy admin API chỉ mạng nội bộ, không public.

Khách chỉ nhập domain là đủ sau khi DNS đã được trỏ hoặc tích hợp DNS hợp lệ. Trong trường hợp DNS khách tự quản lý, phải có bước họ thêm bản ghi; không hứa bỏ qua bước này.

## 6. Self-host và bộ bàn giao

Bundle phải kiểm thử trên VPS sạch và chạy không gọi DB/platform secret của 3T. Runtime API, UI/admin, SQL migration, media seed và cấu hình độc lập. Không buộc site perpetual gọi server license để sống nếu chính sách bán chưa nêu rõ. Có thể dùng signed entitlement để kiểm quyền cập nhật, nhưng source giao rồi vẫn có thể bị sửa.

| Tệp/thành phần | Tiêu chí |
|---|---|
| source và lockfile | Đúng version/hash đã mua, có quyền phân phối |
| build/deploy recipe | Image digest/toolchain được pin, linux/amd64; arm64 chỉ nếu đã build/test |
| compose profile | App/proxy/data volumes, healthcheck, restart, resource config |
| .env.example | Các biến public/secret được phân loại, không default admin password |
| setup | Token random in console/file quyền hẹp, expires, one-time |
| SQL | Migration table, seed mới sạch; không demo account/đơn giả production |
| backup/restore | Quy trình SQL + media + config, restore drill |
| upgrade | Backup, compatibility matrix, migration rollback policy |
| README/license/checksums | Hướng dẫn, tài nguyên bên thứ ba, checksum ZIP/manifest |

VPS có Docker/Compose theo bản hỗ trợ là điều kiện trước triển khai. Lệnh mẫu trong tài liệu cài thật phải được kiểm thử, không đưa “1 lệnh cài” khi chưa sinh script. Setup route không public takeover: installer generate token trước expose, user tạo admin, migrate thành công rồi set initialized trong DB và vô hiệu setup. Secret không in lại sau setup.

## 7. Gia hạn, hết hạn và dữ liệu

Mốc đề xuất: nhắc trước 14/7/1 ngày → period_end → grace 7 ngày → suspended → giữ dữ liệu 30 ngày → notice trước purge → purge theo quyền và lịch. Policy thực tế snapshot theo plan; thời điểm UTC và UI timezone rõ. Job expiry dùng thời gian server, khóa race với payment renewal.

Trong grace site tiếp tục hoạt động nếu policy cho phép. Suspended: public route trả trang thông báo tối thiểu, không lộ số nợ/PII; owner vẫn vào portal để gia hạn, export data hoặc hỗ trợ theo quyền. Gia hạn được áp dụng unique một lần, resume cùng site/data nếu còn. Đã purge thì không quảng cáo khôi phục nếu backup cũng đã hết retention.

Xóa user không cascade xóa chứng từ giao dịch và audit phải giữ; data retention từng loại do doanh nghiệp chốt. Quy trình delete site cần backup/export option, xác nhận resource, lịch trì hoãn, cancel trước cutoff và audit. Không gửi warning giả về “hôm nay xóa” khi scheduler chưa có lịch.

## 8. Sao lưu và khôi phục

| Đối tượng | Mặc định đề xuất | Kiểm tra |
|---|---|---|
| PostgreSQL nền tảng | Backup hằng ngày + WAL/PITR nếu mục tiêu yêu cầu | RPO mục tiêu 1h khi WAL/PITR được cấu hình; chỉ daily thì RPO tối đa 24h |
| Site SQL + media | Daily và trước upgrade/restore | Snapshot consistency, checksum, version |
| Config/secrets refs | Mã hóa, quyền riêng, key recovery procedure | Không lưu plaintext cùng bundle khách |
| Artifact đã bán | Immutable, replication/versioning theo storage | Hash và phục hồi link quyền |
| Demo | Không backup dài hạn | TTL cleanup; promotion snapshot có retention ngắn |

Không copy file SQLite đang ghi theo cách có thể bỏ WAL; dùng backup API/snapshot an toàn đã test. Media/DB snapshot có manifest chung và thời điểm/cutoff để tránh reference mất ảnh. Restore lên runtime tạm → integrity check → smoke → đổi route; có backup của trạng thái trước restore. Backup giữ ở vị trí khác node chính, mã hóa và giới hạn access. RTO mục tiêu 4h là **mục tiêu cần đo**; không SLA kinh doanh trước drill.

## 9. Observability và response sự cố

- Logs structured: time/service/request_id/job_id/site_id/event code, redacted sensitive fields; hạn chế retention PII.
- Metrics: p50/p95/error API, DB pool/lock, job queue age/retry, import success, demo lifecycle, payment mismatch, TLS expiry, disk/quota, partner webhook success.
- Alerts: payment webhook verify spike, paid-but-no-entitlement, paid-but-fulfillment pending quá ngưỡng, backups thất bại, disk > ngưỡng, node lost, TLS sắp hết hạn.
- Runbook: xác định phạm vi → tạm chặn thao tác gây hại → đối soát event/idempotency → phục hồi → kiểm dữ liệu/quyền → thông báo người liên quan theo quy trình → ghi postmortem.
- Log build và runtime không được chứa JWT/key/password, signed download URL hoặc `.env`.

## 10. Security release gate

RBAC/tenant boundary tests, SQL injection/XSS/CSRF/SSRF tests, archive tests, no secret in bundle, auth/setup takeover tests, rate limit, partner scope và signature tests phải pass. Secrets phân environment và role; staging dùng dữ liệu giả. Dependency scanning/SBOM và quyền asset kiểm trước publish. Container bị xâm nhập không được có đường tới DB thu tiền hoặc toàn bộ object store.

## 11. Nguồn

[S6 — Caddy Automatic HTTPS](https://caddyserver.com/docs/automatic-https), kiểm tra 23/10/2026. Domain registry, quota, policy retention và runbook trong tài liệu này là thiết kế của dự án.
