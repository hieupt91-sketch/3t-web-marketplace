# 01. Sản phẩm, phạm vi và nghiệp vụ

## 1. Mục tiêu và người dùng

Tên làm việc: **3T Web Marketplace**. Một nơi để 3T đưa các website/landing page đã làm lên, dùng lại bộ tài nguyên đó cho demo, bán bộ cài và triển khai hosting. CTV được lấy danh mục qua API để bán cho khách của mình. Giao diện và nội dung hỗ trợ nhiều ngôn ngữ.

| Vai trò | Công việc | Giới hạn dữ liệu |
|---|---|---|
| Khách vãng lai | Tìm mẫu, xem giá, xem demo công khai | Chỉ dữ liệu đã công bố |
| Khách đã đăng nhập | Thử quản trị, mua, tải, quản lý website | Chỉ tài khoản/website của mình |
| Quản trị viên website khách | Sửa nội dung của website được mời | Không quản lý giao dịch nền tảng |
| CTV | Lấy danh mục, tạo checkout, xem đơn giới thiệu và hoa hồng | Không nhận source chỉ vì có API key |
| Biên tập mẫu | Nhập tài nguyên, mô tả, bản dịch, giá nháp | Không hoàn tiền hoặc sửa khóa thanh toán |
| Kế toán | Đối soát, hoàn tiền theo quyền, hoa hồng, chi trả | Không đọc secrets hạ tầng |
| Vận hành | Build, demo, hosting, domain, backup | Không tự tạo giao dịch thanh toán |
| Hỗ trợ | Ticket, trạng thái đơn/site đã được phân công | Không đăng nhập giả khách âm thầm |
| Chủ nền tảng | Quản lý quyền, chính sách, tích hợp | MFA và nhật ký cho thao tác nhạy cảm |

Một người có thể có nhiều vai trò, nhưng kiểm tra từng quyền ở API. Tư cách CTV không tự cấp quyền quản trị khách. Mời quản trị site phải do chủ site chấp nhận và thu hồi được.

## 2. Yêu cầu bắt buộc có mã theo dõi

| Mã | Yêu cầu | Kết quả phải quan sát được |
|---|---|---|
| REQ-01 | Cửa hàng mẫu | Tìm/lọc, trang chi tiết, tính năng và giá rõ |
| REQ-02 | Nhập mẫu ZIP | Upload, tiến trình, lỗi có vị trí, không mất source |
| REQ-03 | Nhập mẫu GitHub | Chọn repo/ref/path, ghim commit, chống webhook lặp |
| REQ-04 | Nhận diện adapter | Có kết quả nhận diện, độ chắc chắn và trường còn thiếu |
| REQ-05 | Chuẩn manifest | File có version, schema, adapter, demo, export, locale |
| REQ-06 | Build cách ly | Source không truy cập control plane, secrets hoặc host socket |
| REQ-07 | Demo công khai | URL dùng được, responsive, cảnh báo mô phỏng |
| REQ-08 | Demo quản trị riêng | Dữ liệu mỗi phiên riêng, có TTL và dọn dẹp |
| REQ-09 | Tài khoản | Xác minh, đăng nhập, quên mật khẩu, quản lý phiên |
| REQ-10 | Đơn và thanh toán | Backend tính tiền, xác minh giao dịch, đối soát |
| REQ-11 | Cấp quyền | Chưa trả tiền không tải/chạy site trả phí |
| REQ-12 | Bộ cài tự triển khai | ZIP hoàn chỉnh, hướng dẫn và setup an toàn |
| REQ-13 | Hosting của 3T | Tạo site theo quyền, dữ liệu/tệp riêng |
| REQ-14 | Tên miền | Subdomain hoặc DNS riêng, xác minh, HTTPS |
| REQ-15 | Gia hạn | Nhắc hạn, grace, suspend, giữ/xóa dữ liệu có lịch |
| REQ-16 | Quản trị mẫu và phiên bản | Nháp, duyệt, phát hành, quay lại phiên bản |
| REQ-17 | Quản trị nền tảng | Đơn, khách, tác vụ, trạng thái, ticket, nhật ký |
| REQ-18 | Quản trị website | Theo capability, không hiện chức năng không được cung cấp |
| REQ-19 | CTV API | Catalog, demo link, checkout, trạng thái đơn của CTV |
| REQ-20 | Hoa hồng | Sổ phát sinh, giữ chờ, đủ điều kiện, chi trả, đảo hoàn tiền |
| REQ-21 | Partner keys/webhook | Scope, giới hạn, luân chuyển, thu hồi, chữ ký |
| REQ-22 | Đa ngôn ngữ | UI, nội dung, mail, validation và SEO VI/EN |
| REQ-23 | SQL qua API | Không đưa credential SQL xuống trình duyệt |
| REQ-24 | Sao lưu/khôi phục | Khôi phục được SQL, tệp và cấu hình phù hợp |
| REQ-25 | GitHub nhiều máy | Clone, lockfile, env mẫu, trạng thái và CI |
| REQ-26 | Khả năng truy cập | Bàn phím, focus, nhãn, contrast, responsive |
| REQ-27 | Tính nhất quán | Idempotency, optimistic locking, transaction/outbox |
| REQ-28 | Quan sát hệ thống | Correlation ID, logs sạch secrets, cảnh báo tác vụ |
| REQ-29 | Xuất/chuyển dữ liệu | Phân biệt export dữ liệu và quyền nhận source |
| REQ-30 | Quyền nội dung/tài nguyên | Chỉ phát hành asset/font/code có quyền phân phối phù hợp |

