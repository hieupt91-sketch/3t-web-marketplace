# 10. Backlog, kiểm thử và nghiệm thu

## 1. Nguyên tắc hoàn thành

Không nghiệm thu dựa vào ảnh đẹp hoặc có menu. Một chức năng hoàn thành khi có schema/migration cần thiết, API có quyền/validation, UI mọi trạng thái, i18n, test nghiệp vụ và bằng chứng chạy ở staging. Bộ tài liệu này chưa chứng minh phần mềm production đã được viết.

Các mốc dưới chia thứ tự thực hiện; release theo yêu cầu đầy đủ phải bao gồm M1–M8. Có thể chạy beta nội bộ sớm nhưng không gọi beta thiếu hosting/CTV/EN là đã hoàn thành yêu cầu.

## 2. Backlog theo phụ thuộc

| Mốc/epic | Công việc phải làm | Deliverable | Phụ thuộc / gate |
|---|---|---|---|
| M0 / SPEC | Chốt tài liệu, defaults, repo private, manifest contract, UI IDs | Bộ đặc tả và GitHub | Đã có trước code |
| M1 / FOUNDATION | Monorepo, toolchain/lockfile, API skeleton, PostgreSQL migration, auth/session/RBAC, design tokens, vi/en, docs CI | Login + empty portal thực | SPEC, security review auth |
| M2 / IMPORT | ZIP quarantine/extraction, schema validator, static/Vite/Node/Next adapters, sandbox builder, object store, jobs/outbox, preview | Upload → URL demo và logs | FOUNDATION; malicious archive tests |
| M3 / CATALOG | Catalog CMS, localized metadata, prices, capability matrix, publish gates, public UI, admin import screens | Xem mẫu/demo/plan bằng dữ liệu API | IMPORT + UI P/A |
| M4 / COMMERCE | Quote/order/payment adapter sandbox, webhook verify/idempotency, entitlement/download, selfhost bundle/setup | Mua sandbox → tải và cài VPS sạch | CATALOG; accounting invariants |
| M5 / HOSTING | Runtime agent, site allocation, DB/volume riêng, domains/DNS/TLS, backup/restore, renew/suspend, promotion | Mua → site/domain chạy, restore drill | COMMERCE + runtime isolation |
| M6 / PARTNER | Apply/review, keys/scopes, catalog API, checkout attribution, signed events, ledger/payout portal | CTV store integration end-to-end | COMMERCE; no partner buyer takeover |
| M7 / LOCALIZE | Hoàn chỉnh VI/EN mọi UI/mail/content/SEO, translation review, runtime locale | Toàn bộ journey VI/EN, no key leaks | Xuyên suốt M1–M6, gate cuối |
| M8 / RELEASE | E2E/security/load/accessibility, runbooks, backup drill, production config, business policy review | Release candidate và acceptance report | Tất cả gates phía trên |

## 3. Tickets triển khai tối thiểu

| ID | Task | Điều kiện hoàn thành |
|---|---|---|
| DEV-01 | Repo/bootstrap/env | Clone trên hai máy chạy được docs/dev checks đúng hướng dẫn |
| DEV-02 | Core SQL/migrations | Rebuild DB test sạch và rollback/forward policy rõ |
| DEV-03 | Auth/RBAC | Role tests, verify/reset/session expiry/MFA staff |
| DEV-04 | UI kit/i18n shell | Components/vi/en và common states |
| DEV-05 | Catalog/pricing/translations | Search/detail/plan dựa SQL, snapshot version |
| DEV-06 | Import storage/extractor | Archive bounds, digest, quarantine, no path escape |
| DEV-07 | Detector/manifest | Preset confidence/config form/schema errors |
| DEV-08 | Build executor | No host credentials/socket, allowlist network, timeouts |
| DEV-09 | Static/Vite adapters | Entry/assets/deep route smoke, static serving |
| DEV-10 | Node/Next adapters | Port/health/DB/seed/standalone assets validated |
| DEV-11 | Demo lifecycle | Private session, TTL/reset/promotion race safe |
| DEV-12 | Jobs/outbox | Lease/fencing/dedupe/crash recovery/dead-letter |
| DEV-13 | Quote/order/payment | Provider sandbox + reconciliation + duplicate events |
| DEV-14 | Entitlement/export | Private download, eligible versions, clean source bundle |
| DEV-15 | Selfhost installer | VPS sạch, setup token, backup/upgrade independence |
| DEV-16 | Hosting provisioning | Slot reservation, per-site resources, rollback/retry |
| DEV-17 | Domain/TLS | Ownership/DNS/HTTPS/primary/cleanup safe |
| DEV-18 | Billing lifecycle | Renew race, grace/suspend/resume/purge policy |
| DEV-19 | Backup/restore/update | Consistent SQL+media, restore and upgrade drill |
| DEV-20 | Partner auth/API | Scope keys, quote/session, buyer claim, rate limits |
| DEV-21 | Attribution/ledger | Policy snapshot/partial refund/negative balance |
| DEV-22 | Partner webhooks/payout | Signature/replay/SSRF, reservation/evidence |
| DEV-23 | All UI screens | UI IDs + responsive + translated + authorization |
| DEV-24 | Runtime CMS | Capability controlled admin and localized content |
| DEV-25 | SEO/email/notifications | Locale correctness, public metadata, noindex demo |
| DEV-26 | Observability/runbooks | Alert simulated failures and audited recovery |
| DEV-27 | Release verification | E2E/load/security/accessibility, handover evidence |

