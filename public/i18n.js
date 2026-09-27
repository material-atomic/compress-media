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
  },

  vi: {
    // static HTML
    tagline: 'Video, ảnh, âm thanh — xử lý ngay trên máy bạn, không upload lên internet.',
    settingsLabel: 'Cài đặt nén',
    tabVideo: 'Video', tabImage: 'Ảnh', tabAudio: 'Âm thanh',
    quality: 'Chất lượng',
    qHigh: 'Cao', qBalanced: 'Cân bằng', qSmall: 'Nhỏ', qTiny: 'Rất nhỏ', qTarget: 'Theo MB',
    targetSize: 'Dung lượng mục tiêu',
    targetHint: 'Hữu ích khi app giới hạn dung lượng (Gmail 25 MB, Discord 10 MB…). Chế độ này luôn nén bằng CPU để bám sát con số.',
    codec: 'Định dạng nén',
    h264Hint: 'Phát được ở mọi nơi (web, Windows, Zalo, Messenger…).',
    h265Hint: 'Nhỏ hơn H.264 khoảng 30–50% với cùng chất lượng. Chạy tốt trên Apple, Android, Chrome mới.',
    encoder: 'Bộ mã hóa',
    encHardware: 'Phần cứng Apple',
    cpuHint: 'File nhỏ nhất, chậm hơn.',
    hwHint: 'Nhanh gấp nhiều lần (VideoToolbox), file lớn hơn một chút.',
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
    dropHint: 'hoặc bấm để chọn · Video (MOV, MP4…), ảnh (JPG, PNG, HEIC, GIF…), âm thanh (M4A, WAV…)',
    downloadAll: 'Tải tất cả',
    clearList: 'Xóa danh sách',
    close: 'Đóng',
    license: 'Mã nguồn mở · Giấy phép MIT',

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
