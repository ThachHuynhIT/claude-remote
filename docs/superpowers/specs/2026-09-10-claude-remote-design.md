# claude-remote — Design Spec

Date: 2026-09-10

## Purpose

Cho phép người dùng khác (bạn bè/đồng nghiệp tin tưởng của chủ máy) truy cập
qua Internet vào một phiên `claude` (Claude Code CLI) đang chạy trên máy chủ
sở hữu (host), thông qua trình duyệt — mà không cần cấp SSH hay quyền truy
cập hệ thống đầy đủ. Nhiều người xem/gõ vào cùng một phiên terminal dùng
chung, giống việc chia sẻ một cửa sổ tmux qua web.

## Constraints / decisions đã chốt

- Chỉ chia sẻ phiên Claude Code (không phải shell tự do) — nhưng vì Claude
  Code có thể chạy lệnh shell qua tool của nó, người có quyền truy cập vẫn
  gián tiếp có khả năng thực thi lệnh trên máy host. Đây là rủi ro đã được
  người dùng chấp nhận với điều kiện chỉ chia sẻ cho người tin tưởng.
- Người truy cập: số lượng nhỏ, đã biết trước (không phải public ẩn danh).
- Truy cập qua Internet, expose bằng VS Code Port Forwarding (không cần
  ngrok/cloudflared/VPS riêng).
- Một phiên `claude` dùng chung cho tất cả client (không phải mỗi người một
  phiên riêng).
- Có tính năng upload file từ máy khách lên máy host, vì Claude Code chỉ đọc
  được file nằm trên máy host — file trên máy khách phải được chuyển sang
  host trước khi đọc được.
- Chạy trên Windows (host hiện tại), nên chọn thư viện pty hỗ trợ ConPTY
  thay vì công cụ Linux-only (ttyd/gotty).

## Kiến trúc

Ứng dụng Node.js + Express, một tiến trình duy nhất, lắng nghe một port cố
định (mặc định `3000`, cấu hình qua biến môi trường `PORT`).

### Thành phần

1. **PTY manager** (`src/pty.js`)
   - Dùng `node-pty` spawn một tiến trình `claude` khi server khởi động (hoặc
     lazy — khi client đầu tiên kết nối).
   - Giữ instance pty duy nhất trong module state (singleton).
   - Nếu tiến trình pty thoát (`onExit`), đánh dấu là "dead", broadcast
     thông báo tới mọi client đang kết nối, và respawn khi có hoạt động kế
     tiếp (kết nối mới hoặc input mới).

2. **WebSocket hub** (`src/wsHub.js`)
   - Dùng thư viện `ws`, gắn vào cùng HTTP server với Express (`server.on('upgrade', ...)`).
   - Khi một client kết nối WS: xác thực cookie (xem Auth), nếu hợp lệ thì
     thêm client vào tập `clients`, gửi lại toàn bộ scrollback buffer gần
     nhất (giữ trong bộ nhớ, giới hạn ví dụ 200KB cuối) để người mới vào
     thấy ngữ cảnh, rồi tiếp tục stream output mới.
   - Output pty → broadcast tới toàn bộ `clients` đang mở.
   - Input từ bất kỳ client nào (message dạng `{type: "input", data}`) →
     ghi vào `pty.write(data)`.
   - Message dạng `{type: "resize", cols, rows}` → gọi `pty.resize()` (dùng
     kích thước do client cuối cùng resize gửi lên; đơn giản hoá bằng cách
     lấy kích thước nhỏ nhất trong các client đang mở, tránh vỡ layout).

3. **Auth** (`src/auth.js`)
   - Password đặt qua biến môi trường `ACCESS_PASSWORD` (bắt buộc phải set,
     server từ chối khởi động nếu thiếu, để tránh chạy không mật khẩu).
   - `POST /login` nhận `{password}`, so sánh bằng so sánh hằng thời gian
     (`crypto.timingSafeEqual`), nếu đúng → set cookie `httpOnly`, `secure`
     (khi không phải localhost), giá trị là token ký HMAC bằng
     `SESSION_SECRET` (tự sinh ngẫu nhiên lúc khởi động nếu không set qua
     env, in ra log để biết session sẽ mất khi restart).
   - Middleware `requireAuth` áp dụng cho: trang chính (`/`), `POST
     /upload`, và bước xác thực khi WS upgrade (đọc cookie từ header của
     upgrade request).
   - Rate limit đăng nhập: tối đa 5 lần sai trong 60 giây theo mỗi IP (bộ
     đếm in-memory, đủ dùng cho quy mô người dùng nhỏ đã chốt).

