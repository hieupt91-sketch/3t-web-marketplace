# 12. Đề xuất UI/UX và phân bổ chức năng Webmaket

Ngày: 30/10/2026. Trạng thái: **đề xuất để thiết kế và triển khai**, chưa phải chức năng đã hoàn thành. Phạm vi: toàn bộ cửa hàng, mua hàng, bàn giao, hosting landing page/subdomain, tài khoản khách, quản trị nội dung, vận hành và cộng tác viên.

## 1. Mục tiêu và cách dùng

Giúp người không biết code chọn đúng website, hiểu tổng chi phí, mua, nhận website và tiếp tục quản lý mà không phải đọc tài liệu hạ tầng. Người có kỹ thuật vẫn có đường tải bộ cài và tự triển khai riêng.

**Không đưa mọi tính năng lên trang chủ.** Trang chủ làm nhiệm vụ giới thiệu, gợi ý mẫu và điều hướng. Nghiệp vụ chuyên sâu có trang riêng, dữ liệu riêng và quyền riêng. Một khách mua landing page không cần nhìn thấy API key, Docker, hàng đợi, sổ hoa hồng hoặc bảng quản trị nền tảng.

Đọc cùng [đặc tả UI/UX gốc](05-ui-ux.md), [nghiệp vụ](01-san-pham-va-nghiep-vu.md), [kiến trúc](02-kien-truc-va-sql.md), [API](04-api.md) và [nghiệm thu](10-backlog-va-nghiem-thu.md). Tài liệu này bổ sung cách bố trí và chia chức năng; không tự thay quyền, invariant thanh toán hay phạm vi phát hành đầy đủ trong đặc tả gốc. Route mới bên dưới là đề xuất; dev phải kiểm tra route thực tế, cập nhật OpenAPI khi cần và giữ mapping các mã màn hình gốc.

### Cơ sở quan sát và giới hạn

Đợt kiểm tra công khai ngày 29/10/2026 đọc HTTP/HTML/API và mã client phân phối: danh mục có 97 mẫu (96 static, một Node); 96 URL demo tĩnh trả HTML thành công; 97 metadata mẫu chỉ có gói mua selfhost; bộ lọc hosted trả rỗng. Mẫu động nhà hàng chưa có demo công khai. Trang chủ hứa không sửa code trong khi bài hướng dẫn yêu cầu sửa HTML. Đây là ảnh chụp trạng thái tại thời điểm kiểm tra, cần kiểm tra lại trước triển khai.

Chưa có kiểm thử tương tác bằng trình duyệt, thanh toán thành công, tải bộ cài thương mại hay provision site. Do đó các đề xuất hình thức là định hướng thiết kế, không phải kết luận đã đo màu sắc, responsive, hiệu năng hoặc hoàn tất hành trình thực tế. Không đưa số lượng mẫu quan sát được vào nội dung marketing cố định.

### Nhóm người dùng

| Nhóm | Việc chính | Đường đi mặc định |
|---|---|---|
| Chủ shop, spa, quán ăn không biết code | Có trang giới thiệu và nhận liên hệ | Chọn mẫu → 3T triển khai → nhập/gửi nội dung → subdomain → xuất bản |
| Khách có kỹ thuật | Mua mẫu và tự vận hành | Xem yêu cầu → mua gói tải về → tải → cài theo hướng dẫn đúng adapter |
| Khách đã mua | Sửa nội dung, xem đơn, gia hạn | Đăng nhập → Website của tôi / Gói đã mua |
| Nhân sự biên tập site | Chỉnh nội dung được giao | Website → Nội dung; không vào thanh toán hoặc hạ tầng |
| CTV giới thiệu bán hàng | Tạo link, theo dõi đơn và hoa hồng | Cổng CTV riêng |
| Nhân sự 3T | Quản lý mẫu, đơn và vận hành theo quyền | Quản trị riêng; tác vụ nhạy cảm có audit |

## 2. Sơ đồ thông tin: chức năng ở đúng khu vực

```text
CÔNG KHAI
├── Trang chủ: giới thiệu, tìm nhanh, mẫu nổi bật, ba bước, liên kết gói
├── Thư viện mẫu: tìm/lọc/sắp xếp/lưu/so sánh
│   └── Chi tiết mẫu → Demo → Chọn gói
├── Gói dịch vụ: tải bộ cài / 3T triển khai, bảng phí và trách nhiệm
├── Cách hoạt động: hành trình theo loại khách
├── Trợ giúp: tìm bài → hướng dẫn đúng mẫu/gói
└── Liên hệ, điều khoản, bảo mật, chính sách hosting/hoàn tiền

MUA HÀNG
└── Cấu hình gói → Tài khoản → Kiểm tra đơn → Thanh toán → Kết quả
    ├── Tải bộ cài → Trợ lý tự triển khai
    └── Khởi tạo website → Nội dung → Subdomain/tên miền → Xem trước → Xuất bản

TÀI KHOẢN KHÁCH
├── Tổng quan và việc cần làm
├── Website của tôi → Tổng quan / Nội dung / Media / Tên miền
│                    / Gói & gia hạn / Sao lưu / Dữ liệu / Thành viên
├── Gói đã mua & tải xuống
├── Đơn hàng & chứng từ
├── Mẫu đã lưu
├── Hỗ trợ & thông báo
└── Hồ sơ & bảo mật

KHU VỰC NGHIỆP VỤ RIÊNG
├── Quản trị 3T: mẫu, nhập/build, đơn, quyền mua, site, hỗ trợ, vận hành
└── Cổng CTV: link giới thiệu, danh mục, đơn, hoa hồng, API/webhook
```

### Điều hướng

| Vị trí | Mục đề xuất | Quy tắc |
|---|---|---|
| Header công khai desktop | Logo, Mẫu website, Gói dịch vụ, Cách hoạt động, Trợ giúp, ngôn ngữ, tài khoản | CTV đặt trong menu/footer; không tranh vị trí với đường mua |
| Header mobile | Logo, menu, biểu tượng tài khoản có nhãn truy cập | Drawer có đóng, focus trap, trở về phần tử mở khi đóng |
| Sidebar khách | Tổng quan, Website, Gói đã mua, Đơn hàng, Đã lưu, Hỗ trợ, Cài đặt | Nhóm website và mua hàng riêng; active state rõ |
| Menu trong một website | Tổng quan, Nội dung, Media, Tên miền, Gói, Sao lưu, Cài đặt | Tên website và nút đổi website luôn rõ, tránh sửa nhầm site |
| Sidebar admin | Nhóm theo vai trò và nhiệm vụ | Ẩn mục không có quyền; API vẫn kiểm quyền độc lập |
| Footer | Liên hệ đơn vị, hướng dẫn, chính sách, CTV | Trạng thái beta/mở bán khớp khả năng mua thực tế |

