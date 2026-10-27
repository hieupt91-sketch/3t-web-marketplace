# Quy trình chuẩn vận hành Web Marketplace

Tài liệu này ghi lại các quy trình chuẩn của sàn, dành cho người vận hành.
Mọi con số về giá, hoa hồng, thời gian giữ tiền và mức chi trả tối thiểu đều
do chủ sàn cấu hình trong trang quản trị, tài liệu này không chốt con số nào.

## 1. Quy trình mua của khách

1. Khách xem danh mục, dùng bộ lọc và xem demo trước khi mua. Demo là bản
   chạy thật trên tên miền riêng; biểu mẫu, thanh toán và email trong demo
   chỉ là mô phỏng.
2. Khách chọn gói ở trang chi tiết hoặc trang chọn gói. Hệ thống hiện yêu
   cầu hosting của mẫu trước khi đặt hàng (mẫu tĩnh chạy được trên mọi
   hosting tĩnh, mẫu chạy máy chủ cần Node.js 22 hoặc Docker).
3. Hệ thống tạo báo giá từ giá hiện hành của gói. Báo giá giữ nguyên giá
   trong thời gian hiệu lực, kể cả khi giá gói thay đổi sau đó.
4. Khách đồng ý điều khoản, đặt hàng và thanh toán. Đơn chỉ được xử lý sau
   khi thanh toán được xác nhận.
5. Bàn giao theo gói: gói tự triển khai cho phép tải gói về, gói hosting
   được sàn triển khai thành site cho khách.

## 2. Quy trình tải về và tự triển khai

1. Khách vào mục đơn mua, xin link tải gói. Link chỉ dùng được một lần và
   hết hạn sau một thời gian ngắn; hết hạn thì xin link mới từ cùng trang.
2. Hệ thống đóng gói đúng theo mẫu và gói đã mua, khách không chọn loại gói
   tải về lúc tải:
   - Mẫu tĩnh: thư mục `site` + README + manifest + CHECKSUMS. Upload file
     trong `site` lên bất kỳ hosting tĩnh nào là chạy.
   - Mẫu chạy máy chủ: thư mục `app` + Dockerfile + docker-compose.yml +
     .env.example + README. Chạy bằng `docker compose up -d --build` sau
     khi điền `.env`; mẫu dùng PostgreSQL có thêm service database, mẫu
     dùng SQLite giữ dữ liệu trong volume.
3. Cập nhật lên phiên bản mới: tải gói mới, thay thư mục `app` (hoặc `site`),
   giữ nguyên `.env` và dữ liệu, chạy lại lệnh triển khai.
4. Gói tải về không chứa secret, database hay backend quản trị của sàn.

## 3. Quy trình hosting của sàn

1. Khách mua gói hosting, sàn triển khai mẫu thành site cho khách.
2. Khách quản lý site trong tài khoản: khởi động lại, gắn tên miền, tạo bản
   sao lưu, cập nhật phiên bản mẫu, quản lý thành viên, xuất hoặc xóa dữ
   liệu site.
3. Gia hạn được xử lý đúng một lần cho mỗi kỳ. Hết hạn thì site đi qua vòng
   đời gia hạn, tạm ngưng rồi xóa theo cấu hình của gói.
4. Sao lưu: sao lưu database bằng pg_dump và sao lưu volume dữ liệu dùng
   chung; khôi phục bằng cách dừng service app, nạp lại bản sao lưu rồi
   khởi động lại (xem `deploy/README.md`).

## 4. Quy trình nhập và xuất bản mẫu (quản trị)

1. Quản trị viên nhập mẫu bằng file ZIP hoặc từ GitHub.
2. Hệ thống giải nén trong giới hạn, quét secret, nhận diện adapter và ghi
   rõ các ứng viên phát hiện cùng tín hiệu; mẫu chưa đủ thông tin dừng ở
   trạng thái chờ cấu hình, không tự đoán tiếp.
3. Hệ thống build trong môi trường tách biệt, chạy kiểm tra đầu ra rồi ghi
   demo cho nhân sự xem trước và chụp màn hình.
4. Xuất bản chỉ khi mọi cổng kiểm tra đều đạt. Sau khi xuất bản, mẫu hiện
   trong danh mục, demo công khai (với mẫu tĩnh) hoặc phiên demo có thời
   hạn (với mẫu chạy máy chủ).
5. Ảnh xem trước trên thẻ mẫu là ảnh thật của mẫu; khi chưa có ảnh thật,
   thẻ hiện nền gradient với tên mẫu, không dùng ảnh giả làm ảnh thật.

## 5. Quy trình đối tác

1. Đối tác gửi đơn đăng ký, sàn xét duyệt rồi cấp khóa API và liên kết giới
   thiệu trong cổng đối tác.
2. Đối tác bán qua liên kết hoặc API danh mục. Sàn là bên thu tiền và xử lý
   bàn giao, đối tác không tự thu tiền của khách.
3. Sàn giữ tiền theo thời gian giữ của chính sách đang áp dụng rồi chi trả
   hoa hồng. Chính sách áp dụng cho một đơn là chính sách được ghi nhận tại
   thời điểm đơn phát sinh; đơn cũ giữ nguyên ảnh chụp chính sách của nó.
4. Đối tác theo dõi đơn, hoa hồng và lịch sử chi trả trong cổng đối tác.

## 6. Quy trình hỗ trợ, hoàn tiền và liên hệ

1. Khách gửi yêu cầu qua form liên hệ hoặc mở ticket trong tài khoản.
   Hệ thống trả lời chung chung cho form liên hệ để không lộ thông tin đơn
   của người khác.
2. Nút liên hệ nổi luôn hiện trên mọi trang: số điện thoại, Zalo, Messenger
   (khi đã cấu hình) và form liên hệ. Kênh liên hệ do chủ sàn cấu hình ở
   trang quản trị, không bịa số hay kênh.
3. Yêu cầu hoàn tiền gửi qua hỗ trợ và xử lý theo chính sách hoàn tiền áp
   dụng cho gói và phương thức thanh toán của đơn.
4. Giá và chính sách bán do chủ sàn tự cấu hình ở trang quản trị; khi đổi
   giá, danh mục và báo giá mới tự cập nhật ngay, đơn và báo giá đã tạo
   giữ nguyên giá cũ.