4. **Upload** (`src/upload.js`)
   - `POST /upload`, dùng `multer` với `diskStorage`, lưu vào thư mục
     `uploads/` ở gốc project.
   - Tên file lưu: `Date.now()-<basename gốc đã sanitize>` để tránh trùng
     và path traversal (dùng `path.basename` trên tên gốc trước khi ghép).
   - Giới hạn dung lượng: 20MB/file (`multer` limits).
   - Response trả về đường dẫn tuyệt đối trên host (vd `uploads/173..-a.txt`
     resolve thành absolute path) để người dùng copy vào terminal.
   - Thư mục `uploads/` thêm vào `.gitignore`.

5. **Frontend** (`public/index.html`, `public/login.html`)
   - `login.html`: form password đơn giản, submit tới `/login`, lỗi hiển
     thị message, không có logic phức tạp.
   - `index.html`:
     - `xterm.js` (qua CDN — `xterm` + `xterm-addon-fit`) render terminal,
       mở kết nối `WebSocket` tới cùng origin (`wss://.../ws`).
     - Gửi phím gõ → WS message `{type:"input", data}`.
     - Nhận message `{type:"output", data}` → ghi vào terminal.
     - Khu vực upload: `<input type="file">` + kéo-thả, submit qua
       `fetch('/upload', {method:'POST', body: formData})`, sau khi xong
       hiện đường dẫn trả về kèm nút "copy".
     - Xử lý resize cửa sổ trình duyệt → gọi `fitAddon.fit()` → gửi resize
       message.

### Data flow

```
Trình duyệt (client)                     Máy host (server)
  |-- GET / -----------------------------> chưa có cookie? redirect /login
  |-- POST /login {password} ------------> đúng? set-cookie : lỗi
  |-- GET / (có cookie) ------------------> trả index.html
  |-- WS /ws (cookie kèm theo) -----------> auth cookie -> attach vào pty chung
  |<-- output pty (broadcast) ------------|
  |-- input bàn phím ---------------------> pty.write()
  |-- POST /upload (multipart, cookie) ---> lưu uploads/, trả về path
```

## Error handling

- Thiếu `ACCESS_PASSWORD` khi khởi động → server thoát ngay với thông báo
  rõ ràng (fail fast, không chạy không mật khẩu).
- Cookie thiếu/không hợp lệ trên `/`, `/upload`, hoặc WS upgrade → 401 /
  đóng kết nối WS ngay, không leak thông tin lỗi chi tiết.
- Sai password quá ngưỡng → 429 tạm thời cho IP đó.
- Pty crash → broadcast `{type:"system", data:"session ended, restarting..."}`
  tới mọi client, respawn pty, client tự nối lại vào pty mới (không cần
  reload trang).
- Upload lỗi (quá size, không có file) → trả JSON lỗi rõ ràng, không
  crash server.

## Testing (thủ công — không có test tự động cho I/O pty thật)

1. Khởi động server thiếu `ACCESS_PASSWORD` → xác nhận server từ chối chạy.
2. Mở 2 tab trình duyệt, đăng nhập cả 2 → gõ ở tab 1 → xác nhận tab 2 thấy
   cùng output ngay lập tức.
3. Nhập sai password 6 lần liên tiếp trong 1 phút → xác nhận lần thứ 6 bị
   chặn (429).
4. Upload 1 file text nhỏ → copy đường dẫn trả về, gõ vào terminal yêu cầu
   Claude đọc file đó → xác nhận đọc được nội dung.
5. Kill tiến trình `claude` con thủ công (Task Manager) trong khi server
   đang chạy → xác nhận client nhận được thông báo "session ended" và pty
   được respawn khi gõ tiếp.
6. Reload trang (F5) → xác nhận không tạo thêm tiến trình `claude` mới (vẫn
   dùng chung 1 pty).

## Cách chạy & chia sẻ

1. Tạo file `.env` (không commit) với `ACCESS_PASSWORD=<mật khẩu mạnh>`.
2. `npm install && npm start`.
3. Trong VS Code, mở tab "Ports" → "Forward a Port" → nhập `3000` → click
   chuột phải → "Port Visibility" → "Public".
4. Copy URL được sinh ra, gửi kèm password cho người tin tưởng qua kênh
   riêng (không gửi chung với link).
5. Tắt server hoặc set lại port về "Private" khi không dùng nữa.

## Ngoài phạm vi (out of scope)

- Nhiều phiên `claude` độc lập cho nhiều người dùng khác nhau.
- Quản lý user/role phức tạp (chỉ có 1 password dùng chung).
- Lưu trữ lịch sử chat lâu dài / database.
- Mã hoá đầu-cuối riêng (dựa vào HTTPS do VS Code tunnel cung cấp).