## 3. Trang chủ: giới thiệu và dẫn đường, không làm dashboard

Route `/:locale`, kế thừa màn hình cửa hàng gốc. Một lời hứa chính, một hành động chính: **Chọn mẫu website**. Chỉ quảng bá tự sửa nội dung hoặc xuất bản ngay nếu gói thực sự cung cấp.

### Bố cục từ trên xuống

| Khối | Nội dung | Hành động và đích đến |
|---|---|---|
| Hero | Tiêu đề lợi ích, một câu cách nhận web, ảnh một mẫu thực | Chọn mẫu → thư viện; Xem cách nhận website → hướng dẫn |
| Tìm nhanh | Một ô ngành/từ khóa, ví dụ ngắn | Enter → thư viện có query; không mở checkout trực tiếp |
| Chọn ngành | Tối đa tám nhóm dễ hiểu và ảnh đại diện | Ngành → thư viện đã lọc |
| Mẫu nổi bật | Khoảng sáu mẫu đã duyệt, giá từ, nhãn quản trị | Demo hoặc chi tiết; xem thêm → thư viện |
| Ba bước | Chọn mẫu → thay nội dung → nhận website; tùy đường bàn giao | Đọc chi tiết → Cách hoạt động |
| Hai cách nhận web | 3T triển khai giúp / tải về tự triển khai, tóm tắt ai làm gì | So sánh gói → trang gói dịch vụ |
| Minh chứng | Website khách thật có phép hoặc ví dụ ghi nhãn rõ | Xem trường hợp cụ thể; không bịa lượt mua/đánh giá |
| FAQ trước mua | Bốn đến sáu câu về chỉnh nội dung, form, phí và hỗ trợ | Xem trợ giúp đầy đủ |
| Tư vấn | Một lời mời khi chưa chọn được | Form tư vấn có ngữ cảnh; không được coi là đơn hàng |

Gợi ý lời giới thiệu khi hosted đã sẵn sàng: “Landing page cho công việc của bạn” và “Chọn mẫu, thay thông tin và xuất bản tại tenban.webmaket.com”. Nếu 3T chỉnh nội dung thủ công, đổi thành “Gửi nội dung, 3T thiết lập và bàn giao theo gói”; không hứa tự động.

### Không đưa lên trang chủ

- Form thanh toán, chọn nhà cung cấp VPS, cấu hình DNS, nhập API key, upload source.
- Trình sửa nội dung, quản lý site, backup/restore, gia hạn chi tiết.
- Bảng giá đủ mọi trường hợp, hướng dẫn Node/Docker, tài liệu API CTV.
- Toàn bộ 97 mẫu hoặc danh mục dài không phân trang; số lượng thay đổi theo dữ liệu.
- Nhiều chatbot, nhiều thanh liên hệ cố định hoặc popup bán hàng cùng xuất hiện.

Nghiệm thu: người mới xác định được sản phẩm, hai cách nhận và bước tiếp theo; mọi khối dẫn tới đúng màn hình; trang không chứa nghiệp vụ tài khoản hoặc kỹ thuật cần đăng nhập.

## 4. Thư viện mẫu: tìm, lọc và so sánh

Route `/:locale/templates`. Desktop dùng bộ lọc bên trái và grid; mobile dùng ô tìm kiếm, chip bộ lọc đang áp dụng và nút mở bộ lọc. Tìm kiếm và phân trang lấy dữ liệu thật, không lọc riêng các thẻ đã tải rồi giả là toàn danh mục.

| Mã | Chức năng | Hành vi và điều kiện |
|---|---|---|
| CAT-01 | Tìm theo ngành/tên/nhu cầu | Hỗ trợ có dấu/không dấu; không hứa trợ lý AI nếu chỉ là tìm từ khóa |
| CAT-02 | Lọc cách nhận | Hosted chỉ hiện khi có gói bán hợp lệ; khác biệt capability hỗ trợ và gói hiện bán |
| CAT-03 | Lọc tính năng | Có quản trị, nhận form thật, đa ngôn ngữ, loại trang; không suy từ hình minh họa |
| CAT-04 | Lọc giá | Giá một lần và giá định kỳ có nhãn; min ≤ max, không âm |
| CAT-05 | Sắp xếp | Phù hợp, mới cập nhật, giá; “bán chạy” chỉ khi có dữ liệu đủ tin cậy |
| CAT-06 | Giữ bộ lọc | Query trên URL, reload/back giữ lựa chọn; tìm mới không âm thầm mất bộ lọc |
| CAT-07 | Thẻ mẫu chuẩn | Ảnh, tên, một câu ngắn, giá theo mode, có/không quản trị, demo/chi tiết |
| CAT-08 | Lưu mẫu | Khách vãng lai lưu cục bộ không nhạy cảm; đăng nhập có luồng hợp nhất rõ |
| CAT-09 | So sánh | Chọn tối đa ba mẫu; trang riêng, không nhét bảng vào trang chủ |
| CAT-10 | Không có kết quả | Nêu bộ lọc gây giới hạn, xóa từng chip hoặc xóa tất cả; gợi ý ngành liên quan |
| CAT-11 | Ảnh thiếu/demo thiếu | Fallback và nhãn thật; không để nút demo dẫn tới trang trống |
| CAT-12 | Phân trang | Đọc tiếp không lặp/bỏ mẫu; giữ điều kiện lọc; có thông báo đang tải/lỗi |

Trang so sánh đề xuất `/:locale/templates/compare`, bảng cùng tiêu chí: khách phù hợp, cách sửa, form, quản trị, ngôn ngữ, cách nhận, phí ban đầu, phí duy trì. Mobile xếp từng tiêu chí; không đổi ý nghĩa bảng.

## 5. Chi tiết mẫu: quyết định mua trước, kỹ thuật sau

Route `/:locale/templates/:slug`. Desktop hai cột: nội dung và thẻ gói tóm tắt; mobile một cột, nút chọn gói cố định chỉ xuất hiện khi không che nội dung hoặc bàn phím.

### Thứ tự nội dung

