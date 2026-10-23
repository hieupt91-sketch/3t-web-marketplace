# 11. Bàn giao đội dev, quyết định và tài liệu tham chiếu

## 1. Gói đặc tả cung cấp

- Yêu cầu/roles/phạm vi và 30 REQ.
- Kiến trúc, logical SQL dictionary, invariants và job reliability.
- Hợp đồng import/manifest/adapters, demo và export.
- API catalog theo actor, requests/responses/errors/security.
- 95 mã UI với route, component, hành vi, validation và common states.
- CTV API/attribution/hoa hồng/payout/webhooks.
- VI/EN xuyên suốt UI/nội dung/mail/API/SEO và runtime.
- Thanh toán/hosting/domain/backup/renewal/runbook.
- GitHub multi-machine/CI/CD và backlog/60 acceptance scenarios.
- Schema JSON, fixture static nhỏ và script kiểm tra tài liệu.

Số UI thực tế được script kiểm tra; nếu thêm/bớt màn phải cập nhật bản này. Đây là bộ tài liệu triển khai, không phải xác nhận đã xây xong hệ thống. Website chạy demo tự động chỉ có sau khi dev hiện thực và kiểm thử pipeline.

## 2. Quyết định đã có để không hỏi lại

1. Sản phẩm bán website và landing page có demo.
2. Hai hình thức: tải trọn bộ tự triển khai; hosting của 3T với subdomain hoặc domain khách.
3. Thanh toán được xác minh trước mở quyền.
4. SQL là nguồn dữ liệu nghiệp vụ, UI qua API; không public database.
5. Nhập ZIP/GitHub theo contract để tự tạo demo.
6. CTV có API bán hàng và hoa hồng, không nhận toàn bộ source mặc định.
7. Đa ngôn ngữ, khởi đầu VI/EN.
8. Repo riêng `3t-web-marketplace`, làm tiếp được ở nhà.
9. Giữ dữ liệu/mã nguồn mẫu gốc; thay đổi có version, không xóa công việc cũ.

## 3. Quyết định được đề xuất, có thể đổi qua ADR

| Chủ đề | Mặc định | Khi cần xác nhận trước production |
|---|---|---|
| Stack | TypeScript/React/Next/Fastify/PostgreSQL; runtime nhỏ SQLite | Đội dev có nền tảng sẵn cần tái sử dụng |
| Thanh toán | Adapter, một provider sandbox trước | Provider/merchant account/phí/giao dịch thật |
| Domain thương hiệu | Placeholder, chưa giả có domain thật | Mua/chọn domain và quyền DNS |
| Giá/gói/hoa hồng | Do admin cấu hình; commission default 0 | Chủ dự án phê duyệt trước công bố |
| Hosting quota/SLA | Mục tiêu thử nghiệm trong docs | Đo tải và chi phí thật |
| Chính sách quyền source | Một website/quyền mặc định | Hợp đồng và quyền asset/code bên thứ ba |
| Hạn demo/grace/retention | 24h/7d/30d đề xuất | Quy trình vận hành và yêu cầu dữ liệu |
| Thu tiền CTV | Nền tảng thu trực tiếp | Mở reseller thu riêng cần bổ sung mô hình tài chính |
| Backend ngoài Node | Unsupported có thông báo | Thêm adapter và test, không đổi manifest tùy tiện |

Những điểm này không chặn viết foundation, UI, manifest và sandbox. Chúng phải được chốt trước khi phát sinh tiền, mua hạ tầng hoặc công bố điều khoản với khách.

## 4. Lệnh giao việc cho dev/AI CLI

Nội dung có thể dùng làm task đầu tiên:

> Đọc README.md, PROJECT_STATUS.md, DECISIONS.md và toàn bộ docs trước khi thay đổi. Triển khai theo các mốc M1–M8, giữ REQ/UI IDs và hợp đồng manifest v1. Bắt đầu bằng nền tảng API/SQL/auth/RBAC/i18n và design tokens, sau đó hoàn thiện luồng import static → demo → catalog. Không xóa/viết lại công việc đã có khi chưa đánh giá. Không tạo nút giả, không hardcode payment success, không coi UI hiding là phân quyền. Chưa triển khai chức năng nào phải ghi rõ trong PROJECT_STATUS, không tự bỏ CTV/VI-EN/hosting/self-host. Mỗi PR ghi thay đổi, test có ý nghĩa, rủi ro và bước tiếp. Không commit secrets/DB thật, không chạy source import trên host API, không push production từ PR chưa duyệt.

Task theo milestone phải vừa đủ review, không tạo skeleton toàn bộ rồi tuyên bố hoàn tất. Một vertical slice tốt: static fixture import → job → isolated serving → screenshot → catalog draft với UI lỗi/loading hoàn chỉnh và test chống archive unsafe.

## 5. Quy tắc cập nhật tài liệu

Thay business rule → update docs 01/08/06 liên quan + acceptance test. Thay field/API → update docs 04 + schema/client. Thay UI → docs 05 + locale keys. Thay import → schema + fixture + adapters + security tests. Thay policy ảnh hưởng đơn cũ → migration/snapshot rõ. Không sửa bản ghi giao dịch để “cho khớp UI”.

ADR lưu context, options ngắn, quyết định, ảnh hưởng, test/migration và người chốt. Mặc định phiên bản đặc tả tăng minor khi thêm tính năng, major khi phá hợp đồng; patch cho sửa lỗi không đổi nghiệp vụ.

## 6. Nguồn kỹ thuật đã đối chiếu

Các URL sau là tài liệu gốc, kiểm tra ngày 23/10/2026. Chúng hỗ trợ một số lưu ý cụ thể; kiến trúc và chính sách kinh doanh là đề xuất của bộ đặc tả, không phải nội dung được các nhà cung cấp phê duyệt.

| Nguồn | URL | Áp dụng |
|---|---|---|
| SQLite | https://sqlite.org/whentouse.html | Phân biệt runtime nhỏ và concurrent central DB |
| Vite | https://vite.dev/guide/static-deploy.html | Build dist/static, preview không là production server |
| Next.js | https://nextjs.org/docs/app/api-reference/config/next-config-js/output | standalone và asset cần đóng gói |
| Docker | https://docs.docker.com/engine/security/rootless/ | Rootless giảm quyền, không thay cách ly toàn diện |
| OWASP | https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html | Kiểm file upload nhiều lớp |
| Caddy | https://caddyserver.com/docs/automatic-https | Điều kiện và quản lý HTTPS |
| GitHub | https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-new-repository | Tạo repository và chọn visibility |
| GitHub | https://docs.github.com/en/actions/reference/security/secure-use | Quyền workflow/secrets/source không tin cậy |

Không khóa tài liệu vào số phiên bản framework được nhớ từ trước. Dev chọn release được hỗ trợ khi thực hiện, pin lockfile/image digest và chạy compatibility tests; không tự nâng version production khi đọc tài liệu mới.
