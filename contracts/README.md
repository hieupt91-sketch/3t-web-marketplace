# Hợp đồng tài nguyên

`template-manifest.schema.json` mô tả contract v1 theo JSON Schema 2020-12. Dev production dùng validator tiêu chuẩn tương thích draft này, rồi chạy kiểm tra cross-field/path/policy và sandbox như docs/03.

`examples/*.manifest.json` là ví dụ cấu trúc Vite/Next/Node, **không chứa source app tương ứng và không được quảng cáo là bộ cài chạy sẵn**. `toolchain: node-lts-approved` là tên profile trong registry do đội dev cần tạo và pin image digest; không phải version Node thực để cài trực tiếp.

Fixture có tệp chạy tĩnh thật ở `../examples/static-landing/`. Script kiểm tra tài liệu chỉ kiểm subset schema đang được sử dụng và fixture/path tham chiếu; không thực thi source, không giải nén ZIP và không thay sandbox/security scanner production.