1. Tên, dành cho ai, ảnh/gallery, nút demo, giá và cách nhận.
2. Bảng chức năng hoạt động thật, giới hạn và cách sửa nội dung.
3. Gói mua, tổng chi phí dự kiến, phạm vi thiết lập và trách nhiệm.
4. Các trang/khối đi kèm, VI/EN, quyền dùng, hỗ trợ và cập nhật.
5. Ba bước sau mua đúng gói; FAQ của mẫu.
6. Yêu cầu tự triển khai và changelog trong vùng mở rộng.

| Mã | Chức năng | Yêu cầu |
|---|---|---|
| DET-01 | Gallery thực | Ảnh desktop/mobile của đúng phiên bản; xem ảnh không bị coi là demo hoạt động |
| DET-02 | Ma trận chức năng | Mỗi mục là “Có sẵn”, “Chỉ giao diện”, “Cần tích hợp”, hoặc “Không có” |
| DET-03 | Cách sửa | Sửa HTML / trình quản trị / gửi 3T; không gộp thành lời hứa không biết code |
| DET-04 | Form liên hệ | Nêu nơi nhận dữ liệu, chống spam và chi phí nếu có; mẫu form không là chức năng contact thật |
| DET-05 | Chọn cách nhận | Mô tả người phù hợp; gói ngừng bán có trạng thái, không chọn được |
| DET-06 | Chi phí minh bạch | Phí mẫu, thiết lập, kỳ đầu, chu kỳ tiếp, thuế/phí theo cấu hình; không cộng giá demo của ngành vào giá mẫu |
| DET-07 | Hỗ trợ/cập nhật | Số lần chỉnh nếu có, phạm vi, thời gian, quyền cập nhật; lấy từ policy đã công bố |
| DET-08 | Giấy phép | Số site, quyền dùng thương mại, quyền source; có source không đồng nghĩa được bán lại |
| DET-09 | Tư vấn đúng ngữ cảnh | Nhớ mẫu và nhu cầu; không gợi CMS như chức năng có sẵn khi chưa tích hợp |
| DET-10 | Mẫu đã ngừng bán | Giữ giải thích và link quyền mua cũ; không làm khách cũ mất khả năng tải |

**Bảng chức năng mẫu để designer dựng component:**

| Khả năng | Bộ file tĩnh | Mẫu có quản trị | Ghi chú hiển thị |
|---|---|---|---|
| Thay tên/điện thoại/ảnh | Sửa file hoặc dịch vụ chỉnh theo gói | Qua trường quản trị được hỗ trợ | Phụ thuộc từng mẫu, không áp mặc định |
| Form gửi thông tin thật | Chỉ có khi đã tích hợp | Chỉ có khi capability và endpoint thật | Hiển thị kênh nhận |
| Đăng bài | Không tự có | Có nếu mẫu hỗ trợ | Blog một trang có thể chỉ là nội dung mẫu |
| Giỏ hàng/thanh toán | Không tự có | Chỉ theo capability shop | Khác thanh toán mua mẫu của nền tảng |
| Hosting/subdomain | Theo gói bán đang bật | Theo gói bán đang bật | Không suy từ adapter |

## 6. Demo riêng: xem thử mà không mất đường mua

Route `/:locale/demo/:slug`; giữ origin demo tách nền tảng theo đặc tả gốc.

| Mã | Chức năng | Yêu cầu |
|---|---|---|
| DEM-01 | Khung xem demo | Tên mẫu, quay lại chi tiết, chọn gói, mở tab mới |
| DEM-02 | Kích thước xem | Desktop/tablet/mobile là mô phỏng khung; vẫn phải test thiết bị/trình duyệt thật |
| DEM-03 | Nhãn mô phỏng | Form/email/thanh toán demo không gửi thật; cảnh báo không che nội dung |
| DEM-04 | Đổi ngôn ngữ | Phân biệt ngôn ngữ giao diện sàn và nội dung mẫu; chỉ hiện locale có sẵn |
| DEM-05 | Demo quản trị | Phiên riêng, seed giả, TTL, reset; không lộ mật khẩu/quyền khách thật |
| DEM-06 | Không mở được | Có thử lại, chi tiết mẫu và hỗ trợ; không thông báo mua thành công |
| DEM-07 | Demo chưa có | Nêu rõ trạng thái; có ảnh/video thật nếu có; không dựng nút demo giả |

## 7. Gói dịch vụ và cách hoạt động là hai trang riêng

### Trang gói `/:locale/plans/compare`

So sánh theo **kết quả nhận được**, không theo tên máy chủ. Hai cột chính là “3T triển khai giúp” và “Tải về tự triển khai”. Nếu 3T nhận chỉnh nội dung thủ công, thể hiện như dịch vụ bổ sung có phí/quyền lợi rõ; không tự thêm loại entitlement mới khi chưa chốt nghiệp vụ.

| Nội dung bắt buộc | Cách trình bày |
|---|---|
| Ai đưa web lên mạng, ai vận hành | Câu ngắn theo từng gói |
| Sửa nội dung thế nào | Có quản trị hay cần chỉnh file/dịch vụ |
| Source và dữ liệu | Quyền tải source khác quyền xuất dữ liệu |
| Tên miền phụ | Ví dụ tenban.webmaket.com, phí/thời hạn/quy tắc đổi; không gọi là sở hữu tên miền gốc |
| Tên miền riêng | Tùy gói thực hỗ trợ, phí riêng nếu có |
| Giá | Tách một lần/kỳ đầu/kỳ sau; cấu hình thật, không chèn giá đề xuất thành giá đã duyệt |
| Hết hạn | Grace, tạm dừng, giữ/xóa dữ liệu, cách khôi phục theo policy |
| Hỗ trợ | Kênh, phạm vi và thời gian phản hồi đã cam kết |

Không mặc định một subdomain/site miễn phí vĩnh viễn. Không quảng bá số site không giới hạn khi chưa có quota và đo tài nguyên.

### Trang cách hoạt động `/:locale/how-it-works`

Đầu trang cho chọn “Tôi cần 3T làm giúp” hoặc “Tôi tự triển khai”. Mỗi đường có sơ đồ ngắn, ảnh hướng dẫn và nút tiếp theo. Hạ tầng nâng cao dẫn sang trợ giúp, không mở ra giữa bước mua.

## 8. Tài khoản và mua hàng: không để khách bắt đầu lại

