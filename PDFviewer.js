    /*
        BẢN ĐỒ FILE (đọc theo thứ tự này):
        1. Trạng thái      : các biến giữ "đang xem trang nào, zoom bao nhiêu"
        2. Cặp trang       : spreadStartOf / goToPage / nextSpread / prevSpread
        3. Vòng lặp vẽ     : requestRender -> renderLoop -> drawSpread (chỉ vẽ yêu cầu mới nhất)
        4. Zoom            : zoomTo (xem trước bằng CSS, vẽ lại sắc nét sau khi dừng tay)
        5. Sự kiện         : mở file, kéo thả, chuột, bàn phím, toàn màn hình
        6. Mục lục & Xem tất cả trang :
            - Mục lục 3 tầng trong một nút: (1) outline có sẵn -> (2) chọn trang mục lục rồi đọc chữ
            thành danh sách bấm được -> (3) trang ảnh / cấu trúc lạ thì hiện ảnh trang mục lục
            - Ảnh mục lục (tầng 3): cuộn chuột để phóng to quanh con trỏ, kéo để di chuyển, nhấp đúp để về vừa khung
            - Xem tất cả trang: bảng thu nhỏ mọi trang để nhảy nhanh
        */
    // Phiên bản PDF.js được ghim ở đây. Muốn dùng bản mới hơn thì đổi số phiên bản ở CẢ HAI dòng.
    import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";
    pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";

    const $ = (id) => document.getElementById(id);
    const readerView = $("reader-view");
    const bookView = $("book-view"),
    pagesEl = $("pages");
    const leftCanvas = $("left-canvas"),
    rightCanvas = $("right-canvas");
    const prevBtn = $("prev-btn"),
    nextBtn = $("next-btn");
    const pageInput = $("page-input"),
    pageTotal = $("page-total"),
    zoomInput = $("zoom-input");
    const fullscreenBtn = $("fullscreen-btn");

    const MIN_ZOOM = 0.25,
    MAX_ZOOM = 4;
    // Giới hạn số pixel mỗi canvas (bộ nhớ). Máy cảm ứng để thấp hơn vì trình duyệt di động giới hạn chặt.
    const MAX_CANVAS_PIXELS = matchMedia("(pointer: coarse)").matches ? 16e6 : 32e6;
    const MAX_CANVAS_SIDE = 16384; // giới hạn một cạnh canvas
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

    // ---------- 1. Trạng thái ----------
    let pdf = null;
    let spreadStart = 1; // trang bên trái (số nhỏ hơn) của cặp đang xem
    let wantedZoom = 1; // zoom người dùng muốn (1 = vừa khung)
    let shownZoom = 1; // zoom của ảnh đang hiển thị trên canvas
    let zoomOrigin = null,
    zoomTimer = 0;

    // ---------- 2. Cặp trang ----------
    // Cặp trang: (1-2), (3-4)... Muốn bìa đứng riêng thì sửa hàm này (và bước nhảy 2 ở nextSpread/prevSpread).
    const spreadStartOf = (page) => (page % 2 === 1 ? page : page - 1);

    function goToPage(page) {
    if (!pdf) return;
    spreadStart = spreadStartOf(clamp(Math.round(page) || 1, 1, pdf.numPages));
    updateUI();
    requestRender({ resetScroll: true });
    }
    const nextSpread = () => {
    if (pdf && !nextBtn.disabled) goToPage(spreadStart + 2);
    };
    const prevSpread = () => {
    if (pdf && !prevBtn.disabled) goToPage(spreadStart - 2);
    };

    // ---------- 3. Vòng lặp vẽ ----------
    // Bấm nhanh, kéo cửa sổ hay zoom đều chỉ gọi requestRender. Lần vẽ cũ bị hủy, chỉ vẽ yêu cầu mới nhất.
    let needsRender = false,
    rendering = false,
    resetScrollNext = false,
    activeTasks = [];

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
    const start = spreadStart,
        drawZoom = wantedZoom;
    const pages = [await pdf.getPage(start)];
    if (start < pdf.numPages) pages.push(await pdf.getPage(start + 1));

    // Tính scale vừa khung: lấy tỉ lệ nhỏ hơn giữa chiều rộng và chiều cao
    const base = pages.map((p) => p.getViewport({ scale: 1 }));
    const availW = Math.max(1, bookView.clientWidth - 24),
        availH = Math.max(1, bookView.clientHeight - 24);
    const fit = Math.min(
        availW / base.reduce((sum, v) => sum + v.width, 0),
        availH / Math.max(...base.map((v) => v.height)),
    );
    const scale = fit * drawZoom;

    activeTasks = [];
    const images = await Promise.all(pages.map((p) => renderToBuffer(p, scale)));

    // Đổi ảnh mới vào canvas cùng lúc nên không bị nhấp nháy
    const zoomChanged = drawZoom !== shownZoom;
    const beforeW = pagesEl.offsetWidth || 1,
        beforeH = pagesEl.offsetHeight || 1;
    showOnCanvas(leftCanvas, images[0]);
    if (images[1]) showOnCanvas(rightCanvas, images[1]);
    else rightCanvas.style.display = "none";
    shownZoom = drawZoom;
    updatePreview();

    if (resetScrollNext) {
        bookView.scrollLeft = 0;
        bookView.scrollTop = 0;
        resetScrollNext = false;
    } else if (zoomChanged && zoomOrigin) {
        // Giữ điểm đang zoom (vị trí con trỏ) đứng yên trên màn hình
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

    // Vẽ trang vào một canvas tạm (chưa hiện ra màn hình)
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
    // Kích thước hiển thị = số pixel thật / dpr: 1 pixel canvas khớp đúng 1 pixel màn hình, không bị co giãn lẻ gây mờ
    return {
        buffer,
        cssWidth: buffer.width / dpr,
        cssHeight: buffer.height / dpr,
    };
    }

    function showOnCanvas(canvas, image) {
    canvas.width = image.buffer.width;
    canvas.height = image.buffer.height;
    canvas.style.width = image.cssWidth + "px"; // kích thước hiển thị
    canvas.style.height = image.cssHeight + "px";
    canvas.getContext("2d").drawImage(image.buffer, 0, 0);
    image.buffer.width = 0; // giải phóng bộ nhớ của canvas tạm
    canvas.style.display = "block";
    }

    // ---------- 4. Zoom ----------
    // Khi đang zoom: phóng ảnh cũ bằng CSS (tức thì, mượt). Dừng tay khoảng 0,14 giây mới vẽ lại cho nét.
    function updatePreview() {
    const k = wantedZoom / shownZoom;
    pagesEl.style.transform = k === 1 ? "" : `scale(${k})`;
    }

    function zoomTo(
    value,
    ax = bookView.clientWidth / 2,
    ay = bookView.clientHeight / 2,
    delay = 0,
    ) {
    if (!pdf) return;
    if (wantedZoom === shownZoom) {
        // bắt đầu một lần zoom mới: ghi nhớ điểm neo
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

    function updateUI() {
    if (!pdf) return;
    if (document.activeElement !== pageInput) pageInput.value = spreadStart;
    if (document.activeElement !== zoomInput)
        zoomInput.value = Math.round(wantedZoom * 100);
    prevBtn.disabled = spreadStart <= 1;
    nextBtn.disabled = spreadStart + 2 > pdf.numPages;
    }

    // ---------- 5. Sự kiện ----------
    function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open("pdf-reader", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("files");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    }

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
        const doc = await pdfjsLib.getDocument({ data: storedFile.bytes }).promise;
        const oldDoc = pdf;
        pdf = doc;
        spreadStart = 1;
        wantedZoom = shownZoom = 1;
        oldDoc?.destroy();
        fileKey = `${storedFile.name}|${storedFile.size}|${doc.numPages}`;
        closeToc();
        closeBrowse();
        tocPages = loadToc()
        .filter((n) => n >= 1 && n <= doc.numPages)
        .sort((a, b) => a - b);
        outlineCache = null; // file mới thì hỏi lại outline
        try {
        tocOffset = Number(localStorage.getItem("tocOff:" + fileKey)) || 0;
        } catch {
        tocOffset = 0;
        }
        tocOffsetInput.value = tocOffset;
        pagesEl.style.transform = "";
        pageTotal.textContent = doc.numPages;
        pageInput.max = doc.numPages;
        readerView.hidden = false;
        updateUI();
        requestRender({ resetScroll: true });
    } catch (err) {
        console.error(err);
        location.replace("./index.html");
    }
    }

    $("open-btn").addEventListener("click", () => location.href = "./index.html");
    prevBtn.addEventListener("click", prevSpread);
    nextBtn.addEventListener("click", nextSpread);
    pageInput.addEventListener("change", () => goToPage(Number(pageInput.value)));
    pageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") pageInput.blur();
    });
    pageInput.addEventListener("focus", () => pageInput.select());
    zoomInput.addEventListener("change", () =>
    zoomTo(Number(zoomInput.value) / 100 || 1),
    );
    zoomInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") zoomInput.blur();
    });
    pageInput.addEventListener("blur", updateUI);
    zoomInput.addEventListener("blur", updateUI);
    $("zoom-out-btn").addEventListener("click", () => zoomTo(wantedZoom / 1.25));
    $("zoom-in-btn").addEventListener("click", () => zoomTo(wantedZoom * 1.25));
    $("zoom-reset-btn").addEventListener("click", () => zoomTo(1));

    // Cuộn chuột = zoom quanh vị trí con trỏ
    bookView.addEventListener(
    "wheel",
    (e) => {
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
    },
    { passive: false },
    );

    // Kéo để di chuyển; bấm (không kéo) vào trang trái/phải để lật trang
    let drag = null;
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
    const dx = e.clientX - drag.x,
        dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    if (!drag.moved) {
        drag.moved = true;
        // Trang vừa khung theo chiều ngang thì kéo ngang = vuốt lật trang; đang zoom to thì kéo = di chuyển
        const fits = bookView.scrollWidth <= bookView.clientWidth + 1;
        drag.mode =
        fits && Math.abs(dx) > Math.abs(dy) && wantedZoom === shownZoom
            ? "swipe"
            : "pan";
        bookView.setPointerCapture(e.pointerId);
        bookView.classList.add("is-dragging");
    }
    if (drag.mode === "swipe") {
        const now = performance.now();
        drag.vx =
        0.7 * drag.vx +
        0.3 * ((e.clientX - drag.lastX) / Math.max(1, now - drag.lastT)); // vận tốc (px/ms)
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
    // Hiệu ứng cuộn góc: góc dưới của trang cuộn lên theo quãng vuốt (trang không di chuyển)
    const curl = $("curl");
    let curlTimer = 0;
    function showCurl(dir, dx) {
    clearTimeout(curlTimer);
    const size = Math.min(Math.abs(dx) * 0.8, 200, pagesEl.offsetWidth / 2);
    curl.classList.toggle("prev", dir < 0); // vuốt sang phải: cuộn góc dưới bên trái
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

    // Vuốt sang trái = trang sau, vuốt sang phải = trang trước
    function finishSwipe(dx, vx) {
    const dir = dx < 0 ? 1 : -1;
    const far = Math.abs(dx) > Math.min(120, bookView.clientWidth * 0.15); // kéo đủ xa
    const flick = Math.abs(vx) > 0.5 && Math.sign(vx) === Math.sign(dx); // hoặc vuốt đủ nhanh
    const canTurn = dir > 0 ? !nextBtn.disabled : !prevBtn.disabled;
    if ((far || flick) && canTurn) {
        hideCurl(false);
        if (dir > 0) nextSpread();
        else prevSpread();
    } else {
        hideCurl(true); // không đủ lực hoặc hết sách: góc trang cuộn lại
    }
    }

    bookView.addEventListener("pointerup", (e) => {
    if (drag && !drag.moved) {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (el === leftCanvas) prevSpread();
        else if (el === rightCanvas) nextSpread();
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

    // Bàn phím
    document.addEventListener("keydown", (e) => {
    if (!pdf || e.target.matches("input") || e.ctrlKey || e.metaKey || e.altKey)
        return;
    if (e.key === "ArrowRight" || e.key === "PageDown") nextSpread();
    else if (e.key === "ArrowLeft" || e.key === "PageUp") prevSpread();
    else if (e.key === "+" || e.key === "=") zoomTo(wantedZoom * 1.25);
    else if (e.key === "-") zoomTo(wantedZoom / 1.25);
    else if (e.key === "0") zoomTo(1);
    else if (e.key.toLowerCase() === "f") toggleFullscreen();
    else if (e.key.toLowerCase() === "m") setMenuHidden(!controls.hidden);
    else if (e.key.toLowerCase() === "v") browseBtn.click();
    });

    // Toàn màn hình
    function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else readerView.requestFullscreen?.();
    }
    fullscreenBtn.addEventListener("click", toggleFullscreen);
    fullscreenBtn.hidden = !document.fullscreenEnabled;
    document.addEventListener("fullscreenchange", () => {
    const on = !!document.fullscreenElement;
    fullscreenBtn.querySelector(".icon-enter").toggleAttribute("hidden", on); // icon "vào toàn màn hình"
    fullscreenBtn.querySelector(".icon-exit").toggleAttribute("hidden", !on); // icon "thoát toàn màn hình"
    const label = on ? "Thoát toàn màn hình" : "Toàn màn hình";
    fullscreenBtn.title = label;
    fullscreenBtn.setAttribute("aria-label", label);
    });

    // Ẩn/hiện menu điều khiển (phím M). Trạng thái được nhớ cho lần mở sau.
    const controls = $("controls"),
    menuOpenBtn = $("menu-open-btn");
    function setMenuHidden(hidden) {
    controls.hidden = hidden;
    menuOpenBtn.hidden = !hidden;
    try {
        localStorage.setItem("menuHidden", hidden ? "1" : "0");
    } catch {}
    }
    $("menu-hide-btn").addEventListener("click", () => setMenuHidden(true));
    menuOpenBtn.addEventListener("click", () => setMenuHidden(false));
    try {
    if (localStorage.getItem("menuHidden") === "1") setMenuHidden(true);
    } catch {}

    // ---------- 6. Mục lục & Xem tất cả trang ----------
    // Bấm "Mục lục" (3 tầng):
    //   1. File có outline sẵn -> hiện outline, bấm để nhảy tới trang.
    //   2. Không có -> người dùng chọn trang mục lục -> đọc chữ trang đó thành danh sách bấm được.
    //   3. Trang chỉ có ảnh hoặc cấu trúc lạ -> hiện ảnh trang mục lục như bình thường.
    // Bấm "Xem tất cả": luôn hiện danh sách mọi trang để nhảy nhanh tới trang bất kỳ.
    const tocBtn = $("toc-btn"),
    tocPanel = $("toc-panel"),
    tocBody = $("toc-body");
    const tocTitle = $("toc-title"),
    tocChangeBtn = $("toc-change-btn");
    const tocOffsetWrap = $("toc-offset-wrap"),
    tocOffsetInput = $("toc-offset");
    const tocDoneBtn = $("toc-done-btn");
    const browseBtn = $("browse-btn"),
    browsePanel = $("browse-panel"),
    browseBody = $("browse-body");
    let tocPages = []; // các trang mục lục do người dùng chọn, đã sắp xếp (rỗng = chưa chỉ định)
    let pickSet = new Set(); // các trang đang được tick trong bảng chọn (chưa bấm Xong)
    const MAX_TOC_PAGES = 20; // giới hạn số trang mục lục để không tốn tài nguyên
    const TOC_MIN_ZOOM = 0.5,
    TOC_MAX_ZOOM = 5; // giới hạn zoom của ảnh mục lục (1 = vừa bề rộng bảng)
    const TOC_MAX_PIXELS = 8e6; // giới hạn số pixel mỗi ảnh mục lục để không tốn bộ nhớ khi zoom lớn
    let tocImageMode = false; // true khi bảng đang hiện ảnh mục lục (tầng 3)
    let tocImages = []; // [{ n: số trang, canvas }] của ảnh mục lục đang hiện
    let tocZoom = 1,
    tocBaseW = 0,
    tocZoomTimer = 0; // zoom hiện tại, bề rộng "vừa khung", hẹn giờ vẽ lại
    let tocMode = "view"; // "outline" = outline sẵn, "view" = xem mục lục, "pick" = chọn trang mục lục
    let tocToken = 0; // tăng mỗi lần dựng lại nội dung, để bỏ qua các lần vẽ đã cũ
    let fileKey = ""; // khóa nhận diện file (tên + dung lượng + số trang) để nhớ trang mục lục
    const USE_OUTLINE = false; // TẠM TẮT tầng 1 để test tự sinh mục lục. Đổi thành true để dùng outline có sẵn của file
    let outlineCache = null; // null = chưa hỏi PDF.js, [] = file không có outline
    let tocOffset = 0; // trang PDF = số trang in trong sách + tocOffset
    let thumbObserver = null,
    browseObserver = null;

    // Nhớ danh sách trang mục lục theo từng file (đọc được cả khóa cũ "toc:" chỉ lưu 1 trang)
    const loadToc = () => {
    try {
        const list = JSON.parse(localStorage.getItem("tocPages:" + fileKey));
        if (Array.isArray(list)) return list.filter(Number.isInteger);
        const old = Number(localStorage.getItem("toc:" + fileKey));
        return old ? [old] : [];
    } catch {
        return [];
    }
    };
    const saveToc = () => {
    try {
        localStorage.setItem("tocPages:" + fileKey, JSON.stringify(tocPages));
    } catch {}
    };

    // Ghi gọn danh sách trang cho tiêu đề bảng: [3,4,5,6,7,10] -> "3–7, 10"
    function describePages(pages) {
    const parts = [];
    for (let i = 0; i < pages.length; ) {
        let j = i;
        while (pages[j + 1] === pages[j] + 1) j++;
        parts.push(j > i ? `${pages[i]}–${pages[j]}` : `${pages[i]}`);
        i = j + 1;
    }
    return parts.join(", ");
    }

    // Nút "Xong": chốt các trang đã tick rồi bắt đầu quét
    function updateDoneBtn() {
    tocDoneBtn.hidden = tocMode !== "pick";
    tocDoneBtn.disabled = pickSet.size === 0;
    tocDoneBtn.textContent = `Xong (${pickSet.size})`;
    }
    tocDoneBtn.addEventListener("click", () => {
    if (!pickSet.size) return;
    tocPages = [...pickSet].sort((a, b) => a - b);
    saveToc();
    showTocPage();
    });

    tocOffsetInput.addEventListener("change", () => {
    tocOffset = Math.round(Number(tocOffsetInput.value)) || 0;
    try {
        localStorage.setItem("tocOff:" + fileKey, String(tocOffset));
    } catch {}
    });
    tocOffsetInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") tocOffsetInput.blur();
    });

    async function openToc() {
    if (!browsePanel.hidden) closeBrowse(); // hai bảng dùng chung khoảng trống bên trái, không mở đồng thời
    tocPanel.hidden = false;
    tocBtn.setAttribute("aria-expanded", "true");
    if (!tocPages.length && (await showOutline())) return; // tầng 1: file có outline sẵn (trừ khi người dùng đã tự chọn trang)
    if (tocPanel.hidden) return; // người dùng đã đóng bảng trong lúc chờ
    if (tocPages.length) showTocPage();
    else showPicker();
    }
    function closeToc() {
    tocPanel.hidden = true;
    tocBtn.setAttribute("aria-expanded", "false");
    tocToken++;
    thumbObserver?.disconnect();
    setTocImageMode(false);
    tocBody.replaceChildren(); // bỏ các canvas để giải phóng bộ nhớ
    }

    // Vẽ một trang vào canvas với bề rộng hiển thị cho trước.
    // Vẽ vào canvas tạm rồi chép sang một lượt nên ảnh cũ không bị xóa trắng trong lúc vẽ lại (zoom mượt).
    async function drawInto(canvas, pageNumber, cssWidth, token) {
    try {
        const page = await pdf.getPage(pageNumber);
        if (token !== tocToken) return;
        const base = page.getViewport({ scale: 1 });
        const cssHeight = (cssWidth * base.height) / base.width;
        const dpr = Math.min(
        window.devicePixelRatio || 1,
        Math.sqrt(TOC_MAX_PIXELS / (cssWidth * cssHeight)),
        );
        const viewport = page.getViewport({ scale: (cssWidth / base.width) * dpr });
        const buffer = document.createElement("canvas");
        buffer.width = Math.max(1, Math.round(viewport.width));
        buffer.height = Math.max(1, Math.round(viewport.height));
        await page.render({ canvasContext: buffer.getContext("2d"), viewport })
        .promise;
        if (token !== tocToken) {
        buffer.width = 0;
        return;
        } // đã có lần vẽ mới hơn
        canvas.width = buffer.width;
        canvas.height = buffer.height;
        canvas.style.width = cssWidth + "px";
        canvas.style.height = cssHeight + "px";
        canvas.dataset.ratio = cssHeight / cssWidth; // tỉ lệ cao/rộng, dùng để phóng ảnh cũ tức thì khi zoom
        canvas.getContext("2d").drawImage(buffer, 0, 0);
        buffer.width = 0; // giải phóng bộ nhớ canvas tạm
    } catch (err) {
        if (token === tocToken) console.error(err);
    }
    }

    // ---- Tầng 1: outline có sẵn trong file ----
    function flattenOutline(items, level = 0, out = []) {
    for (const it of items) {
        out.push({
        title: it.title.replace(/\s+/g, " ").trim(),
        dest: it.dest,
        level,
        bold: it.bold,
        canGo: !!it.dest,
        });
        if (it.items?.length) flattenOutline(it.items, level + 1, out); // đệ quy: mục con thụt sâu hơn 1 cấp
    }
    return out;
    }
    async function outlinePage(dest) {
    const d = typeof dest === "string" ? await pdf.getDestination(dest) : dest; // dest có thể là tên
    if (!d) return null;
    return Number.isInteger(d[0]) ? d[0] + 1 : (await pdf.getPageIndex(d[0])) + 1; // getPageIndex tính từ 0
    }

    // Vẽ danh sách (dùng chung cho outline và mục lục đọc từ chữ)
    function renderTocList(entries, onPick) {
    const frag = document.createDocumentFragment();
    entries.forEach((e, i) => {
        const row = document.createElement(e.canGo ? "button" : "div");
        if (e.canGo) row.type = "button";
        row.className =
        "toc-item" + (e.bold ? " bold" : "") + (e.canGo ? "" : " label");
        row.style.setProperty("--lv", e.level);
        row.dataset.i = i;
        const t = document.createElement("span");
        t.textContent = e.title;
        row.append(t);
        const shown = e.marker ?? e.page; // số La Mã (không bấm được) hoặc số trang
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
        // gán lại onclick (buildThumbList cũng dùng cùng thuộc tính này)
        const row = ev.target.closest("button.toc-item");
        if (row) onPick(entries[Number(row.dataset.i)]);
    };
    }

    // Outline tự sinh (vd "image_1", "image_2"...): mọi tiêu đề chỉ khác số cuối, và đúng 1 mục cho mỗi trang
    function isAutoOutline(list) {
    if (list.length < 3 || list.length !== pdf.numPages) return false;
    const prefixes = new Set(
        list.map((e) =>
        e.title
            .replace(/\d+\s*$/, "")
            .trim()
            .toLowerCase(),
        ),
    );
    return prefixes.size === 1;
    }

    async function showOutline() {
    if (!USE_OUTLINE) return false; // đang tắt tầng 1
    if (outlineCache === null) {
        const raw = await pdf.getOutline(); // null nếu file không có outline
        const flat = raw ? flattenOutline(raw) : [];
        outlineCache = isAutoOutline(flat) ? [] : flat; // outline tự sinh = coi như không có
    }
    if (!outlineCache.length) return false;
    if (tocPanel.hidden) return true; // người dùng đã đóng bảng trong lúc chờ
    tocMode = "outline";
    tocPanel.classList.remove("picking");
    tocTitle.textContent = "Mục lục (có sẵn trong file)";
    tocChangeBtn.hidden = false;
    tocChangeBtn.textContent = "Tự chọn"; // outline thật nhưng người dùng muốn dùng trang mục lục riêng
    tocOffsetWrap.hidden = true;
    tocDoneBtn.hidden = true;
    setTocImageMode(false);
    thumbObserver?.disconnect();
    tocToken++;
    renderTocList(outlineCache, async (e) => {
        const p = await outlinePage(e.dest);
        if (p) goToPage(p);
    });
    return true;
    }

    // ---- Tầng 2: đọc chữ của trang mục lục ----
    const HEADER_ZONE = 0.12; // dòng KHÔNG có số trang nằm trong 12% trên cùng = tiêu đề chạy, bỏ qua (chỉnh tại đây)
    const FOOTER_ZONE = 0.08; // tương tự cho 8% dưới cùng (chân trang)

    function isBoldFont(page, fontName) {
    try {
        if (!page.commonObjs.has(fontName)) return false;
        const f = page.commonObjs.get(fontName);
        return !!f.bold || /bold|black|heavy|CMBX|-Bd/i.test(f.name || "");
    } catch {
        return false;
    }
    }

    // Đọc MỘT trang thành các dòng đã tách số trang (bước 1-3). Trả về null nếu trang không có chữ.
    async function readTocRows(pageNumber) {
    const page = await pdf.getPage(pageNumber);
    await page.getOperatorList(); // ép PDF.js nạp font để đoán chữ đậm
    const { items } = await page.getTextContent();
    const words = items.filter((it) => it.str.trim());
    if (!words.length) return null; // không có chữ = trang ảnh
    const pageH = page.getViewport({ scale: 1 }).height;

    // (1) Gom các mẩu chữ thành dòng. transform[4] = x, transform[5] = y (y tính từ đáy trang)
    words.sort(
        (a, b) =>
        b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4],
    );
    const lines = [];
    for (const w of words) {
        const last = lines.at(-1);
        if (last && Math.abs(last.y - w.transform[5]) < w.height * 0.4)
        last.words.push(w);
        else lines.push({ y: w.transform[5], words: [w] });
    }

    // (2) Mỗi dòng: ghép chữ, lấy x đầu dòng, cỡ chữ, đậm hay không
    const rows = lines.map((line) => {
        line.words.sort((a, b) => a.transform[4] - b.transform[4]);
        let text = "",
        end = null;
        for (const w of line.words) {
        if (end !== null && w.transform[4] - end > w.height * 0.15) text += " "; // khoảng hở đủ rộng = dấu cách
        text += w.str;
        end = w.transform[4] + w.width;
        }
        const first = line.words[0];
        return {
        text: text.replace(/\s+/g, " ").trim(),
        x: first.transform[4],
        y: line.y,
        size: Math.max(...line.words.map((w) => w.height)),
        bold: isBoldFont(page, first.fontName),
        };
    });

    // (3) Tách số trang ở CUỐI dòng (cho phép dấu chấm dẫn "....."), gồm cả số La Mã (viii, xii...)
    const raw = [];
    for (const r of rows) {
        if (/^[\d\s.]+$/.test(r.text)) continue; // dòng chỉ toàn số (số trang chân trang)
        let m = r.text.match(/^(.*\p{L}.*?)([\s.·…_]+)(\d{1,4}|[ivxlcdm]{1,8})$/iu);
        // Số La Mã chỉ tin khi có dấu chấm dẫn "....", tránh nhầm với chữ thường như "mix"
        if (m && !/^\d+$/.test(m[3]) && !/[.·…_]{2,}/.test(m[2])) m = null;
        // Dòng không có số trang nằm sát mép trên/dưới = tiêu đề chạy / chân trang, bỏ qua
        if (
        !m &&
        ((pageH - r.y) / pageH < HEADER_ZONE || r.y / pageH < FOOTER_ZONE)
        )
        continue;
        raw.push({
        ...r,
        title: m ? m[1] : r.text,
        marker: m ? m[3] : null,
        page: m && /^\d+$/.test(m[3]) ? Number(m[3]) : null,
        });
    }
    return raw;
    }

    // Đọc các trang mục lục đã chọn: gom dòng của mọi trang rồi mới nối dòng + chia cấp một lượt
    async function parseTocPages(pages) {
    const raw = [];
    let hasText = false;
    for (const n of pages) {
        const rows = await readTocRows(n);
        if (rows) {
        hasText = true;
        raw.push(...rows);
        }
    }
    if (!hasText) return { reason: "image" };
    if (!raw.length) return { reason: "structure" };
    const sizes = raw.map((r) => r.size).sort((a, b) => a - b);
    const tol = sizes[sizes.length >> 1] * 0.8; // dung sai thụt lề, tỉ lệ theo cỡ chữ

    // (4) Tiêu đề xuống 2 dòng: dòng trước chưa có số trang + cùng cỡ/đậm + không thụt ra ngoài thì nối vào
    const merged = [];
    for (const r of raw) {
        const p = merged.at(-1);
        const isWrap =
        p &&
        p.page === null &&
        !p.marker &&
        Math.abs(p.size - r.size) < 0.6 &&
        p.bold === r.bold &&
        r.x >= p.x - tol;
        if (isWrap) {
        p.title += " " + r.title;
        p.page = r.page;
        p.marker = r.marker;
        } else merged.push({ ...r });
    }

    // (5) Chia cấp: gom các x gần nhau thành "cột thụt lề"; cùng cột thì đậm đứng trước nhạt
    const xs = [...new Set(merged.map((e) => e.x))].sort((a, b) => a - b);
    const columns = [];
    for (const x of xs) {
        if (columns.length && x - columns.at(-1).at(-1) <= tol)
        columns.at(-1).push(x);
        else columns.push([x]);
    }
    const key = (e) =>
        columns.findIndex((c) => e.x <= c.at(-1)) * 2 + (e.bold ? 0 : 1);
    const ranks = [...new Set(merged.map(key))].sort((a, b) => a - b);

    // (6) Kiểm tra: phải có đủ dòng "tiêu đề + số trang", không thì coi là cấu trúc lạ
    const withPage = merged.filter((e) => e.marker).length;
    if (withPage < 3 || withPage < merged.length / 2)
        return { reason: "structure" };
    const entries = merged.map((e) => ({
        title: e.title,
        page: e.page,
        marker: e.marker,
        bold: e.bold,
        canGo: e.page !== null,
        level: ranks.indexOf(key(e)),
    }));
    console.table(entries); // xem kết quả để chỉnh
    return { entries };
    }

    // ---- Ảnh mục lục (tầng 3): phóng to + di chuyển giống phần nội dung chính ----
    function setTocImageMode(on) {
    tocImageMode = on;
    tocBody.classList.toggle("toc-images", on);
    if (!on) {
        tocImages = [];
        clearTimeout(tocZoomTimer);
    }
    }
    // Phóng/thu ảnh CŨ ngay bằng CSS (tức thì, hơi mờ) - vẽ lại cho nét sau khi dừng tay
    function resizeTocImages() {
    const w = tocBaseW * tocZoom;
    for (const { canvas } of tocImages) {
        if (!canvas.dataset.ratio) continue; // chưa vẽ lần đầu
        canvas.style.width = w + "px";
        canvas.style.height = w * canvas.dataset.ratio + "px";
    }
    }
    async function renderTocImages() {
    const list = tocImages,
        token = ++tocToken; // token mới = các lần vẽ cũ tự bỏ
    for (const { n, canvas } of list) {
        if (token !== tocToken) return;
        await drawInto(canvas, n, tocBaseW * tocZoom, token);
    }
    }

    async function showTocPage() {
    tocMode = "view";
    tocPanel.classList.remove("picking");
    tocTitle.textContent = `Mục lục (trang ${describePages(tocPages)})`;
    tocChangeBtn.hidden = false;
    tocChangeBtn.textContent = "Đổi trang";
    tocOffsetWrap.hidden = true;
    tocDoneBtn.hidden = true;
    setTocImageMode(false);
    thumbObserver?.disconnect();
    const token = ++tocToken;
    tocBody.replaceChildren();
    const result = await parseTocPages(tocPages).catch(() => ({
        reason: "structure",
    }));
    if (token !== tocToken) return; // bảng đã đóng hoặc đổi trong lúc chờ

    if (result.entries) {
        // tầng 2
        tocOffsetWrap.hidden = false;
        renderTocList(result.entries, (e) => goToPage(e.page + tocOffset));
        return;
    }
    // tầng 3: hiện ảnh của MỌI trang mục lục đã chọn (xếp dọc), kèm lời nhắn
    const note = document.createElement("p");
    note.className = "toc-note";
    note.textContent =
        result.reason === "image"
        ? "Các trang này chỉ chứa ảnh nên không tạo được danh sách. Đang hiện ảnh trang mục lục."
        : "Không nhận dạng được cấu trúc (số trang phải nằm cuối mỗi tiêu đề). Đang hiện ảnh trang mục lục.";
    setTocImageMode(true);
    tocZoom = 1;
    tocBaseW = tocBody.clientWidth - 20; // zoom 1 = vừa bề rộng bảng
    tocImages = tocPages.map((n) => ({
        n,
        canvas: document.createElement("canvas"),
    }));
    const wrap = document.createElement("div"); // khung chứa ảnh: dùng làm mốc khi zoom quanh con trỏ
    wrap.className = "toc-zoom";
    wrap.append(...tocImages.map((i) => i.canvas));
    tocBody.onclick = null;
    tocBody.replaceChildren(note, wrap);
    tocBody.scrollTop = tocBody.scrollLeft = 0;
    renderTocImages();
    }

    // Dựng danh sách trang thu nhỏ theo chiều dọc vào "container" cho trước, đánh dấu "highlightPage" là trang hiện tại.
    // Dùng chung cho cả "chọn trang mục lục" và "xem tất cả trang". Chỉ vẽ trang đang cuộn tới (IntersectionObserver)
    // nên sách nhiều trang vẫn nhanh. Trả về observer để nơi gọi tự disconnect khi đóng bảng.
    async function buildThumbList(container, highlightPage, token, onPick) {
    const thumbW = container.clientWidth - 40;
    const size = (await pdf.getPage(1)).getViewport({ scale: 1 }); // trang 1 làm mẫu tỉ lệ cho ô giữ chỗ
    if (token !== tocToken) return null;
    const frag = document.createDocumentFragment();
    for (let n = 1; n <= pdf.numPages; n++) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "thumb" + (n === highlightPage ? " current" : "");
        item.dataset.page = n;
        const canvas = document.createElement("canvas");
        canvas.style.width = thumbW + "px";
        canvas.style.height = (thumbW * size.height) / size.width + "px";
        const label = document.createElement("span");
        label.textContent = `Trang ${n}`;
        item.append(canvas, label);
        frag.append(item);
    }
    container.replaceChildren(frag);
    const observer = new IntersectionObserver(
        (entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            observer.unobserve(entry.target);
            drawInto(
            entry.target.querySelector("canvas"),
            Number(entry.target.dataset.page),
            thumbW,
            token,
            );
        }
        },
        { root: container, rootMargin: "300px" },
    );
    container.querySelectorAll(".thumb").forEach((el) => observer.observe(el));
    container.querySelector(".current")?.scrollIntoView({ block: "center" });
    container.onclick = (e) => {
        const item = e.target.closest(".thumb");
        if (item) onPick(Number(item.dataset.page), item); // item để nơi gọi tô sáng / bỏ tô
    };
    return observer;
    }

    async function showPicker() {
    tocMode = "pick";
    tocPanel.classList.add("picking");
    tocTitle.textContent = "Chọn các trang mục lục, rồi bấm Xong:";
    tocOffsetWrap.hidden = true;
    tocChangeBtn.hidden = true;
    setTocImageMode(false);
    pickSet = new Set(tocPages); // mở lại bảng chọn thì giữ các trang đã chọn trước đó
    updateDoneBtn();
    thumbObserver?.disconnect();
    const token = ++tocToken;
    thumbObserver = await buildThumbList(
        tocBody,
        tocPages[0] || 0,
        token,
        (page, item) => {
        if (pickSet.has(page))
            pickSet.delete(page); // bấm lần nữa = bỏ chọn
        else if (pickSet.size < MAX_TOC_PAGES) pickSet.add(page);
        item.classList.toggle("selected", pickSet.has(page));
        updateDoneBtn();
        },
    );
    if (!thumbObserver) return; // bảng đã đóng trong lúc dựng
    for (const n of pickSet)
        tocBody
        .querySelector(`.thumb[data-page="${n}"]`)
        ?.classList.add("selected");
    }

    // Cuộn chuột = zoom quanh vị trí con trỏ (chỉ khi đang hiện ảnh mục lục)
    tocBody.addEventListener(
    "wheel",
    (e) => {
        if (!tocImageMode) return; // dạng danh sách thì cuộn bình thường
        e.preventDefault();
        const wrap = tocBody.querySelector(".toc-zoom");
        if (!wrap) return;
        const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        const next = clamp(
        tocZoom * Math.exp(-dy * 0.002),
        TOC_MIN_ZOOM,
        TOC_MAX_ZOOM,
        );
        if (next === tocZoom) return;
        const before = wrap.getBoundingClientRect();
        const cx = e.clientX - before.left,
        cy = e.clientY - before.top,
        k = next / tocZoom; // điểm dưới con trỏ, tính trong khung ảnh
        tocZoom = next;
        resizeTocImages();
        const after = wrap.getBoundingClientRect();
        tocBody.scrollLeft += after.left + cx * k - e.clientX; // cuộn bù để điểm đó vẫn nằm dưới con trỏ
        tocBody.scrollTop += after.top + cy * k - e.clientY;
        clearTimeout(tocZoomTimer);
        tocZoomTimer = setTimeout(renderTocImages, 140);
    },
    { passive: false },
    );

    // Kéo để di chuyển ảnh mục lục
    let tocDrag = null;
    tocBody.addEventListener("pointerdown", (e) => {
    if (!tocImageMode || e.button !== 0) return;
    // bấm vào thanh cuộn thì để trình duyệt tự xử lý
    if (
        e.target === tocBody &&
        (e.offsetX >= tocBody.clientWidth || e.offsetY >= tocBody.clientHeight)
    )
        return;
    tocDrag = {
        x: e.clientX,
        y: e.clientY,
        left: tocBody.scrollLeft,
        top: tocBody.scrollTop,
    };
    tocBody.setPointerCapture(e.pointerId);
    tocBody.classList.add("is-dragging");
    });
    tocBody.addEventListener("pointermove", (e) => {
    if (!tocDrag) return;
    tocBody.scrollLeft = tocDrag.left - (e.clientX - tocDrag.x);
    tocBody.scrollTop = tocDrag.top - (e.clientY - tocDrag.y);
    });
    const endTocDrag = () => {
    tocDrag = null;
    tocBody.classList.remove("is-dragging");
    };
    tocBody.addEventListener("pointerup", endTocDrag);
    tocBody.addEventListener("pointercancel", endTocDrag);
    // Nhấp đúp = về lại vừa khung
    tocBody.addEventListener("dblclick", () => {
    if (!tocImageMode) return;
    tocZoom = 1;
    resizeTocImages();
    tocBody.scrollLeft = 0;
    renderTocImages();
    });

    tocBtn.addEventListener("click", () =>
    tocPanel.hidden ? openToc() : closeToc(),
    );
    $("toc-close-btn").addEventListener("click", closeToc);
    tocChangeBtn.addEventListener("click", showPicker);

    // Xem tất cả trang: bấm vào trang nhỏ = nhảy tới đọc trang đó luôn
    function openBrowse() {
    if (!tocPanel.hidden) closeToc();
    browsePanel.hidden = false;
    browseBtn.setAttribute("aria-expanded", "true");
    const token = ++tocToken;
    buildThumbList(browseBody, spreadStart, token, (page) => {
        goToPage(page);
        closeBrowse();
    }).then((obs) => (browseObserver = obs));
    }
    function closeBrowse() {
    browsePanel.hidden = true;
    browseBtn.setAttribute("aria-expanded", "false");
    tocToken++;
    browseObserver?.disconnect();
    browseBody.replaceChildren();
    }
    browseBtn.addEventListener("click", () =>
    browsePanel.hidden ? openBrowse() : closeBrowse(),
    );
    $("browse-close-btn").addEventListener("click", closeBrowse);

    document.addEventListener("keydown", (e) => {
    // T: bật/tắt mục lục, Esc: đóng bảng đang mở
    if (!pdf || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Escape") {
        if (!tocPanel.hidden) closeToc();
        if (!browsePanel.hidden) closeBrowse();
    } else if (e.key.toLowerCase() === "t" && !e.target.matches("input"))
        tocBtn.click();
    });

    // Vẽ lại khi khung xem đổi kích thước (kéo cửa sổ, vào/ra toàn màn hình, ẩn/hiện menu...)
    new ResizeObserver(() => requestRender()).observe(bookView);
    loadPdf().catch((err) => {
        console.error("Không thể khởi tạo PDF viewer:", err);
        location.replace("./index.html");
    });
