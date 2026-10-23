# Trạng thái dự án

Ngày cập nhật: 23/10/2026 (Asia/Ho_Chi_Minh). Đặc tả 1.0.

## Đã chuẩn bị

- Bộ tài liệu sản phẩm, kiến trúc SQL/API, nhập mẫu/demo, toàn bộ UI, CTV, VI/EN, vận hành, GitHub, backlog/QA.
- JSON Schema manifest v1, manifest ví dụ, fixture HTML nhỏ, validator tài liệu.
- Đã tạo repository Private: https://github.com/hieupt91-sketch/3t-web-marketplace . Bộ tài liệu này là baseline commit đầu của dự án sau README khởi tạo.
- Kiểm tra cục bộ: 95 mã UI duy nhất, 30 REQ, 60 kịch bản nghiệm thu được đặc tả, 4 manifest ví dụ, 7 kiểm tra hợp đồng âm; validator tài liệu PASS. Các kịch bản nghiệm thu phần mềm vẫn chờ triển khai.

## Chưa triển khai

Frontend/backend production, SQL migration thực, payment provider, sandbox executor, runtime agent, domain/TLS integration, CTV ledger/API production, email, deployments và nghiệm thu trên VPS.

## Bước tiếp theo

1. Đọc docs/01, docs/02, docs/03 và docs/05.
2. Chốt toolchain/lockfile và bootstrap M1 trên branch `feat/foundation`.
3. Làm auth/RBAC/i18n/UI kit và initial SQL migration.
4. Thực hiện vertical slice import HTML fixture → preview URL ở M2.

## Lệnh hiện có

```bash
python3 scripts/validate_docs.py
```

Chưa có lệnh chạy ứng dụng nền tảng. Không dùng kết quả validator tài liệu để khẳng định pipeline demo/thanh toán đã chạy.