Luồng cơ bản: chi tiết → cấu hình gói → đăng nhập/đăng ký nếu cần → kiểm tra đơn → thanh toán → bàn giao. Cho khách xem gói và yêu cầu trước khi bắt tạo tài khoản nếu kiến trúc cho phép; backend vẫn chỉ tạo đơn/quyền theo policy xác minh.

| Mã | Màn/chức năng | Quy tắc hành vi |
|---|---|---|
| BUY-01 | Đăng nhập | Giữ mẫu/gói/locale/CTV và đường quay lại nội bộ an toàn |
| BUY-02 | Đăng ký | Label đúng ID input; password manager; policy mật khẩu; liên kết điều khoản dễ mở |
| BUY-03 | Xác minh email | Gửi lại có giới hạn, giải thích hết hạn và bước tiếp theo; giữ ý định mua |
| BUY-04 | Quên mật khẩu | Không mất checkout; thông báo không tiết lộ tài khoản |
| BUY-05 | Cấu hình gói | Chọn cách nhận, chu kỳ, tùy chọn hợp lệ; backend xác nhận giá |
| BUY-06 | Báo giá/kiểm tra | Tên mẫu/version, quyền lợi, tổng, hạn quote, phí gia hạn, điều khoản áp dụng |
| BUY-07 | Đồng ý điều khoản | Snapshot phiên bản; gia hạn tự thu tiền cần chấp thuận riêng nếu triển khai |
| BUY-08 | Thanh toán | Chỉ phương thức thật đang bật; mã đơn, tiền, thời hạn rõ; chống bấm hai lần |
| BUY-09 | Chờ xác nhận | Đọc trạng thái máy chủ; reload an toàn; không lấy redirect trình duyệt làm bằng chứng paid |
| BUY-10 | Thất bại/hết hạn | Nêu khả năng kiểm tra lại, đổi phương thức hoặc hỗ trợ; không ép trả lần hai khi đang đối soát |
| BUY-11 | Thành công | Hiện quyền đã cấp và một nút tiếp theo đúng mode: tạo website hoặc tải bộ cài |
| BUY-12 | Paid nhưng bàn giao lỗi | Quyền mua còn nguyên, site/job có mã hỗ trợ và retry; không thu lại tiền |
| BUY-13 | Giữ tiến trình | Back/refresh/login không mất lựa chọn; không lưu mật khẩu/token hoặc dữ liệu thanh toán nhạy cảm trong draft |
| BUY-14 | Đơn từ CTV | Giữ attribution đúng policy; verified buyer sở hữu đơn, CTV không chọn chủ thay khách |

Checkout có bản tóm tắt mẫu xuyên suốt. Không yêu cầu nhập DNS, chọn Docker hoặc tạo tài khoản cloud để hoàn tất thanh toán gói hosted.

## 9. Trợ lý nhận và triển khai website: tách khỏi trang chủ

### 9.1. Luồng hosted đề xuất `/account/sites/new?entitlement=…`

Stepper tối đa năm bước có lưu nháp: **Thông tin → Nội dung → Địa chỉ → Xem trước → Xuất bản**. Nếu công việc dài, cho lưu và tiếp tục sau; nút Back giữ dữ liệu.

| Mã | Chức năng | Đặc tả |
|---|---|---|
| DEP-01 | Chọn quyền đã mua | Chỉ entitlement hợp lệ và còn slot; không tin entitlement ID từ URL |
| DEP-02 | Thông tin cơ bản | Tên site, ngành, locale, thông tin liên hệ; gợi ý ví dụ không chèn số demo vào site thật |
| DEP-03 | Thay nội dung | Biểu mẫu theo schema mẫu, ảnh/logo/dịch vụ; không cố sinh CMS cho mọi HTML |
| DEP-04 | Dịch vụ làm giúp | Nếu mẫu không có editor, thu nhận yêu cầu và báo trạng thái 3T xử lý, không giả tự động |
| DEP-05 | Chọn subdomain | Gợi ý slug, kiểm tra format/tên cấm/trùng bằng server; kiểm tra chưa đồng nghĩa đã giữ chỗ |
| DEP-06 | Giữ subdomain | Reservation có TTL/quyền; xử lý hai khách chọn cùng tên, giải thích khi hết giữ chỗ |
| DEP-07 | Xem trước riêng | Đúng dữ liệu nháp, không public trước publish; tránh index nháp |
| DEP-08 | Checklist xuất bản | Tên/điện thoại/email/link đúng, không nội dung demo chưa thay, form đúng mô tả, ảnh hợp lệ |
| DEP-09 | Xác nhận xuất bản | Hiện địa chỉ sẽ công khai, khả năng sửa sau đó và phí nếu có |
| DEP-10 | Tiến trình tạo site | Đang chờ/đang tạo/kiểm tra/đang bật HTTPS/sẵn sàng; tiến trình thật, không phần trăm giả |
| DEP-11 | Lỗi và tiếp tục | Thông báo dễ hiểu, mã hỗ trợ, retry idempotent; không tạo trùng site khi tải lại |
| DEP-12 | Bàn giao | Link HTTPS, nút mở web, cách sửa nội dung, gửi hỗ trợ, ngày gia hạn |

Nội dung schema chưa được mẫu hỗ trợ phải là dịch vụ tích hợp hoặc công việc chuẩn hóa mẫu trước; không quảng cáo DEP-03 như khả năng áp dụng ngay cho mọi ZIP.

### 9.2. Luồng tải bộ cài và tự triển khai

Route tải trong Gói đã mua. Hướng dẫn dựa trên adapter/version thực; không bắt khách lựa chọn một database/framework khác với thứ đã mua.

| Mã | Chức năng | Đặc tả |
|---|---|---|
| SELF-01 | Thông tin bộ cài | Mẫu/version, dung lượng, checksum, quyền cập nhật, yêu cầu hosting |
| SELF-02 | Bản sạch/bản demo | Có chỉ khi artifact thực cung cấp; mặc định gợi ý bản sạch để xuất bản |
| SELF-03 | Tải có quyền | Link ngắn hạn; hết hạn cấp lại sau authorize; người khác không dùng được |
| SELF-04 | Hướng dẫn static | Giải nén → thay nội dung → upload đúng thư mục → mở kiểm tra; ảnh minh họa thật |
| SELF-05 | Hướng dẫn Node | Runtime/Docker/env/DB/volume/HTTPS theo README đã test; chỉ hiện cho mẫu tương ứng |
| SELF-06 | Kiểm tra sau cài | URL mở được, ảnh, link, liên hệ, lưu dữ liệu nếu có; không tự nhận mọi form đã hoạt động |
| SELF-07 | Lịch sử tải/cập nhật | Phiên bản đã mua và phiên bản đủ quyền; không mất quyền chạy bản đã bàn giao |
| SELF-08 | Yêu cầu hỗ trợ | Đính mẫu/version/bước lỗi; cảnh báo không gửi mật khẩu, private key hoặc .env |

