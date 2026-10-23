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
