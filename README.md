# Lượm Lúa - Nộp hồ sơ (web cho điện thoại)

Trang web (PWA) dùng điện thoại quét QR để ghi nhận **nộp hồ sơ khi ra cổng**. Dùng chung database Supabase với app máy tính.
Không có máy chủ riêng, không cần cài đặt: chỉ là các file tĩnh (HTML/CSS/JS).

## Tính năng
- Quét QR bằng camera sau (hoặc nhập / quét Mã NV bằng máy quét Bluetooth).
- Quét lần đầu: ghi nhận đã nộp. Quét lại: báo "Bệnh nhân đã khám xong và nộp hồ sơ vào lúc dd/MM/yy HH:mm:ss".
- Thống kê đối soát (tổng, đã khám, đã nộp, chờ nộp, lệch), tìm kiếm không cần dấu, lọc trạng thái và lọc theo ngày.
- Tự cập nhật khi các máy khác thay đổi; mất mạng thì lưu tạm và tự gửi lại với đúng giờ quét.
- Cài lên màn hình chính như ứng dụng.

## Đưa lên GitHub Pages (chỉ chứa các file trong thư mục này)
> ⚠ **Chỉ đưa nội dung thư mục `web` lên GitHub.** Tuyệt đối không đưa file Excel/Word/PDF hay cả thư mục dự án (có dữ liệu bệnh nhân, CCCD). `.gitignore` ở đây đã chặn các định dạng đó.

1. Copy **toàn bộ nội dung thư mục `web`** (kể cả thư mục ẩn `.github`) vào gốc repo GitHub, push lên nhánh `main`.
2. GitHub → repo → **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Chờ tab **Actions** chạy xong, link sẽ có dạng `https://<tài-khoản>.github.io/<tên-repo>/`.
4. GitHub Pages với repo **riêng tư** cần gói trả phí (Pro/Team). Gói miễn phí: để repo **công khai** (trang không chứa bí mật nào) hoặc dùng Cloudflare Pages / Netlify (miễn phí, hỗ trợ repo riêng tư).

## Dùng trên điện thoại
1. Mở link bằng Chrome (Android) / Safari (iPhone). Camera chỉ hoạt động trên HTTPS (GitHub Pages có sẵn).
2. Tab **Cài đặt** → nhập **Mã truy cập** (cùng mã đã đặt trong `supabase/schema.sql`) → **Lưu và tải danh sách**.
3. Tab **Quét** → **Bật camera**, cho phép dùng camera → đưa mã QR vào khung.
4. Menu trình duyệt → **Thêm vào màn hình chính** để mở như ứng dụng.

## Bảo mật
- `config.js` chỉ chứa URL dự án và khóa **publishable** (công khai theo thiết kế của Supabase). **Không ghi mã truy cập vào file nào**: mã chỉ nhập trên điện thoại và lưu trong trình duyệt của máy đó (nút "Xóa mã truy cập" để gỡ).
- Dữ liệu bệnh nhân chỉ đọc/ghi được khi có đúng mã truy cập (kiểm tra trong database).
- Thư viện đọc QR (jsQR 1.4.0) tải từ cdn.jsdelivr.net; trình duyệt có `BarcodeDetector` (Chrome Android) dùng bộ đọc có sẵn của máy.
