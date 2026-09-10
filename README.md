# claude-remote

Chia sẻ một phiên `claude` (Claude Code) đang chạy trên máy bạn cho một
người khác dùng qua trình duyệt, kèm mật khẩu và tính năng upload file.

## Cài đặt

1. Cài Node.js >= 18.
2. `npm install`
3. Copy `.env.example` thành `.env`, đặt `ACCESS_PASSWORD` là một mật khẩu
   mạnh. Có thể để trống `SESSION_SECRET` (server tự sinh ngẫu nhiên mỗi
   lần khởi động — nghĩa là mọi người phải đăng nhập lại sau khi restart).
4. Đảm bảo lệnh `claude` chạy được từ terminal thường (đã cài Claude Code).

## Chạy

```bash
npm start
```

Mặc định chạy ở `http://localhost:3000`.

## Chia sẻ qua Internet bằng VS Code Port Forwarding

1. Trong VS Code, mở tab **Ports** (panel dưới, cạnh Terminal).
2. Bấm **Forward a Port**, nhập `3000` (hoặc giá trị `PORT` bạn đặt trong `.env`).
3. Click chuột phải vào port vừa forward → **Port Visibility** → **Public**.
4. Copy URL được sinh ra, gửi kèm mật khẩu cho người bạn tin tưởng qua một
   kênh khác (không gửi chung một tin nhắn với link).
5. Khi xong việc, đặt lại **Port Visibility** về **Private** hoặc dừng
   server (`Ctrl+C`).

## Cảnh báo bảo mật

Bất kỳ ai có link + mật khẩu đều có thể gõ lệnh vào phiên Claude Code này,
và Claude Code có thể thực thi lệnh shell trên máy bạn. Chỉ chia sẻ với
người bạn thực sự tin tưởng, và tắt server/đặt lại port về Private ngay
khi không dùng nữa.

## Kiểm tra thủ công trước khi dùng thật

1. Khởi động server *không* set `ACCESS_PASSWORD` → xác nhận server từ
   chối chạy và thoát với thông báo lỗi rõ ràng.
2. Set `ACCESS_PASSWORD`, chạy `npm start`, mở 2 tab trình duyệt, đăng
   nhập cả 2 → gõ ở tab 1 → xác nhận tab 2 thấy cùng output ngay lập tức.
3. Nhập sai password 6 lần liên tiếp trong 1 phút → xác nhận lần thứ 6 bị
   chặn (lỗi 429).
4. Upload 1 file text nhỏ → copy đường dẫn trả về, gõ vào terminal yêu cầu
   Claude đọc file đó → xác nhận đọc được nội dung.
5. Kill tiến trình `claude` con thủ công (Task Manager) trong khi server
   đang chạy → xác nhận cả 2 tab nhận được thông báo "session ended,
   restarting..." và phiên mới hoạt động khi gõ tiếp.
6. Reload trang (F5) → xác nhận không có thêm tiến trình `claude` mới bị
   tạo ra (vẫn dùng chung 1 pty — kiểm tra bằng Task Manager).
