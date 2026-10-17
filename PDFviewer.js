/* ==========================================================================
   pdfREADER - TRÌNH ĐỌC SÁCH & TÀI LIỆU CHUYÊN NGHIỆP
   Bản nâng cấp trải nghiệm người dùng toàn diện:
   - Chế độ đọc linh hoạt: Trang đơn, Trang đôi, Sách in có bìa riêng (Book cover).
   - Tự động ghi nhớ trang đọc dở dang và lưu tủ sách IndexedDB.
   - Giao diện Dark Mode, Sepia dịu mắt với bộ lọc ban đêm thông minh.
   - Thanh Dock điều khiển nổi (Floating Pill) tích hợp Scrubber cuộn lướt nhanh.
   - Sidebar hợp nhất: Mục lục (Outline PDF + Tự sinh 3 tầng), Lưới trang 2 cột, Dấu trang.
   - Tìm kiếm toàn văn bản trong PDF (Full-text Search).
   - Kéo thả file PDF trực tiếp vào màn hình đọc.
   ========================================================================== */

import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";

const $ = (id) => document.getElementById(id);

// --- Các phần tử DOM chính ---
const readerView = $("reader-view");
const topBar = $("top-bar");
const docTitle = $("doc-title");
const docBadge = $("doc-badge");

const bookView = $("book-view");
const pagesEl = $("pages");
const leftCanvas = $("left-canvas");
const rightCanvas = $("right-canvas");
const curl = $("curl");

const floatingDock = $("floating-dock");
const dockShowBtn = $("dock-show-btn");
const prevBtn = $("prev-btn");
const nextBtn = $("next-btn");
const pageInput = $("page-input");
const pageTotal = $("page-total");
const pageScrubber = $("page-scrubber");
const zoomInput = $("zoom-input");
const zoomOutBtn = $("zoom-out-btn");
const zoomInBtn = $("zoom-in-btn");
const zoomResetBtn = $("zoom-reset-btn");
const dockHideBtn = $("dock-hide-btn");

const sidebarDrawer = $("sidebar-drawer");
const sidebarToggleBtn = $("sidebar-toggle-btn");
const sidebarCloseBtn = $("sidebar-close-btn");
const tabBtnToc = $("tab-btn-toc");
const tabBtnThumbs = $("tab-btn-thumbs");
const tabBtnBookmarks = $("tab-btn-bookmarks");
const paneToc = $("pane-toc");
const paneThumbs = $("pane-thumbs");
const paneBookmarks = $("pane-bookmarks");
const thumbsGrid = $("thumbs-grid");
const bookmarksList = $("bookmarks-list");
const bookmarkToggleBtn = $("bookmark-toggle-btn");
const bookmarkCurrentBtn = $("bookmark-current-btn");

const searchModal = $("search-modal");
const searchOpenBtn = $("search-open-btn");
const searchCloseBtn = $("search-close-btn");
const searchQueryInput = $("search-query-input");
const searchExecBtn = $("search-exec-btn");
const searchStatus = $("search-status");
const searchResults = $("search-results");

const shortcutsModal = $("shortcuts-modal");
const helpBtn = $("help-btn");
const shortcutsCloseBtn = $("shortcuts-close-btn");
const fullscreenBtn = $("fullscreen-btn");
const fullscreenTopbarShowBtn = $("fullscreen-topbar-show-btn");
const fullscreenTopbarHideBtn = $("fullscreen-topbar-hide-btn");

const viewerFileInput = $("viewer-file-input");
const viewerOpenFileBtn = $("viewer-open-file-btn");
const viewerDropOverlay = $("viewer-drop-overlay");
const toastContainer = $("toast-container");

// Cụm chế độ trang
const modeSingleBtn = $("mode-single-btn");
const modeSpreadBtn = $("mode-spread-btn");
const modeBookBtn = $("mode-book-btn");

// Giới hạn Zoom & Canvas
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4.0;
const MAX_CANVAS_PIXELS = matchMedia("(pointer: coarse)").matches ? 16e6 : 32e6;
const MAX_CANVAS_SIDE = 16384;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ==========================================================================
// 1. TRẠNG THÁI ỨNG DỤNG (STATE)
// ==========================================================================
let pdf = null;
let fileKey = "";
let currentDocName = "Tài liệu PDF";
let spreadStart = 1; // Trang bắt đầu của khung hiển thị hiện tại
let wantedZoom = 1;
let shownZoom = 1;
let zoomOrigin = null;
let zoomTimer = 0;

// Chế độ hiển thị trang: 'book' (bìa riêng), 'spread' (cặp trang), 'single' (trang đơn)
let pageMode = localStorage.getItem("readerPageMode") || "book";

// Danh sách dấu trang cá nhân (Bookmarks)
let bookmarks = new Set();

// ==========================================================================
// 2. TÍNH TOÁN CẶP TRANG & ĐIỀU HƯỚNG
// ==========================================================================
function getVisiblePageNumbers(page, mode = pageMode) {
  if (!pdf) return [1];
  const p = clamp(Math.round(page) || 1, 1, pdf.numPages);

  if (mode === "single") {
    return [p];
  } else if (mode === "spread") {
    const start = p % 2 === 1 ? p : p - 1;
    return start < pdf.numPages ? [start, start + 1] : [start];
  } else {
    // Mode 'book' (Trang 1 là bìa riêng)
    if (p === 1) return [1];
    const start = p % 2 === 0 ? p : p - 1;
    return start < pdf.numPages ? [start, start + 1] : [start];
  }
}

