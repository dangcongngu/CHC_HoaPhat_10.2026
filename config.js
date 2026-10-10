// Cấu hình mặc định. Chỉ chứa thông tin CÔNG KHAI (URL dự án và khóa publishable của Supabase).
// KHÔNG ghi "mã truy cập" vào file này: nhân viên nhập mã trên điện thoại ở mục Cài đặt (lưu trong máy).
window.APP_CONFIG = {
  supabaseUrl: "https://lnzwxucwtbzbmqaapvzo.supabase.co",
  supabasePublishableKey: "sb_publishable_-bZxLpLWFH9-2eA9t2oSDQ_gZU-NqXD",
  pollSeconds: 3,          // chu kỳ cập nhật dữ liệu từ các máy khác
  pageSize: 60             // số dòng hiển thị mỗi lần trong danh sách
};
