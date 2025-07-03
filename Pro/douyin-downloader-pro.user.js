// ==UserScript==
// @name         Douyin Downloader (PRO)
// @namespace    http://tampermonkey.net/
// @version      7.3 (Final)
// @description  Download all videos from a Douyin user's page with a professional UI: drag-and-drop, smart resume, video preview and selection, custom filename formatting, and advanced controls.
// @author       Ben
// @match        https://www.douyin.com/user/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // Hàm chính để chạy toàn bộ trình tải xuống
    const runDouyinDownloader = async () => {

        // --- CẤU HÌNH CỐ ĐỊNH ---
        const CONFIG = {
            CONCURRENT_DOWNLOADS: 5,        // Số lượng tải xuống đồng thời
            DOWNLOAD_RETRIES: 3,            // Số lần thử lại nếu tải xuống thất bại
            UI_ID: 'douyin-downloader-ui',  // ID của phần tử giao diện người dùng
            STORAGE_KEY: 'douyinDownloaderPrefs', // Khóa lưu trữ cài đặt người dùng
            UI_POSITION_KEY: 'douyinDownloaderUIPos', // Khóa lưu trữ vị trí giao diện
            VIDEOS_PER_PAGE: 30,            // Số lượng video hiển thị trên màn hình chọn
            API_FETCH_DELAY_MIN: 500,       // Độ trễ tối thiểu (ms) giữa các cuộc gọi API
            API_FETCH_DELAY_MAX: 1500       // Độ trễ tối đa (ms) giữa các cuộc gọi API
        };

        // --- BIẾN TRẠNG THÁI ---
        let isCancelled = false; // Cờ hủy quá trình
        let allFetchedVideos = []; // Lưu trữ TẤT CẢ metadata video đã lấy
        let currentlyDisplayedVideos = []; // Lưu trữ video đang hiển thị trên màn hình chọn
        let currentFilter = 'all'; // Bộ lọc hiện tại: 'all', 'downloaded', 'not-downloaded'
        let currentSort = 'newest'; // Sắp xếp hiện tại: 'newest', 'likes-desc'
        let hasMoreVideosToFetch = true; // Theo dõi còn video để lấy từ API Douyin không
        let isFetchingMoreVideos = false; // Ngăn chặn nhiều yêu cầu fetch đồng thời
        let maxCursor = 0; // Con trỏ phân trang cho API Douyin
        let originalVideoIndex = 0; // Để giữ thứ tự ban đầu cho sắp xếp "mới nhất"
        let zipWorker = null; // Đối tượng Web Worker cho việc nén ZIP

        // --- NỘI DUNG SCRIPT CỦA WEB WORKER (cho việc nén) ---
        // Script này sẽ được chuyển đổi thành Blob URL và chạy như một Web Worker
        const ZIP_WORKER_SCRIPT_CONTENT = `
            importScripts('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');

            self.onmessage = async (event) => {
                const { filesToZip, metadata } = event.data;
                const zip = new JSZip();

                // Thêm file metadata
                zip.file('metadata.json', JSON.stringify(metadata, null, 2));

                for (const file of filesToZip) {
                    // Đảm bảo tên file là tương đối với thư mục gốc của zip
                    const cleanedFilename = file.filename.startsWith('/') ? file.filename.substring(1) : file.filename;
                    zip.file(cleanedFilename, file.blob);
                }

                try {
                    const zipBlob = await zip.generateAsync({
                        type: 'blob',
                        compression: 'DEFLATE'
                    }, (meta) => {
                        // Gửi tiến độ về luồng chính
                        self.postMessage({ type: 'progress', data: meta.percent });
                    });
                    self.postMessage({ type: 'complete', data: zipBlob });
                } catch (error) {
                    self.postMessage({ type: 'error', data: error.message });
                }
            };
        `;

        // --- QUẢN LÝ CƠ SỞ DỮ LIỆU (IndexedDB) ---
        const downloadedDb = {
            db: null,
            dbName: 'douyinDownloadsDB_v2',
            storeName: 'downloadedFiles',

            async openDB() {
                return new Promise((resolve, reject) => {
                    if (this.db) {
                        return resolve();
                    }
                    const request = indexedDB.open(this.dbName, 1);
                    request.onerror = () => reject(new Error("Lỗi khi mở IndexedDB."));
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
                    if (!this.db) {
                        return resolve();
                    }
                    const transaction = this.db.transaction([this.storeName], 'readwrite');
                    const store = transaction.objectStore(this.storeName);
                    const request = store.put(fileData);
                    request.onsuccess = resolve;
                    request.onerror = (event) => reject(new Error(`Lỗi thêm file vào DB: ${event.target.error}`));
                });
            },

            async getAllFiles() {
                return new Promise((resolve, reject) => {
                    if (!this.db) {
                        return resolve([]);
                    }
                    const transaction = this.db.transaction([this.storeName], 'readonly');
                    const store = transaction.objectStore(this.storeName);
                    const request = store.getAll();
                    request.onsuccess = (e) => resolve(e.target.result);
                    request.onerror = (event) => reject(new Error(`Lỗi lấy file từ DB: ${event.target.error}`));
                });
            },

            async clearStore() {
                return new Promise((resolve, reject) => {
                    if (!this.db) {
                        return resolve();
                    }
                    const transaction = this.db.transaction([this.storeName], 'readwrite');
                    const store = transaction.objectStore(this.storeName);
                    const request = store.clear();
                    request.onsuccess = resolve;
                    request.onerror = (event) => reject(new Error(`Lỗi xóa store trong DB: ${event.target.error}`));
                });
            }
        };

        // --- HÀM TIỆN ÍCH ---

        /**
         * Tạo hiệu ứng kéo thả cho một phần tử UI.
         * @param {HTMLElement} element - Phần tử sẽ được kéo.
         * @param {HTMLElement} handle - Phần tử dùng để kéo (thường là thanh tiêu đề).
         */
        const makeDraggable = (element, handle) => {
            let offsetX, offsetY, isDragging = false;
            handle.onmousedown = (e) => {
                // Không kéo nếu click vào nút hoặc nhóm nút
                if (e.target.tagName === 'BUTTON' || e.target.closest('.downloader-title-btn-group')) {
                    return;
                }
                isDragging = true;
                element.classList.add('dragging'); // Tắt transition khi kéo
                offsetX = e.clientX - element.offsetLeft;
                offsetY = e.clientY - element.offsetTop;
                document.addEventListener('mousemove', onMouseMove);
                document.addEventListener('mouseup', onMouseUp);
            };

            const onMouseMove = (e) => {
                if (!isDragging) {
                    return;
                }
                element.style.left = `${e.clientX - offsetX}px`;
                element.style.top = `${e.clientY - offsetY}px`;
            };

            const onMouseUp = () => {
                isDragging = false;
                element.classList.remove('dragging'); // Bật lại transition
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);

                // Lưu vị trí mới vào localStorage
                localStorage.setItem(CONFIG.UI_POSITION_KEY, JSON.stringify({
                    left: element.style.left,
                    top: element.style.top
                }));
            };
            handle.style.cursor = 'move';
        };

        /**
         * Cập nhật văn bản trạng thái và thanh tiến độ trên UI.
         * @param {string} text - Văn bản trạng thái.
         * @param {number} progress - Tiến độ (0-100).
         */
        const updateProgressUI = (text, progress) => {
            const statusEl = document.getElementById('downloader-status-text');
            const progressEl = document.getElementById('downloader-progress-bar');
            if (!statusEl || !progressEl) {
                return;
            }
            if (isCancelled && progress < 100 && text.startsWith('Downloading')) { // Tránh cập nhật khi đã hủy
                return;
            }
            statusEl.textContent = text;
            progressEl.style.width = `${progress}%`;
            progressEl.textContent = `${Math.round(progress)}%`;
        };

        /**
         * Cập nhật tên file đang được tải xuống trên UI.
         * @param {string} filename - Tên file đang tải.
         */
        const updateCurrentDownloadDisplay = (filename) => {
            const currentFileEl = document.getElementById('current-download-file');
            if (currentFileEl) {
                currentFileEl.textContent = filename ? `Đang tải: ${filename}` : '';
            }
        };

        /**
         * Thêm một mục vào nhật ký tải xuống.
         * @param {string} filename - Tên file.
         * @param {'success'|'failed'} status - Trạng thái tải xuống.
         */
        const addDownloadLogEntry = (filename, status) => {
            const logContainer = document.getElementById('download-log');
            if (!logContainer) {
                return;
            }

            const entry = document.createElement('p');
            entry.style.margin = '2px 0';
            entry.style.fontSize = '11px';
            if (status === 'success') {
                entry.style.color = '#2ecc71'; // Xanh lá
                entry.textContent = `✓ ${filename}`;
            } else if (status === 'failed') {
                entry.style.color = '#e74c3c'; // Đỏ
                entry.textContent = `✖ ${filename}`;
            }
            logContainer.prepend(entry); // Thêm lên đầu

            // Giới hạn số lượng mục trong log
            while (logContainer.children.length > 5) {
                logContainer.removeChild(logContainer.lastChild);
            }
        };

        /**
         * Hiển thị thông báo lỗi trên UI.
         * @param {string} filename - Tên file bị lỗi.
         */
        const logErrorUI = (filename) => {
            const ui = document.getElementById(CONFIG.UI_ID);
            if (!ui) {
                return;
            }
            let errorLogContainer = ui.querySelector('#downloader-error-log');
            if (!errorLogContainer) {
                errorLogContainer = document.createElement('div');
                errorLogContainer.id = 'downloader-error-log';
                errorLogContainer.style.cssText = 'margin-top: 10px; font-size: 12px; max-height: 60px; overflow-y: auto; background: #1e2b38; padding: 5px; border-radius: 3px;';
                ui.querySelector('#downloader-main-container').appendChild(errorLogContainer);
            }
            errorLogContainer.style.display = 'block';
            const errorEntry = document.createElement('p');
            errorEntry.textContent = `Lỗi: ${filename}`;
            errorEntry.style.margin = '0';
            errorLogContainer.appendChild(errorEntry);
        };

        /**
         * Hiển thị một thông báo toast.
         * @param {string} message - Nội dung thông báo.
         * @param {'info'|'success'|'error'} type - Loại thông báo.
         * @param {number} duration - Thời gian hiển thị (ms).
         */
        const showToast = (message, type = 'info', duration = 3000) => {
            let toastContainer = document.getElementById('toast-container');
            if (!toastContainer) {
                toastContainer = document.createElement('div');
                toastContainer.id = 'toast-container';
                toastContainer.style.cssText = `
                    position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
                    z-index: 100000; display: flex; flex-direction: column-reverse; gap: 10px;
                    align-items: center; pointer-events: none; /* Cho phép click xuyên qua */
                `;
                document.body.appendChild(toastContainer);
            }

            const toast = document.createElement('div');
            toast.style.cssText = `
                background-color: ${type === 'success' ? '#2ecc71' : type === 'error' ? '#e74c3c' : '#3498db'};
                color: white; padding: 10px 20px; border-radius: 5px;
                box-shadow: 0 2px 10px rgba(0,0,0,0.3); font-size: 14px;
                opacity: 0; transform: translateY(20px); transition: opacity 0.3s ease-out, transform 0.3s ease-out;
                pointer-events: auto; /* Kích hoạt lại click cho chính toast */
            `;
            toast.textContent = message;
            toastContainer.appendChild(toast);

            setTimeout(() => {
                toast.style.opacity = '1';
                toast.style.transform = 'translateY(0)';
            }, 100);

            setTimeout(() => {
                toast.style.opacity = '0';
                toast.style.transform = 'translateY(20px)';
                toast.addEventListener('transitionend', () => toast.remove());
            }, duration);
        };

        /**
         * Tạo một độ trễ ngẫu nhiên.
         * @param {number} ms - Thời gian trễ tối thiểu.
         * @returns {Promise<void>}
         */
        const delay = (ms) => new Promise(res => setTimeout(res, ms));

        /**
         * Lấy dữ liệu video từ API Douyin.
         * @param {string} sec_user_id - ID người dùng Douyin.
         * @param {number} cursor - Con trỏ phân trang.
         * @returns {Promise<object>} Dữ liệu API.
         */
        const fetchVideoPage = async (sec_user_id, cursor) => {
            // Thêm độ trễ ngẫu nhiên trước khi fetch
            const randomDelay = Math.random() * (CONFIG.API_FETCH_DELAY_MAX - CONFIG.API_FETCH_DELAY_MIN) + CONFIG.API_FETCH_DELAY_MIN;
            await delay(randomDelay);

            const apiUrl = `https://www.douyin.com/aweme/v1/web/aweme/post/?device_platform=webapp&aid=6383&channel=channel_pc_web&sec_user_id=${sec_user_id}&max_cursor=${cursor}&count=20`;
            const response = await fetch(apiUrl, { headers: { "accept": "application/json, text/plain, */*" }, referrer: location.href, method: "GET", mode: "cors", credentials: "include" });
            if (!response.ok) {
                throw new Error(`Lỗi HTTP! Trạng thái: ${response.status}`);
            }
            const data = await response.json();
            if (data.status_code !== 0) {
                throw new Error(`Lỗi API Douyin: ${data.status_msg || 'Lỗi không xác định'}`);
            }
            return data;
        };

        /**
         * Tạo tên file dựa trên định dạng đã chọn.
         * @param {object} parts - Các phần của tên file (index, desc, id).
         * @param {object} videoData - Dữ liệu video.
         * @param {number} index - Chỉ số của video.
         * @returns {string} Tên file đã tạo.
         */
        const generateFilename = (parts, videoData, index) => {
            const components = [];
            if (parts.index) {
                components.push(String(index).padStart(4, '0'));
            }
            if (parts.desc) {
                const safeDesc = (videoData.description || 'no_desc').substring(0, 50).replace(/[\\/?%*:|"<>]/g, '');
                components.push(safeDesc);
            }
            if (parts.id) {
                components.push(videoData.id);
            }
            return components.join(' - ').trim() || videoData.id;
        };

        // --- CÁC HÀM XỬ LÝ GIAO DIỆN NGƯỜI DÙNG (UI) ---

        /**
         * Đặt lại trạng thái UI về ban đầu.
         * @param {string} message - Thông báo hiển thị trên trạng thái.
         */
        const resetUI = (message) => {
            const ui = document.getElementById(CONFIG.UI_ID);
            if (!ui) {
                return;
            }

            ui.classList.remove('minimized');
            ui.querySelector('#downloader-minimize-btn').textContent = '—';
            ui.querySelector('#downloader-cancel-button').style.display = 'none';
            ui.querySelector('#downloader-selection-container').style.display = 'none';
            ui.querySelector('#downloader-main-container').style.display = 'block';

            const options = ui.querySelector('#downloader-options');
            if (options) {
                options.style.pointerEvents = 'auto';
                options.style.opacity = '1';
            }

            let runAgainButton = ui.querySelector('#run-again-button');
            const mainContainer = ui.querySelector('#downloader-main-container');
            if (!runAgainButton && mainContainer) {
                runAgainButton = document.createElement('button');
                runAgainButton.id = 'run-again-button';
                runAgainButton.style.cssText = `width: 100%; background-color: #3498db; color: white; border: none; padding: 10px; border-radius: 5px; cursor: pointer; margin-top: 15px; font-size: 16px;`;
                runAgainButton.onclick = () => runDouyinDownloader();
                mainContainer.appendChild(runAgainButton);
            }
            if (runAgainButton) {
                runAgainButton.textContent = 'Bắt đầu lại';
                runAgainButton.style.display = 'block';
            }
            ui.querySelector('#downloader-start-button').style.display = 'none';

            updateProgressUI(message || 'Sẵn sàng.', 0);
            updateCurrentDownloadDisplay(''); // Xóa hiển thị file đang tải
            document.getElementById('download-log').innerHTML = ''; // Xóa nhật ký tải xuống
            const errorLogContainer = document.getElementById('downloader-error-log');
            if (errorLogContainer) {
                errorLogContainer.innerHTML = '';
                errorLogContainer.style.display = 'none';
            }
        };

        /**
         * Hiển thị màn hình chọn video.
         * @param {Array<object>} videos - Danh sách video để hiển thị.
         * @param {Array<object>} restoredFiles - Danh sách file đã tải xuống từ IndexedDB.
         */
        const showSelectionScreen = (videos, restoredFiles) => {
            const ui = document.getElementById(CONFIG.UI_ID);
            ui.querySelector('#downloader-main-container').style.display = 'none';
            ui.querySelector('#downloader-selection-container').style.display = 'block';
            ui.querySelector('#downloader-cancel-button').style.display = 'none';
            ui.querySelector('#advanced-settings-btn').style.display = 'none';
            ui.querySelector('#downloader-minimize-btn').style.display = 'none';

            const videoListContainer = ui.querySelector('#downloader-video-list');
            videoListContainer.innerHTML = '';
            updateProgressUI(`Tìm thấy ${videos.length} video. Vui lòng chọn.`, 100);

            videoListContainer.style.display = 'grid';
            videoListContainer.style.gridTemplateColumns = 'repeat(3, 1fr)';
            videoListContainer.style.gap = '10px';

            const restoredIds = new Set(restoredFiles.map(f => f.id));

            /**
             * Hàm con để render các mục video vào danh sách.
             * @param {Array<object>} videosToRender - Danh sách video cần render.
             */
            const renderVideoItems = (videosToRender) => {
                videosToRender.forEach((video) => {
                    const isRestored = restoredIds.has(video.id);

                    const itemWrapper = document.createElement('div');
                    itemWrapper.style.cssText = 'position: relative; cursor: pointer;';
                    if (isRestored) {
                        itemWrapper.style.opacity = '0.6';
                    }

                    const checkbox = document.createElement('input');
                    checkbox.type = 'checkbox';
                    checkbox.checked = !isRestored;
                    checkbox.disabled = isRestored; // Vô hiệu hóa checkbox cho video đã tải
                    checkbox.dataset.videoIndex = video.originalIndex; // Lưu index gốc
                    checkbox.style.cssText = 'position: absolute; top: 5px; left: 5px; z-index: 1; height: 18px; width: 18px;';

                    const img = document.createElement('img');
                    img.src = video.coverUrl;
                    img.alt = video.description || 'video cover';
                    img.style.cssText = 'width: 100%; height: 130px; object-fit: cover; border-radius: 4px; display: block;';

                    const desc = document.createElement('span');
                    const shortDesc = (video.description || '...').substring(0, 4);
                    desc.innerHTML = `${shortDesc}... ${isRestored ? '<i>(đã lưu)</i>' : ''}`;
                    desc.style.cssText = 'font-size: 11px; color: #ccc; text-align: center; display: block; margin-top: 4px; height: 15px; overflow: hidden;';

                    // Thêm dấu tích cho video đã tải
                    if (isRestored) {
                        const checkmark = document.createElement('div');
                        checkmark.className = 'downloaded-checkmark';
                        checkmark.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="white" width="18px" height="18px"><path d="M0 0h24v24H0z" fill="none"/><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`;
                        itemWrapper.appendChild(checkmark);
                    }

                    // Xử lý sự kiện hover để xem trước video
                    itemWrapper.onmouseenter = () => {
                        const videoPreviewContainer = document.getElementById('video-preview-container');
                        const videoPreviewPlayer = document.getElementById('video-preview-player');
                        const videoPreviewDesc = document.getElementById('video-preview-desc');

                        if (videoPreviewContainer && videoPreviewPlayer && videoPreviewDesc) {
                            videoPreviewPlayer.src = video.videoUrl;
                            videoPreviewDesc.textContent = video.description || 'Không có mô tả';

                            const itemRect = itemWrapper.getBoundingClientRect();
                            const previewWidth = 270;
                            const previewHeight = 200;

                            let previewLeft;
                            let previewTop = itemRect.top;

                            // Đặt vị trí xem trước: bên phải nếu đủ chỗ, ngược lại bên trái
                            if (itemRect.right + previewWidth + 10 <= window.innerWidth) {
                                previewLeft = itemRect.right + 10;
                            } else {
                                previewLeft = itemRect.left - previewWidth - 10;
                                if (previewLeft < 0) { // Nếu vẫn không đủ chỗ, đặt ở góc trái
                                    previewLeft = 10;
                                }
                            }

                            // Đảm bảo xem trước không vượt quá đáy màn hình
                            if (previewTop + previewHeight > window.innerHeight) {
                                previewTop = window.innerHeight - previewHeight - 10;
                                if (previewTop < 0) { // Nếu vẫn không đủ chỗ, đặt ở góc trên
                                    previewTop = 10;
                                }
                            }

                            videoPreviewContainer.style.left = `${previewLeft}px`;
                            videoPreviewContainer.style.top = `${previewTop}px`;
                            videoPreviewContainer.style.display = 'block';

                            setTimeout(() => {
                                videoPreviewPlayer.play().catch(error => {
                                    console.error("Lỗi khi phát xem trước video:", error);
                                    videoPreviewDesc.textContent = "Không thể phát video này.";
                                });
                            }, 50);
                        }
                    };

                    itemWrapper.onmouseleave = () => {
                        const videoPreviewContainer = document.getElementById('video-preview-container');
                        const videoPreviewPlayer = document.getElementById('video-preview-player');
                        if (videoPreviewContainer && videoPreviewPlayer) {
                            videoPreviewPlayer.pause();
                            videoPreviewPlayer.currentTime = 0;
                            videoPreviewContainer.style.display = 'none';
                        }
                    };

                    img.onclick = () => {
                        if (!checkbox.disabled) {
                            checkbox.checked = !checkbox.checked;
                        }
                    };

                    itemWrapper.appendChild(checkbox);
                    itemWrapper.appendChild(img);
                    itemWrapper.appendChild(desc);
                    videoListContainer.appendChild(itemWrapper);
                });
            };

            // Render một tập hợp con ban đầu của video
            currentlyDisplayedVideos = applyFilterAndSort(videos, restoredIds, (filtered) => {
                return filtered.slice(0, CONFIG.VIDEOS_PER_PAGE);
            });
            renderVideoItems(currentlyDisplayedVideos);

            // Thêm phần tử chỉ báo đang tải (loading indicator)
            const loadingIndicator = document.createElement('div');
            loadingIndicator.id = 'lazy-load-indicator';
            loadingIndicator.style.cssText = `
                text-align: center; padding: 10px; font-size: 14px; color: #ccc; display: none;
            `;
            loadingIndicator.textContent = 'Đang tải thêm video...';
            videoListContainer.parentNode.appendChild(loadingIndicator); // Thêm bên dưới danh sách video

            // Thêm trình nghe sự kiện cuộn để tải lười (lazy loading)
            videoListContainer.onscroll = async () => {
                if (isCancelled || isFetchingMoreVideos || !hasMoreVideosToFetch) {
                    return;
                }

                // Ngưỡng cuộn (50px từ đáy)
                const scrollThreshold = videoListContainer.scrollHeight - videoListContainer.clientHeight - 50;
                if (videoListContainer.scrollTop > scrollThreshold) {
                    isFetchingMoreVideos = true;
                    loadingIndicator.style.display = 'block'; // Hiện chỉ báo tải
                    updateProgressUI(`Đang tải thêm video...`, 100);

                    const videoLimit = parseInt(document.getElementById('limit-videos').value, 10) || Infinity;
                    const secUserId = location.pathname.match(/user\/([^?]+)/)?.[1];

                    try {
                        const currentPageData = await fetchVideoPage(secUserId, maxCursor);
                        if (!currentPageData || !currentPageData.aweme_list || currentPageData.aweme_list.length === 0) {
                            hasMoreVideosToFetch = false;
                            showToast('Đã tải tất cả video.', 'info');
                            updateProgressUI(`Đã tải tất cả ${allFetchedVideos.length} video.`, 100);
                            isFetchingMoreVideos = false;
                            loadingIndicator.style.display = 'none'; // Ẩn chỉ báo tải
                            return;
                        }

                        let newVideos = [];
                        for (const video of currentPageData.aweme_list) {
                            if (allFetchedVideos.length >= videoLimit) {
                                hasMoreVideosToFetch = false;
                                break;
                            }
                            if (video?.video?.play_addr?.url_list?.[0]) {
                                newVideos.push({
                                    id: video.aweme_id,
                                    description: video.desc,
                                    coverUrl: video.video.cover.url_list[0],
                                    videoUrl: video.video.play_addr.url_list[0].replace('http:','https:'),
                                    likes: video.statistics.digg_count,
                                    originalIndex: originalVideoIndex++
                                });
                            }
                        }
                        allFetchedVideos.push(...newVideos);
                        maxCursor = currentPageData.max_cursor;
                        hasMoreVideosToFetch = currentPageData.has_more === 1;

                        const filteredAndSorted = applyFilterAndSort(allFetchedVideos, restoredIds, (filtered) => filtered);
                        const newVideosToDisplay = filteredAndSorted.slice(currentlyDisplayedVideos.length, currentlyDisplayedVideos.length + CONFIG.VIDEOS_PER_PAGE);
                        currentlyDisplayedVideos.push(...newVideosToDisplay);
                        renderVideoItems(newVideosToDisplay); // Chỉ render những cái mới

                        updateProgressUI(`Tìm thấy ${allFetchedVideos.length} video. Vui lòng chọn.`, 100);
                        if (!hasMoreVideosToFetch) {
                            showToast('Đã tải tất cả video.', 'info');
                        }

                    } catch (error) {
                        let errorMessage = `Lỗi khi tải thêm video: ${error.message}.`;
                        if (error.message.includes("HTTP Error")) {
                            errorMessage = `Lỗi mạng khi tải thêm video: ${error.message}. Vui lòng kiểm tra kết nối internet.`;
                        } else if (error.message.includes("Douyin API Error")) {
                            errorMessage = `Lỗi API Douyin khi tải thêm video: ${error.message}. Vui lòng thử lại sau.`;
                        }
                        showToast(errorMessage, 'error', 5000);
                        console.error("Lỗi khi fetch thêm video:", error);
                        hasMoreVideosToFetch = false; // Ngừng cố gắng fetch nếu có lỗi
                    } finally {
                        isFetchingMoreVideos = false;
                        loadingIndicator.style.display = 'none'; // Ẩn chỉ báo tải
                    }
                }
            };

            // Gắn sự kiện cho các nút điều khiển trên màn hình chọn
            ui.querySelector('#select-all-btn').onclick = () => {
                videoListContainer.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                    if (!cb.disabled) cb.checked = true;
                });
            };
            ui.querySelector('#deselect-all-btn').onclick = () => videoListContainer.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
            ui.querySelector('#downloader-download-selected').onclick = () => {
                ui.querySelector('#advanced-settings-btn').style.display = 'block';
                ui.querySelector('#downloader-minimize-btn').style.display = 'block';
                // Thu thập các video đã chọn từ allFetchedVideos dựa trên originalIndex
                const selectedIndices = [...videoListContainer.querySelectorAll('input:checked')]
                    .map(cb => parseInt(cb.dataset.videoIndex, 10));
                const selectedVideos = selectedIndices.map(index => allFetchedVideos.find(v => v.originalIndex === index)); // Tìm bằng originalIndex
                startFinalDownload(selectedVideos, restoredFiles);
            };

            const filterButtons = ui.querySelectorAll('#filter-buttons button');
            filterButtons.forEach(button => {
                button.onclick = (e) => {
                    filterButtons.forEach(btn => btn.classList.remove('active'));
                    e.target.classList.add('active');
                    currentFilter = e.target.dataset.filter;
                    // Render lại danh sách dựa trên bộ lọc/sắp xếp mới
                    const filteredAndSorted = applyFilterAndSort(allFetchedVideos, restoredIds, (filtered) => filtered);
                    videoListContainer.innerHTML = ''; // Xóa tất cả để render lại
                    currentlyDisplayedVideos = filteredAndSorted.slice(0, CONFIG.VIDEOS_PER_PAGE);
                    renderVideoItems(currentlyDisplayedVideos);
                };
            });

            const sortSelect = ui.querySelector('#sort-select');
            sortSelect.onchange = (e) => {
                currentSort = e.target.value;
                // Render lại danh sách dựa trên bộ lọc/sắp xếp mới
                const filteredAndSorted = applyFilterAndSort(allFetchedVideos, restoredIds, (filtered) => filtered);
                videoListContainer.innerHTML = ''; // Xóa tất cả để render lại
                currentlyDisplayedVideos = filteredAndSorted.slice(0, CONFIG.VIDEOS_PER_PAGE);
                renderVideoItems(currentlyDisplayedVideos);
            };

            ui.querySelector(`#filter-buttons button[data-filter="${currentFilter}"]`)?.classList.add('active');
            sortSelect.value = currentSort;
        };

        /**
         * Áp dụng bộ lọc và sắp xếp cho danh sách video.
         * @param {Array<object>} videos - Danh sách video đầy đủ.
         * @param {Set<string>} restoredIds - Tập hợp ID của các video đã được khôi phục.
         * @param {function} renderCallback - Hàm callback để xử lý danh sách đã lọc/sắp xếp.
         * @returns {Array<object>} Danh sách video đã lọc và sắp xếp.
         */
        const applyFilterAndSort = (videos, restoredIds, renderCallback) => {
            let filtered = [...videos];

            if (currentFilter === 'downloaded') {
                filtered = filtered.filter(video => restoredIds.has(video.id));
            } else if (currentFilter === 'not-downloaded') {
                filtered = filtered.filter(video => !restoredIds.has(video.id));
            }

            if (currentSort === 'likes-desc') {
                filtered.sort((a, b) => (b.likes || 0) - (a.likes || 0));
            } else if (currentSort === 'newest') {
                filtered.sort((a, b) => a.originalIndex - b.originalIndex);
            }

            return renderCallback(filtered);
        };

        /**
         * Tạo và hiển thị giao diện người dùng chính của trình tải xuống.
         */
        const createProgressUI = () => {
            const oldUi = document.getElementById(CONFIG.UI_ID);
            if (oldUi) {
                oldUi.remove();
            }

            // Tải cài đặt từ localStorage
            const prefs = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEY)) || {};
            prefs['filename-parts'] = prefs['filename-parts'] || { index: true, desc: true, id: false };
            prefs['concurrent-downloads'] = prefs['concurrent-downloads'] || CONFIG.CONCURRENT_DOWNLOADS;
            prefs['filter'] = prefs['filter'] || 'all';
            prefs['sort'] = prefs['sort'] || 'newest';
            prefs['video-folder'] = prefs['video-folder'] || 'videos';
            prefs['image-folder'] = prefs['image-folder'] || 'images';

            currentFilter = prefs['filter'];
            currentSort = prefs['sort'];

            const uiContainer = document.createElement('div');
            uiContainer.id = CONFIG.UI_ID;
            uiContainer.style.cssText = `position: fixed; top: 20px; right: 20px; width: 380px; background-color: #2c3e50; color: white; padding: 20px; border-radius: 10px; z-index: 99999; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif; box-shadow: 0 5px 15px rgba(0,0,0,0.3); transition: all 0.3s; display: flex; flex-direction: column;`;

            // Khôi phục vị trí UI đã lưu
            const savedUIPosition = JSON.parse(localStorage.getItem(CONFIG.UI_POSITION_KEY));
            if (savedUIPosition) {
                uiContainer.style.left = savedUIPosition.left;
                uiContainer.style.top = savedUIPosition.top;
            }

            // Thêm các kiểu CSS
            const styleSheet = document.createElement('style');
            styleSheet.textContent = `
                #filename-toggles button.active, #filter-buttons button.active { background-color: #3498db !important; }
                .downloader-title-btn {
                    background: none; border: none; color: white; font-size: 20px;
                    cursor: pointer; padding: 0 5px; line-height: 1;
                }
                #downloader-body {
                    transition: all 0.3s ease-out;
                    overflow: hidden;
                }
                #${CONFIG.UI_ID}.minimized #downloader-body {
                    height: 0 !important;
                    opacity: 0;
                    padding-top: 0;
                    padding-bottom: 0;
                    margin-top: -10px;
                }
                #${CONFIG.UI_ID} h3 {
                    user-select: none;
                    -webkit-user-select: none;
                }
                #${CONFIG.UI_ID}.dragging {
                    transition: none !important;
                }
                .filter-sort-group {
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    margin-bottom: 10px;
                    flex-wrap: wrap;
                }
                .filter-sort-group label {
                    white-space: nowrap;
                }
                .filter-sort-group button {
                    background: #566573;
                    color: white;
                    border: none;
                    padding: 5px 10px;
                    border-radius: 3px;
                    cursor: pointer;
                }
                .filter-sort-group select {
                    background: #3b4e63;
                    color: white;
                    border: 1px solid #465a70;
                    padding: 5px;
                    border-radius: 3px;
                }
                #current-download-file {
                    font-size: 13px;
                    margin-top: 5px;
                    min-height: 18px;
                    color: #a0a0a0;
                    overflow: hidden;
                    white-space: nowrap;
                    text-overflow: ellipsis;
                }
                #download-log {
                    max-height: 80px;
                    overflow-y: auto;
                    background: #1e2b38;
                    padding: 5px;
                    border-radius: 3px;
                    margin-top: 10px;
                    border: 1px solid #465a70;
                }
                .custom-overlay {
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    background-color: rgba(0, 0, 0, 0.7);
                    z-index: 99998;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                }
                #custom-alert-box, #custom-confirm-box {
                    position: relative;
                    top: auto;
                    left: auto;
                    transform: none;
                    z-index: 100000;
                }
                #toast-container {
                    position: fixed;
                    bottom: 20px;
                    left: 50%;
                    transform: translateX(-50%);
                    z-index: 100000;
                    display: flex;
                    flex-direction: column-reverse;
                    gap: 10px;
                    align-items: center;
                    pointer-events: none;
                }
                #toast-container > div {
                    background-color: #3498db;
                    color: white;
                    padding: 10px 20px;
                    border-radius: 5px;
                    box-shadow: 0 2px 10px rgba(0,0,0,0.3);
                    font-size: 14px;
                    opacity: 0;
                    transform: translateY(20px);
                    transition: opacity 0.3s ease-out, transform 0.3s ease-out;
                    pointer-events: auto;
                }
                #toast-container > div.success {
                    background-color: #2ecc71;
                }
                #toast-container > div.error {
                    background-color: #e74c3c;
                }
                #video-preview-container {
                    position: fixed;
                    background: #1e2b38;
                    border-radius: 8px;
                    box-shadow: 0 4px 15px rgba(0,0,0,0.5);
                    z-index: 100001;
                    padding: 10px;
                    display: none;
                }
                .downloaded-checkmark {
                    position: absolute;
                    top: 5px;
                    right: 5px;
                    background-color: #2ecc71; /* Nền xanh lá cây để dễ nhìn */
                    border-radius: 50%;
                    width: 24px;
                    height: 24px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 2;
                    box-shadow: 0 1px 3px rgba(0,0,0,0.3);
                }
                .downloaded-checkmark svg {
                    width: 16px;
                    height: 16px;
                    fill: white;
                }
            `;
            uiContainer.appendChild(styleSheet);

            // Thanh tiêu đề UI
            const titleBar = document.createElement('h3');
            titleBar.style.cssText = `margin: -20px -20px 10px -20px; padding: 15px 20px; border-bottom: 1px solid #465a70; position: relative; display: flex; align-items: center; justify-content: space-between;`;

            const titleText = document.createElement('span');
            titleText.style.textAlign = 'left';
            titleText.style.fontWeight = 'bold';
            titleText.innerHTML = `Douyin Downloader by <span style="color: orange; font-weight: bold;">Ben</span>`;

            const titleButtons = document.createElement('div');
            titleButtons.className = 'downloader-title-btn-group';
            titleButtons.style.display = 'flex';

            const minimizeBtn = document.createElement('button');
            minimizeBtn.id = 'downloader-minimize-btn';
            minimizeBtn.className = 'downloader-title-btn';
            minimizeBtn.style.fontWeight = 'bold';
            minimizeBtn.textContent = '—';
            titleButtons.appendChild(minimizeBtn);

            const settingsBtn = document.createElement('button');
            settingsBtn.id = 'advanced-settings-btn';
            settingsBtn.className = 'downloader-title-btn';
            settingsBtn.textContent = '⚙️';
            titleButtons.appendChild(settingsBtn);

            titleBar.appendChild(titleText);
            titleBar.appendChild(titleButtons);
            uiContainer.appendChild(titleBar);

            const bodyContainer = document.createElement('div');
            bodyContainer.id = 'downloader-body';

            // Tùy chọn nâng cao (mặc định ẩn)
            const advancedOptions = document.createElement('div');
            advancedOptions.id = 'advanced-options';
            advancedOptions.style.cssText = 'display: none; margin-bottom: 15px; border-bottom: 1px solid #465a70; padding-bottom: 15px; gap: 10px; flex-direction: column;';
            advancedOptions.innerHTML = `
                <div style="display: flex; align-items: center;"><label for="concurrent-downloads" style="flex: 1;">Tốc độ tải xuống:</label><input type="number" id="concurrent-downloads" value="${prefs['concurrent-downloads']}" min="1" max="10" style="width: 80px; padding: 5px; border-radius: 3px; border: 1px solid #465a70; background: #3b4e63; color: white;"></div>
                <div style="display: flex; align-items: center;"><label for="video-folder" style="flex: 1;">Thư mục Video:</label><input type="text" id="video-folder" value="${prefs['video-folder']}" placeholder="videos" style="width: 120px; padding: 5px; border-radius: 3px; border: 1px solid #465a70; background: #3b4e63; color: white;"></div>
                <div style="display: flex; align-items: center;"><label for="image-folder" style="flex: 1;">Thư mục Ảnh:</label><input type="text" id="image-folder" value="${prefs['image-folder']}" placeholder="images" style="width: 120px; padding: 5px; border-radius: 3px; border: 1px solid #465a70; background: #3b4e63; color: white;"></div>
                <button id="clear-cache-btn" style="width: 100%; background: #c0392b; color: white; border: none; padding: 8px; border-radius: 3px; cursor: pointer;">Xóa bộ nhớ cache</button>
            `;
            bodyContainer.appendChild(advancedOptions);

            const mainContainer = document.createElement('div');
            mainContainer.id = 'downloader-main-container';

            // Tùy chọn tải xuống chính
            const optionsDiv = document.createElement('div');
            optionsDiv.id = 'downloader-options';
            optionsDiv.style.cssText = 'margin-bottom: 15px; display: flex; flex-direction: column; gap: 10px;';
            optionsDiv.innerHTML = `
                <div style="display: flex; align-items: center;"><input type="checkbox" id="download-covers" style="margin-right: 8px;" ${ (prefs['download-covers'] !== false) ? 'checked' : ''}><label for="download-covers" style="cursor: pointer;">Tải ảnh bìa</label></div>
                <div style="display: flex; align-items: center;"><label for="limit-videos" style="flex: 1;">Giới hạn Video</label><input type="number" id="limit-videos" placeholder="Tất cả" value="${prefs['limit-videos'] || ''}" style="width: 80px; padding: 5px; border-radius: 3px; border: 1px solid #465a70; background: #3b4e63; color: white;"></div>
                <hr style="border-color: #465a70; margin: 5px 0; border-style: solid; border-width: 1px 0 0 0;">
                <div id="filename-builder">
                    <label style="display: block; margin-bottom: 5px;">Định dạng tên file:</label>
                    <div id="filename-toggles" style="display:flex; flex-wrap:wrap; gap:5px; margin-bottom:5px;">
                    <button id="fn-index" class="${prefs['filename-parts'].index ? 'active' : ''}" style="background:#566573; color:white; border:none; padding: 5px 10px; border-radius:3px; cursor:pointer;">Chỉ số</button>
                    <button id="fn-desc" class="${prefs['filename-parts'].desc ? 'active' : ''}" style="background:#566573; color:white; border:none; padding: 5px 10px; border-radius:3px; cursor:pointer;">Mô tả</button>
                    <button id="fn-id" class="${prefs['filename-parts'].id ? 'active' : ''}" style="background:#566573; color:white; border:none; padding: 5px 10px; border-radius:3px; cursor:pointer;">ID Video</button>
                    </div>
                </div>
            `;
            mainContainer.appendChild(optionsDiv);

            // Thanh trạng thái và tiến độ
            const statusText = document.createElement('p');
            statusText.id = 'downloader-status-text';
            statusText.style.cssText = 'margin: 0 0 10px 0; font-size: 14px; min-height: 20px;';
            statusText.textContent = 'Sẵn sàng...';
            mainContainer.appendChild(statusText);

            const currentDownloadFile = document.createElement('p');
            currentDownloadFile.id = 'current-download-file';
            currentDownloadFile.style.cssText = 'margin: 0 0 5px 0; font-size: 13px; min-height: 18px; color: #a0a0a0;';
            mainContainer.appendChild(currentDownloadFile);

            const progressWrapper = document.createElement('div');
            progressWrapper.id = 'progress-wrapper';
            progressWrapper.style.cssText = 'display: flex; align-items: center; gap: 10px;';

            const progressBarContainer = document.createElement('div');
            progressBarContainer.id = 'progress-bar-container';
            progressBarContainer.style.cssText = 'flex-grow: 1; background-color: #465a70; border-radius: 5px; overflow: hidden;';
            const progressBar = document.createElement('div');
            progressBar.id = 'downloader-progress-bar';
            progressBar.style.cssText = 'width: 0%; height: 28px; background-color: #3498db; transition: width 0.3s ease-in-out; text-align: center; line-height: 28px; font-size: 12px;';
            progressBar.textContent = '0%';
            progressBarContainer.appendChild(progressBar);
            progressWrapper.appendChild(progressBarContainer);

            const cancelBtnMain = document.createElement('button');
            cancelBtnMain.id = 'downloader-cancel-button';
            cancelBtnMain.style.cssText = 'background: #c0392b; color: white; border: none; height: 28px; width: 40px; border-radius: 5px; cursor: pointer; display: none; font-size: 16px; line-height: 28px;';
            cancelBtnMain.textContent = '✖';
            progressWrapper.appendChild(cancelBtnMain);
            mainContainer.appendChild(progressWrapper);

            const downloadLog = document.createElement('div');
            downloadLog.id = 'download-log';
            downloadLog.style.cssText = 'max-height: 80px; overflow-y: auto; background: #1e2b38; padding: 5px; border-radius: 3px; margin-top: 10px; border: 1px solid #465a70;';
            mainContainer.appendChild(downloadLog);

            // Nút bắt đầu chính
            const startButton = document.createElement('button');
            startButton.id = 'downloader-start-button';
            startButton.style.cssText = 'width: 100%; background-color: #27ae60; color: white; border: none; padding: 10px; border-radius: 5px; cursor: pointer; margin-top: 15px; font-size: 16px;';
            startButton.textContent = 'Tìm & Chọn Video';
            mainContainer.appendChild(startButton);
            bodyContainer.appendChild(mainContainer);

            // Màn hình lựa chọn video
            const selectionContainer = document.createElement('div');
            selectionContainer.id = 'downloader-selection-container';
            selectionContainer.style.display = 'none';
            selectionContainer.innerHTML = `
                <p>Vui lòng chọn video để tải xuống:</p>
                <div class="filter-sort-group">
                    <label>Bộ lọc:</label>
                    <div id="filter-buttons">
                        <button data-filter="all" class="${currentFilter === 'all' ? 'active' : ''}">Tất cả</button>
                        <button data-filter="downloaded" class="${currentFilter === 'downloaded' ? 'active' : ''}">Đã tải</button>
                        <button data-filter="not-downloaded" class="${currentFilter === 'not-downloaded' ? 'active' : ''}">Chưa tải</button>
                    </div>
                </div>
                <div class="filter-sort-group">
                    <label for="sort-select">Sắp xếp theo:</label>
                    <select id="sort-select">
                        <option value="newest" ${currentSort === 'newest' ? 'selected' : ''}>Mới nhất</option>
                        <option value="likes-desc" ${currentSort === 'likes-desc' ? 'selected' : ''}>Lượt thích (Cao đến Thấp)</option>
                    </select>
                </div>
                <div id="downloader-video-list" style="max-height: 400px; overflow-y: auto; margin: 10px 0; border: 1px solid #465a70; padding: 10px; border-radius: 5px;"></div>
                <div style="display: flex; justify-content: space-between; margin-bottom: 10px;">
                    <button id="select-all-btn" style="padding: 5px 10px; border: none; border-radius: 5px; color: white; cursor: pointer; background-color: #3498db;">Chọn tất cả</button>
                    <button id="deselect-all-btn" style="padding: 5px 10px; border: none; border-radius: 5px; color: white; cursor: pointer; background-color: #566573;">Bỏ chọn tất cả</button>
                </div>
                <button id="downloader-download-selected" style="width: 100%; padding: 10px; border: none; border-radius: 5px; color: white; cursor: pointer; background-color: #27ae60; font-size: 16px;">Tải xuống đã chọn</button>
            `;
            bodyContainer.appendChild(selectionContainer);
            uiContainer.appendChild(bodyContainer);

            // Container xem trước video (ẩn mặc định)
            const videoPreviewContainer = document.createElement('div');
            videoPreviewContainer.id = 'video-preview-container';
            videoPreviewContainer.style.cssText = `
                display: none; position: fixed; background: #1e2b38; border-radius: 8px;
                box-shadow: 0 4px 15px rgba(0,0,0,0.5); z-index: 100001; padding: 10px;
            `;
            videoPreviewContainer.innerHTML = `
                <video id="video-preview-player" controls muted autoplay preload="auto" playsinline style="width: 250px; height: auto; border-radius: 4px;"></video>
                <p id="video-preview-desc" style="font-size: 12px; color: #ccc; margin-top: 5px; text-align: center; max-height: 40px; overflow: hidden;"></p>
            `;
            document.body.appendChild(videoPreviewContainer);

            // Gắn UI vào DOM
            if (document.body) {
                document.body.appendChild(uiContainer);
            } else {
                document.addEventListener('DOMContentLoaded', () => {
                    document.body.appendChild(uiContainer);
                });
            }

            // Gắn các sự kiện cho các điều khiển UI
            makeDraggable(uiContainer, titleBar);
            cancelBtnMain.onclick = () => { isCancelled = true; };
            startButton.onclick = startProcess; // Bắt đầu quá trình tìm kiếm video
            uiContainer.querySelector('#filename-toggles').addEventListener('click', (e) => {
                if (e.target.tagName === 'BUTTON') {
                    e.target.classList.toggle('active');
                }
            });
            uiContainer.querySelector('#clear-cache-btn').onclick = async () => {
                const confirmClear = await showCustomConfirm('Bạn có chắc chắn muốn xóa bộ nhớ cache tải xuống không? Thao tác này không thể hoàn tác.');
                if (confirmClear) {
                    await downloadedDb.openDB(); // Đảm bảo DB được mở trước khi xóa
                    await downloadedDb.clearStore();
                    showToast('Đã xóa bộ nhớ cache thành công!', 'success');
                    resetUI('Đã xóa bộ nhớ cache. Sẵn sàng cho một khởi đầu mới.');
                }
            };
            titleButtons.querySelector('#advanced-settings-btn').onclick = () => {
                const advOptions = uiContainer.querySelector('#advanced-options');
                advOptions.style.display = advOptions.style.display === 'none' ? 'flex' : 'none';
            };
            titleButtons.querySelector('#downloader-minimize-btn').onclick = (e) => {
                const isMinimized = uiContainer.classList.toggle('minimized');
                e.target.textContent = isMinimized ? '❐' : '—';
            };
        };

        /**
         * Hiển thị một hộp thoại cảnh báo tùy chỉnh.
         * @param {string} message - Tin nhắn cảnh báo.
         */
        const showCustomAlert = (message) => {
            let overlay = document.getElementById('custom-dialog-overlay');
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.id = 'custom-dialog-overlay';
                overlay.className = 'custom-overlay';
                document.body.appendChild(overlay);
            }
            overlay.style.display = 'flex';

            let alertBox = document.getElementById('custom-alert-box');
            if (!alertBox) {
                alertBox = document.createElement('div');
                alertBox.id = 'custom-alert-box';
                alertBox.style.cssText = `
                    background-color: #3b4e63; padding: 20px; border-radius: 8px;
                    box-shadow: 0 4px 10px rgba(0,0,0,0.5); z-index: 100000;
                    display: flex; flex-direction: column; align-items: center;
                    gap: 15px; width: 80%; max-width: 300px; text-align: center;
                `;
                overlay.appendChild(alertBox);
            }
            alertBox.innerHTML = `
                <p style="margin:0; font-size:14px;">${message}</p>
                <button id="custom-alert-ok" style="background:#3498db; color:white; border:none; padding:8px 15px; border-radius:5px; cursor:pointer;">OK</button>
            `;
            alertBox.style.display = 'flex';
            alertBox.querySelector('#custom-alert-ok').onclick = () => {
                alertBox.style.display = 'none';
                overlay.style.display = 'none';
            };
        };

        /**
         * Hiển thị một hộp thoại xác nhận tùy chỉnh.
         * @param {string} message - Tin nhắn xác nhận.
         * @returns {Promise<boolean>} Trả về true nếu người dùng chọn "Có", false nếu chọn "Không".
         */
        const showCustomConfirm = (message) => {
            return new Promise(resolve => {
                let overlay = document.getElementById('custom-dialog-overlay');
                if (!overlay) {
                    overlay = document.createElement('div');
                    overlay.id = 'custom-dialog-overlay';
                    overlay.className = 'custom-overlay';
                    document.body.appendChild(overlay);
                }
                overlay.style.display = 'flex';

                let confirmBox = document.getElementById('custom-confirm-box');
                if (!confirmBox) {
                    confirmBox = document.createElement('div');
                    confirmBox.id = 'custom-confirm-box';
                    confirmBox.style.cssText = `
                        background-color: #3b4e63; padding: 20px; border-radius: 8px;
                        box-shadow: 0 4px 10px rgba(0,0,0,0.5); z-index: 100000;
                        display: flex; flex-direction: column; align-items: center;
                        gap: 15px; width: 80%; max-width: 300px; text-align: center;
                    `;
                    overlay.appendChild(confirmBox);
                }
                confirmBox.innerHTML = `
                    <p style="margin:0; font-size:14px;">${message}</p>
                    <div style="display:flex; gap:10px;">
                        <button id="custom-confirm-yes" style="background:#27ae60; color:white; border:none; padding:8px 15px; border-radius:5px; cursor:pointer;">Có</button>
                        <button id="custom-confirm-no" style="background:#c0392b; color:white; border:none; padding:8px 15px; border-radius:5px; cursor:pointer;">Không</button>
                    </div>
                `;
                confirmBox.style.display = 'flex';

                confirmBox.querySelector('#custom-confirm-yes').onclick = () => {
                    confirmBox.style.display = 'none';
                    overlay.style.display = 'none';
                    resolve(true);
                };
                confirmBox.querySelector('#custom-confirm-no').onclick = () => {
                    confirmBox.style.display = 'none';
                    overlay.style.display = 'none';
                    resolve(false);
                };
            });
        };

        /**
         * Bắt đầu quá trình tải xuống và nén các video đã chọn.
         * @param {Array<object>} selectedVideos - Danh sách video đã chọn.
         * @param {Array<object>} restoredFiles - Danh sách file đã tải xuống từ IndexedDB.
         */
        const startFinalDownload = async (selectedVideos, restoredFiles) => {
            isCancelled = false;
            const ui = document.getElementById(CONFIG.UI_ID);
            // Cập nhật UI về trạng thái tải xuống
            ui.querySelector('#downloader-selection-container').style.display = 'none';
            ui.querySelector('#downloader-main-container').style.display = 'block';
            ui.querySelector('#advanced-settings-btn').style.display = 'block';
            ui.querySelector('#downloader-minimize-btn').style.display = 'block';
            ui.querySelector('#downloader-options').style.pointerEvents = 'none';
            ui.querySelector('#downloader-options').style.opacity = '0.5';
            ui.querySelector('#downloader-cancel-button').style.display = 'block';
            ui.querySelector('#run-again-button')?.remove();
            ui.querySelector('#downloader-start-button').style.display = 'none';

            if (selectedVideos.length === 0) {
                resetUI("Không có video nào được chọn để tải xuống.");
                return;
            }

            const restoredIds = new Set(restoredFiles.map(f => f.id));
            const videosToDownload = selectedVideos.filter(v => !restoredIds.has(v.id)); // Chỉ tải những video CHƯA có

            const prefs = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEY)) || {};
            const filenameParts = prefs['filename-parts'];
            const downloadCovers = document.getElementById('download-covers').checked;
            const videoFolder = (prefs['video-folder'] || 'videos').replace(/^\/|\/$/g, '');
            const imageFolder = (prefs['image-folder'] || 'images').replace(/^\/|\/$/g, '');

            const downloadQueue = [];
            const restoredVideoCount = restoredFiles.filter(f => !f.id.includes('_cover')).length;

            // Xây dựng hàng đợi tải xuống cho các video và ảnh bìa mới
            videosToDownload.forEach((videoInfo, i) => {
                const index = restoredVideoCount + i + 1; // Đảm bảo index duy nhất, tiếp tục từ các video đã khôi phục
                const baseFilename = generateFilename(filenameParts, videoInfo, index);
                downloadQueue.push({ type: 'video', url: videoInfo.videoUrl, filename: `${videoFolder}/${baseFilename}.mp4`, id: videoInfo.id });
                if (downloadCovers && videoInfo.coverUrl) {
                    downloadQueue.push({ type: 'image', url: videoInfo.coverUrl, filename: `${imageFolder}/${baseFilename}.jpg`, id: videoInfo.id + '_cover' });
                }
            });

            let failedDownloads = [];
            let completedItems = 0;
            const totalNewItems = downloadQueue.length;
            const concurrency = parseInt(document.getElementById('concurrent-downloads').value, 10) || CONFIG.CONCURRENT_DOWNLOADS;

            updateProgressUI(`Bắt đầu tải xuống ${totalNewItems} tệp đã chọn...`, 0); // Tiến độ ban đầu cho các file mới

            /**
             * Tải xuống một mục (video/ảnh) và lưu vào IndexedDB.
             * @param {object} item - Thông tin mục cần tải.
             * @param {boolean} isRetry - Là lần thử lại không.
             * @returns {Promise<boolean>} True nếu thành công, false nếu thất bại sau tất cả các lần thử.
             */
            const downloadTask = async (item, isRetry = false) => {
                if (isCancelled) {
                    return false;
                }
                updateCurrentDownloadDisplay(item.filename);
                for (let attempt = 1; attempt <= CONFIG.DOWNLOAD_RETRIES; attempt++) {
                    try {
                        const response = await fetch(item.url);
                        if (!response.ok) {
                            throw new Error(`Trạng thái ${response.status}`);
                        }
                        const blob = await response.blob();
                        // Lưu blob vào IndexedDB ngay sau khi tải xuống
                        await downloadedDb.addFile({ id: item.id, filename: item.filename, blob: blob });
                        if (!isRetry) {
                            completedItems++; // Chỉ tăng số lượng completedItems nếu không phải là lần thử lại
                        }
                        addDownloadLogEntry(item.filename, 'success');
                        return true;
                    } catch (e) {
                        console.warn(`Lỗi tải xuống ${item.filename} (thử lại ${attempt}/${CONFIG.DOWNLOAD_RETRIES}):`, e);
                        if (attempt === CONFIG.DOWNLOAD_RETRIES) {
                            if (!isRetry) { // Chỉ ghi lỗi và thêm vào failedDownloads nếu đây là lần thử gốc
                                logErrorUI(item.filename);
                                failedDownloads.push(item);
                                completedItems++; // Tăng completedItems để phản ánh rằng mục này đã được xử lý (dù thất bại)
                                addDownloadLogEntry(item.filename, 'failed');
                            }
                            return false;
                        }
                        await delay(1000 * attempt); // Đợi lâu hơn trước khi thử lại
                    }
                }
                return false; // Không bao giờ đến đây, nhưng an toàn để thêm vào
            };

            /**
             * Xử lý hàng đợi tải xuống với số lượng download đồng thời đã cấu hình.
             * @param {Array<object>} queue - Hàng đợi các mục cần tải.
             * @param {boolean} isRetryPass - Là lần xử lý lại các mục thất bại không.
             */
            const processQueue = async (queue, isRetryPass = false) => {
                const workers = Array(concurrency).fill(null).map(async () => {
                    while (queue.length > 0 && !isCancelled) {
                        const item = queue.shift();
                        if (item) {
                            await downloadTask(item, isRetryPass);
                            // Cập nhật tiến độ chỉ dựa trên các item tải xuống mới
                            const downloadProgress = (completedItems / totalNewItems) * 100;
                            updateProgressUI(`Đang tải xuống ${completedItems}/${totalNewItems} tệp mới...`, downloadProgress);
                        }
                    }
                });
                await Promise.all(workers);
            };

            // Bắt đầu tải xuống các file mới
            await processQueue(downloadQueue, false);

            // Xử lý các lần tải xuống thất bại
            if (failedDownloads.length > 0 && !isCancelled) {
                showToast(`Có ${failedDownloads.length} mục bị lỗi, đang thử lại...`, 'error', 3000);
                updateProgressUI(`Đang thử lại ${failedDownloads.length} mục bị lỗi...`, ((completedItems) / totalNewItems) * 100);
                await delay(1500); // Đợi một chút trước khi thử lại
                const retryFailed = [...failedDownloads]; // Tạo bản sao để tránh thay đổi khi lặp
                failedDownloads = []; // Đặt lại danh sách thất bại
                await processQueue(retryFailed, true); // Chạy lại hàng đợi cho các mục thất bại
            }

            if (isCancelled) {
                showToast('Đã hủy tải xuống. Tiến độ đã được lưu vào bộ nhớ cache.', 'info');
                resetUI('Đã hủy. Tiến độ đã được lưu vào bộ nhớ cache.');
                return;
            }

            // --- Bắt đầu nén với Web Worker ---
            updateProgressUI('Đang nén tệp...', 0); // Đặt lại tiến độ cho việc nén
            updateCurrentDownloadDisplay('Đang chuẩn bị nén...');

            // Lấy tất cả các file từ IndexedDB (đã khôi phục + vừa tải)
            const allFilesFromDb = await downloadedDb.getAllFiles();
            const filesToZipForWorker = allFilesFromDb.map(f => ({ filename: f.filename, blob: f.blob }));
            const totalZipItems = filesToZipForWorker.length + 1; // +1 cho metadata.json

            // Khởi tạo Web Worker nếu chưa có
            if (!zipWorker) {
                const blob = new Blob([ZIP_WORKER_SCRIPT_CONTENT], { type: 'application/javascript' });
                zipWorker = new Worker(URL.createObjectURL(blob));
            }

            // Lắng nghe tin nhắn từ Web Worker
            zipWorker.onmessage = (event) => {
                if (event.data.type === 'progress') {
                    const percent = event.data.data;
                    updateProgressUI(`Đang nén tệp... ${Math.round(percent)}%`, percent);
                    updateCurrentDownloadDisplay(`Nén: ${Math.round(percent)}%`);
                } else if (event.data.type === 'complete') {
                    const zipBlob = event.data.data;
                    const finalFailedCount = failedDownloads.length; // Số lượng lỗi từ giai đoạn tải xuống

                    if (finalFailedCount > 0) {
                        showToast(`Hoàn tất! ${totalZipItems - finalFailedCount}/${totalZipItems} tệp thành công. Có ${finalFailedCount} tệp bị lỗi.`, 'error', 5000);
                    } else {
                        showToast(`Hoàn tất! Tất cả ${totalZipItems} tệp đã tải xuống thành công.`, 'success');
                    }
                    updateProgressUI(`Hoàn tất! ${totalZipItems - finalFailedCount}/${totalZipItems} tệp thành công.`, 100);

                    // Tạo và click link tải xuống file ZIP
                    const link = document.createElement('a');
                    link.href = URL.createObjectURL(zipBlob);

                    const usernameElement = document.querySelector('.hSGGwDAt'); // Selector Douyin cụ thể
                    const douyinUsername = usernameElement ? usernameElement.textContent.trim() : 'Douyin-Downloader-by-Ben';
                    const safeUsername = douyinUsername.replace(/[\\/?%*:|"<>]/g, '-');
                    link.download = `${safeUsername}.zip`;

                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                    URL.revokeObjectURL(link.href);

                    downloadedDb.clearStore(); // Xóa IndexedDB sau khi tải xuống hoàn tất
                    resetUI('Hoàn tất! Đã xóa bộ nhớ cache.');
                } else if (event.data.type === 'error') {
                    showToast(`Lỗi khi nén tệp: ${event.data.data}`, 'error', 5000);
                    resetUI(`Lỗi khi nén tệp: ${event.data.data}`);
                    console.error("Lỗi Web Worker:", event.data.data);
                }
            };

            zipWorker.onerror = (error) => {
                showToast(`Lỗi Web Worker: ${error.message}`, 'error', 5000);
                resetUI(`Lỗi Web Worker: ${error.message}`);
                console.error("Lỗi Web Worker:", error);
            };

            // Gửi files và metadata tới worker để nén
            zipWorker.postMessage({ filesToZip: filesToZipForWorker, metadata: selectedVideos });
        };

        /**
         * Bắt đầu quá trình tìm nạp video từ Douyin và hiển thị màn hình chọn.
         */
        const startProcess = async () => {
            isCancelled = false;
            const ui = document.getElementById(CONFIG.UI_ID);
            // Cập nhật UI về trạng thái tìm kiếm
            ui.querySelector('#downloader-start-button').style.display = 'none';
            ui.querySelector('#run-again-button')?.remove();
            ui.querySelector('#downloader-cancel-button').style.display = 'block';
            ui.querySelector('#advanced-settings-btn').style.display = 'none';
            ui.querySelector('#advanced-options').style.display = 'none';
            ui.querySelector('#downloader-options').style.pointerEvents = 'none';
            ui.querySelector('#downloader-options').style.opacity = '0.5';

            // Lưu cài đặt người dùng vào localStorage
            const prefsToSave = {
                'download-covers': ui.querySelector('#download-covers').checked,
                'limit-videos': ui.querySelector('#limit-videos').value,
                'filename-parts': {
                    index: ui.querySelector('#fn-index').classList.contains('active'),
                    desc: ui.querySelector('#fn-desc').classList.contains('active'),
                    id: ui.querySelector('#fn-id').classList.contains('active'),
                },
                'concurrent-downloads': ui.querySelector('#concurrent-downloads').value,
                'filter': currentFilter,
                'sort': currentSort,
                'video-folder': ui.querySelector('#video-folder').value,
                'image-folder': ui.querySelector('#image-folder').value
            };
            localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(prefsToSave));

            let restoredFiles = [];
            try {
                updateProgressUI('Đang chuẩn bị...', 0);
                await downloadedDb.openDB();
                restoredFiles = await downloadedDb.getAllFiles();
                if (restoredFiles.length > 0) {
                    const videoCount = restoredFiles.filter(f => !f.id.includes('_cover')).length;
                    updateProgressUI(`Tìm thấy ${videoCount} video trong bộ nhớ cache.`, 0);
                    await delay(1500);
                }
            } catch (e) {
                let errorMessage = `Lỗi khởi tạo: ${e.message}`;
                if (e.message.includes("IndexedDB")) {
                    errorMessage = `Lỗi khởi tạo bộ nhớ cache: Không thể truy cập IndexedDB. Vui lòng kiểm tra cài đặt trình duyệt của bạn (ví dụ: quyền truy cập bộ nhớ, chế độ ẩn danh).`;
                }
                showToast(errorMessage, 'error', 5000);
                resetUI(errorMessage);
                return;
            }

            updateProgressUI('Đang tìm nạp danh sách video...', 0);
            const secUserId = location.pathname.match(/user\/([^/]+)/)?.[1]; // Đảm bảo regex chính xác hơn cho user ID
            const videoLimit = parseInt(document.getElementById('limit-videos').value, 10) || Infinity;

            if (!secUserId) {
                const errorMessage = `Lỗi: Không tìm thấy ID người dùng Douyin trên trang. Vui lòng đảm bảo bạn đang ở trang hồ sơ người dùng hợp lệ.`;
                showToast(errorMessage, 'error', 5000);
                resetUI(errorMessage);
                return;
            }

            allFetchedVideos = []; // Reset danh sách video khi bắt đầu quá trình mới
            originalVideoIndex = 0; // Reset index
            maxCursor = 0; // Reset cursor
            hasMoreVideosToFetch = true; // Reset cờ
            isFetchingMoreVideos = false; // Reset cờ

            try {
                const initialPageData = await fetchVideoPage(secUserId, maxCursor);
                if (!initialPageData || !initialPageData.aweme_list || initialPageData.aweme_list.length === 0) {
                    hasMoreVideosToFetch = false;
                    showToast('Không tìm thấy video nào.', 'info');
                    resetUI('Không tìm thấy video nào.');
                    return;
                }

                for (const video of initialPageData.aweme_list) {
                    if (allFetchedVideos.length >= videoLimit) {
                        hasMoreVideosToFetch = false;
                        break;
                    }
                    if (video?.video?.play_addr?.url_list?.[0]) {
                        allFetchedVideos.push({
                            id: video.aweme_id,
                            description: video.desc,
                            coverUrl: video.video.cover.url_list[0],
                            videoUrl: video.video.play_addr.url_list[0].replace('http:','https:'),
                            likes: video.statistics.digg_count,
                            originalIndex: originalVideoIndex++
                        });
                    }
                }
                maxCursor = initialPageData.max_cursor;
                hasMoreVideosToFetch = initialPageData.has_more === 1;

            } catch (error) {
                let errorMessage = `Lỗi khi tìm nạp thông tin: ${error.message}.`;
                if (error.message.includes("HTTP Error")) {
                    errorMessage = `Lỗi mạng khi tìm nạp video: ${error.message}. Vui lòng kiểm tra kết nối internet.`;
                } else if (error.message.includes("Douyin API Error")) {
                    errorMessage = `Lỗi API Douyin khi tìm nạp video: ${error.message}. Vui lòng thử lại sau.`;
                }
                showToast(errorMessage, 'error', 5000);
                resetUI(errorMessage);
                return;
            }

            if (isCancelled) {
                showToast('Đã hủy bởi người dùng.', 'info');
                resetUI('Đã hủy bởi người dùng.');
                return;
            }

            // Hiển thị màn hình chọn video sau khi đã tải trang đầu tiên
            showSelectionScreen(allFetchedVideos, restoredFiles);
        };

        // --- KHỞI TẠO SCRIPT ---
        createProgressUI();
    };

    // Chạy script sau một khoảng thời gian ngắn để đảm bảo DOM đã tải đủ
    setTimeout(runDouyinDownloader, 1000);
})();