# Quyết định thiết kế

Ngày 23/10/2026. Đây là baseline đề xuất kỹ thuật theo yêu cầu người dùng; chính sách thương mại cần chốt trước public launch.

| ADR | Quyết định | Lý do / hệ quả |
|---|---|---|
| ADR-001 | Modular monolith, API và worker riêng process | Dễ làm/vận hành ban đầu, tách module để mở rộng |
| ADR-002 | PostgreSQL control plane, SQLite cho site nhỏ | Giao dịch trung tâm đồng thời; bộ cài khách gọn |
| ADR-003 | Artifact immutable + manifest versioned | Demo, download và hosting cùng source có truy vết |
| ADR-004 | Auto-detect có phạm vi, không chạy code tùy ý | Nhập mẫu dễ nhưng không giả nhận diện mọi source |
| ADR-005 | Build/demo cách ly và origin khác portal | Bảo vệ secrets, tenant và cookie |
| ADR-006 | Paid/entitlement/provisioning tách trạng thái | Tạo site lỗi không làm mất quyền mua |
| ADR-007 | CTV bán API, platform thu tiền | Cấp quyền đáng tin cậy và sổ hoa hồng đối soát được |
| ADR-008 | VI/EN từ đầu, locale khác currency | Không phải dịch lại toàn UI sau khi đã code |
| ADR-009 | Repo riêng private, không DB/secret trong Git | Làm ở nhiều máy, bảo vệ sản phẩm và dữ liệu |
| ADR-010 | Source self-host chạy độc lập theo gói | Không hứa chống sao chép tuyệt đối; kiểm quyền tải/cập nhật |
| ADR-011 | Demo auto-ready, catalog publish qua gate | Có preview ngay nhưng không tự bán bản lỗi/thiếu giá |
| ADR-012 | Hosted export data khác source license | Khách lấy dữ liệu của mình, quyền source theo gói |

## Quyết định khi triển khai M1/M2 (23/10/2026)

| ADR | Quyết định | Lý do / hệ quả |
|---|---|---|
| ADR-013 | pnpm workspace, TypeScript chạy qua `tsx`, chưa có bước build riêng cho API/worker | Ít cấu hình lúc đầu; trước production cần build/đóng gói image và pin digest |
| ADR-014 | Next.js 15.5 + React 19.1 cho web; admin nằm trong `apps/web` dưới `/admin` | Một frontend cho M1–M3; tách `apps/admin`/`apps/partner` khi cần deploy riêng |
| ADR-015 | Mật khẩu băm scrypt (N=2^17, r=8, p=1) bằng `node:crypto` | Không cần native module; cost cấu hình qua `PASSWORD_HASH_COST` |
| ADR-016 | Origin preview theo nhãn hostname ngẫu nhiên 160-bit, không đăng nhập | Bản nháp chỉ chia sẻ qua URL khó đoán; demo admin cần token exchange (chưa làm) |
| ADR-017 | Artifact site tĩnh lưu theo digest nội dung; source_sha của version = digest cây tệp | Nén lại cùng nội dung → cùng version; cùng semver khác nội dung bị từ chối (AT-30) |
| ADR-018 | Kết quả nghiệp vụ (rejected/needs_configuration) đánh dấu job succeeded; lỗi hạ tầng mới retry | Hàng dead-letter chỉ chứa việc cần vận hành can thiệp |
| ADR-019 | Chụp ảnh chạy Chromium trên worker với chặn mạng ngoài origin preview | Chấp nhận cho mẫu do đội 3T nhập; source không tin cậy phải chuyển vào executor cách ly |

## Quyết định khi triển khai M3 (23/10/2026)

| ADR | Quyết định | Lý do / hệ quả |
|---|---|---|
| ADR-020 | `plan_prices` dùng khoảng hiệu lực [from, to) + exclusion constraint (btree_gist) chống chồng lấn; đổi giá tự đóng khoảng cũ | Giữ lịch sử giá, đơn cũ snapshot không đổi; "áp dụng cho đơn mới từ…" (A08) |
| ADR-021 | Kích hoạt gói đòi có giá hiện hành ở currency nền tảng; gói không giá không hiển thị cho khách | Không công bố gói lỗi/thiếu giá (REQ-11, §7 docs/01) |
| ADR-022 | `template_editor` có `pricing:write` ("giá nháp"); chỉ `template:publish` mới công bố | Khớp bảng vai trò docs/01 §1; tách soạn thảo và phát hành |
| ADR-023 | Công bố gộp A06/A08/A09 trong một trang `/admin/templates/{id}` theo ETag mẫu | Một nguồn sự thật, tránh xung đột revision giữa nhiều màn |
| ADR-024 | Timestamp trả API chuẩn hóa ISO 8601 UTC (Z), kể cả giá trị lấy từ jsonb | Khớp hợp đồng docs/04 §1 |

## Quyết định khi triển khai M3 CMS nội dung (24/10/2026)

| ADR | Quyết định | Lý do / hệ quả |
|---|---|---|
| ADR-025 | Nội dung trang/chính sách lưu markdown subset, render escape HTML + allowlist link ở web | An toàn XSS (docs/05 RichText), không cần sanitizer nặng; không nhận HTML tùy ý |
| ADR-026 | `policy_versions` bất biến sau publish (trigger); đổi chính sách = tạo version mới | Đơn hàng snapshot version đã áp dụng, không sửa lịch sử (docs/04 §3) |
| ADR-027 | Contact honeypot: điền field ẩn → đánh dấu `suspected`, vẫn nhận; response 202 chung | Không báo cho bot biết bị chặn; không nhầm liên hệ với tạo đơn (P09) |

## Quyết định khi triển khai M4 COMMERCE (24/10/2026)

| ADR | Quyết định | Lý do / hệ quả |
|---|---|---|
| ADR-028 | `PaymentProvider` interface + `MockPaymentProvider` sandbox ký HMAC; chưa tích hợp provider thật | Chạy đủ luồng verify webhook (chữ ký + timestamp + dedupe) khi chưa có tài khoản merchant (docs/08 §1) |
| ADR-029 | Giá tính 100% ở backend từ giá hiện hành của gói; quote bound theo buyer + hết hạn 15 phút | Không tin total/giá từ client (invariant §6.1, AT-14) |
| ADR-030 | Cấp quyền chỉ từ sự kiện đã verify; entitlement unique theo order_item; webhook trùng/sai thứ tự idempotent | Redirect success giả không mở quyền (AT-15/16); tiền sai → needs_reconciliation (AT-17) |
| ADR-031 | Bộ cài self-host sinh on-demand từ artifact static_site (site/ + README + manifest + CHECKSUMS), mtime cố định để hash ổn định | Bàn giao tải được cho mẫu tĩnh ngay; adapter runtime bổ sung compose/migration sau |
| ADR-032 | Tải qua token một lần hash trong DB, hết hạn 5 phút, redeem kiểm quyền lại mỗi lần | Không lộ URL storage; chặn tải khi chưa trả tiền/khác user (AT-18/19) |
