# Zoopla Crawler – Chrome Extension

Extension Chrome để cào dữ liệu bất động sản từ Zoopla ngay trên profile Chrome đang dùng, không bị coi là bot. Dữ liệu lưu local (IndexedDB), có thể export CSV hoặc gửi lên backend (PostgreSQL qua API).

## Cài đặt extension

1. Mở Chrome, vào **chrome://extensions/**
2. Bật **Developer mode** (góc trên bên phải)
3. Bấm **Load unpacked**
4. Chọn thư mục **zoopla_extension** (thư mục chứa file `manifest.json`)

Sau khi cài, icon extension sẽ xuất hiện trên thanh toolbar.

## Cách dùng

### Lưu một listing đơn lẻ

1. Mở Zoopla, vào **trang chi tiết** một bất động sản (URL dạng `zoopla.co.uk/for-sale/details/12345/`).
2. Bấm icon extension → bấm **Lưu listing này**.
3. Dữ liệu được lưu vào bộ nhớ local của extension.

### Crawl nhiều listing từ trang tìm kiếm

1. Mở Zoopla, vào **trang tìm kiếm** (ví dụ: `zoopla.co.uk/for-sale/property/manchester/`, có thể thêm bộ lọc giá, số phòng ngủ…).
2. Trong popup extension, cấu hình:
   - **Số bản ghi tối đa**: 1–5000 (mặc định 500) — thu thập link từ nhiều trang cho đến đủ số này thì dừng.
   - **Đẩy lên backend tự động mỗi X bản ghi**: (mặc định 50).
3. Bấm **Thu thập link (nhiều trang)**: tab sẽ tự chuyển qua từng trang (pn=1, 2, 3…), gom link lại. Khi xong, số link hiển thị và có thể bấm **Crawl từng trang** để lấy dữ liệu từng listing.

### Xem và export dữ liệu

- **Đã lưu**: số bản ghi đang lưu local.
- **Export CSV**: tải file CSV toàn bộ dữ liệu đã lưu (UTF-8).
- **Gửi lên Backend**: gửi dữ liệu lên server (cần cấu hình Backend URL trong Cài đặt).

### Cài đặt (Backend URL)

Bấm **Cài đặt (Backend URL)** trong popup → nhập URL gốc của backend (không có `/api/properties` ở cuối).  
Ví dụ: `http://localhost:8000` nếu chạy API local (xem bên dưới).

**Luồng dùng:**

1. **Cấu hình Backend** trong Cài đặt (Backend URL).
2. Trong popup: nhập **Số bản ghi tối đa**, **Đẩy lên backend tự động mỗi (bản ghi)** (vd: 50 → cứ mỗi 50 bản ghi sẽ tự POST lên backend và xóa local + config).
3. Bấm **Lưu config** → config bị khóa (không sửa được nữa).
4. Bấm **Thu thập link (nhiều trang)** rồi **Crawl từng trang**. Khi đủ số bản ghi theo cấu hình, extension tự đẩy lên backend và clear dữ liệu + config.
5. Muốn chỉnh lại config: bấm **Clear dữ liệu** → mở khóa, chỉnh số bản ghi / đẩy tự động rồi **Lưu config** lại.

Extension gửi `POST {backendUrl}/api/properties` với body JSON:  
`{ "properties": [ { "url", "city", "price", ... }, ... ] }`.

## Chạy backend (app Zoopla + API) để lưu vào PostgreSQL

Trong thư mục **zoopla_crawler_app**:

1. Cấu hình `.env` (PostgreSQL) như bình thường.
2. Chạy API (dùng chung database với app Streamlit):

   ```bash
   cd zoopla_crawler_app
   pip install -r requirements.txt
   uvicorn app.api:app --reload --port 8000
   ```

3. Trong extension, Cài đặt → Backend URL: `http://localhost:8000`.
4. Bấm **Gửi lên Backend** trong popup → dữ liệu sẽ được upsert vào bảng `properties`.

Có thể vừa chạy Streamlit (`streamlit run app/main.py`) vừa chạy API (`uvicorn app.api:app --port 8000`) để vừa crawl bằng extension vừa xem/export trong app.

## Các trường dữ liệu

Trùng với app Zoopla: `url`, `city`, `price`, `address`, `property_type`, `bedrooms`, `bathrooms`, `living_rooms`, `area_sqft`, `description`, `epc_rating`.  
Khi gửi lên backend, API sẽ thêm `created_at` và upsert theo `url`.

## Lưu ý

- Extension chỉ chạy trên **www.zoopla.co.uk**.
- Dữ liệu local (IndexedDB) nằm trong profile Chrome; xóa extension hoặc xóa dữ liệu site sẽ mất.
- Nên crawl với tốc độ vừa phải (extension đợi ~2.5s mỗi trang trước khi trích xuất) để tránh bị Zoopla giới hạn.