Không yêu cầu SSH credential của khách như bước bắt buộc. Nếu sau này có dịch vụ triển khai từ xa, phải thiết kế quyền truy cập ngắn hạn và quy trình riêng.

## 10. Dashboard khách: công việc sau mua nằm ở đây

### Tổng quan `/account`

Ưu tiên việc cần làm: đơn chờ xác nhận, website chưa xuất bản, domain cần xử lý, gói sắp hết hạn, ticket có trả lời. Không lấp dashboard bằng biểu đồ doanh thu giả hoặc chỉ số không liên quan khách mua web.

| Mã | Khu vực/chức năng | Dữ liệu và hành động |
|---|---|---|
| ACC-01 | Tổng quan | Việc cần làm và đường tiếp tục đúng resource |
| ACC-02 | Website của tôi | Ảnh/tên/URL/trạng thái/gói/hạn; tìm và chuyển site |
| ACC-03 | Gói đã mua | Quyền tải, version, cách nhận và slot còn lại |
| ACC-04 | Đơn hàng | Lọc trạng thái, chi tiết tiền, timeline thanh toán/bàn giao |
| ACC-05 | Chứng từ | Theo chính sách xuất chứng từ thật; không gọi bản tóm tắt là hóa đơn thuế khi chưa đáp ứng |
| ACC-06 | Đã lưu | Mẫu đã lưu/ngừng bán, so sánh và quay lại mua |
| ACC-07 | Thông báo | Giao dịch, xuất bản, hết hạn, hỗ trợ; đọc/chưa đọc và cài kênh |
| ACC-08 | Ticket | Tạo, phân loại, đính kèm, theo dõi; tự gắn mã đơn/site theo quyền |
| ACC-09 | Hồ sơ | Tên, locale, email và quy trình xác minh khi đổi |
| ACC-10 | Bảo mật | Phiên đăng nhập, đổi mật khẩu, MFA theo policy, đăng xuất phiên khác |
| ACC-11 | Thanh toán/gia hạn | Gói hiện tại, ngày tiếp theo, lịch sử, hành động rõ; không tự bật auto-charge |
| ACC-12 | Xuất dữ liệu | Phạm vi dữ liệu của khách, trạng thái xử lý, link có quyền và hạn |

### Chi tiết website `/account/sites/:id`

| Tab | Nội dung | Ranh giới |
|---|---|---|
| Tổng quan | URL, sức khỏe dễ hiểu, trạng thái, tác vụ gần đây | Chi tiết kỹ thuật chỉ cho vai trò phù hợp |
| Nội dung | Mở editor hoặc hướng dẫn đúng capability | Mẫu không CMS không hiện editor giả |
| Media | Upload/tối ưu/chọn ảnh, dung lượng còn lại | Không đọc ảnh tenant khác |
| Tên miền | Subdomain, domain riêng nếu hỗ trợ, HTTPS | Không cho đổi tên âm thầm gây mất URL |
| Gói & gia hạn | Phí, quota, hạn, grace, lịch sử | Đúng snapshot đã mua, báo thay đổi trước áp dụng |
| Sao lưu | Lịch sử, tạo, yêu cầu khôi phục | Restore xác nhận ghi đè và quyền; không chỉ nút trang trí |
| Thành viên | Mời, quyền, thu hồi | Chủ site chấp nhận; CTV không mặc định là thành viên |
| Dữ liệu & cài đặt | Export, thông tin site, tạm dừng/xóa theo quyền | Hành động xóa có thời hạn và tác động rõ |

## 11. Quản trị nội dung website: chỉ hiện chức năng mẫu có

Editor nằm trong ngữ cảnh website, không xuất hiện ở trang chủ sàn. Sidebar gọn: Nội dung, Dịch vụ/Sản phẩm nếu có, Ảnh, Liên hệ, Cài đặt.

| Mã | Chức năng | Yêu cầu |
|---|---|---|
| CMS-01 | Sửa theo trường | Tên, mô tả, liên hệ, dịch vụ, giá, giờ; schema/validation của mẫu |
| CMS-02 | Sắp xếp/ẩn khối | Chỉ các block được mẫu hỗ trợ; không hứa kéo thả toàn bộ như page builder |
| CMS-03 | Nháp và xuất bản | Tách lưu nháp với công khai; trạng thái đã lưu/thất bại rõ |
| CMS-04 | Xem trước | Dữ liệu nháp riêng, chọn mobile/desktop, quay lại không mất sửa |
| CMS-05 | Lịch sử phiên bản | Xem trước bản cũ, khôi phục theo quyền; giải quyết xung đột chỉnh đồng thời |
| CMS-06 | VI/EN nội dung | Tabs trạng thái thiếu/cũ; locale của sàn không tự dịch nội dung khách |
| CMS-07 | Thư viện ảnh | MIME/size/quota thật, alt, crop/tối ưu, tham chiếu đang dùng; xóa có cảnh báo |
| CMS-08 | SEO cơ bản | Title, description, social image, slug nếu mẫu có route; không cho sửa script tùy ý |
| CMS-09 | Hộp thư liên hệ | Chỉ khi form/backend thật; xem yêu cầu, đánh dấu xử lý, quyền PII |
| CMS-10 | Tích hợp liên hệ | Điện thoại, Zalo, email, social có kiểm URL; form service theo gói |
| CMS-11 | Nội dung mẫu còn sót | Nhắc trường chưa thay; không coi mọi số trong nội dung là lỗi |
| CMS-12 | Mất mạng/xung đột | Giữ draft không nhạy cảm, retry và thông báo revision; không ghi đè âm thầm |

Blog, sản phẩm, đơn hàng, tồn kho là module tùy capability. Không hiện menu trống hoặc tính năng mẫu chưa có, cũng không đưa tất cả module vào mọi landing page.

## 12. Subdomain, tên miền và hosting

Đây là khu vực trong từng website. Luồng subdomain mặc định đơn giản; DNS nâng cao chỉ mở khi khách chọn domain riêng.

