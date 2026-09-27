# Compress Media

[English](README.md) · **Tiếng Việt**

[![CI](https://github.com/material-atomic/compress-media/actions/workflows/ci.yml/badge.svg)](https://github.com/material-atomic/compress-media/actions/workflows/ci.yml)
[![Docker Hub](https://img.shields.io/docker/v/runsnip/compress-media?label=docker&sort=semver)](https://hub.docker.com/r/runsnip/compress-media)
[![Image size](https://img.shields.io/docker/image-size/runsnip/compress-media?sort=semver)](https://hub.docker.com/r/runsnip/compress-media)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Công cụ tự host để nén **video, ảnh, âm thanh và PDF**, kèm công cụ làm GIF và **tạo phụ đề từ giọng nói**. Có giao diện web kéo thả, CLI và HTTP API, dùng ffmpeg, sharp, Ghostscript và whisper.cpp. Còn có thể nén **ngay trên trình duyệt**, file không rời khỏi thiết bị.

- Ra đời để xử lý các video quay màn hình QuickTime nặng hàng GB: một bản ghi 2880×1800, 60fps thường **nhỏ đi 90–98%**.
- File được xử lý ngay trên máy hoặc server của bạn.
- File lớn được upload theo từng phần, tải tiếp được khi bị gián đoạn, và có thể upload thẳng lên kho lưu trữ chuẩn S3.

![Ảnh chụp màn hình](docs/screenshot.png)

## Mục lục

[Tính năng](#tính-năng) · [Dự kiến cho 2.2](#dự-kiến-cho-22) · [Các cách dùng](#các-cách-dùng) · [Bắt đầu nhanh](#bắt-đầu-nhanh) · [Giao diện web](#giao-diện-web) · [CLI](#cli) · [HTTP API](#http-api) · [Cấu hình](#cấu-hình) · [Lưu trữ đối tượng](#lưu-trữ-đối-tượng-s3) · [Nền tảng](#nền-tảng-hỗ-trợ) · [AI agent](#dùng-với-ai-agent) · [Bảo mật](#bảo-mật) · [Phát triển](#phát-triển) · [Giấy phép](#giấy-phép)

## Tính năng

- **Video** (MOV, MP4, MKV, WebM, AVI…) → MP4, WebM hoặc **GIF** động.
  - H.264 (phát được ở mọi nơi), H.265 (nhỏ hơn 30–50%), **AV1** (nhỏ hơn nữa), hoặc VP9 trong WebM.
  - Chọn mức chất lượng có sẵn, hoặc đặt **dung lượng mục tiêu theo MB** khi cần vừa giới hạn upload (mã hóa hai lượt).
  - **Cắt đoạn** theo thời điểm bắt đầu/kết thúc, giảm độ phân giải, giới hạn FPS, giữ / giảm / bỏ âm thanh.
  - **Nén bằng phần cứng**: Apple VideoToolbox, NVIDIA NVENC, Intel Quick Sync, VA-API, AMD AMF, tự nhận diện.
- **Ảnh** (JPG, PNG, WebP, AVIF, **HEIC**, GIF, TIFF).
  - Giữ định dạng cũ, hoặc chuyển sang JPEG, WebP, AVIF, PNG.
  - Chỉnh chất lượng và cạnh dài tối đa.
  - PNG được giảm số màu (giống pngquant).
  - GIF và WebP động vẫn giữ chuyển động, kể cả khi định dạng đã chọn không hỗ trợ ảnh động.
  - Mặc định xóa metadata EXIF và vị trí GPS.
- **Âm thanh** (WAV, M4A, FLAC, AIFF, MP3…) → MP3, M4A hoặc Opus. Chọn được bitrate và mono.
- **PDF** → PDF nhỏ hơn, với các mức ảnh từ 72 đến 300 dpi, có thể chuyển đen trắng (Ghostscript).
- **Tạo ảnh động từ ảnh tĩnh** (làm GIF): 2–1000 ảnh chụp màn hình hoặc ảnh thường → một GIF động, WebP động hoặc MP4, chỉnh được thời gian mỗi khung hình, số lần lặp và kích thước tối đa.
- **Phụ đề**: lời nói trong video hoặc file âm thanh → file SRT hoặc WebVTT gồm mốc thời gian và nội dung (whisper.cpp, tự nhận diện hoặc chọn ngôn ngữ, có thể dịch sang tiếng Anh), hoặc gắn phụ đề vào video dưới dạng track bật/tắt được hay in thẳng lên hình. Dùng được cả file `.srt`/`.vtt` có sẵn của bạn.
- **Nén trên trình duyệt (beta)**: video, âm thanh và ảnh được nén ngay trên thiết bị người dùng bằng WebCodecs, hoàn toàn không upload. Việc trình duyệt không làm được sẽ tự chuyển sang server.
- **Upload**
  - File được chia thành các phần 8 MB, gửi song song 4 phần một lúc.
  - Phần nào lỗi thì tự gửi lại. Bị gián đoạn thì tải tiếp được, kể cả sau khi tải lại trang.
  - Có thể gửi thẳng lên AWS S3, Cloudflare R2, GCS, MinIO, B2…
- **Tiện ích**
  - Nén nhiều file một lúc bằng cách kéo thả hoặc dán.
  - Hiện tiến độ và thời gian còn lại.
  - Xem trước bản gốc và bản nén cạnh nhau.
  - Nén lại với cài đặt khác mà không cần upload lại.
  - Hủy giữa chừng, **tải tất cả thành một file ZIP**.
- **Đăng nhập có sẵn**, mặc định bật: tên đăng nhập/email và mật khẩu lấy từ biến môi trường, có API token cho script.
- **Tích hợp**: HTTP API có Server-Sent Events, webhook có chữ ký và xem trạng thái nhiều job một lần.
- **Mở rộng quy mô**: hàng đợi Redis tùy chọn, với các worker chạy riêng.
- **Giao diện** tiếng Anh và tiếng Việt, có chế độ sáng và tối, dùng được trên điện thoại.

## Dự kiến cho 2.2

Sẽ làm tiếp theo; chưa có trong mã nguồn, chi tiết có thể thay đổi. Các tính năng AI dùng model nhỏ chạy bằng CPU ngay trên server của bạn (hoặc trong trình duyệt); giống model giọng nói, chúng được tải ở lần dùng đầu, và chỉ chọn model có giấy phép cho phép dùng thương mại.

- **Âm thanh sạch hơn.** Chuẩn hóa âm lượng theo mức YouTube và TikTok yêu cầu (−14 LUFS), và giảm tiếng ồn nền (quạt, máy lạnh) cho video và âm thanh, bằng RNNoise (model khoảng 100 KB, qua filter `arnndn` của ffmpeg).
- **Xoay, lật và đổi tốc độ.** Dựng thẳng video quay ngang, lật gương, hoặc phát nhanh 1.5×, 2×, hay làm timelapse.
- **Cắt khoảng lặng.** Tự bỏ các quãng ngừng dài trong video nói (jump cut), dùng chung bộ phát hiện giọng nói với tính năng phụ đề.
- **Chèn watermark.** Đặt logo hoặc chữ lên video và ảnh, chọn được vị trí và độ mờ.
- **Chương cho YouTube.** Gợi ý mốc và tên chương từ phụ đề bằng một mô hình ngôn ngữ nhỏ (Qwen2.5 0.5B–1.5B qua llama.cpp), dán thẳng vào phần mô tả video.
- **Dịch phụ đề** sang các ngôn ngữ khác ngoài tiếng Anh (ví dụ Anh → Việt), bằng model dịch Opus-MT hoặc chính mô hình ngôn ngữ nhỏ ở trên.
- **Ghép video.** Nối nhiều đoạn thành một video.
- **Tách âm thanh** khỏi video thành MP3, M4A hoặc Opus.
- **Chuyển đổi phụ đề** giữa SRT và WebVTT mà không cần video.
- **Xóa phông nền ảnh** (U²-Net hoặc MODNet, 5–25 MB), cho ảnh sản phẩm và chân dung.
- **Phóng to ảnh** 2× hoặc 4× và làm nét (Real-ESRGAN).
- **Làm mờ khuôn mặt** trong ảnh và video để bảo vệ riêng tư (nhận diện khuôn mặt bằng YuNet, dưới 1 MB).
- **Xem thông tin file** trên giao diện web và API: thời lượng, độ phân giải, FPS, codec và bitrate trước khi chọn cài đặt (hiện chỉ có ở lệnh `compress-media probe`).

Những gì thay đổi qua từng phiên bản, kể cả lưu ý khi nâng cấp: [CHANGELOG.md](CHANGELOG.md) (tiếng Anh).

## Các cách dùng

| | Phù hợp với | Bắt đầu bằng |
|---|---|---|
| **Giao diện web** | Người dùng thường: kéo file vào, tải kết quả về | `docker run … runsnip/compress-media` hoặc `npm start` |
| **CLI** | Script, nén cả thư mục, AI agent. Không cần server. | `compress-media clip.mov` |
| **HTTP API** | Ứng dụng hoặc dịch vụ khác gọi tới một server dùng chung | [docs/api.md](docs/api.md), [examples/](examples) |
| **AI agent** | Nhờ Claude hay agent khác nén file giúp, hoặc triển khai dịch vụ | [skills/](skills) |

## Bắt đầu nhanh

**Docker** (mọi hệ điều hành):

```bash
docker run -d --name compress-media -p 127.0.0.1:4747:4747 -v compress-media-data:/data \
  -e AUTH_USERNAME=me@example.com -e AUTH_PASSWORD='mat-khau-cua-ban' runsnip/compress-media
```

Sau đó mở http://localhost:4747 và đăng nhập. Nếu không đặt `AUTH_PASSWORD`, server tự tạo mật khẩu: xem bằng `docker logs compress-media | grep Login`.

**Docker Compose** (đọc cài đặt từ file `.env`):

```bash
cp .env.example .env    # không bắt buộc
docker compose up -d
```

**Node.js 20+** (nên dùng trên Mac vì có nén bằng phần cứng và đọc được HEIC):

```bash
npm install
npm start               # http://localhost:4747
```

Không cần cài ffmpeg, `npm install` tự tải về. Log lúc khởi động in ra thông tin đăng nhập (đặt `AUTH_USERNAME`/`AUTH_PASSWORD` trong `.env`, hoặc `AUTH_ENABLED=false` nếu là máy riêng). Nếu cổng 4747 đã có app khác dùng, server sẽ báo lỗi chứ không chen vào. Khi đó chạy `PORT=4848 npm start`.

Muốn nén PDF khi chạy trực tiếp thì cài Ghostscript (`brew install ghostscript`, `apt install ghostscript`); muốn tạo phụ đề từ giọng nói thì cài whisper.cpp (`brew install whisper-cpp`). Image Docker đã có sẵn cả hai.

## Giao diện web

1. Đăng nhập, rồi chọn cài đặt ở các tab **Video**, **Ảnh**, **Âm thanh**, **PDF**. Trình duyệt sẽ nhớ các cài đặt này. Có thể chọn **Nén ở: Trình duyệt này** để file không rời khỏi thiết bị (chỉ chạy qua HTTPS hoặc localhost).
2. Kéo thả, chọn hoặc dán file vào trang. Nhiều file được xử lý cùng lúc.
3. Mỗi dòng hiện tiến độ upload và tiến độ nén. Khi xong:
   - **Tải về** để lưu kết quả;
   - **Xem** để so sánh bản gốc với bản nén;
   - **Nén lại** để nén bằng cài đặt hiện tại mà không cần upload lại.
4. Nếu mạng rớt, dòng đó hiện nút **Tải tiếp**, bấm vào chỉ gửi những phần còn thiếu. Tải lại trang rồi thêm lại đúng file đó cũng sẽ tải tiếp.
5. **Tải tất cả** lưu mọi kết quả. **Xóa danh sách** xóa các dòng đã xong, cùng file của chúng trên server.

Nút chuyển chế độ ở đầu trang chọn việc cần làm: **Nén file**, **Tạo ảnh động** hoặc **Phụ đề**. Phần cài đặt và vùng thả file đổi theo chế độ đó.

Muốn làm GIF từ ảnh chụp màn hình, chuyển sang **Tạo ảnh động**. Ảnh thả vào trở thành các khung hình có đánh số: kéo (hoặc dùng ← →) để đổi thứ tự, bỏ một khung, hoặc **Xóa** hết. Chọn định dạng, thời gian mỗi khung, số lần lặp và kích thước ở tab **Ảnh động**, rồi bấm **Tạo ảnh động**. Kết quả là một dòng, có **Nén lại** và **Xem** như mọi dòng khác. Ảnh động luôn được tạo trên server, kể cả khi chọn **Nén ở: Trình duyệt này**.

Muốn tạo phụ đề, chuyển sang **Phụ đề** rồi thả video (hoặc file âm thanh) vào. Ở tab **Phụ đề**, chọn kết quả (**File phụ đề**, **Video + track** hoặc **In lên hình**), định dạng file (SRT hoặc WebVTT), ngôn ngữ nói trong video, **Dịch sang phụ đề tiếng Anh** và độ chính xác (model giọng nói; lần dùng đầu sẽ tải model về). Muốn dùng phụ đề của bạn, thả file `.srt`/`.vtt` cùng với video, đặt cùng tên (`talk.mov` + `talk.srt`). Mỗi dòng hiện tiến độ theo từng bước: tải model nhận dạng giọng nói, nghe và viết phụ đề, gắn phụ đề vào video. Khi xong, **Tải về** lưu kết quả (và **SRT** lưu file phụ đề, khi kết quả là video). **Xem & sửa** phát video kèm phụ đề bên cạnh ô sửa chữ: **Xem thử** để xem thay đổi, rồi **Lưu** để tạo lại kết quả từ bản của bạn, không cần nhận dạng lại. **Nén lại** dùng lại phụ đề đã nhận dạng, trừ khi bạn đổi ngôn ngữ, bật/tắt dịch hoặc đổi model. Phụ đề luôn được tạo trên server.

Nếu bản nén không nhỏ hơn bản gốc, dòng đó sẽ có cảnh báo, và bạn nên giữ bản gốc. Ngôn ngữ giao diện tự theo trình duyệt, đổi được bằng nút EN/VI ở góc trên.

## CLI

Cùng bộ xử lý nén như bản web, chạy thẳng từ terminal, không cần server.

```bash
npm install && npm link                                   # hoặc: node bin/cli.js …

compress-media "Screen Recording.mov" --max-res 1080 --fps 30
compress-media clip.mov --target-mb 24                   # vừa file đính kèm email
compress-media clip.mov --codec h265 --speed slow        # nhỏ nhất, cho thiết bị Apple / trình duyệt mới
compress-media ~/Pictures/trip -r --image-format webp --max-dim 2048 -o web
compress-media memo.m4a --audio-format opus --bitrate 48 --mono
compress-media demo.mov --start 0:04 --end 0:19 --video-format gif   # GIF để gắn vào issue
compress-media cv.pdf --pdf-quality ebook                            # CV để gửi email
compress-media animate shot-*.png --delay 700 --max-dim 1200 -o walkthrough.gif   # ảnh chụp màn hình → GIF
compress-media subtitles talk.mov --lang vi              # lời nói → talk.vi.srt (ví dụ để đăng YouTube)
compress-media subtitles talk.mov --srt talk.srt --embed burn --font-size large   # in phụ đề của bạn lên video
compress-media probe clip.mov                             # xem độ phân giải, fps, thời lượng, codec
compress-media *.mov --json -q > report.json              # báo cáo JSON cho script
compress-media serve                                      # mở giao diện web
```

- Kết quả được ghi cạnh file gốc với tên `<tên>-compressed.<đuôi>`. File gốc không bao giờ bị sửa.
- Mã thoát: `0` là thành công hết, `1` là có file lỗi, `2` là gõ sai lệnh.
- Chạy qua Docker: `docker run --rm -v "$PWD:/work" -w /work runsnip/compress-media compress-media clip.mov`.

Đầy đủ các flag, định dạng báo cáo JSON và ghi chú về tốc độ: **[docs/cli.md](docs/cli.md)** (tiếng Anh).

## HTTP API

Giao diện web chạy trên một API JSON nhỏ, bạn có thể gọi trực tiếp. Xác thực bằng HTTP Basic hoặc `Authorization: Bearer $AUTH_TOKEN`:

1. Bắt đầu một lượt upload chia phần.
2. PUT từng phần, lên server hoặc thẳng lên bucket.
3. Hoàn tất upload, lúc này job nén được tạo.
4. Theo dõi trạng thái job.
5. Tải kết quả về.

Ảnh động có endpoint riêng, `POST /api/animations`, nhận các khung hình theo thứ tự. Phụ đề cũng vậy: `POST /api/subtitles` nhận một video (và file `.srt`/`.vtt` của bạn nếu có), còn `GET /api/jobs/:id/subtitles` trả nội dung phụ đề dạng SRT hoặc WebVTT. Ngoài ra còn có tải nhiều kết quả thành một file ZIP, tiến độ theo thời gian thực qua Server-Sent Events, và webhook có chữ ký khi job xong. Có sẵn hai client mẫu, đã xử lý việc thử lại và cả hai chế độ lưu trữ:

```bash
export COMPRESS_MEDIA_USER=me@example.com COMPRESS_MEDIA_PASSWORD=…
examples/compress.sh "Screen Recording.mov" '{"video":{"resolution":1080,"fps":30}}' http://localhost:4747   # bash + curl + jq
node examples/compress.mjs photo.heic '{"image":{"format":"webp"}}'                                        # Node.js 20+
```

Đầy đủ các endpoint, tùy chọn, mã lỗi và giao thức upload: **[docs/api.md](docs/api.md)**.

## Cấu hình

Mọi thứ cấu hình qua biến môi trường: đặt trực tiếp trên dòng lệnh, qua `docker run -e`, hoặc trong file `.env`. Cả `npm start` lẫn Docker Compose đều đọc file này, và biến môi trường đặt thật được ưu tiên hơn. Các biến hay dùng:

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` / `HOST` | `4747` / `127.0.0.1` | Cổng và địa chỉ server lắng nghe |
| `AUTH_USERNAME` / `AUTH_PASSWORD` | `admin` / tự tạo | Đăng nhập (username hoặc email). `AUTH_ENABLED=false` để tắt; `AUTH_TOKEN` để bật API token. |
| `PUBLIC_URL` | — | Địa chỉ công khai, ví dụ `https://media.example.com` (dùng để kiểm tra CORS của bucket) |
| `JOB_TTL_HOURS` | `3` | Sau bấy nhiêu giờ thì file bị xóa |
| `MAX_UPLOAD_MB` | `0` | Giới hạn dung lượng mỗi file (0 = không giới hạn) |
| `MEDIA_CONCURRENCY` | `1` | Số job video/âm thanh chạy song song |
| `UPLOAD_PART_MB` / `UPLOAD_CONCURRENCY` | `8` / `4` | Kích thước mỗi phần upload (nên để 5–100) và số phần gửi song song |
| `STORAGE` | `local` | `local` (ổ đĩa) hoặc `s3` (lưu trữ đối tượng) |
| `QUEUE` / `REDIS_URL` / `ROLE` | `memory` / — / `all` | Hàng đợi Redis dùng chung, và các process `web` / `worker` để mở rộng quy mô |
| `HW_ENCODER` | `auto` | `off`, hoặc chỉ định `videotoolbox` / `nvenc` / `qsv` / `vaapi` / `amf` |
| `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | — | Thông tin kho lưu trữ S3 |
| `WHISPER_MODEL` | `small` | Model giọng nói để tạo phụ đề: `tiny`, `base`, `small`, `medium` hoặc `large-v3-turbo` |
| `WHISPER_MODELS_DIR` / `WHISPER_DOWNLOAD` | `WORK_DIR/models` / `true` | Thư mục chứa model giọng nói; `false` để không bao giờ tải model (server không có internet) |

Danh sách đầy đủ: **[docs/configuration.md](docs/configuration.md)**. File mẫu có chú thích: [`.env.example`](.env.example).

## Lưu trữ đối tượng (S3)

Đặt `STORAGE=s3` thì trình duyệt sẽ **upload thẳng lên bucket** qua URL ký sẵn, dữ liệu upload không đi qua server app. Kết quả cũng được lưu trong bucket và tải về trực tiếp từ đó.

Dùng được với AWS S3, Cloudflare R2, Google Cloud Storage, MinIO, SeaweedFS, Backblaze B2, DigitalOcean Spaces, Wasabi (Azure thì chưa).

```env
STORAGE=s3
S3_BUCKET=compress-media
S3_REGION=auto
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=…
S3_SECRET_ACCESS_KEY=…
PUBLIC_URL=https://media.example.com
S3_SETUP_CORS=true        # tự thêm quy tắc CORS mà trình duyệt cần (giữ nguyên các quy tắc sẵn có)
```

Thử ngay trên máy với một server S3 đi kèm: `docker compose -f docker-compose.s3.yml up -d`.

**Nhiều máy:** với `QUEUE=redis`, bao nhiêu web server và worker cũng dùng chung một hàng đợi. `docker compose -f docker-compose.scale.yml up -d` khởi động 1 web server, 2 worker và Redis. Xem [deployment.md → Scaling out](docs/deployment.md#scaling-out).

Trong **[docs/deployment.md](docs/deployment.md)** có:
- cấu hình cho từng nhà cung cấp;
- quy tắc CORS và quy tắc lifecycle;
- chính sách phân quyền IAM;
- cấu hình Caddy/nginx để mở app ra ngoài an toàn;
- ghi chú về việc mở rộng quy mô.

## Nền tảng hỗ trợ

| | macOS | Linux | Windows |
|---|---|---|---|
| Docker (`amd64`, `arm64`) | ✅ | ✅ | ✅ (Docker Desktop) |
| `npm start` / CLI | ✅ | ✅ x64 và arm64 | ✅ x64 |
| Nén bằng phần cứng | ✅ VideoToolbox | NVENC, VA-API, Quick Sync (tự nhận diện) | NVENC, Quick Sync, AMF (tự nhận diện) |
| Ảnh HEIC | ✅ có sẵn | cài `libheif-examples` / `libheif-tools` | dùng Docker |
| PDF | cài Ghostscript | cài `ghostscript` | cài Ghostscript, hoặc dùng Docker |
| Phụ đề từ giọng nói | `brew install whisper-cpp` | gói `whisper.cpp`, hoặc tự build | bản build sẵn của whisper.cpp (`WHISPER_PATH`), hoặc dùng Docker |
| Nén trên trình duyệt | Chrome, Edge, Firefox, Safari (qua HTTPS hoặc localhost; codec tùy trình duyệt, phần thiếu do server làm) | | |

Trên Linux ARM (Raspberry Pi, server ARM), nên trỏ `FFMPEG_PATH`/`FFPROBE_PATH` tới ffmpeg của hệ điều hành, vì bản đi kèm qua npm chạy chậm hơn nhiều. Image Docker đã làm sẵn việc này.

## Cài đặt gợi ý

| Mục đích | Giao diện web / API | CLI |
|---|---|---|
| Video quay màn hình, gửi đi mọi nơi | H.264 · Cân bằng · 1080p · 30 fps | `--max-res 1080 --fps 30` |
| Phải vừa giới hạn upload | Theo MB | `--target-mb 24` |
| Nhỏ nhất, cho thiết bị Apple / trình duyệt mới | H.265 · CPU · Chậm | `--codec h265 --speed slow` |
| Video dài, cần nhanh (macOS) | Phần cứng Apple | `--hw` |
| Ảnh cho website | WebP · tối đa 1920 px | `--image-format webp --max-dim 1920` |
| Ghi âm giọng nói | Opus · 48 kbps · mono | `--audio-format opus --bitrate 48 --mono` |
| Đoạn clip cho tài liệu hoặc issue | GIF · cắt đoạn · 480p | `--video-format gif --start 4 --end 19` |
| PDF CV hoặc portfolio | PDF · Cân bằng | `--pdf-quality ebook` |
| GIF từ ảnh chụp màn hình | Tạo ảnh động · GIF · 700 ms | `animate shot-*.png --delay 700` |
| Phụ đề cho YouTube | Phụ đề · File phụ đề · SRT · Cân bằng | `subtitles talk.mov --lang vi` |
| Phụ đề cho TikTok / Reels | Phụ đề · In lên hình · Lớn | `subtitles clip.mov --embed burn --font-size large` |

## Dùng với AI agent

| Dành cho | File |
|---|---|
| Agent **nén file giúp bạn** (qua CLI hoặc API): tìm tool, chọn cài đặt theo mục đích, đọc báo cáo, không bao giờ xóa file gốc | [`skills/compress-media/`](skills/compress-media/SKILL.md) |
| Agent **triển khai và vận hành dịch vụ**: Docker, reverse proxy, lưu trữ S3, CORS, xử lý sự cố | [`skills/compress-media-deploy/`](skills/compress-media-deploy/SKILL.md) |
| Agent **sửa code dự án**: kiến trúc, các lệnh, thế nào là xong việc, các bẫy đã gặp | [`AGENTS.md`](AGENTS.md) (Claude Code tự đọc qua `CLAUDE.md`) |
| LLM cần bản đồ tài liệu | [`llms.txt`](llms.txt) |

Cài skill cho Claude Code:

```bash
cp -r skills/* ~/.claude/skills/        # cho mọi dự án
cp -r skills/* .claude/skills/          # cho một dự án
```

Với agent khác, trỏ thẳng tới các file `SKILL.md`. Mỗi skill tự đầy đủ, không phụ thuộc file nào khác.

## Bảo mật

**Mặc định phải đăng nhập.** Phiên đăng nhập dùng cookie HttpOnly có chữ ký; script dùng HTTP Basic hoặc token; nhập sai mật khẩu nhiều lần sẽ bị chặn tạm thời. Mặc định server cũng chỉ nghe ở `127.0.0.1`, các file Compose chỉ mở cổng trên `127.0.0.1`. Khi mở ra internet, hãy thêm HTTPS bằng reverse proxy ([ví dụ](docs/deployment.md#reverse-proxy)).

- Tên file upload không bao giờ được dùng làm đường dẫn.
- Webhook trỏ tới mạng nội bộ bị từ chối mặc định (chống SSRF).
- Server chỉ xóa hai thư mục `uploads/` và `outputs/` do chính nó tạo ra.
- Với lưu trữ S3, trình duyệt chỉ nhận URL ký sẵn có hạn ngắn.

Báo lỗ hổng bảo mật một cách riêng tư, xem [SECURITY.md](SECURITY.md).

## Cách hoạt động

```
trình duyệt ──các phần──▶ server.js (web) ──────────────────┐     (STORAGE=local)
trình duyệt ──các phần──▶ bucket S3 ◀── ký URL ── server.js │     (STORAGE=s3)
trình duyệt ── WebCodecs (public/local.js) ── không upload gì      ("Nén ở: Trình duyệt này")
                     hàng đợi job (bộ nhớ hoặc Redis) ▼
                 worker ──▶ lib/media.js ──▶ ffmpeg / sharp / Ghostscript / whisper.cpp
terminal / agent ──▶ bin/cli.js ──▶ lib/media.js
```

| Đường dẫn | Là gì |
|---|---|
| [`lib/media.js`](lib/media.js) | Bộ xử lý nén: nhận diện loại file, khả năng của máy (VideoToolbox, HEIC), ffprobe, các encoder |
| [`lib/subtitles.js`](lib/subtitles.js) | Đọc/ghi SRT và WebVTT, chia câu phụ đề dễ đọc, tải model giọng nói |
| [`lib/storage.js`](lib/storage.js) | Nơi lưu file upload và kết quả (`local` hoặc `s3`) |
| [`lib/jobs.js`](lib/jobs.js) · [`lib/store.js`](lib/store.js) | Vòng đời job, và nơi lưu job cùng hàng đợi (`memory` hoặc `redis`) |
| [`lib/auth.js`](lib/auth.js) · [`lib/webhook.js`](lib/webhook.js) | Đăng nhập, và webhook có chữ ký |
| [`server.js`](server.js) | App Express: upload chia phần, API, ZIP, SSE; chạy như web, worker hoặc cả hai |
| [`bin/cli.js`](bin/cli.js) | CLI |
| [`public/`](public) | Giao diện web: HTML/CSS/JS thuần, không cần build (`local.js` = nén trên trình duyệt, `i18n.js` = bản dịch) |

## Phát triển

```bash
npm run dev             # giao diện web, tự khởi động lại khi sửa code
npm run typecheck       # kiểm tra kiểu JSDoc bằng TypeScript (không biên dịch gì)
npm test                # test API, CLI và đăng nhập (tự tạo file media mẫu bằng ffmpeg)
npx playwright install chromium firefox webkit   # chạy một lần
npm run test:e2e        # test trên trình duyệt Chromium, Firefox, WebKit
```

Chạy test ở chế độ lưu trữ S3, với bất kỳ server nào tương thích S3:

```bash
STORAGE=s3 S3_BUCKET=… S3_ENDPOINT=… S3_FORCE_PATH_STYLE=true S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… npm test
QUEUE=redis REDIS_URL=redis://localhost:6379 npm test       # chế độ hàng đợi dùng chung
```

Xem thêm [CONTRIBUTING.md](CONTRIBUTING.md) và [AGENTS.md](AGENTS.md).

**Phát hành bản mới:** tăng `version` trong `package.json`, rồi push tag `vX.Y.Z` tương ứng. CI sẽ build image cho nhiều kiến trúc và đăng lên Docker Hub và GHCR.

## Giấy phép

Mã nguồn dùng giấy phép [MIT](LICENSE). Compress Media chạy kèm phần mềm của bên thứ ba, mỗi phần mềm có giấy phép riêng:

| Thành phần | Giấy phép | Cách dùng |
|---|---|---|
| **FFmpeg** kèm x264/x265 | **GPL** | Chương trình riêng |
| **Ghostscript** (PDF) | **AGPL-3.0** | Chương trình riêng. Không có trong các image `-nopdf` (`runsnip/compress-media:2.0.0-nopdf`, `latest-nopdf`). |
| **sharp / libvips** | Apache-2.0 / **LGPL-3.0** | Liên kết động, thay thế được |
| **libheif** (Docker) | LGPL-3.0 | Chương trình riêng |
| **Mediabunny** (nén trên trình duyệt) | **MPL-2.0** | Phục vụ nguyên bản, không sửa |
| **whisper.cpp** (phụ đề) | MIT | Chương trình riêng. Model giọng nói (MIT) được tải ở lần dùng đầu, không đóng gói sẵn. |
| **Font DejaVu** (Docker) | Bitstream Vera / DejaVu (tự do) | Font để in phụ đề lên hình |
| AWS SDK, Express, BullMQ, ioredis, yazl… | Apache-2.0 / MIT / ISC / BSD | Thư viện |

Code của bạn dùng Compress Media không bị ảnh hưởng. **Nếu bạn phát hành lại image Docker**, image có chứa binary GPL/AGPL/LGPL và giấy phép của chúng áp dụng cho các binary đó. Xem **[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)** (tiếng Anh) để biết điều đó nghĩa là gì, lấy mã nguồn ở đâu, và lưu ý về bằng sáng chế H.264/H.265/AAC.

Phát triển bởi [RunSnip](https://runsnip.com).
