# 07. Đa ngôn ngữ, nội dung và SEO

## 1. Phạm vi bắt buộc

| Lớp | Nội dung phải dịch | Nơi lưu |
|---|---|---|
| UI nền tảng | Menu, button, validation, empty/error/status | Gói locale versioned trong repo |
| Catalog | Tên mẫu, mô tả, tính năng, SEO, hướng dẫn | SQL translation tables |
| Thương mại | Plan label, quyền lợi, điều khoản hiển thị | SQL phiên bản + snapshot order |
| Email/thông báo | Verify, paid, site ready, renewal, partner | Template theo locale, versioned |
| API CTV | Localized catalog + stable code | locale query/header, schema |
| Website khách | UI và nội dung theo khả năng của mẫu | Runtime locale packs + SQL của site |
| Quản trị | Nhãn nền tảng/site/CTV và form nội dung | UI locale riêng với content locale |
| SEO | URL, title, description, hreflang, sitemap | Public page generator |

Khởi đầu `vi`, `en`. Nút đổi ngôn ngữ là bắt buộc, không chỉ dịch trang chủ. Kiến trúc thêm locale được nhưng chỉ công bố ngôn ngữ đã dịch và QA. Không coi một mẫu chỉ có tiếng Việt là đã có tiếng Anh vì cửa hàng có nút English.

## 2. Ba lựa chọn tách biệt

1. **Interface locale:** ngôn ngữ người dùng sử dụng dashboard, lưu preference.
2. **Content locale:** ngôn ngữ bản nội dung đang sửa/xem, thể hiện rõ trong editor.
3. **Currency/timezone:** giá bán và múi giờ; không tự đổi khi switch vi/en.

Ví dụ người quản trị dùng UI tiếng Việt để soạn trang tiếng Anh; khách thanh toán English vẫn trả VND theo plan. Money format dùng Intl theo locale nhưng bảo toàn amount/currency. UTC ở DB, ngày đến hạn thể hiện timezone cụ thể.

## 3. Routing và fallback

Public routes: `/vi/templates/mau-doanh-nghiep` và `/en/templates/business-template`. Localized slug map về cùng template_id. URL param ưu tiên locale; account preference chỉ quyết định redirect khi đường dẫn chưa có locale. Không redirect liên tục theo IP.

Dashboard có thể giữ route `/account/...` với locale lưu profile/cookie, bảo toàn resource khi đổi ngôn ngữ. Shared link public luôn có locale. Cookie locale không phải auth; không cấp quyền theo nó.

UI key fallback: requested locale → default `vi`; CI không cho thiếu key required trong vi/en ở release. Catalog fallback phải trả `requested_locale`, `resolved_locale`, `translation_status` và badge “Nội dung hiện có bằng tiếng Việt” khi cần; không tạo trang EN indexable với nội dung VI giả danh.

SEO v1: locale chưa có bản đã publish → không sinh localized URL indexable hoặc trả trang không có bản dịch với noindex phù hợp. Language switch tới trang tương đương nếu tồn tại; nếu không, chỉ rõ sẽ về danh mục cùng locale. Không đổi locale rồi mất giỏ/đơn, partner attribution hoặc form draft.

## 4. Cấu trúc gói UI

Key semantic ổn định: `checkout.payment.pending`, `domain.status.waiting_dns`, `partner.commission.eligible`. Không dùng câu tiếng Việt làm key. Dùng plural/interpolation có escaping; không nối chuỗi “Bạn có ” + n + “ đơn hàng” nếu ngôn ngữ cần grammar khác.

Placeholder phải cùng tập giữa vi/en, ví dụ `{count}`, `{siteName}`, `{expiresAt}`. Rich content chỉ component allowlist; không nhét HTML chưa sanitize vào bản dịch. Không đưa secret/token hoặc data đầy đủ vào bản dịch string logs.