## 4. Acceptance matrix nghiệp vụ

| Test | REQ | Tình huống | Kết quả phải có |
|---|---|---|---|
| AT-01 | 01 | Tìm/lọc mẫu đã publish | Kết quả/giá/locale đúng, URL giữ filter |
| AT-02 | 02,04 | ZIP HTML fixture hợp lệ | Nhận static, URL demo mở, asset đúng |
| AT-03 | 02,06 | ZIP `../`, absolute, symlink, bomb, tên normalize trùng | Chặn trước execution, không viết ngoài workspace |
| AT-04 | 03 | Webhook GitHub cùng delivery gửi ba lần | Một import logic, pinned commit đúng |
| AT-05 | 04,05 | Source có nhiều framework/thiếu lockfile | Needs configuration, không tự chọn sai |
| AT-06 | 05 | Unsupported schemaVersion/field/path | Lỗi JSON pointer rõ, UI sửa được |
| AT-07 | 06 | Build tìm prod env/metadata/docker socket | Không truy cập được; logs không secret |
| AT-08 | 06 | Build timeout/OOM/worker crash | Failure rõ, quota cleanup, retry checkpoint |
| AT-09 | 07 | Demo HTML, Vite, Node, Next | Main/deep routes/assets/API và locale pass |
| AT-10 | 08 | Hai user sửa admin demo | Không nhìn thấy dữ liệu của nhau |
| AT-11 | 08 | TTL hết khi tab vẫn mở | API từ chối ghi, cleanup chạy, UI expired |
| AT-12 | 08 | Promotion và cleanup cùng lúc | Snapshot an toàn, dữ liệu thật không bị xóa |
| AT-13 | 09 | Login/reset token replay/expiry | Không takeover, error chung, revoke phiên |
| AT-14 | 10 | Client sửa total/plan/coupon | Backend tính lại/khước từ, không giảm tiền trái policy |
| AT-15 | 10,11 | Redirect success giả | Đơn vẫn unpaid, chưa có entitlement |
| AT-16 | 10,27 | Webhook trùng/đến sai thứ tự | Một payment/entitlement, không quay paid về pending |
| AT-17 | 10 | Số tiền/currency sai hoặc late payment | Needs reconciliation, không tự mở sai quyền |
| AT-18 | 11 | Gọi download API khi chưa trả tiền | 403/404 đúng scope, không storage URL |
| AT-19 | 11 | Download token hết hạn/khác user | Không tải, cấp lại sau authorize |
| AT-20 | 12 | Cài bundle trên VPS sạch | Chạy UI/API/SQL, setup một lần, không phụ thuộc DB 3T |
| AT-21 | 12 | Mở setup trước khi chủ site nhập | Thiếu token bị chặn, không tạo admin trái phép |
| AT-22 | 13,27 | Hai lệnh tạo site cùng entitlement slot | Chỉ cấp theo instance limit, không race vượt quota |
| AT-23 | 13 | Paid nhưng provision lỗi rồi retry | Giữ quyền, không thu tiền lại, cùng site ID |
| AT-24 | 13,23 | Đổi site_id/Host/header để sang tenant B | Không truy cập DB/media/admin của B |
| AT-25 | 14 | Domain chưa TXT đúng nhưng DNS trỏ đúng | Không nhận domain cho site sai chủ |
| AT-26 | 14 | DNS IPv6/CAA/TLS lỗi | Hiển thị lỗi khả thi, subdomain vẫn hoạt động |
| AT-27 | 14 | Gỡ domain, gắn lại user khác | Ownership xác minh lại, không dangling takeover |
| AT-28 | 15 | Renewal webhook lặp đúng lúc expire | Cộng kỳ một lần, không suspend site đã gia hạn |
| AT-29 | 15 | Grace/suspend/purge | Đúng timeline/policy, owner có luồng phục hồi |
| AT-30 | 16 | Upload cùng semver khác source hash | Reject conflict, release cũ bất biến |
| AT-31 | 17 | Support staff gọi refund/settings secrets | Denied; chỉ kế toán/quản trị đúng permission |
| AT-32 | 18 | Static template không CMS | Không quảng cáo/hiện admin CMS không tồn tại |
| AT-33 | 19,21 | Partner A đổi order/key ID sang B | Denied, không lộ PII |
| AT-34 | 19 | Partner tự gửi is_paid/total thấp | Không ảnh hưởng quote/entitlement |
| AT-35 | 19 | Partner session được buyer khác email hint claim | Chỉ verified buyer chấp nhận hợp lệ sở hữu; CTV không tự claim thay |
| AT-36 | 19,27 | CTV retry external_reference | Một checkout/order logic, response ổn định |
| AT-37 | 20 | Policy rate đổi sau paid | Đơn cũ giữ snapshot, đơn mới dùng rate mới |
| AT-38 | 20 | Partial refund nhiều lần rồi full | Net commission 0, rounding đúng, không double reversal |
| AT-39 | 20 | Refund sau paid payout | Entry âm/hold rõ, payout history giữ nguyên |
| AT-40 | 20 | Hai payout request đồng thời | Không reserve vượt eligible balance |
| AT-41 | 21 | Key revoke/expire/suspend | Chặn trong SLO; site buyer không bị xóa |
| AT-42 | 21 | Webhook sai signature/timestamp/replay | Receiver example từ chối; retry signed mới, dedupe event |
| AT-43 | 21 | Endpoint webhook trỏ IP nội bộ/redirect/DNS rebinding | Sender chặn SSRF |
| AT-44 | 22 | Toàn journey mua VI/EN | UI/email/error/price/terms đúng locale |
| AT-45 | 22 | Catalog không EN nhưng UI EN | Fallback được gắn nhãn, không false hreflang |
| AT-46 | 22 | Đổi locale ở checkout partner | Giữ order/partner, không đổi giá trị tiền |
| AT-47 | 24 | Restore SQL + media backup lên node khác | Nội dung/ảnh/account đúng, checksum và smoke pass |
| AT-48 | 24 | Upgrade DB không backward-compatible | Chặn rollback app đơn giản; dùng restore kế hoạch |
| AT-49 | 25 | Clone từ máy ở nhà | Tài liệu và checks chạy; không cần secret trong repo |
| AT-50 | 26 | Bàn phím/mobile/chuỗi dài | Mua/import/domain/key form dùng được không overflow |
| AT-51 | 27 | ETag cũ PATCH content | 412, UI giữ draft và cho xử lý conflict |
| AT-52 | 28 | Paid-but-pending job quá ngưỡng | Alert chứa request/resource IDs và không secret |
| AT-53 | 29 | Hosting user export data không có source license | Chỉ dữ liệu của họ, không toàn bộ platform/source trái gói |
| AT-54 | 30 | Asset chưa rõ quyền phân phối | Publish gate chặn, cần hồ sơ quyền |
| AT-55 | 06,21 | XSS demo/iframe postMessage | Không đọc cookie/token nền tảng, origin check |
| AT-56 | 10,20 | Refund failed rồi provider confirmed retry | Chỉ đảo hoa hồng sau xác nhận đúng một lần |
| AT-57 | 03,16 | Push GitHub source mới | Chỉ preview version mới; production chưa tự đổi |
| AT-58 | 12 | Scan bộ ZIP thương mại | Không `.env`, key, DB khách, session demo, Git history |
| AT-59 | 11 | Tải version ngoài updates_until | API từ chối, version được mua vẫn có theo policy |
| AT-60 | 07,08 | Demo gửi contact/payment/mail | Mô phỏng, không thu tiền/gửi người thật |

