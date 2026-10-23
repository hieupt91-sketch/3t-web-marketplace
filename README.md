# 3T Web Marketplace

Nền tảng bán website/landing page, tự tạo demo từ tài nguyên chuẩn, bàn giao bộ cài hoặc vận hành hosting, có API cộng tác viên và đa ngôn ngữ.

**Bản đặc tả:** 1.0 — 23/10/2026 — tiếng Việt. **Trạng thái:** tài liệu triển khai và bộ hợp đồng mẫu; chưa phải phần mềm thương mại đã chạy.

## Bắt đầu đọc

1. [Yêu cầu sản phẩm và phạm vi](docs/01-san-pham-va-nghiep-vu.md).
2. [Kiến trúc và dữ liệu SQL](docs/02-kien-truc-va-sql.md).
3. [Chuẩn tài nguyên, nhận diện và demo tự động](docs/03-nhap-mau-va-demo.md).
4. [Hợp đồng API](docs/04-api.md).
5. [Toàn bộ yêu cầu UI/UX](docs/05-ui-ux.md).
6. [Cộng tác viên và API bán hàng](docs/06-cong-tac-vien.md).
7. [Đa ngôn ngữ và SEO](docs/07-da-ngon-ngu.md).
8. [Thanh toán, hosting, tên miền và vận hành](docs/08-van-hanh.md).
9. [GitHub, làm việc nhiều máy và CI/CD](docs/09-github-va-devops.md).
10. [Backlog, kiểm thử và nghiệm thu](docs/10-backlog-va-nghiem-thu.md).
11. [Bàn giao dev, quyết định và nguồn tham khảo](docs/11-ban-giao.md).

## Kết quả mong muốn

Quản trị viên đưa ZIP hoặc commit GitHub vào → hệ thống đọc manifest/nhận diện preset → kiểm tra → build cách ly → chạy demo → tạo bản nháp sản phẩm → quản trị viên đặt giá và công bố. Khách/CTV xem mẫu → thanh toán được máy chủ xác minh → mở quyền tải hoặc khởi tạo website.

**“Tự nhận diện” có phạm vi:** HTML tĩnh đủ tệp có thể chạy ngay; source Vite/Next/Node phải khớp adapter và có cấu hình. Ảnh thiết kế, SQL dump hoặc source thiếu dependency không tự biến thành website. Mẫu chuẩn hóa một lần; các phiên bản sau nhập và dựng demo tự động.

## Tệp có thể dùng ngay

- `contracts/template-manifest.schema.json`: cấu trúc manifest phiên bản 1.
- `examples/static-landing/`: fixture HTML rất nhỏ để kiểm thử import, không phải giao diện hoàn thiện của cửa hàng.
- `contracts/examples/`: manifest minh họa các adapter khác; chỉ là hợp đồng, không chứa ứng dụng backend.
- `scripts/validate_docs.py`: kiểm tra liên kết, JSON, quy tắc manifest của bộ tài liệu.
- `PROJECT_STATUS.md`, `DECISIONS.md`: ghi việc đã làm và điểm bắt đầu khi đổi máy.

```bash
python3 scripts/validate_docs.py
```

## Quy ước triển khai

- Mặc định repository riêng tư `3t-web-marketplace`; không gộp với dự án khác.
- Mã nguồn/tài liệu/migration ở GitHub; dữ liệu thật, `.env`, khóa, upload, backup và bộ cài bán hàng ở hệ thống lưu trữ riêng.
- Mặc định tiếng Việt + tiếng Anh, tiền VND. Ngôn ngữ không tự thay đổi tiền tệ.
- CTV bán qua API; nền tảng thu tiền và cấp quyền, CTV nhận hoa hồng.
- Mặc định phát hành hoàn chỉnh phải có cả tải bộ cài, hosting, CTV API và VI/EN. Chia mốc để xây tuần tự không có nghĩa bỏ chức năng.
- Mọi con số dung lượng, TTL, SLA và hoa hồng trong đặc tả là cấu hình khởi điểm đề xuất, không phải năng lực hệ thống đã được đo hoặc giá đã được chủ dự án duyệt.

## Trạng thái thực hiện

Đọc `PROJECT_STATUS.md` trước khi code. Bộ này chưa chứa API production, cổng thanh toán tích hợp, hệ thống chạy container hay frontend hoàn chỉnh. Không mô tả kiểm tra tài liệu là kiểm thử toàn bộ nền tảng.