function goToPage(page) {
  if (!pdf) return;
  const target = clamp(Math.round(page) || 1, 1, pdf.numPages);
  const visible = getVisiblePageNumbers(target, pageMode);
  spreadStart = visible[0];

  updateUI();
  saveReadingProgress();
  requestRender({ resetScroll: true });
}

function nextSpread() {
  if (!pdf || nextBtn.disabled) return;
  if (pageMode === "single") {
    goToPage(spreadStart + 1);
  } else if (pageMode === "spread") {
    goToPage(spreadStart + 2);
  } else {
    // Mode 'book'
    if (spreadStart === 1) goToPage(2);
    else goToPage(spreadStart + 2);
  }
}

function prevSpread() {
  if (!pdf || prevBtn.disabled) return;
  if (pageMode === "single") {
    goToPage(spreadStart - 1);
  } else if (pageMode === "spread") {
    goToPage(spreadStart - 2);
  } else {
    // Mode 'book'
    if (spreadStart <= 3) goToPage(1);
    else goToPage(spreadStart - 2);
  }
}

// ==========================================================================
// 3. VÒNG LẶP VẼ CANVAS (RENDER LOOP)
// ==========================================================================
let needsRender = false;
let rendering = false;
let resetScrollNext = false;
let activeTasks = [];

function requestRender({ resetScroll = false } = {}) {
  if (!pdf) return;
  needsRender = true;
  resetScrollNext ||= resetScroll;
  activeTasks.forEach((task) => task.cancel());
  if (!rendering) renderLoop();
}

async function renderLoop() {
  rendering = true;
  while (needsRender) {
    needsRender = false;
    try {
      await drawSpread();
    } catch (err) {
      if (err?.name !== "RenderingCancelledException") console.error(err);
    }
  }
  rendering = false;
}

async function drawSpread() {
  if (!pdf) return;
  const visibleNumbers = getVisiblePageNumbers(spreadStart, pageMode);
  const drawZoom = wantedZoom;

  const pages = await Promise.all(visibleNumbers.map(n => pdf.getPage(n)));

  // Tính scale vừa khung
  const base = pages.map((p) => p.getViewport({ scale: 1 }));
  const availW = Math.max(1, bookView.clientWidth - 32);
  const availH = Math.max(1, bookView.clientHeight - 32);

  const totalW = base.reduce((sum, v) => sum + v.width, 0);
  const maxH = Math.max(...base.map((v) => v.height));

  const fit = Math.min(availW / totalW, availH / maxH);
  const scale = fit * drawZoom;

  activeTasks = [];
  const images = await Promise.all(pages.map((p) => renderToBuffer(p, scale)));

  const zoomChanged = drawZoom !== shownZoom;
  const beforeW = pagesEl.offsetWidth || 1;
  const beforeH = pagesEl.offsetHeight || 1;

  showOnCanvas(leftCanvas, images[0]);
  if (images[1]) {
    showOnCanvas(rightCanvas, images[1]);
  } else {
    rightCanvas.style.display = "none";
  }

  shownZoom = drawZoom;
  updatePreview();

  if (resetScrollNext) {
    bookView.scrollLeft = 0;
    bookView.scrollTop = 0;
    resetScrollNext = false;
  } else if (zoomChanged && zoomOrigin) {
    bookView.scrollLeft =
      pagesEl.offsetLeft +
      zoomOrigin.x * (pagesEl.offsetWidth / beforeW) -
      zoomOrigin.ax;
    bookView.scrollTop =
      pagesEl.offsetTop +
      zoomOrigin.y * (pagesEl.offsetHeight / beforeH) -
      zoomOrigin.ay;
  }

  updateUI();
}

async function renderToBuffer(page, scale) {
  const css = page.getViewport({ scale });
  const dpr = Math.min(
    window.devicePixelRatio || 1,
    Math.sqrt(MAX_CANVAS_PIXELS / (css.width * css.height)),
    MAX_CANVAS_SIDE / Math.max(css.width, css.height),
  );
  const viewport = page.getViewport({ scale: scale * dpr });
  const buffer = document.createElement("canvas");
  buffer.width = Math.max(1, Math.round(viewport.width));
  buffer.height = Math.max(1, Math.round(viewport.height));

  const task = page.render({
    canvasContext: buffer.getContext("2d"),
    viewport,
  });
  activeTasks.push(task);
  await task.promise;

  return {
    buffer,
    cssWidth: buffer.width / dpr,
    cssHeight: buffer.height / dpr,
  };
}

function showOnCanvas(canvas, image) {
  canvas.width = image.buffer.width;
  canvas.height = image.buffer.height;
  canvas.style.width = image.cssWidth + "px";
  canvas.style.height = image.cssHeight + "px";
  canvas.getContext("2d").drawImage(image.buffer, 0, 0);
  image.buffer.width = 0;
  canvas.style.display = "block";
}

// ==========================================================================
// 4. ZOOM
// ==========================================================================
function updatePreview() {
  const k = wantedZoom / shownZoom;
  pagesEl.style.transform = k === 1 ? "" : `scale(${k})`;
}

function zoomTo(value, ax = bookView.clientWidth / 2, ay = bookView.clientHeight / 2, delay = 0) {
  if (!pdf) return;
  if (wantedZoom === shownZoom) {
    zoomOrigin = {
      ax,
      ay,
      x: bookView.scrollLeft + ax - pagesEl.offsetLeft,
      y: bookView.scrollTop + ay - pagesEl.offsetTop,
    };
    pagesEl.style.transformOrigin = `${zoomOrigin.x}px ${zoomOrigin.y}px`;
  }
  wantedZoom = clamp(value, MIN_ZOOM, MAX_ZOOM);
  updatePreview();
  updateUI();
  clearTimeout(zoomTimer);
  zoomTimer = setTimeout(requestRender, delay);
}

