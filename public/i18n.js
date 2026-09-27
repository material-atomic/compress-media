'use strict';

/*
 * Tiny i18n layer.
 * - Static HTML carries English text and a `data-i18n` key; English is read back from the DOM,
 *   so only other languages need entries for those keys.
 * - Strings built in JS are looked up with t(key, vars) and need an entry in every language.
 * To add a language: copy the `vi` block, translate it and add a button in index.html.
 */
const I18N = {
  en: {
    // runtime strings
    waitingUpload: 'Waiting to upload · {size}',
    uploading: 'Uploading {pct}% · {size}',
    queued: 'Queued · {size}',
    compressing: 'Compressing {pct}%',
    remaining: '~{time} left',
    cancelled: 'Cancelled · {size}',
    genericError: 'Something went wrong',
    unsupported: 'This file type is not supported',
    uploadFailed: 'Upload failed ({status})',
    uploadInterrupted: 'Upload interrupted — is the server still running?',
    lostConnection: 'Lost connection to the server (it may have restarted)',
    keepOriginalBadge: 'keep the original',
    keepOriginalTitle: 'The original was already well optimised — keep it instead',
    took: 'took {time}',
    download: 'Download',
    view: 'View',
    redo: 'Redo',
    redoTitle: 'Compress again with the current settings',
    resume: 'Resume',
    resumeTitle: 'Continue the upload from where it stopped',
    cancel: 'Cancel',
    remove: 'Remove from list',
    filesDone: '{n} done',
    saved: 'saved {size} ({pct}%)',
    processing: '{n} in progress',
    original: 'Original',
    compressed: 'Compressed',
    lessThanSecond: 'under a second',
    seconds: '{s}s',
    minutes: '{m}m {s}s',
    hours: '{h}h {m}m',
    hardware: 'hardware',
    noAudio: 'no audio',
    keepFormat: 'Keep format',
    qHigh: 'High', qBalanced: 'Balanced', qSmall: 'Small', qTiny: 'Tiny',
    wrongLogin: 'Wrong username or password',
    tooManyAttempts: 'Too many failed attempts. Try again in 15 minutes.',
    encHardware: 'Hardware',
    trimEndPlaceholder: 'end',
    pdfScreen: 'Smallest', pdfEbook: 'Balanced', pdfPrinter: 'Print', pdfPrepress: 'Prepress',
    grayscaleShort: 'grayscale',
    compressingLocal: 'Compressing in this browser {pct}%',
    inBrowser: 'in browser',
    fellBack: 'Done on the server: {reason}',
    keptAnimation: 'Animated: kept as {format}',
  },

  vi: {
    // static HTML
    tagline: 'Video, ảnh, âm thanh — xử lý ngay trên máy bạn, không upload lên internet.',
    settingsLabel: 'Cài đặt nén',
    tabVideo: 'Video', tabImage: 'Ảnh', tabAudio: 'Âm thanh',
    quality: 'Chất lượng',
    qHigh: 'Cao', qBalanced: 'Cân bằng', qSmall: 'Nhỏ', qTiny: 'Rất nhỏ', qTarget: 'Theo MB',
    targetSize: 'Dung lượng mục tiêu',
    targetHint: 'Hữu ích khi app giới hạn dung lượng (Gmail 25 MB, Discord 10 MB…). Nén hai lượt bằng CPU để bám sát con số.',
    webmHint: 'Định dạng mở cho web (VP9 hoặc AV1 + Opus). Phát được trên mọi trình duyệt hiện đại.',
    gifHint: 'GIF động cho tài liệu, issue, tin nhắn. Không có tiếng; mặc định 480p và 12 fps.',
    av1Hint: 'File nhỏ nhất (nhỏ hơn H.265 khoảng 20–30%), nén chậm hơn. Phát được trên trình duyệt và điện thoại đời mới.',
    trim: 'Cắt đoạn',
    trimStart: 'Bắt đầu',
    trimEnd: 'Kết thúc',
    trimEndPlaceholder: 'hết',
    trimHint: 'Số giây hoặc phút:giây, ví dụ 5 và 1:30. Để trống để giữ cả video.',
    pdfScreen: 'Nhỏ nhất', pdfEbook: 'Cân bằng', pdfPrinter: 'In ấn', pdfPrepress: 'Chế bản',
    pdfScreenHint: 'Ảnh 72 dpi. Xem trên màn hình ổn, in ra sẽ mờ.',
    pdfEbookHint: 'Ảnh 150 dpi. Hợp để gửi CV, báo cáo, portfolio.',
    pdfPrinterHint: 'Ảnh 300 dpi để in. Chỉ nhỏ đi khi ảnh gốc lớn hơn mức đó.',
    pdfPrepressHint: 'Giữ ảnh chất lượng nhà in; chủ yếu dọn dẹp file.',
    grayscale: 'Chuyển sang đen trắng',
    grayscaleShort: 'đen trắng',
    whereLabel: 'Nén ở',
    whereServer: 'Server',
    whereBrowser: 'Trình duyệt này (beta)',
    whereBrowserHint: 'File không rời khỏi thiết bị này. Dùng CPU/GPU của bạn; việc trình duyệt không làm được (GIF, PDF, HEIC, AVIF, MP3…) vẫn gửi lên server.',
    compressingLocal: 'Đang nén trên trình duyệt {pct}%',
    inBrowser: 'trên trình duyệt',
    fellBack: 'Nén trên server: {reason}',
    keptAnimation: 'Ảnh động: giữ dạng {format}',
    codec: 'Định dạng nén',
    h264Hint: 'Phát được ở mọi nơi (web, Windows, Zalo, Messenger…).',
    h265Hint: 'Nhỏ hơn H.264 khoảng 30–50% với cùng chất lượng. Chạy tốt trên Apple, Android, Chrome mới.',
    encoder: 'Bộ mã hóa',
    encHardware: 'Phần cứng',
    cpuHint: 'File nhỏ nhất, chậm hơn.',
    hwHint: 'Nhanh gấp nhiều lần nhờ GPU, file lớn hơn một chút.',
    speed: 'Tốc độ nén',
    spFast: 'Nhanh', spMedium: 'Vừa', spSlow: 'Chậm · nhỏ hơn',
    maxResolution: 'Độ phân giải tối đa',
    maxFps: 'FPS tối đa',
    keepOriginal: 'Giữ nguyên',
    audioTrack: 'Âm thanh',
    aKeep: 'Giữ', aLow: 'Giảm (mono)', aRemove: 'Bỏ tiếng',
    outputFormat: 'Định dạng đầu ra',
    fmtKeep: 'Giữ nguyên',
    fmtAutoHint: 'HEIC sẽ chuyển sang JPEG. GIF động giữ nguyên GIF.',
    fmtWebpHint: 'Nhỏ hơn JPEG ~25–35%, hỗ trợ ảnh động & nền trong suốt.',
    fmtAvifHint: 'Nhỏ nhất, nhưng nén chậm hơn và một số app cũ chưa mở được.',
    fmtPngHint: 'Giảm số màu (như pngquant) — hợp với ảnh chụp màn hình, logo.',
    maxDim: 'Cạnh dài tối đa',
    keepMeta: 'Giữ metadata (EXIF, vị trí GPS, ngày chụp)',
    br48: '48 kbps — giọng nói',
    br128: '128 kbps — nhạc',
    monoHint: 'Chuyển sang mono (giảm thêm ~½ cho ghi âm giọng nói)',
    footHint: 'Cài đặt áp dụng cho file thêm mới. Với file đã nén, bấm <b>Nén lại</b> để dùng cài đặt hiện tại.',
    dropTitle: 'Kéo thả file vào đây',
    dropHint: 'hoặc bấm để chọn · Video (MOV, MP4…), ảnh (JPG, PNG, HEIC, GIF…), âm thanh (M4A, WAV…), PDF',
    downloadAll: 'Tải tất cả (ZIP)',
    clearList: 'Xóa danh sách',
    close: 'Đóng',
    license: 'Mã nguồn mở · Giấy phép MIT',
    signInTitle: 'Đăng nhập',
    signInHint: 'Máy chủ Compress Media này là riêng tư.',
    usernameLabel: 'Tên đăng nhập hoặc email',
    passwordLabel: 'Mật khẩu',
    signIn: 'Đăng nhập',
    signOut: 'Đăng xuất',
    wrongLogin: 'Sai tên đăng nhập hoặc mật khẩu',
    tooManyAttempts: 'Sai quá nhiều lần. Hãy thử lại sau 15 phút.',

    // runtime strings
    waitingUpload: 'Chờ tải lên · {size}',
    uploading: 'Đang tải lên {pct}% · {size}',
    queued: 'Đang chờ đến lượt · {size}',
    compressing: 'Đang nén {pct}%',
    remaining: 'còn ~{time}',
    cancelled: 'Đã hủy · {size}',
    genericError: 'Có lỗi xảy ra',
    unsupported: 'Loại file này chưa được hỗ trợ',
    uploadFailed: 'Tải lên thất bại ({status})',
    uploadInterrupted: 'Tải lên bị gián đoạn — server còn chạy không?',
    lostConnection: 'Mất kết nối với server (có thể server đã khởi động lại)',
    keepOriginalBadge: 'nên giữ bản gốc',
    keepOriginalTitle: 'File gốc đã được tối ưu sẵn — nên giữ bản gốc',
    took: 'mất {time}',
    download: 'Tải về',
    view: 'Xem',
    redo: 'Nén lại',
    redoTitle: 'Nén lại với cài đặt hiện tại',
    resume: 'Tải tiếp',
    resumeTitle: 'Tiếp tục tải lên từ chỗ bị dừng',
    cancel: 'Hủy',
    remove: 'Xóa khỏi danh sách',
    filesDone: '{n} file xong',
    saved: 'tiết kiệm {size} ({pct}%)',
    processing: '{n} file đang xử lý',
    original: 'Bản gốc',
    compressed: 'Sau khi nén',
    lessThanSecond: 'chưa tới 1 giây',
    seconds: '{s} giây',
    minutes: '{m} phút {s} giây',
    hours: '{h} giờ {m} phút',
    hardware: 'phần cứng',
    noAudio: 'không tiếng',
    keepFormat: 'Giữ định dạng',
  },
};
const LANG_KEY = 'compress-media:lang';
let lang = 'en';
try {
  lang = localStorage.getItem(LANG_KEY) || '';
} catch { /* ignore */ }
if (!I18N[lang]) {
  const browser = (navigator.language || 'en').slice(0, 2).toLowerCase();
  lang = I18N[browser] ? browser : 'en';
}