| Mã | Chức năng | Yêu cầu nghiệm thu |
|---|---|---|
| HOST-01 | Địa chỉ hiện tại | Link đầy đủ, copy, HTTPS và domain chính có nhãn |
| HOST-02 | Đổi subdomain | Kiểm trùng/cấm, tác động URL, redirect nếu hỗ trợ, giới hạn đổi; giữ hostname khi suspend theo policy |
| HOST-03 | Gắn domain riêng | Kiểm format và quyền sở hữu; DNS trỏ đúng không thay xác minh sở hữu |
| HOST-04 | Hướng dẫn DNS | Copy từng host/type/value, không yêu cầu gửi mật khẩu tài khoản tên miền |
| HOST-05 | Trạng thái domain | Chờ xác minh, chờ DNS, cấp HTTPS, hoạt động, lỗi; hướng xử lý tương ứng |
| HOST-06 | Tháo/chuyển domain | Xác nhận, reverify khi gắn lại, tránh người khác chiếm domain cũ |
| HOST-07 | Quota | Dung lượng/media/instance theo gói; gần đầy có giải thích, không xóa dữ liệu để ép mua |
| HOST-08 | Gia hạn | Ngày hết hạn, phí, grace, tạm dừng, khôi phục sau trả tiền; chống cộng kỳ lặp |
| HOST-09 | Sao lưu/khôi phục | SQL + media nhất quán nếu có; kết quả drill thật, tiến trình và tác động rõ |
| HOST-10 | Cập nhật mẫu | Version mới, thay đổi, backup, lỗi và kế hoạch phục hồi; commit mới không tự đổi site |

Các tính năng vận hành nâng cao có thể mở theo giai đoạn; chức năng chưa có hiển thị “chưa hỗ trợ” hoặc ẩn theo gói, không mô phỏng thành công.

## 13. Trợ giúp và tư vấn: hướng dẫn theo nhiệm vụ

Route `/:locale/help` có ô tìm, nhóm bài và nút hỗ trợ. Đầu bài ghi dành cho gói/adapter nào, thời gian cập nhật; tránh nhắc “tất cả mẫu đều tĩnh”.

| Mã | Chức năng | Cách bố trí |
|---|---|---|
| HELP-01 | Chọn hành trình | Không biết code / tự triển khai / quản lý sau mua |
| HELP-02 | Tìm bài | Từ khóa và ngữ cảnh mẫu/gói; không lộ bài vận hành nội bộ |
| HELP-03 | Bài từng bước | Điều kiện trước, thao tác, ảnh thật, kết quả mong đợi, lỗi thường gặp |
| HELP-04 | Checklist cá nhân | Đánh dấu tiến trình; bước hoàn thành do người dùng khác trạng thái hệ thống xác nhận |
| HELP-05 | Trợ lý chung | Một điểm vào, nhớ trang/mẫu, giải thích dựa dữ liệu được công bố; không tự tạo đơn hoặc hứa chức năng |
| HELP-06 | Chuyển hỗ trợ | Kèm mẫu/site/đơn theo quyền; xin đồng ý trước gửi nội dung trao đổi |
| HELP-07 | Công cụ ảnh | Trang riêng /resize-tool.html hoặc route được chốt; preview/crop/dung lượng; lỗi file rõ |
| HELP-08 | Phản hồi bài | Hữu ích/chưa rõ và lý do tùy chọn; không ép nhập thông tin cá nhân |

Widget hỗ trợ chỉ một nút nổi trên mobile; mở bảng chọn gọi/Zalo/form. Không che CTA, banner cookie nếu có, bàn phím hoặc nội dung demo. Liên hệ không được gửi tự động chỉ vì người dùng mở widget.

## 14. Quản trị 3T: tách khỏi cửa hàng và phân quyền

Khu vực `/admin` tái sử dụng mapping màn gốc. Có bộ lọc, phân trang, timeline và audit; không cho nhân sự hỗ trợ sửa giá, tiền hoặc secret chỉ vì truy cập dashboard.

| Mã | Module | Chức năng chính |
|---|---|---|
| ADM-01 | Tổng quan tác nghiệp | Đơn paid chưa bàn giao, job lỗi, site có vấn đề; số liệu thật và link xử lý |
| ADM-02 | Danh mục mẫu | Thông tin VI/EN, ảnh, ngành, capability, trạng thái xuất bản |
| ADM-03 | Nhập/version | ZIP/Git, manifest, preview, lỗi file rõ, version immutable |
| ADM-04 | Kiểm duyệt | Demo, tài nguyên có quyền, giá/gói, bản dịch, readiness; chặn publish thiếu điều kiện |
| ADM-05 | Gói & giá | Selfhost/hosted, chu kỳ/quota/quyền lợi; sửa giá không đổi đơn cũ |
| ADM-06 | Đơn/thanh toán | Timeline, đối soát, trạng thái provider, hành động theo quyền |
| ADM-07 | Hoàn tiền | Lý do/tác động/quyền, xác nhận provider, đảo hoa hồng đúng thời điểm |
| ADM-08 | Quyền mua | Entitlement, downloads, slot; không sửa lịch sử giao dịch tùy ý |
| ADM-09 | Site/domain | Trạng thái, owner, quota, retry an toàn, DNS/HTTPS; không mở terminal tùy ý cho support |
| ADM-10 | Khách/quyền | Tài khoản, membership, khóa/mở theo policy; không đăng nhập giả khách âm thầm |
| ADM-11 | Hỗ trợ | Ticket, phân công, lịch sử và tài nguyên được cấp quyền |
| ADM-12 | Nội dung sàn | Homepage blocks, FAQ, hướng dẫn, chính sách có version và locale |
| ADM-13 | Vận hành | Job lease/retry/dead-letter, backup drill, cảnh báo; tách view kỹ thuật |
| ADM-14 | Tích hợp | Trạng thái payment/mail/storage, rotate secret có quyền, không đọc lại khóa |
| ADM-15 | Audit | Người thực hiện, thời gian, tài nguyên, thay đổi đã che dữ liệu nhạy cảm |
| ADM-16 | Xuất báo cáo | Theo quyền/phạm vi/ngày; không cho tải PII hàng loạt mặc định |

## 15. CTV: một cổng riêng, không trộn người bán mẫu với người giới thiệu

Trang công khai chỉ giới thiệu và đăng ký. Cổng sau duyệt có navigation riêng. Đội 3T nhập source theo đặc tả hiện tại; mở nhà cung cấp mẫu bên ngoài là quyết định khác, không ngầm cấp từ tư cách CTV.