## 3. Sản phẩm và quyền lợi

| Thuộc tính | Tự triển khai | Hosting |
|---|---|---|
| Thu phí | Một lần cho mẫu/quyền đã chốt | Phí mẫu hoặc khởi tạo + phí chu kỳ |
| Bàn giao | Source + build/package + hướng dẫn + migration | Site được tạo sẵn, quyền quản trị |
| Máy chủ | Khách tự cấp VPS và DNS | 3T cấp tài nguyên theo gói |
| Thời hạn | Quyền chạy đã mua không hết theo hạn hỗ trợ | Theo ngày hết hạn hosting |
| Nâng cấp | Theo quyền tải cập nhật, khách tự thực hiện | Theo lịch vận hành, có backup và kiểm tra |
| Dữ liệu | Khách tự vận hành | 3T sao lưu theo gói |
| Tải source | Có nếu gói nêu rõ | Không tự bao gồm; có gói chuyển đổi riêng |
| Ngừng thu tiền | Không có cơ chế phá site đã giao | Theo chính sách quá hạn đã công bố |

Một gói mua ứng với một site mặc định; số instance được cấu hình. Domain phụ/alias của cùng site không tính thành site mới. Không dùng số domain để giả định số lần triển khai mã nguồn đã tải. Khi đã giao source, không thể bảo đảm chống sao chép bằng kỹ thuật tuyệt đối.

Checkout v1 chọn một mẫu và một kiểu triển khai mỗi đơn để giảm lỗi kích hoạt; data model vẫn có order_items để mở rộng giỏ hàng. Với hosting, hiển thị tách phí một lần, phí kỳ đầu, chu kỳ, ngày gia hạn và giá kỳ sau. Không tự bật gia hạn thu tiền định kỳ khi chưa có sự chấp thuận tương ứng.

## 4. Hành trình chính

### 4.1 Chủ nền tảng thêm mẫu

Chọn ZIP hoặc GitHub → kiểm tra gói → nhận diện → tự dùng cấu hình hợp lệ hoặc yêu cầu bổ sung → build → migrate/seed demo → kiểm tra route và ảnh → nhận URL demo → biên tập giá/bản dịch → công bố. Demo của bản nháp chỉ người có quyền xem; công bố sản phẩm mới bật demo công khai.

### 4.2 Khách mua tải về

Xem mẫu → xem demo → chọn gói → đăng nhập/xác minh → xác nhận điều khoản snapshot → trả tiền → đơn paid → entitlement active → cấp link tải ngắn hạn → tự setup trên VPS. Nếu thanh toán lặp, vẫn chỉ có một entitlement cho một dòng đơn.

### 4.3 Khách mua hosting