/** English defaults for static HTML, captured from the markup on first run. */
const htmlDefaults = new Map();

function t(key, vars = {}) {
  const str = I18N[lang][key] ?? I18N.en[key] ?? htmlDefaults.get(key) ?? key;
  return str.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
}

function applyI18n() {
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll('[data-i18n]')) {
    const key = el.dataset.i18n;
    if (!htmlDefaults.has(key)) htmlDefaults.set(key, el.textContent);
    el.textContent = lang === 'en' ? htmlDefaults.get(key) : I18N[lang][key] ?? htmlDefaults.get(key);
  }
  for (const el of document.querySelectorAll('[data-i18n-html]')) {
    const key = el.dataset.i18nHtml;
    if (!htmlDefaults.has(key)) htmlDefaults.set(key, el.innerHTML);
    el.innerHTML = lang === 'en' ? htmlDefaults.get(key) : I18N[lang][key] ?? htmlDefaults.get(key);
  }
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) {
    const key = el.dataset.i18nPlaceholder;
    if (!htmlDefaults.has(key)) htmlDefaults.set(key, el.getAttribute('placeholder'));
    el.setAttribute('placeholder', lang === 'en' ? htmlDefaults.get(key) : I18N[lang][key] ?? htmlDefaults.get(key));
  }
  for (const el of document.querySelectorAll('[data-i18n-aria-label]')) {
    const key = el.dataset.i18nAriaLabel;
    if (!htmlDefaults.has(key)) htmlDefaults.set(key, el.getAttribute('aria-label'));
    el.setAttribute('aria-label', lang === 'en' ? htmlDefaults.get(key) : I18N[lang][key] ?? htmlDefaults.get(key));
  }
  for (const b of document.querySelectorAll('[data-lang]')) b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
}

function setLang(next) {
  if (!I18N[next] || next === lang) return;
  lang = next;
  try { localStorage.setItem(LANG_KEY, lang); } catch { /* ignore */ }
  applyI18n();
  document.dispatchEvent(new CustomEvent('langchange'));
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-lang]');
  if (b) setLang(b.dataset.lang);
});

applyI18n();