| Mã | Chức năng | Quy tắc |
|---|---|---|
| PAR-01 | Đăng ký/trạng thái duyệt | Hồ sơ, điều khoản chương trình, thiếu thông tin/chờ/duyệt/từ chối |
| PAR-02 | Danh mục bán | Mẫu đang bán, giá/quyền thật, demo, locale |
| PAR-03 | Link giới thiệu | Tạo/copy/xem trước, campaign nếu hỗ trợ; không thay giá bằng query |
| PAR-04 | Đơn giới thiệu | Chỉ đơn thuộc CTV, PII tối thiểu, không có quyền sửa owner |
| PAR-05 | Hoa hồng | Chờ/đủ điều kiện/giữ/đã trả/đảo; policy snapshot, tiền không dùng float |
| PAR-06 | Chi trả | Số dư, khoản giữ, yêu cầu, trạng thái/chứng từ theo quy trình thật |
| PAR-07 | API key | Scope, hết hạn, tạo/copy một lần/rotate/revoke; không render lại secret |
| PAR-08 | Webhook | Endpoint, sự kiện, delivery/retry/chữ ký; cấu hình server có chặn SSRF |
| PAR-09 | Developer center | Ví dụ sandbox, lỗi và idempotency; không chèn credential thật vào snippet |
| PAR-10 | Hỗ trợ/chính sách | Hướng dẫn bán hàng, hoàn tiền/hoa hồng và ticket riêng |

Không quảng cáo mức hoa hồng khi chưa cấu hình/công bố. CTV không được tự gửi “đã thanh toán” để cấp website.

## 16. Design system, mobile và mọi trạng thái

Kế thừa token trong đặc tả gốc: nền sáng, chữ rõ, màu chính xanh, spacing theo scale, body khoảng 16px, thao tác chạm ít nhất 44px. Designer kiểm contrast thực tế WCAG 2.2 AA; không dùng màu đơn độc cho trạng thái.

| Thành phần | Đặc tả sử dụng |
|---|---|
| TemplateCard | Ảnh cùng tỷ lệ, tối đa hai CTA; giá theo mode/kỳ, mô tả ngắn, nhãn quản trị |
| PriceBreakdown | Một lần + kỳ đầu + kỳ sau; hiển thị tổng và khoản tùy chọn trước đặt đơn |
| FormField | Label/input dùng cùng ID, hint/error có aria-describedby; lỗi có tóm tắt và focus |
| Stepper | Bước hiện tại, quay lại giữ dữ liệu, lưu sau; trạng thái chưa hoàn thành dễ hiểu |
| JobTimeline | Trạng thái từ backend, mã hỗ trợ, retry; không spinner vô hạn |
| DomainStatus | Copy DNS riêng từng ô, hostname rõ; trạng thái HTTPS độc lập DNS |
| EmptyState | Chưa mua / chưa có site / lọc không thấy là ba thông điệp khác nhau |
| ConfirmDialog | Nêu tài nguyên/tác động, Cancel rõ; thao tác phá hủy không mặc định xác nhận |
| SupportWidget | Một điểm mở, tránh che nội dung; không tự gửi tin nhắn |
| DataTable | Responsive thành card hoặc cuộn vùng bảng có nhãn; không làm cả trang tràn ngang |

Mọi màn cần: loading, thành công, rỗng, lỗi dữ liệu, lỗi mạng/server, thiếu quyền, hết phiên và mobile. Màn ghi thêm saving, submit lặp, xung đột revision, draft chưa lưu. Retry nghiệp vụ tiền/provision dùng cùng định danh idempotency; không tự tạo giao dịch mới.

Kiểm tra ở 360/390/768/1440px, zoom 200%, chuỗi tiếng Anh dài, bàn phím và reduced motion. Header không che anchor; CTA không che footer/ô nhập; modal khóa focus và trả focus đúng. Không gắn mác đã accessibility pass chỉ vì có thuộc tính aria.

## 17. Dữ liệu và hợp đồng cần có để UI hoạt động thật

Tên sau mô tả nhu cầu dữ liệu, không tuyên bố endpoint mới đã tồn tại. Dev đối chiếu API gốc và chỉ bổ sung OpenAPI khi đã chốt.

| Khu vực | Dữ liệu tối thiểu | Quy tắc |
|---|---|---|
| Danh mục | Title/ảnh/locale/capability, mode có gói hiện bán, giá và kỳ | Không lấy modes hỗ trợ thay danh sách plans bán được |
| Chi tiết | Version, chức năng thực, cách chỉnh, quyền lợi/hạn chế | Snapshot theo version, bản dịch có trạng thái |
| Checkout | Quote ID, hạn, dòng tiền, currency, terms, attribution | Server tính giá và xác nhận paid |
| Bàn giao | Entitlement, slot, deployment ID, job và next action | Paid khác site ready; lỗi không xóa quyền |
| Editor | Schema capability, revision, draft/published | Authorize site từ membership, xử lý conflict |
| Hosting | Hostname ownership, DNS/TLS state, quota, kỳ hạn | Domain registry và tenant isolation |
| Trợ giúp | Bài theo locale/gói/adapter/version, ngày cập nhật | Không hướng dẫn chung sai loại mẫu |
| Analytics | Event ngữ nghĩa và mã lỗi đã làm sạch | Không gửi password, token, form contact hoặc PII vào analytics |

### Theo dõi hiệu quả

Đề xuất event: tìm mẫu, không có kết quả, mở chi tiết, mở demo, chọn gói, bắt đầu đăng ký, quay lại checkout, báo giá, thanh toán server xác nhận, bắt đầu triển khai, publish thành công, mở trợ giúp và gửi ticket. Event gửi ticket chỉ ghi sau hành động chủ động và phản hồi thành công.

Đo các tỷ lệ tìm → chi tiết → demo → chọn gói → paid → ready, thời gian đến URL hoạt động, lỗi theo bước và nhu cầu hỗ trợ. Tách người dùng test/sandbox; không gọi click nút mua là doanh thu. Mục tiêu chuyển đổi và thời gian chỉ chốt sau có baseline, không bịa phần trăm cải thiện.

## 18. Lộ trình: chia mốc thực hiện, không bỏ chức năng