## 5. Non-functional acceptance

Các chỉ tiêu sau là mục tiêu khởi điểm; QA ghi phần cứng, dataset, concurrency, duration và kết quả, không coi số này là năng lực đã chứng minh.

| Nhóm | Kịch bản benchmark | Mục tiêu đề xuất |
|---|---|---|
| API catalog | 1.000 mẫu, 2 locale, 50 concurrent read, 10 phút | p95 <500ms không tính mạng WAN, <1% 5xx |
| Portal | 10.000 order giả, filter/paging/index | Không query scan bất hợp lý, p95 <800ms ở môi trường test |
| Static demo | Fixture <1MiB, node rảnh, warm image | p95 ready <60s |
| Fullstack import | Gói nằm trong quota, dependency cache ghi rõ | Timeout đúng 10 phút; progress/error không mất |
| Payment idempotency | 100 callback trùng + worker restart | Một entitlement, ledger đúng |
| Tenant safety | Hai paid sites + 20 demo phiên | Không trộn SQL/media/session |
| Backup | Dataset 1GiB demo test, node restore riêng | RTO mục tiêu <4h; RPO theo cấu hình thực |
| UX | 360/390/768/1440, Chrome/Safari/Firefox đang hỗ trợ | Không lỗi chặn nhiệm vụ chính |
| i18n | VI/EN + pseudo-localization 150% | Không raw key/truncated CTA quan trọng |