Locale registry: code, display_name_native, direction, enabled, fallback_locale. Fallback graph không có vòng lặp. RTL chuẩn bị bằng CSS logical properties (`margin-inline`, `text-align:start`); bật locale RTL chỉ sau QA layout, input số/URL và icon direction.

## 5. Nội dung SQL

Tách entity phi ngôn ngữ và translation theo resource/locale. Product SKU, giá, ảnh gốc là shared; tên/description/slug/alt/SEO có translation. `source_revision` theo dõi phiên bản nguồn, `review_status` draft/reviewed/published/stale. Khi sửa nguồn → đánh dấu bản dịch stale; không tự xóa bản dịch đã biên tập.

Giá trị rỗng có hai nghĩa: chưa dịch hoặc cố ý trống. Form phân biệt bằng status/override, không dùng `value || fallback` cho mọi trường. Search index hoặc SQL search có partition locale; hỗ trợ tìm có/không dấu cho vi nhưng slug và dữ liệu gốc giữ nguyên.

Chuyển default locale của site cần: locale target đã có nội dung required → preview URL/redirect plan → xác nhận → update routing/sitemap; không đổi âm thầm URL SEO.

## 6. Email và sự kiện

Chọn locale lúc tạo notification: order locale cho mail đơn; user preferred locale cho bảo mật; site owner locale cho vận hành; partner locale cho hoa hồng. Lưu locale/template version để retry không đổi nội dung giữa chừng. Nếu thiếu bản dịch, fallback được log và có khả năng xem trước ở admin.

Email demo không gửi ra ngoài. Email thật dùng base URL đúng environment và resource scope; không xây redirect từ dữ liệu không kiểm. Payment webhook status/error machine code không dịch; UI/mail dịch ở rìa.

## 7. SEO và truy cập

- Mỗi public translation đã publish có canonical trỏ về URL cùng locale; hreflang đối ứng giữa các bản thật và x-default phù hợp.
- Sitemap chứa URL canonical active, cập nhật khi archive/slug change; redirect 301 có mapping không vòng lặp.
- Preview, admin, checkout, account, demo: noindex; robots không thay thế auth.
- `<html lang>` đúng; lang trên fragment khác ngôn ngữ nếu cần. Title/meta/OG có localized content; tránh cùng title VI cho tất cả URL EN.
- Không tạo review/rating/schema dữ liệu thương mại giả. Structured data chỉ biểu diễn thông tin đã có thật.
- Fonts có đủ glyph Việt; test tên dài, dấu, uppercase, xuống dòng. Không nhúng text bắt buộc vào ảnh không dịch được.

## 8. Workflow bản dịch

Nguồn draft → gửi dịch → translator sửa → reviewer review → publish theo locale. Admin nhìn matrix thiếu/stale, kiểm preview; chỉ mặc định yêu cầu locale đang bật cho phần UI checkout. Catalog có thể publish locale gốc và công khai rõ phạm vi hỗ trợ của từng mẫu.

Dịch máy tùy chọn tương lai chỉ tạo draft, ghi provider/model/time nếu dùng; không dùng dữ liệu nhạy cảm làm đầu vào khi chưa có quy trình cho phép. Không thêm chi phí API dịch vào v1 khi chưa cấu hình.

## 9. Kiểm thử i18n bắt buộc

1. Mọi UI ID ở tài liệu 05 mở được vi/en, không key thô hoặc text hardcode chưa dịch.
2. Placeholder/plural đúng; date và currency không bị đổi giá trị.
3. Chuỗi dài 150%, tên Việt có dấu, emoji và đường dẫn Unicode không vỡ layout.
4. Chuyển locale ở detail/cart/checkout/demo giữ đúng template/order/partner context.
5. Catalog thiếu EN báo fallback, không hứa mẫu EN chưa có.
6. API CTV cache theo locale/currency/revision; ETag và cache key không trộn.
7. SEO canonical/hreflang/sitemap chỉ trỏ bản tồn tại.
8. Email verify/payment/renewal/CTV dùng locale lưu, retry giữ template version.