| Mốc | Phạm vi | Kết quả cần thấy |
|---|---|---|
| Giai đoạn A — Làm rõ và sửa lỗi | Thống nhất lời hứa/giá/footer, hosted có hoặc ghi chưa bán, labels, giữ ý định mua, hướng dẫn đúng adapter | Khách hiểu thứ mua và không bị lạc qua tài khoản |
| Giai đoạn B — Mua và bàn giao cốt lõi | Thư viện/detail/demo, gói, sandbox payment, quyền tải, hosted/subdomain nếu bán | Một mẫu mua → tải/cài; một mẫu mua → site HTTPS có bằng chứng |
| Giai đoạn C — Tự phục vụ sau mua | Dashboard, editor theo schema, media, domain, hỗ trợ, renew và backup | Khách quản lý được website theo đúng gói |
| Giai đoạn D — Mở rộng trải nghiệm | Yêu thích/so sánh, thêm mẫu chuẩn hóa, CTV API/ledger, vận hành nâng cao | Không tăng tính năng bằng cách dồn vào homepage |

VI/EN, phân quyền, trạng thái lỗi và khả năng truy cập làm cùng từng mốc, không để thành sửa cuối. Các mốc này là thứ tự tổ chức UI và beta; phát hành hoàn chỉnh vẫn phải đạt phạm vi M1–M8 trong backlog gốc, bao gồm hosting/CTV và các gate kỹ thuật tương ứng.

## 19. Kịch bản nghiệm thu cụ thể cho designer/dev/QA

| Mã | Tình huống | Kết quả quan sát được |
|---|---|---|
| UX-01 | Chủ spa mới vào trang chủ | Hiểu sản phẩm và hai cách nhận; tìm được ngành mà không đọc hạ tầng |
| UX-02 | Tìm có dấu/không dấu, không thấy mẫu | Kết quả phù hợp, reset rõ, bộ lọc trên URL giữ đúng |
| UX-03 | Lọc hosting | Chỉ có mẫu có gói bán hosted; nếu chưa mở bán có giải thích, không giả hỗ trợ mua |
| UX-04 | So sánh mẫu tĩnh và có quản trị | Phân biệt cách sửa/form/thanh toán thực trước chọn gói |
| UX-05 | Xem demo mobile và quay lại | Không mất mẫu/gói, UI mô phỏng không thay kiểm thử mobile thật |
| UX-06 | Mẫu động chưa có demo | Có nhãn và đường khác, không nút dẫn lỗi |
| UX-07 | Khách mới đăng ký/xác minh giữa checkout | Trở lại đúng mẫu/gói/locale và attribution hợp lệ |
| UX-08 | Nhấp nhãn và dùng screen reader đăng ký | Focus đúng input, đọc đúng nhãn/hướng dẫn/lỗi |
| UX-09 | Quote hết hạn hoặc client sửa giá | Hệ thống yêu cầu báo giá hợp lệ; không thu sai/cấp quyền sai |
| UX-10 | Thanh toán sandbox lặp/đến muộn | Một quyền, một ứng dụng kỳ hạn; UI đối soát đúng |
| UX-11 | Paid nhưng provision lỗi | Quyền còn, retry cùng site, không trả tiền lại |
| UX-12 | Hai khách chọn cùng subdomain | Một reservation hợp lệ; người còn lại nhận gợi ý, không chiếm domain |
| UX-13 | Refresh khi tạo website | Thấy job/site cũ, không thêm site hoặc trừ slot lần hai |
| UX-14 | Tải bản sạch và cài static trên môi trường sạch | Đúng file/hướng dẫn, asset/link chạy, form đúng mô tả |
| UX-15 | Cài mẫu Node từ bộ cài thương mại | Runtime/DB/setup theo README, khởi động lại không mất dữ liệu |
| UX-16 | Sửa nội dung rồi mất mạng hoặc có xung đột | Giữ draft, báo lỗi, xử lý revision, không ghi đè âm thầm |
| UX-17 | Khách A đổi site/order ID sang B | Backend từ chối, không lộ nội dung/PII/media |
| UX-18 | Gia hạn đúng lúc hết hạn, callback lặp | Cộng kỳ một lần, không tạm dừng site đã gia hạn |
| UX-19 | Khôi phục backup | Đúng SQL/media và quyền, cảnh báo ghi đè, có evidence khôi phục |
| UX-20 | Mọi luồng VI/EN và bàn phím/mobile | Không raw key, tràn ngang hoặc widget che thao tác chính |
| UX-21 | Khách không có capability CMS/shop | Không hiện editor/giỏ hàng/đơn hàng giả |
| UX-22 | CTV theo dõi đơn của mình | Attribution/commission đúng, không chiếm tài khoản khách |
| UX-23 | Nhân sự hỗ trợ thử refund/sửa secret | Bị từ chối nếu thiếu quyền; hành động hợp lệ có audit |
| UX-24 | Người mới tự dùng sau bàn giao | Tìm được sửa nội dung, hỗ trợ và gia hạn, không cần vào admin nền tảng |

Mỗi kịch bản phải ghi commit, môi trường, gói/mẫu/version, dữ liệu giả lập, expected/actual, ảnh/video hoặc log đã làm sạch và người kiểm tra. Test UI này bổ sung, không thay 60 kịch bản nghiệp vụ gốc. Chưa có tài khoản test/provider sandbox/bộ cài thì ghi “chưa kiểm thử”, không ghi pass.

## 20. Bàn giao và quyết định cần chốt khi triển khai

Designer bàn giao sitemap, wireframe desktop/mobile từng khu vực, component trạng thái và prototype hai hành trình: khách không biết code dùng hosted; khách kỹ thuật tải về. Dev bàn giao route/API/quyền, dữ liệu seed và checklist theo các nhóm mã trong tài liệu. QA chạy staging với thanh toán sandbox, email test và domain test do dự án kiểm soát.

Các quyết định sản phẩm cần ghi rõ trước mở bán: giá và chu kỳ hosted/subdomain; phạm vi hỗ trợ/chỉnh nội dung; mẫu nào có editor; khả năng nhận form thật; quota/retention; quyền source; chính sách CTV. Có thể cấu hình khác nhau theo gói nhưng phải hiển thị nhất quán trước và sau mua.

Không sửa code production hoặc coi tài liệu này là phê duyệt giá/hạ tầng. Đích thiết kế là nhiều chức năng có nơi sử dụng rõ: **trang chủ giúp chọn đường, trang chi tiết giúp chọn đúng, checkout giúp mua, trợ lý bàn giao giúp xuất bản, dashboard giúp vận hành**.
