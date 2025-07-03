// ==UserScript==
// @name         Douyin Downloader (LITE)
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Tải video và ảnh bìa Douyin với giao diện kéo thả, lưu tiến trình và tải song song.
// @author       Bạn
// @match        *://*.douyin.com/*
// @grant        none
// ==/UserScript==

/**
 * Script tất cả trong một, phiên bản chuyên nghiệp với:
 * - Giao diện tùy chỉnh, có thể kéo thả.
 * - Lưu lại lựa chọn của người dùng.
 * - Tải video và ảnh bìa song song để tăng tốc độ.
 * - Thanh tiến trình trực quan, nút Hủy và báo cáo kết quả.
 * - Tự động thử lại các tệp tải xuống bị lỗi.
 * - Tính năng "Tải lại thông minh" đã được sửa lỗi, lưu lại tiến trình khi hủy.
 * - Đã sửa lỗi treo ở bước "Sẵn sàng...".
 */

// Hàm chính để chạy toàn bộ quá trình
const runAllInOneDownloader = async () => {
    // --- CẤU HÌNH ---
    const CONFIG = {
        CONCURRENT_DOWNLOADS: 5,
        DOWNLOAD_RETRIES: 3,
        UI_ID: 'douyin-downloader-ui',
        STORAGE_KEY: 'douyinDownloaderPrefs',
        // Thêm liên kết xã hội của bạn tại đây
        SOCIAL_LINK: 'https://your-social-media-link.com' // Thay thế bằng liên kết của bạn
    };

    // Biến trạng thái để kiểm soát việc hủy bỏ
    let isCancelled = false;

    // --- QUẢN LÝ DATABASE CHO CÁC TỆP ĐÃ TẢI ---
    const downloadedDb = {
        db: null,
        dbName: 'douyinDownloadsDB_v2',
        storeName: 'downloadedFiles',
        async openDB() {
            return new Promise((resolve, reject) => {
                const request = indexedDB.open(this.dbName, 1);
                request.onerror = () => reject("Lỗi khi mở IndexedDB.");
                request.onsuccess = (event) => {
                    this.db = event.target.result;
                    resolve();
                };
                request.onupgradeneeded = (event) => {
                    const db = event.target.result;
                    if (!db.objectStoreNames.contains(this.storeName)) {
                        db.createObjectStore(this.storeName, { keyPath: 'id' });
                    }
                };
            });
        },
        async addFile(fileData) {
            return new Promise((resolve, reject) => {
                if (!this.db) return reject("DB is not open.");
                const transaction = this.db.transaction([this.storeName], 'readwrite');
                const store = transaction.objectStore(this.storeName);
                const request = store.put(fileData);
                request.onsuccess = resolve;
                request.onerror = () => reject("Lỗi khi thêm file vào DB.");
            });
        },
        async getAllFiles() {
            return new Promise((resolve, reject) => {
                if (!this.db) return reject("DB is not open.");
                const transaction = this.db.transaction([this.storeName], 'readonly');
                const store = transaction.objectStore(this.storeName);
                const request = store.getAll();
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject("Lỗi khi lấy danh sách file.");
            });
        },
        async clearStore() {
            return new Promise((resolve, reject) => {
                if (!this.db) return reject("DB is not open.");
                const transaction = this.db.transaction([this.storeName], 'readwrite');
                const store = transaction.objectStore(this.storeName);
                const request = store.clear();
                request.onsuccess = resolve;
                request.onerror = () => reject("Lỗi khi xóa DB.");
            });
        }
    };

    // --- HÀM HỖ TRỢ KÉO THẢ UI ---
    const makeDraggable = (element, handle) => {
        let offsetX, offsetY, isDragging = false;
        handle.onmousedown = (e) => {
            isDragging = true;
            e.preventDefault();
            offsetX = e.clientX - element.offsetLeft;
            offsetY = e.clientY - element.offsetTop;
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        };
        const onMouseMove = (e) => {
            if (!isDragging) return;
            element.style.left = `${e.clientX - offsetX}px`;
            element.style.top = `${e.clientY - offsetY}px`;
        };
        const onMouseUp = () => {
            isDragging = false;
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };
        handle.style.cursor = 'move';
    };

    // --- TIỆN ÍCH GIAO DIỆN NGƯỜI DÙNG (UI) ---
    const createProgressUI = () => {
        const oldUi = document.getElementById(CONFIG.UI_ID);
        if (oldUi) oldUi.remove();
        const prefs = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEY)) || {};
        const uiContainer = document.createElement('div');
        uiContainer.id = CONFIG.UI_ID;
        uiContainer.style.cssText = `position: fixed; top: 20px; right: 20px; width: 350px; background-color: #2c3e50; color: white; padding: 20px; border-radius: 10px; z-index: 9999; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif; box-shadow: 0 5px 15px rgba(0,0,0,0.3); transition: opacity 0.5s;`;
        const title = document.createElement('h3');
        // Đổi tên tiêu đề và thêm chữ LITE màu cam
        title.innerHTML = 'Douyin Downloader <span style="color: #ffa500;">LITE</span>';
        title.style.cssText = `margin: -20px -20px 10px -20px; padding: 15px 20px; border-bottom: 1px solid #465a70; position: relative;`;
        const cancelButton = document.createElement('button');
        cancelButton.id = 'downloader-cancel-button';
        cancelButton.textContent = 'Hủy';
        cancelButton.style.cssText = `position: absolute; top: 50%; right: 20px; transform: translateY(-50%); background-color: #e74c3c; color: white; border: none; padding: 5px 10px; border-radius: 5px; cursor: pointer; display: none;`;
        cancelButton.onclick = () => { isCancelled = true; };
        title.appendChild(cancelButton);
        const optionsContainer = document.createElement('div');
        optionsContainer.id = 'downloader-options';
        optionsContainer.style.cssText = 'margin-bottom: 15px; display: flex; flex-direction: column; gap: 10px;';
        const createCheckbox = (id, labelText, defaultChecked = true) => {
            const wrapper = document.createElement('div');
            wrapper.style.display = 'flex';
            wrapper.style.alignItems = 'center';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.id = id;
            checkbox.checked = prefs[id] !== undefined ? prefs[id] : defaultChecked;
            checkbox.style.marginRight = '8px';
            const label = document.createElement('label');
            label.htmlFor = id;
            label.textContent = labelText;
            label.style.cursor = 'pointer';
            wrapper.appendChild(checkbox);
            wrapper.appendChild(label);
            return wrapper;
        };
        // Hàm createInput không còn được sử dụng cho giới hạn video, nhưng vẫn giữ lại nếu cần cho tương lai.
        const createInput = (id, labelText, defaultValue = '') => {
            const wrapper = document.createElement('div');
            wrapper.style.display = 'flex';
            wrapper.style.alignItems = 'center';
            const label = document.createElement('label');
            label.htmlFor = id;
            label.textContent = labelText;
            label.style.flex = '1';
            const input = document.createElement('input');
            input.type = 'number';
            input.id = id;
            input.placeholder = 'Tất cả';
            input.value = prefs[id] || defaultValue;
            input.style.cssText = 'width: 80px; padding: 5px; border-radius: 3px; border: 1px solid #465a70; background: #3b4e63; color: white;';
            wrapper.appendChild(label);
            wrapper.appendChild(input);
            return wrapper;
        };
        optionsContainer.appendChild(createCheckbox('download-covers', 'Tải ảnh bìa'));
        optionsContainer.appendChild(createCheckbox('save-csv', 'Lưu file CSV'));
        // Xóa bỏ tính năng "Giới hạn số video"
        // optionsContainer.appendChild(createInput('limit-videos', 'Giới hạn số video'));
        const statusText = document.createElement('p');
        statusText.id = 'downloader-status-text';
        statusText.textContent = 'Sẵn sàng...';
        statusText.style.cssText = `margin: 0 0 10px 0; font-size: 14px; min-height: 20px;`;
        const progressBarContainer = document.createElement('div');
        progressBarContainer.style.cssText = `width: 100%; background-color: #465a70; border-radius: 5px; overflow: hidden;`;
        const progressBar = document.createElement('div');
        progressBar.id = 'downloader-progress-bar';
        progressBar.style.cssText = `width: 0%; height: 20px; background-color: #3498db; transition: width 0.3s ease-in-out; text-align: center; line-height: 20px; font-size: 12px;`;
        const startButton = document.createElement('button');
        startButton.id = 'downloader-start-button';
        startButton.textContent = 'Bắt đầu';
        startButton.style.cssText = `width: 100%; background-color: #27ae60; color: white; border: none; padding: 10px; border-radius: 5px; cursor: pointer; margin-top: 15px; font-size: 16px;`;
        const errorLogContainer = document.createElement('div');
        errorLogContainer.id = 'downloader-error-log';
        errorLogContainer.style.cssText = 'margin-top: 10px; font-size: 12px; max-height: 60px; overflow-y: auto; background: #1e2b38; padding: 5px; border-radius: 3px; display: none;';

        // Thêm thông tin liên hệ Ben
        const contactInfo = document.createElement('div');
        contactInfo.id = 'downloader-contact-info';
        contactInfo.style.cssText = 'margin-top: 15px; text-align: center; font-size: 12px;';
        const contactLink = document.createElement('a');
        contactLink.href = CONFIG.SOCIAL_LINK;
        contactLink.target = '_blank'; // Mở trong tab mới
        contactLink.style.cssText = 'color: white; text-decoration: none;';
        contactLink.innerHTML = 'Liên hệ <span style="color: #ffa500; font-weight: bold;">Ben</span>'; // Chữ Ben màu cam
        contactInfo.appendChild(contactLink);

        progressBarContainer.appendChild(progressBar);
        uiContainer.appendChild(title);
        uiContainer.appendChild(optionsContainer);
        uiContainer.appendChild(statusText);
        uiContainer.appendChild(progressBarContainer);
        uiContainer.appendChild(errorLogContainer);
        uiContainer.appendChild(startButton);
        uiContainer.appendChild(contactInfo); // Thêm thông tin liên hệ vào container
        document.body.appendChild(uiContainer);
        makeDraggable(uiContainer, title);
    };

    const updateProgressUI = (text, progress) => {
        const statusEl = document.getElementById('downloader-status-text');
        const progressEl = document.getElementById('downloader-progress-bar');
        if (!statusEl || !progressEl) return;
        if (isCancelled && progress < 100 && text.startsWith('Đang tải')) return;
        statusEl.textContent = text;
        progressEl.style.width = `${progress}%`;
        progressEl.textContent = `${Math.round(progress)}%`;
    };

    const logErrorUI = (filename) => {
        const errorLogContainer = document.getElementById('downloader-error-log');
        if (!errorLogContainer) return;
        errorLogContainer.style.display = 'block';
        const errorEntry = document.createElement('p');
        errorEntry.textContent = `Lỗi: ${filename}`;
        errorEntry.style.margin = '0';
        errorLogContainer.appendChild(errorEntry);
    };

    const resetUI = (message) => {
        const startButton = document.getElementById('downloader-start-button');
        const cancelButton = document.getElementById('downloader-cancel-button');
        const optionsContainer = document.getElementById('downloader-options');

        let runAgainButton = document.getElementById('run-again-button');
        if (!runAgainButton && startButton) {
            runAgainButton = document.createElement('button');
            runAgainButton.id = 'run-again-button';
            runAgainButton.textContent = 'Bắt đầu lại';
            runAgainButton.style.cssText = `width: 100%; background-color: #3498db; color: white; border: none; padding: 10px; border-radius: 5px; cursor: pointer; margin-top: 15px; font-size: 16px;`;
            runAgainButton.onclick = () => runAllInOneDownloader();
            startButton.parentElement.appendChild(runAgainButton);
        }

        updateProgressUI(message || 'Đã hủy. Sẵn sàng để thử lại.', 0);

        if (cancelButton) cancelButton.style.display = 'none';
        if (startButton) startButton.style.display = 'none';
        if (runAgainButton) runAgainButton.style.display = 'block';

        if (optionsContainer) {
            optionsContainer.style.pointerEvents = 'auto';
            optionsContainer.style.opacity = '1';
        }
    };

    // --- CÁC HÀM XỬ LÝ ---
    const loadJSZip = () => new Promise((resolve, reject) => {
        if (window.JSZip) return resolve();
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
        script.onload = resolve;
        script.onerror = () => reject(new Error('JSZip library failed to load.'));
        document.head.appendChild(script);
    });

    const fetchVideoPage = async (sec_user_id, max_cursor) => {
        const apiUrl = `https://www.douyin.com/aweme/v1/web/aweme/post/?device_platform=webapp&aid=6383&channel=channel_pc_web&sec_user_id=${sec_user_id}&max_cursor=${max_cursor}&count=20`;
        const response = await fetch(apiUrl, { headers: { "accept": "application/json, text/plain, */*" }, referrer: location.href, method: "GET", mode: "cors", credentials: "include" });
        if (!response.ok) throw new Error(`Lỗi HTTP! Status: ${response.status}`);
        const data = await response.json();
        if (data.status_code !== 0) throw new Error(`API Douyin trả về lỗi: ${data.status_msg || 'Lỗi không xác định'}`);
        return data;
    };

    const jsonToCsv = (items) => {
        if (items.length === 0) return "";
        const replacer = (key, value) => value === null ? '' : value;
        const header = Object.keys(items[0]);
        const csv = [ header.join(','), ...items.map(row => header.map(fieldName => JSON.stringify(row[fieldName], replacer)).join(',')) ].join('\r\n');
        return csv;
    };

    // --- HÀM CHẠY CHÍNH KHI NHẤN NÚT ---
    const startProcess = async () => {
        isCancelled = false;
        const startButton = document.getElementById('downloader-start-button');
        const cancelButton = document.getElementById('downloader-cancel-button');
        const optionsContainer = document.getElementById('downloader-options');

        const existingRunAgainButton = document.getElementById('run-again-button');
        if (existingRunAgainButton) existingRunAgainButton.remove();

        startButton.style.display = 'none';
        cancelButton.style.display = 'block';
        optionsContainer.style.pointerEvents = 'none';
        optionsContainer.style.opacity = '0.5';

        // Cập nhật prefsToSave để không lưu 'limit-videos'
        const prefsToSave = { 'download-covers': document.getElementById('download-covers').checked, 'save-csv': document.getElementById('save-csv').checked };
        localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(prefsToSave));

        let zip;
        const downloadedIds = new Set();
        let restoredFileCount = 0;

        try {
            updateProgressUI('Đang chuẩn bị công cụ...', 0);
            await loadJSZip();
            zip = new JSZip();

            updateProgressUI('Đang mở kho tạm (DB)...', 0);
            await downloadedDb.openDB();

            const restoredFiles = await downloadedDb.getAllFiles();
            if (restoredFiles.length > 0) {
                updateProgressUI(`Đang khôi phục ${restoredFiles.length} tệp đã tải...`, 0);
                for (const file of restoredFiles) {
                    zip.file(file.filename, file.blob);
                    if (!file.id.includes('_cover')) {
                        downloadedIds.add(file.id);
                    }
                }
                restoredFileCount = restoredFiles.length;
            }
        } catch (e) {
            resetUI(`Lỗi khởi tạo: ${e.message}`);
            return;
        }

        if (downloadedIds.size > 0) {
            updateProgressUI(`Đã khôi phục ${downloadedIds.size} video. Bắt đầu tìm video mới...`, 0);
            await new Promise(resolve => setTimeout(resolve, 1500));
        }

        updateProgressUI('Bắt đầu lấy thông tin video...', 0);
        const state = { videoMetadata: [], hasMore: true, maxCursor: 0, secUserId: location.pathname.match(/user\/([^?]+)/)?.[1], douyinUsername: document.querySelector('.qRqkP4qc')?.textContent || 'douyin-user' };
        // Đặt giới hạn video là Infinity vì tính năng đã bị xóa
        const videoLimit = Infinity;

        if(!state.secUserId) {
            resetUI(`Lỗi: Không tìm thấy User ID trên trang.`);
            return;
        }

        const newVideosToFetch = [];
        try {
            let currentPageData;
            while (state.hasMore && (downloadedIds.size + newVideosToFetch.length) < videoLimit) {
                if (isCancelled) {
                    resetUI('Đã hủy, tiến trình đã được lưu vào kho tạm.');
                    return;
                }

                updateProgressUI(`Đã tìm thấy ${downloadedIds.size + newVideosToFetch.length} video...`, 0);
                currentPageData = await fetchVideoPage(state.secUserId, state.maxCursor);
                if (!currentPageData || !currentPageData.aweme_list || currentPageData.aweme_list.length === 0) {
                    state.hasMore = false;
                    break;
                }
                for (const video of currentPageData.aweme_list) {
                    if ((downloadedIds.size + newVideosToFetch.length) >= videoLimit) break;
                    if (!downloadedIds.has(video.aweme_id) && video?.video?.play_addr?.url_list?.[0]) {
                        let url = video.video.play_addr.url_list[0];
                        if (!url.startsWith("https")) url = url.replace("http", "https");
                        newVideosToFetch.push({ id: video.aweme_id, description: video.desc, createTime: new Date(video.create_time * 1000).toLocaleString('vi-VN'), likes: video.statistics.digg_count, comments: video.statistics.comment_count, shares: video.statistics.share_count, musicTitle: video.music?.title, coverUrl: video.video?.cover?.url_list[0], videoUrl: url });
                    }
                }
                state.hasMore = currentPageData.has_more === 1;
                state.maxCursor = currentPageData.max_cursor;
                if (state.hasMore) await new Promise(resolve => setTimeout(resolve, 500));
            }
        } catch (error) {
            resetUI(`Lỗi khi lấy thông tin: ${error.message}`);
            return;
        }

        state.videoMetadata = newVideosToFetch;

        if (isCancelled) {
            resetUI('Đã hủy, tiến trình đã được lưu vào kho tạm.');
            return;
        }

        if (state.videoMetadata.length === 0) {
            if(restoredFileCount > 0) {
                updateProgressUI('Không có video mới, đang đóng gói các video đã tải...', 100);
            } else {
                resetUI('Không tìm thấy video nào.');
                return;
            }
        }

        const downloadCovers = document.getElementById('download-covers').checked;
        const saveCsv = document.getElementById('save-csv').checked;
        let completedItems = 0, failedItems = 0;

        if (state.videoMetadata.length > 0) {
            zip.file('metadata_new.json', JSON.stringify(state.videoMetadata, null, 2));
            if (saveCsv) zip.file('metadata_new.csv', jsonToCsv(state.videoMetadata));
        }

        const downloadQueue = [];
        state.videoMetadata.forEach((videoInfo, i) => {
            const videoNumber = String(downloadedIds.size + i + 1).padStart(4, '0');
            const safeDesc = (videoInfo.description || 'no_description').substring(0, 30).replace(/[/\\?%*:|"<>]/g, '');
            downloadQueue.push({ type: 'video', url: videoInfo.videoUrl, filename: `${videoNumber}_${safeDesc}.mp4`, id: videoInfo.id });
            if (downloadCovers && videoInfo.coverUrl) {
                downloadQueue.push({ type: 'image', url: videoInfo.coverUrl, filename: `images/${videoNumber}_${safeDesc}.jpg`, id: videoInfo.id + '_cover' });
            }
        });

        const totalItems = downloadQueue.length;
        if(totalItems > 0) {
            updateProgressUI(`Bắt đầu tải ${totalItems} tệp mới...`, 0);
        }

        const downloadTask = async (item) => {
            if (isCancelled) return;
            for (let attempt = 1; attempt <= CONFIG.DOWNLOAD_RETRIES; attempt++) {
                try {
                    const response = await fetch(item.url);
                    if (!response.ok) throw new Error(`Status ${response.status}`);
                    const blob = await response.blob();

                    zip.file(item.filename, blob);
                    await downloadedDb.addFile({ id: item.id, filename: item.filename, blob: blob });

                    completedItems++;
                    const totalProgressItems = restoredFileCount + totalItems;
                    const currentProgress = totalProgressItems > 0 ? (restoredFileCount + completedItems) / totalProgressItems * 100 : 0;
                    updateProgressUI(`Đang tải ${completedItems}/${totalItems} tệp mới...`, currentProgress);
                    return;
                } catch (e) {
                    if (attempt === CONFIG.DOWNLOAD_RETRIES) {
                        console.error(`❌ Lỗi khi tải ${item.filename} sau ${CONFIG.DOWNLOAD_RETRIES} lần thử:`, e.message);
                        logErrorUI(item.filename);
                        failedItems++;
                        completedItems++;
                        const totalProgressItems = restoredFileCount + totalItems;
                        const currentProgress = totalProgressItems > 0 ? (restoredFileCount + completedItems) / totalProgressItems * 100 : 0;
                        updateProgressUI(`Đang tải ${completedItems}/${totalItems} tệp mới...`, currentProgress);
                    }
                }
            }
        };

        const workers = Array(CONFIG.CONCURRENT_DOWNLOADS).fill(null).map(async () => {
            while (downloadQueue.length > 0 && !isCancelled) {
                const item = downloadQueue.shift();
                if (item) await downloadTask(item);
            }
        });
        await Promise.all(workers);

        if (isCancelled) {
            resetUI('Đã hủy, tiến trình đã được lưu vào kho tạm.');
            return;
        }

        updateProgressUI('Đang nén file .zip...', 100);
        const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });

        updateProgressUI(`Hoàn tất! ${downloadedIds.size + newVideosToFetch.length - failedItems} tệp thành công.`, 100);
        const link = document.createElement('a');
        link.href = URL.createObjectURL(zipBlob);
        link.download = `${state.douyinUsername.replace(/[/\\?%*:|"<>]/g, '-')}-data.zip`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(link.href);

        await downloadedDb.clearStore();
        updateProgressUI(`Đã dọn dẹp kho tạm. Sẵn sàng cho lần tải mới.`, 100);
        await new Promise(resolve => setTimeout(resolve, 2000));

        resetUI('Hoàn tất! Sẵn sàng cho lần tải tiếp theo.');
    };

    // --- KHỞI TẠO UI VÀ GÁN SỰ KIỆN ---
    createProgressUI();
    document.getElementById('downloader-start-button').onclick = startProcess;
};

runAllInOneDownloader();