// ==========================================================================
// 5. CẬP NHẬT GIAO DIỆN & TIẾN ĐỘ ĐỌC (UI & PROGRESS)
// ==========================================================================
function updateUI() {
  if (!pdf) return;
  const visible = getVisiblePageNumbers(spreadStart, pageMode);
  const currentNum = visible[0];
  const progressPct = Math.round((currentNum / pdf.numPages) * 100);

  if (document.activeElement !== pageInput) pageInput.value = currentNum;
  if (document.activeElement !== pageScrubber) pageScrubber.value = currentNum;
  if (document.activeElement !== zoomInput) zoomInput.value = Math.round(wantedZoom * 100);

  pageTotal.textContent = pdf.numPages;
  pageScrubber.max = pdf.numPages;

  // Cập nhật nhãn thanh đỉnh
  const rangeStr = visible.length > 1 ? `${visible[0]}–${visible[1]}` : `${visible[0]}`;
  docBadge.textContent = `Trang ${rangeStr}/${pdf.numPages} (${progressPct}%)`;

  // Nút Prev / Next
  prevBtn.disabled = spreadStart <= 1;
  const lastVisible = visible[visible.length - 1];
  nextBtn.disabled = lastVisible >= pdf.numPages;

  // Cập nhật trạng thái Bookmark cho trang hiện tại
  const isBookmarked = bookmarks.has(currentNum);
  bookmarkToggleBtn.classList.toggle("active", isBookmarked);
  const bookmarkIcon = $("bookmark-icon");
  if (bookmarkIcon) {
    bookmarkIcon.setAttribute("fill", isBookmarked ? "currentColor" : "none");
  }

  // Cập nhật active thumbnail trong sidebar
  updateActiveThumbnail(currentNum);
}

function updateActiveThumbnail(activePage) {
  const currentItem = thumbsGrid.querySelector(".thumb-item.current");
  if (currentItem && Number(currentItem.dataset.page) !== activePage) {
    currentItem.classList.remove("current");
  }
  const newItem = thumbsGrid.querySelector(`.thumb-item[data-page="${activePage}"]`);
  if (newItem) {
    newItem.classList.add("current");
  }
}

function showToast(message, duration = 2500) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.innerHTML = `
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
      <polyline points="22 4 12 14.01 9 11.01"></polyline>
    </svg>
    <span>${message}</span>
  `;
  toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.transition = "opacity 0.25s ease, transform 0.25s ease";
    toast.style.opacity = "0";
    toast.style.transform = "translateY(-8px)";
    setTimeout(() => toast.remove(), 260);
  }, duration);
}

