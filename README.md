# 3T Web Marketplace

Nền tảng bán website/landing page, tự tạo demo từ tài nguyên chuẩn, bàn giao bộ cài hoặc vận hành hosting, có API cộng tác viên và đa ngôn ngữ.

**Bản đặc tả:** 1.0 — 23/10/2026 — tiếng Việt. **Trạng thái:** đặc tả + mã nền tảng M1 và lát cắt nhập mẫu tĩnh M2; chưa phải phần mềm thương mại đã chạy.

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

## Mã nguồn hiện có (M1 + lát cắt M2)

| Thư mục | Nội dung |
|---|---|
| `apps/api` | API Fastify `/api/v1`: tài khoản, phiên, RBAC, CSRF, idempotency, ETag; nhập ZIP; danh mục |
| `apps/worker` | Worker xử lý job nhập mẫu `static-html` (kiểm tra gói → bản xem trước → bản nháp) |
| `apps/preview` | Origin xem trước riêng, phục vụ artifact bất biến theo hostname |
| `apps/web` | Next.js: cửa hàng (P01–P03), đăng nhập (U01–U06 một phần), tài khoản (C01), quản trị nhập mẫu (A01–A05) |
| `packages/core` | Cấu hình, PostgreSQL, migration runner, job queue lease/fencing, audit/outbox, object store |
| `packages/template-sdk` | Kiểm tra manifest v1, giải nén ZIP an toàn, quét bí mật, nhận diện adapter |
| `packages/i18n` | Gói ngôn ngữ VI/EN và kiểm tra khóa |
| `migrations/` | SQL nền tảng (forward-only) |
| `tests/` | Kiểm thử tích hợp API → worker → preview |

Chỉ adapter `static-html` chạy được; `vite-static`, `next-standalone`, `node-http` được nhận diện nhưng báo “chưa triển khai”. Chi tiết: `PROJECT_STATUS.md`.

### Chạy trên máy dev

Yêu cầu: Node 22 LTS, pnpm 10 (`corepack enable`), PostgreSQL 16 (binary cục bộ) và Python 3 cho kiểm tra tài liệu.

```bash
pnpm install --frozen-lockfile
pnpm db:start                      # PostgreSQL cục bộ ở 127.0.0.1:55432 (runtime-data/pg)
pnpm db:migrate
OWNER_EMAIL=ban@example.com pnpm owner:create   # hỏi mật khẩu, cấp vai trò platform_owner
pnpm dev                           # API :4000, worker, preview :4100, web http://localhost:3000
```

Email phát triển được ghi vào `runtime-data/dev-mail/` (không gửi ra ngoài). Ảnh chụp demo cần `SCREENSHOTS=on` và `CHROMIUM_PATH`. Xem `.env.example`.

### Kiểm tra

```bash
pnpm run check        # docs + typecheck + kiểm tra khóa i18n + toàn bộ test (cần PostgreSQL đang chạy)
python3 scripts/validate_docs.py
```

Bộ hợp đồng gốc vẫn ở `contracts/` và fixture `examples/static-landing/` (dùng trong test tích hợp).

## Quy ước triển khai

- Mặc định repository riêng tư `3t-web-marketplace`; không gộp với dự án khác.
- Mã nguồn/tài liệu/migration ở GitHub; dữ liệu thật, `.env`, khóa, upload, backup và bộ cài bán hàng ở hệ thống lưu trữ riêng.
- Mặc định tiếng Việt + tiếng Anh, tiền VND. Ngôn ngữ không tự thay đổi tiền tệ.
- CTV bán qua API; nền tảng thu tiền và cấp quyền, CTV nhận hoa hồng.
- Mặc định phát hành hoàn chỉnh phải có cả tải bộ cài, hosting, CTV API và VI/EN. Chia mốc để xây tuần tự không có nghĩa bỏ chức năng.
- Mọi con số dung lượng, TTL, SLA và hoa hồng trong đặc tả là cấu hình khởi điểm đề xuất, không phải năng lực hệ thống đã được đo hoặc giá đã được chủ dự án duyệt.

## Trạng thái thực hiện

Đọc `PROJECT_STATUS.md` trước khi code. Chưa có thanh toán, entitlement, hosting, CTV, executor build cách ly cho source cần build, hay triển khai staging/production. Kiểm thử hiện có chứng minh lát cắt nhập HTML tĩnh trên máy dev, không phải toàn bộ nền tảng.