Điều chỉnh mục tiêu có ghi quyết định và chủ dự án duyệt khi chuẩn bị SLA thương mại. Không dùng caching để che dữ liệu quyền/giá đã thu hồi.

## 6. Kiểm thử theo lớp

Unit cho công thức tiền/commission/state transition/detection normalization. Integration cho SQL constraints/outbox/leases/payment events/partner scoping. Contract cho API schema và manifest. E2E cho hành trình mua/demo/import/domain/CTV/i18n. Security cho source ingestion, isolation, auth, upload, SSRF. Manual QA cho nội dung, accessibility và các tài liệu hướng dẫn VPS.

Không viết test chỉ kiểm gọi đúng tên hàm. Dữ liệu seed test phải tổng hợp. Payment live chỉ thử với tài khoản/thỏa thuận và người có thẩm quyền, không dùng dữ liệu thẻ thật trong repo.

## 7. Traceability theo UI

- P01–P09 → REQ-01/07/22/26.
- U01–U06 → REQ-09/26.
- D01–D04 → REQ-07/08.
- B01–B05 → REQ-10/11/27.
- C01–C15 → REQ-11/12/13/14/15/24/29.
- A01–A27 → REQ-02/03/04/05/06/16/17/28/30.
- R01–R12 → REQ-19/20/21/22.
- W01–W17 → REQ-18/22/23/26.

Mọi mã UI có trạng thái common + trường riêng trong tài liệu 05. Nếu dev tách/gộp route, giữ mapping UI ID để tránh bỏ chức năng.

## 8. Checklist trước public launch

- [ ] Tất cả REQ bắt buộc có test evidence và người nghiệm thu.
- [ ] Provider payment/email/DNS/storage thật đã cấu hình đúng environment; không còn mock được trình bày là thật.
- [ ] Publish demo không lộ credential và không gây tác dụng ngoài thật.
- [ ] Một mẫu static và một mẫu có API/SQL được mua theo cả hai mode hoàn chỉnh.
- [ ] Bốn adapter target có smoke fixtures; adapter chưa pass không được bật như supported.
- [ ] CTV tích hợp trên ứng dụng thử độc lập, webhook/commission/refund/payout pass.
- [ ] VI/EN toàn luồng, scope locale từng mẫu đúng.
- [ ] Tên miền riêng hoạt động, HTTPS renew kiểm thử staging phù hợp.
- [ ] Backup restore/rollback/runbooks và alerts có bằng chứng.
- [ ] Không secret/PII/demo password trong GitHub/bundle/log.
- [ ] Quyền tài nguyên, chính sách bán/hoàn tiền/hosting/CTV được doanh nghiệp xác nhận.
- [ ] Handover README/STATUS/commands/lockfile/diagram khớp bản release.

## 9. Mẫu báo cáo nghiệm thu

Mỗi test ghi: ID, commit/artifact digest, environment, input, expected, actual, evidence path, tester, tested_at, pass/fail, linked issue. Bug chặn thanh toán/quyền/tenant data/secrets là P0; chặn flow mua/provision/CTV là P1; UI không chặn là P2. Không phát hành còn P0/P1 chưa có quyết định xử lý rõ và được người có trách nhiệm chấp thuận.