Mua → entitlement active → đặt tên site, locale, dữ liệu khởi tạo → reserve quota → provision → kiểm tra sức khỏe → có subdomain → sửa nội dung → tùy chọn domain riêng. DNS riêng chậm không làm mất site trên subdomain.

### 4.4 Khách đến từ CTV

CTV hiển thị mẫu từ API → khách xem demo → backend CTV tạo checkout session → khách tới checkout nền tảng → xác minh tài khoản người mua → thanh toán → cấp quyền cho người mua → sổ hoa hồng ghi theo partner → CTV nhận webhook tối thiểu. CTV không nhận mật khẩu quản trị của người mua.

### 4.5 Cập nhật phiên bản

Nhập source mới → tạo version mới bất biến → demo mới → QA → phát hành → khách đủ điều kiện thấy cập nhật. Site đang chạy không tự đổi version chỉ vì có commit mới; update site là tác vụ độc lập có backup, migration và kiểm tra.

## 5. Quyết định mặc định để dev có thể bắt đầu

| Mục | Mặc định đề xuất | Nơi cấu hình |
|---|---|---|
| Nhà cung cấp mẫu | Chỉ đội 3T được nhập source | Admin/RBAC |
| Nhà cung cấp thanh toán | Adapter, chọn một đơn vị ở mốc tích hợp | Secret backend + setting |
| Ngôn ngữ | `vi`, `en`; mặc định `vi` | Locale registry |
| Tiền | VND, số nguyên đơn vị đồng | Pricing/currency registry |
| Demo quản trị | 24 giờ, một phiên đang chạy/người/mẫu | Demo policy |
| Thử nhanh công khai | Bản demo chuẩn không được sửa | Catalog version |
| Upload source | 100 MiB nén, 500 MiB giải nén, 20.000 tệp | Import policy |
| Thời gian build | 10 phút/tác vụ | Adapter policy |
| Demo budget | 1 CPU, 512 MiB RAM cho node, 250 MiB upload | Runtime policy; đo để điều chỉnh |
| Hosting grace | 7 ngày | Plan snapshot |
| Giữ dữ liệu sau suspend | 30 ngày rồi lên lịch xóa có thông báo | Retention policy |
| Hoa hồng | Mức riêng theo plan, mặc định 0 nếu chưa cấu hình | Commission policy |
| Chờ đủ điều kiện hoa hồng | 14 ngày sau settlement, chặn khi dispute | Commission policy |
| CTV thu tiền | Nền tảng thu trực tiếp | Checkout adapter |

Các giá trị là đề xuất vận hành để triển khai; chủ dự án có thể thay mà không sửa mã nguồn. Các hành động phát sinh tiền thực, tài nguyên cloud trả phí và chi trả hoa hồng phải được người có thẩm quyền cấu hình/duyệt theo quy trình của doanh nghiệp.

## 6. Ngoài phạm vi bản đầu

- Marketplace cho bất kỳ người ngoài tự upload code chưa duyệt; cần mô hình sandbox mạnh và quy trình nhà cung cấp riêng.
- Tự hiểu mọi framework, tự sinh backend từ ảnh hoặc tự sửa tất cả source lỗi.
- CTV tự thu tiền rồi gửi API “đã thanh toán”; muốn mô hình đó phải có hợp đồng, hạn mức công nợ/tiền nạp và sổ đối soát riêng.
- Trình kéo thả như các nền tảng no-code đầy đủ. Bản đầu sửa nội dung theo block/schema do mẫu cung cấp.
- Tự dịch và xuất bản mọi nội dung bằng AI; có thể thêm dịch nháp sau.
- Cam kết tài nguyên không giới hạn, chống sao chép tuyệt đối hoặc tự đáp ứng mọi quy định pháp lý.

## 7. Chất lượng bắt buộc

Không mất quyền vì lỗi tạo site; không dùng cookie trình duyệt làm bằng chứng thanh toán; không chia sẻ DB giữa demo và production; không công bố bản import chưa pass kiểm tra; không hiển thị demo có khả năng gửi email/thu tiền thật. Bản phát hành được coi là hoàn chỉnh khi mọi REQ bắt buộc có bằng chứng nghiệm thu trong tài liệu 10.