// ==========================================================================
// 6. LƯU TIẾN ĐỘ VÀO INDEXEDDB & LOCALSTORAGE
// ==========================================================================
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("pdf-reader", 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("files")) db.createObjectStore("files");
      if (!db.objectStoreNames.contains("recents")) db.createObjectStore("recents", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveReadingProgress() {
  if (!pdf || !fileKey) return;
  try {
    localStorage.setItem("lastPage:" + fileKey, String(spreadStart));
    const db = await openDatabase();
    const tx = db.transaction("recents", "readwrite");
    const store = tx.objectStore("recents");
    const getReq = store.get(fileKey);
    getReq.onsuccess = () => {
      const item = getReq.result;
      if (item) {
        item.lastPage = spreadStart;
        item.totalPages = pdf.numPages;
        item.lastOpened = Date.now();
        store.put(item);
      }
    };
  } catch (err) {
    console.warn("Không thể lưu tiến độ đọc:", err);
  }
}

function loadSavedBookmarks() {
  try {
    const raw = localStorage.getItem("bookmarks:" + fileKey);
    bookmarks = new Set(raw ? JSON.parse(raw) : []);
  } catch {
    bookmarks = new Set();
  }
  renderBookmarksList();
}

function saveBookmarks() {
  try {
    localStorage.setItem("bookmarks:" + fileKey, JSON.stringify([...bookmarks]));
  } catch { }
  renderBookmarksList();
}

function toggleBookmark(page = spreadStart) {
  if (bookmarks.has(page)) {
    bookmarks.delete(page);
    showToast(`Đã bỏ đánh dấu trang ${page}`);
  } else {
    bookmarks.add(page);
    showToast(`Đã thêm trang ${page} vào dấu trang`);
  }
  saveBookmarks();
  updateUI();
}

function renderBookmarksList() {
  bookmarksList.replaceChildren();
  if (!bookmarks.size) {
    const empty = document.createElement("p");
    empty.style.color = "var(--muted)";
    empty.style.fontSize = "0.8125rem";
    empty.style.textAlign = "center";
    empty.style.marginTop = "24px";
    empty.textContent = "Chưa có trang nào được đánh dấu.";
    bookmarksList.appendChild(empty);
    return;
  }

  const sorted = [...bookmarks].sort((a, b) => a - b);
  sorted.forEach(page => {
    const item = document.createElement("div");
    item.className = "bookmark-item";
    item.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px;">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="var(--accent)" stroke="var(--accent)" stroke-width="2">
          <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"></path>
        </svg>
        <span class="bookmark-item-title">Trang ${page}</span>
      </div>
      <button type="button" class="bookmark-item-del" title="Xóa dấu trang" data-page="${page}">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    `;

    item.addEventListener("click", (e) => {
      if (e.target.closest(".bookmark-item-del")) return;
      goToPage(page);
    });

    item.querySelector(".bookmark-item-del").addEventListener("click", (e) => {
      e.stopPropagation();
      bookmarks.delete(page);
      saveBookmarks();
      updateUI();
    });

    bookmarksList.appendChild(item);
  });
}

// ==========================================================================
// 7. TẢI TÀI LIỆU PDF & KHỞI CHẠY (INITIALIZATION)
// ==========================================================================
async function loadStoredFile() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction("files").objectStore("files").get("current");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function loadPdf() {
  const storedFile = await loadStoredFile();
  if (!storedFile?.bytes) {
    location.replace("./index.html");
    return;
  }

  try {
    currentDocName = storedFile.name || "Tài liệu PDF";
    docTitle.textContent = currentDocName;
    docTitle.title = currentDocName;
    document.title = `${currentDocName} - Trình xem PDF`;

    const doc = await pdfjsLib.getDocument({ data: storedFile.bytes }).promise;
    const oldDoc = pdf;
    pdf = doc;
    oldDoc?.destroy();

    fileKey = storedFile.id || `${storedFile.name}|${storedFile.size}`;

    // Khôi phục trang đọc gần nhất
    let initialPage = 1;
    try {
      const saved = Number(localStorage.getItem("lastPage:" + fileKey));
      if (saved && saved >= 1 && saved <= doc.numPages) {
        initialPage = saved;
      }
    } catch { }

    spreadStart = initialPage;
    wantedZoom = shownZoom = 1;

    // Khôi phục TOC settings
    try {
      tocOffset = Number(localStorage.getItem("tocOff:" + fileKey)) || 0;
    } catch {
      tocOffset = 0;
    }
    tocOffsetInput.value = tocOffset;

    // Tải bookmarks
    loadSavedBookmarks();

    // Cập nhật chế độ trang hiển thị
    setPageMode(pageMode, false);

    readerView.hidden = false;
    updateUI();
    requestRender({ resetScroll: true });

    // Thông báo nếu tiếp tục từ trang cũ
    if (initialPage > 1) {
      showToast(`Đã tiếp tục từ trang ${initialPage}`);
    }

    // Dựng sẵn danh sách trang thu nhỏ (Thumbnails Grid)
    buildThumbnailsGrid();

    // Mở Outline nếu có
    prepareToc();

  } catch (err) {
    console.error("Lỗi nạp PDF:", err);
    location.replace("./index.html");
  }
}

// ==========================================================================
// 8. CHẾ ĐỘ HIỂN THỊ TRANG (PAGE MODES)
// ==========================================================================
function setPageMode(newMode, shouldRender = true) {
  pageMode = newMode;
  bookView.dataset.mode = newMode;
  localStorage.setItem("readerPageMode", newMode);

  modeSingleBtn.classList.toggle("active", newMode === "single");
  modeSpreadBtn.classList.toggle("active", newMode === "spread");
  modeBookBtn.classList.toggle("active", newMode === "book");

  if (shouldRender) {
    goToPage(spreadStart);
  }
}

modeSingleBtn.addEventListener("click", () => setPageMode("single"));
modeSpreadBtn.addEventListener("click", () => setPageMode("spread"));
modeBookBtn.addEventListener("click", () => setPageMode("book"));

// ==========================================================================
// 9. THEME CHẾ ĐỘ ĐỌC (LIGHT / SEPIA / DARK)
// ==========================================================================
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("readerTheme", theme);
  document.querySelectorAll(".theme-switch-group .segmented-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.themeVal === theme);
  });
}

const initialTheme = localStorage.getItem("readerTheme") || "light";
applyTheme(initialTheme);

document.querySelectorAll(".theme-switch-group .segmented-btn").forEach(btn => {
  btn.addEventListener("click", () => applyTheme(btn.dataset.themeVal));
});

// ==========================================================================
// 10. SỰ KIỆN ĐIỀU KHIỂN & THANH DOCK
// ==========================================================================
$("open-btn").addEventListener("click", () => location.href = "./index.html");
prevBtn.addEventListener("click", prevSpread);
nextBtn.addEventListener("click", nextSpread);

pageInput.addEventListener("change", () => goToPage(Number(pageInput.value)));
pageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") pageInput.blur();
});
pageInput.addEventListener("focus", () => pageInput.select());

// Thanh trượt Scrubber lướt trang
pageScrubber.addEventListener("input", () => {
  const target = Number(pageScrubber.value);
  const visible = getVisiblePageNumbers(target, pageMode);
  docBadge.textContent = `Trang ${visible[0]}/${pdf.numPages} (${Math.round((visible[0] / pdf.numPages) * 100)}%)`;
});
pageScrubber.addEventListener("change", () => {
  goToPage(Number(pageScrubber.value));
});

zoomInput.addEventListener("change", () => zoomTo(Number(zoomInput.value) / 100 || 1));
zoomInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") zoomInput.blur();
});
zoomOutBtn.addEventListener("click", () => zoomTo(wantedZoom / 1.25));
zoomInBtn.addEventListener("click", () => zoomTo(wantedZoom * 1.25));
zoomResetBtn.addEventListener("click", () => zoomTo(1));

// Ẩn / Hiện thanh Dock
function setDockHidden(hidden) {
  floatingDock.classList.toggle("is-hidden", hidden);
  dockShowBtn.hidden = !hidden;
  localStorage.setItem("dockHidden", hidden ? "1" : "0");
}
dockHideBtn.addEventListener("click", () => setDockHidden(true));
dockShowBtn.addEventListener("click", () => setDockHidden(false));
if (localStorage.getItem("dockHidden") === "1") setDockHidden(true);

// Bookmarks
bookmarkToggleBtn.addEventListener("click", () => toggleBookmark(spreadStart));
bookmarkCurrentBtn.addEventListener("click", () => toggleBookmark(spreadStart));

// ==========================================================================
// 11. THAO TÁC CHUỘT, VUỐT TRANG VÀ GẬP GÓC (CURL & DRAG)
// ==========================================================================
// Cuộn chuột = zoom quanh vị trí con trỏ
bookView.addEventListener("wheel", (e) => {
  if (!pdf) return;
  e.preventDefault();
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  const rect = bookView.getBoundingClientRect();
  zoomTo(
    wantedZoom * Math.exp(-dy * 0.002),
    e.clientX - rect.left,
    e.clientY - rect.top,
    140,
  );
}, { passive: false });

let drag = null;
let curlTimer = 0;

bookView.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  drag = {
    x: e.clientX,
    y: e.clientY,
    left: bookView.scrollLeft,
    top: bookView.scrollTop,
    moved: false,
    mode: "pan",
    lastX: e.clientX,
    lastT: performance.now(),
    vx: 0,
  };
});

bookView.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 5) return;
  if (!drag.moved) {
    drag.moved = true;
    const fits = bookView.scrollWidth <= bookView.clientWidth + 1;
    drag.mode = fits && Math.abs(dx) > Math.abs(dy) && wantedZoom === shownZoom ? "swipe" : "pan";
    bookView.setPointerCapture(e.pointerId);
    bookView.classList.add("is-dragging");
  }

  if (drag.mode === "swipe") {
    const now = performance.now();
    drag.vx = 0.7 * drag.vx + 0.3 * ((e.clientX - drag.lastX) / Math.max(1, now - drag.lastT));
    drag.lastX = e.clientX;
    drag.lastT = now;
    const dir = dx < 0 ? 1 : -1;
    if (dir > 0 ? !nextBtn.disabled : !prevBtn.disabled) showCurl(dir, dx);
    else hideCurl(false);
  } else {
    bookView.scrollLeft = drag.left - dx;
    bookView.scrollTop = drag.top - dy;
  }
});

function showCurl(dir, dx) {
  clearTimeout(curlTimer);
  const size = Math.min(Math.abs(dx) * 0.8, 200, pagesEl.offsetWidth / 2);
  curl.classList.toggle("prev", dir < 0);
  curl.classList.add("on");
  curl.style.transition = "none";
  curl.style.width = curl.style.height = size + "px";
}

function hideCurl(animated) {
  clearTimeout(curlTimer);
  if (!animated) {
    curl.classList.remove("on");
    return;
  }
  curl.style.transition = "width .15s ease-out, height .15s ease-out";
  curl.style.width = curl.style.height = "0px";
  curlTimer = setTimeout(() => curl.classList.remove("on"), 160);
}

function finishSwipe(dx, vx) {
  const dir = dx < 0 ? 1 : -1;
  const far = Math.abs(dx) > Math.min(120, bookView.clientWidth * 0.15);
  const flick = Math.abs(vx) > 0.5 && Math.sign(vx) === Math.sign(dx);
  const canTurn = dir > 0 ? !nextBtn.disabled : !prevBtn.disabled;
  if ((far || flick) && canTurn) {
    hideCurl(false);
    if (dir > 0) nextSpread();
    else prevSpread();
  } else {
    hideCurl(true);
  }
}

bookView.addEventListener("pointerup", (e) => {
  if (drag && !drag.moved) {
    if (document.fullscreenElement && !topBar.classList.contains("is-fullscreen-hidden")) {
      setFullscreenTopbarHidden(true);
    }
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el === leftCanvas) {
      if (pageMode === "single") nextSpread();
      else prevSpread();
    } else if (el === rightCanvas) {
      nextSpread();
    }
  } else if (drag?.mode === "swipe") {
    finishSwipe(e.clientX - drag.x, drag.vx);
  }
  drag = null;
  bookView.classList.remove("is-dragging");
});

bookView.addEventListener("pointercancel", () => {
  if (drag?.mode === "swipe") hideCurl(true);
  drag = null;
  bookView.classList.remove("is-dragging");
});

// ==========================================================================
// 12. UNIFIED SIDEBAR (DRAWER: MỤC LỤC, THUMBNAILS, BOOKMARKS)
// ==========================================================================
function openSidebar(defaultTab) {
  sidebarDrawer.classList.add("is-open");
  sidebarToggleBtn.classList.add("active");
  if (defaultTab) switchTab(defaultTab);
}

function closeSidebar() {
  sidebarDrawer.classList.remove("is-open");
  sidebarToggleBtn.classList.remove("active");
}

sidebarToggleBtn.addEventListener("click", () => {
  if (sidebarDrawer.classList.contains("is-open")) closeSidebar();
  else openSidebar();
});
sidebarCloseBtn.addEventListener("click", closeSidebar);

function switchTab(tabName) {
  tabBtnToc.classList.toggle("active", tabName === "toc");
  tabBtnThumbs.classList.toggle("active", tabName === "thumbs");
  tabBtnBookmarks.classList.toggle("active", tabName === "bookmarks");

  paneToc.classList.toggle("active", tabName === "toc");
  paneThumbs.classList.toggle("active", tabName === "thumbs");
  paneBookmarks.classList.toggle("active", tabName === "bookmarks");

  if (tabName === "thumbs") {
    const cur = thumbsGrid.querySelector(".thumb-item.current");
    cur?.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

tabBtnToc.addEventListener("click", () => switchTab("toc"));
tabBtnThumbs.addEventListener("click", () => switchTab("thumbs"));
tabBtnBookmarks.addEventListener("click", () => switchTab("bookmarks"));

// --- Dựng lưới Thumbnail (Thumbnails Grid 2 cột) ---
let thumbsObserver = null;
async function buildThumbnailsGrid() {
  if (!pdf) return;
  thumbsGrid.replaceChildren();
  thumbsObserver?.disconnect();

  const frag = document.createDocumentFragment();
  const samplePage = await pdf.getPage(1);
  const sampleVp = samplePage.getViewport({ scale: 1 });
  const ratio = sampleVp.height / sampleVp.width;

  for (let n = 1; n <= pdf.numPages; n++) {
    const item = document.createElement("div");
    item.className = "thumb-item" + (n === spreadStart ? " current" : "");
    item.dataset.page = n;

    const canvas = document.createElement("canvas");
    canvas.style.aspectRatio = `1 / ${ratio}`;

    const label = document.createElement("span");
    label.className = "thumb-page-label";
    label.textContent = `Trang ${n}`;

    item.append(canvas, label);
    item.addEventListener("click", () => {
      goToPage(n);
    });

    frag.append(item);
  }

  thumbsGrid.appendChild(frag);

  thumbsObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      thumbsObserver.unobserve(entry.target);
      const pageNum = Number(entry.target.dataset.page);
      renderThumbnail(entry.target.querySelector("canvas"), pageNum);
    }
  }, { root: paneThumbs, rootMargin: "300px" });

  thumbsGrid.querySelectorAll(".thumb-item").forEach(el => thumbsObserver.observe(el));
}

async function renderThumbnail(canvas, pageNum) {
  try {
    const page = await pdf.getPage(pageNum);
    const vp = page.getViewport({ scale: 0.25 });
    canvas.width = vp.width;
    canvas.height = vp.height;
    await page.render({
      canvasContext: canvas.getContext("2d"),
      viewport: vp
    }).promise;
  } catch (err) {
    console.error("Lỗi vẽ thumbnail:", err);
  }
}

// ==========================================================================
// 13. MỤC LỤC 3 TẦNG (TOC: OUTLINE -> NHẬN DIỆN CHỮ -> ẢNH)
// ==========================================================================
const tocBody = $("toc-body");
const tocTitle = $("toc-title");
const tocChangeBtn = $("toc-change-btn");
const tocOffsetWrap = $("toc-offset-wrap");
const tocOffsetInput = $("toc-offset");
const tocDoneBtn = $("toc-done-btn");

let tocPages = [];
let pickSet = new Set();
let tocOffset = 0;
let outlineCache = null;
const USE_OUTLINE = true; // KÍCH HOẠT LẠI OUTLINE CÓ SẴN CỦA FILE

async function prepareToc() {
  if (outlineCache === null) {
    try {
      const raw = await pdf.getOutline();
      outlineCache = raw ? flattenOutline(raw) : [];
    } catch {
      outlineCache = [];
    }
  }

  if (USE_OUTLINE && outlineCache.length) {
    showOutlineView();
  } else {
    tocPages = loadToc().filter(n => n >= 1 && n <= pdf.numPages);
    if (tocPages.length) showAutoTocPage();
    else showPicker();
  }
}

function loadToc() {
  try {
    const list = JSON.parse(localStorage.getItem("tocPages:" + fileKey));
    if (Array.isArray(list)) return list.filter(Number.isInteger);
    return [];
  } catch {
    return [];
  }
}

function flattenOutline(items, level = 0, out = []) {
  for (const it of items) {
    out.push({
      title: it.title.replace(/\s+/g, " ").trim(),
      dest: it.dest,
      level,
      bold: it.bold,
      canGo: !!it.dest,
    });
    if (it.items?.length) flattenOutline(it.items, level + 1, out);
  }
  return out;
}

async function outlinePage(dest) {
  const d = typeof dest === "string" ? await pdf.getDestination(dest) : dest;
  if (!d) return null;
  return Number.isInteger(d[0]) ? d[0] + 1 : (await pdf.getPageIndex(d[0])) + 1;
}

function renderTocList(entries, onPick) {
  const frag = document.createDocumentFragment();
  entries.forEach((e, i) => {
    const row = document.createElement(e.canGo ? "button" : "div");
    if (e.canGo) row.type = "button";
    row.className = "toc-item" + (e.bold ? " bold" : "");
    row.style.setProperty("--lv", e.level);
    row.dataset.i = i;

    const t = document.createElement("span");
    t.textContent = e.title;
    row.append(t);

    const shown = e.marker ?? e.page;
    if (shown != null) {
      const n = document.createElement("span");
      n.className = "n";
      n.textContent = shown;
      row.append(n);
    }
    frag.append(row);
  });
  tocBody.replaceChildren(frag);
  tocBody.scrollTop = 0;
  tocBody.onclick = (ev) => {
    const row = ev.target.closest("button.toc-item");
    if (row) onPick(entries[Number(row.dataset.i)]);
  };
}

function showOutlineView() {
  tocTitle.textContent = "Mục lục PDF";
  tocChangeBtn.hidden = false;
  tocChangeBtn.textContent = "Quét lại";
  tocOffsetWrap.style.display = "none";
  tocDoneBtn.hidden = true;

  renderTocList(outlineCache, async (e) => {
    const p = await outlinePage(e.dest);
    if (p) goToPage(p);
  });
}

tocChangeBtn.addEventListener("click", showPicker);
tocOffsetInput.addEventListener("change", () => {
  tocOffset = Math.round(Number(tocOffsetInput.value)) || 0;
  try {
    localStorage.setItem("tocOff:" + fileKey, String(tocOffset));
  } catch { }
});

function showPicker() {
  tocTitle.textContent = "Chọn trang mục lục:";
  tocOffsetWrap.style.display = "none";
  tocChangeBtn.hidden = true;
  pickSet = new Set(tocPages);
  updateDoneBtn();

  const frag = document.createDocumentFragment();
  for (let n = 1; n <= Math.min(pdf.numPages, 30); n++) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn ghost" + (pickSet.has(n) ? " primary" : "");
    btn.style.margin = "4px";
    btn.textContent = `Trang ${n}`;
    btn.addEventListener("click", () => {
      if (pickSet.has(n)) pickSet.delete(n);
      else pickSet.add(n);
      btn.classList.toggle("primary", pickSet.has(n));
      updateDoneBtn();
    });
    frag.append(btn);
  }
  tocBody.replaceChildren(frag);
}

function updateDoneBtn() {
  tocDoneBtn.hidden = false;
  tocDoneBtn.disabled = pickSet.size === 0;
  tocDoneBtn.textContent = `Xong (${pickSet.size})`;
}

tocDoneBtn.addEventListener("click", () => {
  if (!pickSet.size) return;
  tocPages = [...pickSet].sort((a, b) => a - b);
  try {
    localStorage.setItem("tocPages:" + fileKey, JSON.stringify(tocPages));
  } catch { }
  showAutoTocPage();
});

async function showAutoTocPage() {
  tocTitle.textContent = `Mục lục trang ${tocPages.join(", ")}`;
  tocChangeBtn.hidden = false;
  tocChangeBtn.textContent = "Đổi trang";
  tocOffsetWrap.style.display = "inline-flex";
  tocDoneBtn.hidden = true;

  tocBody.innerHTML = `<p style="padding: 12px; color: var(--muted); font-size: 0.8125rem;">Đang nhận dạng chữ mục lục...</p>`;

  try {
    const rows = [];
    for (const n of tocPages) {
      const page = await pdf.getPage(n);
      const { items } = await page.getTextContent();
      const text = items.map(it => it.str).join(" ");
      rows.push({ pageNum: n, text });
    }

    const entries = [];
    rows.forEach(r => {
      const lines = r.text.split(/(?<=\d)\s+/);
      lines.forEach(l => {
        const m = l.match(/(.+?)\s*[\.…·_-]+\s*(\d{1,4})/);
        if (m) {
          entries.push({
            title: m[1].trim(),
            page: Number(m[2]),
            canGo: true,
            level: 0
          });
        }
      });
    });

    if (entries.length >= 2) {
      renderTocList(entries, (e) => goToPage(e.page + tocOffset));
    } else {
      tocBody.innerHTML = `<p style="padding: 12px; color: var(--muted); font-size: 0.8125rem;">Trang mục lục có cấu trúc ảnh hoặc không trích xuất được số trang. Bấm số trang bên tab Tất cả trang để duyệt.</p>`;
    }
  } catch (err) {
    tocBody.innerHTML = `<p style="padding: 12px; color: var(--danger); font-size: 0.8125rem;">Lỗi khi đọc mục lục: ${err.message}</p>`;
  }
}

// ==========================================================================
// 14. TÌM KIẾM TOÀN VĂN BẢN (FULL-TEXT SEARCH)
// ==========================================================================
function openSearch() {
  searchModal.classList.add("is-open");
  searchQueryInput.focus();
  searchQueryInput.select();
}

function closeSearch() {
  searchModal.classList.remove("is-open");
}

searchOpenBtn.addEventListener("click", openSearch);
searchCloseBtn.addEventListener("click", closeSearch);

async function executeSearch() {
  const query = searchQueryInput.value.trim();
  if (!query || !pdf) return;

  searchStatus.textContent = "Đang tìm kiếm trong tài liệu...";
  searchResults.replaceChildren();

  const term = query.toLowerCase();
  const matches = [];

  for (let n = 1; n <= pdf.numPages; n++) {
    try {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      const fullText = content.items.map(it => it.str).join(" ");
      const lower = fullText.toLowerCase();
      let pos = lower.indexOf(term);

      while (pos !== -1) {
        const snippetStart = Math.max(0, pos - 40);
        const snippetEnd = Math.min(fullText.length, pos + term.length + 50);
        const snippet = fullText.substring(snippetStart, snippetEnd);

        matches.push({
          page: n,
          snippet: snippet.replace(new RegExp(`(${query})`, "gi"), "<mark>$1</mark>")
        });
        pos = lower.indexOf(term, pos + term.length);
      }
    } catch { }
  }

  if (!matches.length) {
    searchStatus.textContent = `Không tìm thấy kết quả nào cho "${query}"`;
    return;
  }

  searchStatus.textContent = `Tìm thấy ${matches.length} kết quả cho "${query}":`;

  matches.slice(0, 30).forEach(m => {
    const item = document.createElement("div");
    item.className = "search-result-item";
    item.innerHTML = `
      <div class="search-result-head">Trang ${m.page}</div>
      <div class="search-result-snippet">...${m.snippet}...</div>
    `;
    item.addEventListener("click", () => {
      goToPage(m.page);
      closeSearch();
      showToast(`Đã chuyển đến trang ${m.page}`);
    });
    searchResults.appendChild(item);
  });
}

searchExecBtn.addEventListener("click", executeSearch);
searchQueryInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") executeSearch();
});

// ==========================================================================
// 15. SHORTCUTS & TOÀN MÀN HÌNH
// ==========================================================================
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else readerView.requestFullscreen?.();
}

// Quản lý ẩn/hiện thanh công cụ đỉnh khi ở chế độ toàn màn hình
function setFullscreenTopbarHidden(hidden) {
  if (!document.fullscreenElement) return;
  topBar.classList.toggle("is-fullscreen-hidden", hidden);
  fullscreenTopbarShowBtn.hidden = !hidden;
  fullscreenTopbarHideBtn.hidden = hidden;
}

function toggleFullscreenTopbar() {
  if (!document.fullscreenElement) return;
  const isHidden = topBar.classList.contains("is-fullscreen-hidden");
  setFullscreenTopbarHidden(!isHidden);
}

fullscreenTopbarShowBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  setFullscreenTopbarHidden(false);
});

fullscreenTopbarHideBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  setFullscreenTopbarHidden(true);
});

fullscreenBtn.addEventListener("click", toggleFullscreen);
fullscreenBtn.hidden = !document.fullscreenEnabled;
document.addEventListener("fullscreenchange", () => {
  const on = !!document.fullscreenElement;
  fullscreenBtn.querySelector(".icon-enter").toggleAttribute("hidden", on);
  fullscreenBtn.querySelector(".icon-exit").toggleAttribute("hidden", !on);

  readerView.classList.toggle("is-fullscreen", on);

  if (on) {
    // Khi bật toàn màn hình: Ẩn thanh đỉnh, chỉ hiện icon nhỏ bên phải
    setFullscreenTopbarHidden(true);
  } else {
    // Khi thoát toàn màn hình: Khôi phục thanh đỉnh bình thường
    topBar.classList.remove("is-fullscreen-hidden");
    fullscreenTopbarShowBtn.hidden = true;
    fullscreenTopbarHideBtn.hidden = true;
  }
});

helpBtn.addEventListener("click", () => shortcutsModal.classList.add("is-open"));
shortcutsCloseBtn.addEventListener("click", () => shortcutsModal.classList.remove("is-open"));

// Bàn phím
document.addEventListener("keydown", (e) => {
  if (!pdf || e.target.matches("input") || e.altKey) return;

  if (e.ctrlKey || e.metaKey) {
    if (e.key.toLowerCase() === "f") {
      e.preventDefault();
      openSearch();
    }
    return;
  }

  if (e.key === "Escape") {
    closeSearch();
    shortcutsModal.classList.remove("is-open");
    closeSidebar();
  } else if (e.key === "ArrowRight" || e.key === "PageDown" || (e.key === " " && !e.shiftKey)) {
    e.preventDefault();
    nextSpread();
  } else if (e.key === "ArrowLeft" || e.key === "PageUp" || (e.key === " " && e.shiftKey)) {
    e.preventDefault();
    prevSpread();
  } else if (e.key === "+" || e.key === "=") {
    zoomTo(wantedZoom * 1.25);
  } else if (e.key === "-") {
    zoomTo(wantedZoom / 1.25);
  } else if (e.key === "0") {
    zoomTo(1);
  } else if (e.key.toLowerCase() === "f") {
    toggleFullscreen();
  } else if (e.key.toLowerCase() === "h") {
    if (document.fullscreenElement) {
      toggleFullscreenTopbar();
    }
  } else if (e.key.toLowerCase() === "m") {
    setDockHidden(!floatingDock.classList.contains("is-hidden"));
  } else if (e.key.toLowerCase() === "t") {
    if (sidebarDrawer.classList.contains("is-open")) closeSidebar();
    else openSidebar("toc");
  } else if (e.key.toLowerCase() === "v") {
    if (sidebarDrawer.classList.contains("is-open")) closeSidebar();
    else openSidebar("thumbs");
  } else if (e.key === "?") {
    shortcutsModal.classList.add("is-open");
  }
});

// ==========================================================================
// 16. KÉO THẢ VÀ MỞ FILE MỚI TRỰC TIẾP TRONG VIEWER
// ==========================================================================
viewerOpenFileBtn.addEventListener("click", () => viewerFileInput.click());
viewerFileInput.addEventListener("change", () => {
  if (viewerFileInput.files[0]) handleNewPdfFile(viewerFileInput.files[0]);
  viewerFileInput.value = "";
});

window.addEventListener("dragover", (e) => {
  e.preventDefault();
  viewerDropOverlay.classList.add("is-active");
});

window.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) {
    viewerDropOverlay.classList.remove("is-active");
  }
});

window.addEventListener("drop", (e) => {
  e.preventDefault();
  viewerDropOverlay.classList.remove("is-active");
  if (e.dataTransfer.files[0]) {
    handleNewPdfFile(e.dataTransfer.files[0]);
  }
});

async function handleNewPdfFile(file) {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!new TextDecoder("latin1").decode(bytes.subarray(0, 1024)).includes("%PDF-")) {
      showToast("File được chọn không phải PDF hợp lệ.");
      return;
    }

    const name = file.name;
    const size = file.size || bytes.byteLength;
    const id = `${name}|${size}`;

    const db = await openDatabase();
    const tx = db.transaction(["files", "recents"], "readwrite");
    tx.objectStore("files").put({ bytes, name, size, id }, "current");
    tx.objectStore("recents").put({
      id,
      name,
      size,
      bytes,
      lastOpened: Date.now(),
      lastPage: 1,
      totalPages: 0
    });

    tx.oncomplete = () => {
      showToast(`Đang mở: ${name}...`);
      loadPdf();
    };
  } catch (err) {
    showToast("Lỗi khi mở file: " + err.message);
  }
}

// Tự động căn chỉnh khi resize cửa sổ
new ResizeObserver(() => requestRender()).observe(bookView);

// Khởi chạy ứng dụng
loadPdf().catch((err) => {
  console.error("Không thể khởi tạo PDF viewer:", err);
  location.replace("./index.html");
});
