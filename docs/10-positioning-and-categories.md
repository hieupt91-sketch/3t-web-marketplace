# Định hướng và danh mục của Web Marketplace

## Định hướng

Web Marketplace là sàn mẫu website cho khách nhỏ: **mua là dùng được ngay**.
Một sản phẩm chỉ được bán làm mẫu khi khách xem demo là hiểu ngay, mua xong
là giao ngay, và chạy được mà không cần sửa code. Thứ gì phải sửa code theo
từng khách thì không phải mẫu, mà là dự án.

## Ba tầng sản phẩm

1. **Mẫu tĩnh — bán ngay, giao ngay.** Landing page, web giới thiệu, web
   tĩnh các loại. Tải về là chạy trên mọi hosting tĩnh. Đây là tầng tạo ra
   lượng hàng và lượng đơn đều nhất, làm dày trước.
2. **Mẫu chạy máy chủ — bán mẫu, giao kèm hosting của sàn làm mặc định.**
   Web tin tức có quản trị, shop nhỏ dạng mẫu chuẩn, web chạy Next hoặc
   Node nhưng tính năng đã đóng gói sẵn. Khách không rành kỹ thuật dùng gói
   hosting của sàn; khách đủ khả năng mới chọn gói tự triển khai.
3. **Dự án — không bán qua sàn mẫu.** Web lớn, nghiệp vụ riêng, tích hợp
   hệ thống khác, chuyển dữ liệu cũ, yêu cầu chịu tải cao, và mọi nền tảng
   ngoài 4 adapter của sàn (WordPress, Java, PHP, Python, Ruby). Bán theo
   kiểu tư vấn, báo giá riêng, làm theo giai đoạn rồi bàn giao. Dạng dự án
   nào lặp lại nhiều lần và chuẩn hóa được thì tách ra thành mẫu sau.

## Tiêu chí duyệt một mẫu

- Xem demo được ngay, không cần tài khoản hay cấu hình trước.
- Chạy được bằng một lệnh triển khai duy nhất: upload thư mục `site` với
  mẫu tĩnh, `docker compose up -d --build` với mẫu chạy máy chủ.
- Có file `template.manifest.json` khai đủ tên, mô tả, ngôn ngữ, tính năng,
  cổng chạy, database và môi trường (với mẫu chạy máy chủ).
- Thuộc đúng một danh mục dưới đây, gán bằng PATCH /admin/templates/:id.
- Không hứa hẹn tính năng ngoài những gì demo thể hiện.

## Danh mục (một tầng dưới gốc `website`)

Mã danh mục là định danh ổn định, nhãn hiển thị lấy từ i18n
`ui.category.<code>`. Lọc theo danh mục cha sẽ bao gồm cả danh mục con
(nếu sau này thêm tầng con), nhưng hiện tại sàn giữ đúng một tầng để bộ
lọc luôn rõ ràng.

| Mã | Tên | Gồm những gì | Khách điển hình | Dạng chạy chủ yếu |
| --- | --- | --- | --- | --- |
| `landing` | Trang landing | Bán hàng, giới thiệu sản phẩm, SaaS, sự kiện | Người chạy quảng cáo, chủ shop nhỏ | Tĩnh |
| `business` | Doanh nghiệp & Dịch vụ | Giới thiệu công ty, văn phòng, xưởng, agency | Công ty nhỏ, đơn vị dịch vụ | Tĩnh |
| `food` | Ẩm thực | Nhà hàng, quán ăn, cafe, trà sữa | Chủ quán ăn, chuỗi nhỏ | Tĩnh |
| `realestate` | Bất động sản | Bán, cho thuê, môi giới, dự án | Môi giới, sàn nhỏ | Tĩnh, có thể chạy máy chủ khi có lọc phức tạp |
| `store` | Cửa hàng online | Thời trang, mỹ phẩm, shop nhỏ | Chủ shop | Tĩnh phần xem hàng, chạy máy chủ khi có giỏ hàng và đơn hàng |
| `beauty` | Làm đẹp & Sức khỏe | Spa, salon, phòng khám, nha khoa | Chủ spa, phòng khám | Tĩnh |
| `blog` | Tin tức & Blog | Tin tức, blog cá nhân | Tòa soạn nhỏ, blogger | Tĩnh phần đọc, chạy máy chủ khi có quản trị đăng bài |
| `portfolio` | Portfolio | Cá nhân, nhiếp ảnh, thiết kế | Freelancer, studio | Tĩnh |

## Quy tắc giữ danh mục rõ ràng

- Không tạo danh mục mới chỉ vì một mẫu lẻ. Một danh mục chỉ tồn tại khi
  có ít nhất vài mẫu cùng nhóm khách và cùng nhu cầu.
- Không gán một mẫu vào hai danh mục. Nếu một mẫu vừa bán hàng vừa giới
  thiệu công ty thì chọn theo nhu cầu chính của khách mua nó.
- Danh mục không có mẫu vẫn hiện trong bộ lọc; vì vậy khi thêm danh mục
  mới phải có kế hoạch đưa mẫu vào ngay, không để danh mục trống lâu.
- Đổi tên hiển thị thì sửa nhãn i18n, không đổi mã, vì mã đã gắn với mẫu
  và bộ lọc.
