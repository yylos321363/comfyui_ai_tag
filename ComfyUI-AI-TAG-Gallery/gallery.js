import { app } from "/scripts/app.js";
import { fetchSiteConfig, fetchGalleryPage, fetchWorkDetail, clearGalleryPageCache, fetchTitleBlacklist, saveTitleBlacklist } from "./gallery/api.js";
import { installStateMethods } from "./gallery/state.js";
import { renderPage, appendListItems, recoverStaleListImages, prioritizeVisibleListImages } from "./gallery/render-list.js";
import { renderDetailFromRaw } from "./gallery/render-detail.js";
import { getTimeRangeOptions, getMonthlyOptions } from "./gallery/utils.js";

console.log("[Gallery] modular JS loaded");

const GALLERY_PAGE_SIZE = 60;
const GALLERY_TITLE_BLACKLIST_KEY = "ComfyUI.Gallery.titleBlacklist.v1";
const GALLERY_INTERNAL_WIDGET_NAMES = new Set([
    "user_id",
    "image_id",
    "ai_type",
    "image_path",
    "ai_json",
    "prompt_text",
    "draw_enabled",
    "search_query",
    "sort_mode",
    "time_range"
]);
const GALLERY_INTERNAL_SLOT_NAMES = new Set([
    ...GALLERY_INTERNAL_WIDGET_NAMES,
    "gallery_widget"
]);

function normalizeBlacklistTitle(title) {
    return String(title || "").trim().replace(/\s+/g, " ");
}

function normalizeBlacklistUserId(userId) {
    return String(userId ?? "").trim();
}

function getBlacklistCompareKey(title) {
    return normalizeBlacklistTitle(title).toLocaleLowerCase();
}

function getItemBlacklistAuthorId(item = {}) {
    return normalizeBlacklistUserId(
        item?.userId
            ?? item?.userid
            ?? item?.user_id
            ?? item?.authorId
            ?? item?.author_id
            ?? item?.user?.id
            ?? item?.author?.id
            ?? ""
    );
}

function normalizeBlacklistEntry(entry) {
    if (typeof entry === "string") {
        const title = normalizeBlacklistTitle(entry);
        return title ? { title, userId: "" } : null;
    }

    const title = normalizeBlacklistTitle(entry?.title ?? "");
    const userId = normalizeBlacklistUserId(
        entry?.userId
            ?? entry?.user_id
            ?? entry?.userid
            ?? entry?.authorId
            ?? entry?.author_id
            ?? ""
    );

    return title ? { title, userId } : null;
}

function getBlacklistEntryStorageKey(entry) {
    const normalized = normalizeBlacklistEntry(entry);
    if (!normalized) return "";
    return `${getBlacklistCompareKey(normalized.title)}\u0000${normalized.userId}`;
}

function isBlacklistEntryMatch(entry, item) {
    const normalized = normalizeBlacklistEntry(entry);
    if (!normalized?.title || !normalized.userId) return false;

    const itemTitleKey = getBlacklistCompareKey(item?.title);
    const itemUserId = getItemBlacklistAuthorId(item);
    return Boolean(
        itemTitleKey
            && itemUserId
            && itemTitleKey === getBlacklistCompareKey(normalized.title)
            && itemUserId === normalized.userId
    );
}

function readTitleBlacklist() {
    try {
        const raw = localStorage.getItem(GALLERY_TITLE_BLACKLIST_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed)
            ? parsed.map(normalizeBlacklistEntry).filter(Boolean)
            : [];
    } catch (error) {
        console.warn("[Gallery] failed to read title blacklist", error);
        return [];
    }
}

function writeTitleBlacklist(list) {
    try {
        const normalizedList = Array.isArray(list)
            ? list.map(normalizeBlacklistEntry).filter(Boolean)
            : [];
        localStorage.setItem(GALLERY_TITLE_BLACKLIST_KEY, JSON.stringify(normalizedList));
    } catch (error) {
        console.warn("[Gallery] failed to write title blacklist", error);
    }
}

function mergeTitleBlacklists(...lists) {
    const seen = new Set();
    const merged = [];

    lists.flat().forEach((entry) => {
        const normalized = normalizeBlacklistEntry(entry);
        const key = getBlacklistEntryStorageKey(normalized);
        if (!key || seen.has(key)) return;
        seen.add(key);
        merged.push(normalized);
    });

    return merged;
}

function normalizeGalleryQuery({ searchQuery = "", sort = "new", timeRange = "all" } = {}) {
    const normalizedQuery = String(searchQuery || "").trim();
    let normalizedSort = sort || "new";
    let normalizedTimeRange = timeRange || "all";

    if (normalizedQuery && normalizedSort !== "new") {
        normalizedSort = "new";
        if (normalizedTimeRange === "current" || normalizedTimeRange === "older" || /^m\d+$/i.test(normalizedTimeRange)) {
            normalizedTimeRange = "all";
        }
    }

    return {
        searchQuery: normalizedQuery,
        sort: normalizedSort,
        timeRange: normalizedTimeRange
    };
}

function areGalleryQueriesEqual(a, b) {
    if (!a || !b) return false;
    return a.searchQuery === b.searchQuery
        && a.sort === b.sort
        && a.timeRange === b.timeRange;
}

function splitSearchTerms(searchQuery = "") {
    return String(searchQuery || "").match(/"[^"]+"|\S+/g) || [];
}

function buildSearchQueryFromTerms(terms = []) {
    return terms.map((term) => String(term || "").trim()).filter(Boolean).join(" ");
}

function getSearchTermCompareKey(term) {
    return String(term || "").trim().replace(/^"|"$/g, "").toLocaleLowerCase();
}

function getSearchTermLabel(term) {
    return String(term || "").trim().replace(/^"|"$/g, "");
}

app.registerExtension({
    name: "ComfyUI.Gallery",

    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "GalleryImageLoader") return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        installStateMethods(nodeType);

        nodeType.prototype.hideInternalWidgets = function () {
            if (!this.widgets) return;

            for (const w of this.widgets) {
                if (GALLERY_INTERNAL_WIDGET_NAMES.has(String(w.name || "").trim())) {
                    w.computeSize = () => [0, 0];
                    w.type = "hidden";
                    w.hidden = true;
                    w.serialize = true;
                }
            }

            this.setDirtyCanvas?.(true, true);
        };

        nodeType.prototype.hideInternalInputs = function () {
            if (!Array.isArray(this.inputs) || !this.inputs.length) return;

            let changed = false;
            for (let i = this.inputs.length - 1; i >= 0; i--) {
                const inputName = String(this.inputs[i]?.name || "").trim();
                if (GALLERY_INTERNAL_SLOT_NAMES.has(inputName) || !inputName) {
                    if (typeof this.removeInput === "function") {
                        this.removeInput(i);
                    } else {
                        this.inputs.splice(i, 1);
                    }
                    changed = true;
                }
            }

            if (changed) this.setDirtyCanvas?.(true, true);
        };

        nodeType.prototype.renderPage = renderPage;
        nodeType.prototype.appendListItems = appendListItems;
        nodeType.prototype.recoverStaleListImages = recoverStaleListImages;
        nodeType.prototype.prioritizeVisibleListImages = prioritizeVisibleListImages;
        nodeType.prototype.renderDetailFromRaw = renderDetailFromRaw;

        nodeType.prototype.hideHoverPreviews = function () {
            this._activeListPreviewToken = null;
            this._activeDetailPreviewToken = null;
            if (this._listHoverPreview) this._listHoverPreview.style.display = 'none';
            if (this._detailHoverPreview) this._detailHoverPreview.style.display = 'none';
        };

        nodeType.prototype.restoreGalleryScroll = function (mode, scrollTop = 0) {
            if (!this.galleryGrid) return;

            const target = Math.max(0, Number(scrollTop) || 0);
            const isDetail = mode === 'detail';
            const savedKey = isDetail ? '_savedDetailScrollTop' : '_savedListScrollTop';

            this[savedKey] = target;
            if (!isDetail) this._savedScrollTop = target;
            this._isRestoringGalleryScroll = true;

            let attempts = 0;
            const apply = () => {
                if (!this.galleryGrid) {
                    this._isRestoringGalleryScroll = false;
                    return;
                }

                this.galleryGrid.scrollTop = target;
                this[savedKey] = target;
                if (!isDetail) this._savedScrollTop = target;

                attempts += 1;
                if (attempts < 6) {
                    requestAnimationFrame(apply);
                } else {
                    setTimeout(() => {
                        if (this.galleryGrid) {
                            this.galleryGrid.scrollTop = target;
                            this[savedKey] = target;
                            if (!isDetail) this._savedScrollTop = target;
                        }
                        this._isRestoringGalleryScroll = false;
                        if (!isDetail) this.syncVisibleGalleryPageFromScroll?.();
                        this.saveGalleryState?.();
                    }, 80);
                }
            };

            requestAnimationFrame(apply);
        };

        nodeType.prototype.getGalleryLayoutWidth = function () {
            const source = this.customUI || this.galleryGrid;
            return Math.round(source?.getBoundingClientRect?.().width || this.galleryGrid?.clientWidth || this.size?.[0] || 0);
        };

        nodeType.prototype.getListDomCacheKey = function () {
            const query = this.getCurrentGalleryQuery?.() || {};
            const blacklist = this.getTitleBlacklist?.() || [];
            return JSON.stringify({
                searchQuery: query.searchQuery || "",
                sort: query.sort || "new",
                timeRange: query.timeRange || "all",
                page: this.galleryPage || 1,
                totalPages: this.galleryTotalPages || 1,
                itemCount: Array.isArray(this.galleryAllItems) ? this.galleryAllItems.length : 0,
                blacklist: blacklist.map(getBlacklistEntryStorageKey).filter(Boolean).join("\u0001")
            });
        };

        nodeType.prototype.clearListDomCache = function () {
            if (this._listDomCache?.host) {
                this._listDomCache.host.replaceChildren();
            }
            this._listDomCache = null;
        };

        nodeType.prototype.stashListDomForDetail = function () {
            if (!this.galleryGrid || this._viewMode !== "list") return false;
            const listContainer = this._galleryGridContainer;
            if (!listContainer || !this.galleryGrid.contains(listContainer)) return false;

            this.clearListDomCache?.();

            const host = document.createElement("div");
            while (this.galleryGrid.firstChild) {
                host.appendChild(this.galleryGrid.firstChild);
            }

            this._listDomCache = {
                host,
                key: this.getListDomCacheKey?.(),
                layoutWidth: this.getGalleryLayoutWidth?.() || 0
            };
            return true;
        };

        nodeType.prototype.restoreListDomCache = function () {
            if (!this.galleryGrid || !this._listDomCache?.host) return false;

            const cache = this._listDomCache;
            const currentWidth = this.getGalleryLayoutWidth?.() || 0;
            const widthChanged = cache.layoutWidth && currentWidth && Math.abs(currentWidth - cache.layoutWidth) > 2;
            const keyChanged = cache.key !== this.getListDomCacheKey?.();

            if (widthChanged || keyChanged || !cache.host.childNodes.length) {
                this.clearListDomCache?.();
                return false;
            }

            this.galleryGrid.innerHTML = "";
            this.galleryGrid.style.padding = "";
            this.galleryGrid.style.boxSizing = "";

            while (cache.host.firstChild) {
                this.galleryGrid.appendChild(cache.host.firstChild);
            }

            this._galleryGridContainer = this.galleryGrid.querySelector('[data-gallery-list-container="1"]') || this._galleryGridContainer;
            this._listDomCache = null;
            this.syncPageControls?.();
            return true;
        };

        nodeType.prototype.ensureGalleryStyles = function () {
            if (document.getElementById("gallery-plugin-styles")) return;

            const style = document.createElement("style");
            style.id = "gallery-plugin-styles";
            style.textContent = `
                .gallery-centered-state {
                    min-height: 280px;
                    width: 100%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    text-align: center;
                    padding: 24px;
                    box-sizing: border-box;
                }

                .gallery-fade-in {
                    animation: galleryFadeIn 0.22s ease;
                }

                @keyframes galleryFadeIn {
                    from {
                        opacity: 0;
                        transform: translateY(8px);
                    }
                    to {
                        opacity: 1;
                        transform: translateY(0);
                    }
                }

                .gallery-soft-loading {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    gap: 10px;
                    min-height: 280px;
                    width: 100%;
                    color: #8ea2ff;
                    text-align: center;
                }

                .gallery-soft-loading-spinner {
                    width: 28px;
                    height: 28px;
                    border-radius: 50%;
                    border: 3px solid rgba(102,126,234,0.22);
                    border-top-color: #667eea;
                    animation: gallerySpin 0.8s linear infinite;
                }

                @keyframes gallerySpin {
                    to { transform: rotate(360deg); }
                }

                .gallery-bottom-loading {
                    display: none;
                    align-items: center;
                    justify-content: center;
                    gap: 8px;
                    position: absolute;
                    left: 50%;
                    bottom: 12px;
                    z-index: 20;
                    min-height: 34px;
                    padding: 7px 14px;
                    border-radius: 9999px;
                    background: rgba(20, 20, 30, 0.92);
                    border: 1px solid rgba(102,126,234,0.38);
                    box-shadow: 0 10px 30px rgba(0,0,0,0.28);
                    backdrop-filter: blur(6px);
                    color: #a8b5ff;
                    font-size: 11px;
                    opacity: 0;
                    pointer-events: none;
                    transform: translate(-50%, 8px);
                    transition: opacity 0.18s ease, transform 0.18s ease;
                }

                .gallery-bottom-loading.is-visible {
                    display: flex;
                    opacity: 1;
                    transform: translate(-50%, 0);
                }

                .gallery-bottom-loading-spinner {
                    width: 16px;
                    height: 16px;
                    border-radius: 50%;
                    border: 2px solid rgba(102,126,234,0.24);
                    border-top-color: #8ea2ff;
                    animation: gallerySpin 0.8s linear infinite;
                }

                .gallery-draw-overlay {
                    position: absolute;
                    inset: 0;
                    z-index: 40;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    padding: 20px;
                    background:
                        radial-gradient(circle at 50% 35%, rgba(255, 196, 92, 0.18), transparent 36%),
                        linear-gradient(180deg, rgba(15,18,28,0.78), rgba(8,10,18,0.92));
                    opacity: 0;
                    pointer-events: none;
                    transition: opacity 0.2s ease;
                    backdrop-filter: blur(8px);
                }

                .gallery-draw-overlay.is-visible {
                    opacity: 1;
                    pointer-events: auto;
                }

                .gallery-draw-panel {
                    min-width: 260px;
                    max-width: 360px;
                    border-radius: 18px;
                    padding: 22px 20px;
                    text-align: center;
                    color: #fff4da;
                    border: 1px solid rgba(255, 200, 94, 0.34);
                    background:
                        linear-gradient(180deg, rgba(52,32,10,0.96), rgba(23,18,13,0.96));
                    box-shadow:
                        0 24px 60px rgba(0,0,0,0.42),
                        inset 0 1px 0 rgba(255,255,255,0.08);
                    transform: translateY(8px) scale(0.98);
                    transition: transform 0.22s ease;
                }

                .gallery-draw-overlay.is-visible .gallery-draw-panel {
                    transform: translateY(0) scale(1);
                }

                .gallery-draw-ring {
                    width: 64px;
                    height: 64px;
                    margin: 0 auto 14px;
                    border-radius: 50%;
                    border: 3px solid rgba(255, 214, 125, 0.22);
                    border-top-color: #ffd36a;
                    border-right-color: #ff9f43;
                    box-shadow: 0 0 28px rgba(255, 185, 64, 0.22);
                    animation: gallerySpin 0.9s linear infinite;
                }

                .gallery-draw-title {
                    font-size: 18px;
                    font-weight: 700;
                    letter-spacing: 0.08em;
                }

                .gallery-draw-subtitle {
                    margin-top: 8px;
                    color: rgba(255, 240, 210, 0.82);
                    font-size: 12px;
                    line-height: 1.5;
                }

                .gallery-draw-badge {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    min-height: 28px;
                    margin-top: 14px;
                    padding: 0 12px;
                    border-radius: 9999px;
                    border: 1px solid rgba(255, 215, 128, 0.24);
                    background: rgba(255, 214, 120, 0.08);
                    color: #ffd88a;
                    font-size: 12px;
                    font-weight: 700;
                }

                .gallery-search-back {
                    width: 26px;
                    height: 26px;
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    flex: 0 0 auto;
                    border-radius: 4px;
                    border: 1px solid #4a5568;
                    background: #3b4252;
                    color: #dbe4ff;
                    cursor: pointer;
                    font-size: 15px;
                    line-height: 1;
                }

                .gallery-search-back:disabled {
                    opacity: 0.38;
                    cursor: default;
                }

                .gallery-search-box {
                    position: relative;
                    flex: 1;
                    min-width: 170px;
                    min-height: 26px;
                    display: flex;
                    align-items: center;
                    gap: 4px;
                    padding: 2px 24px 2px 5px;
                    background: #313741;
                    color: white;
                    border: 1px solid #4a5568;
                    border-radius: 3px;
                    box-sizing: border-box;
                    overflow: hidden;
                }

                .gallery-search-terms {
                    display: flex;
                    align-items: center;
                    gap: 4px;
                    flex: 0 1 auto;
                    flex-wrap: nowrap;
                    min-width: 0;
                    max-width: 100%;
                    overflow-x: auto;
                    overflow-y: hidden;
                    white-space: nowrap;
                    scrollbar-width: none;
                    -ms-overflow-style: none;
                }

                .gallery-search-terms::-webkit-scrollbar {
                    width: 0;
                    height: 0;
                    display: none;
                }

                .gallery-search-scrollbar {
                    position: absolute;
                    left: 6px;
                    right: 28px;
                    bottom: 2px;
                    height: 3px;
                    overflow: hidden;
                    border-radius: 999px;
                    background: rgba(160, 174, 210, 0.16);
                    opacity: 0;
                    pointer-events: none;
                    transition: opacity 140ms ease;
                }

                .gallery-search-scrollbar-thumb {
                    height: 100%;
                    width: 0;
                    border-radius: inherit;
                    background: rgba(190, 203, 235, 0.78);
                    box-shadow: 0 0 4px rgba(190, 203, 235, 0.28);
                    transform: translateX(0);
                }

                .gallery-search-box.is-scrolling .gallery-search-scrollbar {
                    opacity: 1;
                }

                .gallery-search-term {
                    display: inline-flex;
                    align-items: center;
                    flex: 0 0 auto;
                    max-width: 160px;
                    min-height: 20px;
                    border: 1px solid rgba(125, 146, 190, 0.62);
                    border-radius: 4px;
                    background: rgba(82, 92, 121, 0.72);
                    color: #eef3ff;
                    font-size: 11px;
                    line-height: 1.2;
                    overflow: hidden;
                }

                .gallery-search-term-label {
                    min-width: 0;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                    padding: 2px 5px 2px 7px;
                }

                .gallery-search-term-remove {
                    width: 20px;
                    align-self: stretch;
                    border: 0;
                    border-left: 1px solid rgba(255, 255, 255, 0.12);
                    background: rgba(0, 0, 0, 0.1);
                    color: #d9e2ff;
                    cursor: pointer;
                    font-size: 12px;
                    line-height: 1;
                    padding: 0;
                }

                .gallery-search-input {
                    flex: 1;
                    min-width: 70px;
                    height: 20px;
                    padding: 0 2px;
                    background: transparent;
                    color: white;
                    border: 0;
                    outline: 0;
                    font-size: 11px;
                }
            `;
            document.head.appendChild(style);
        };

        nodeType.prototype.tryRestoreOrLoad = function () {
            const restored = this.restoreGalleryState?.();
            if (restored && this.galleryAllItems?.length > 0) {
                if (this._viewMode === 'detail' && this._detailWorkId && this._detailRaw) {
                    this.renderDetailFromRaw(this._detailRaw);
                    this.restoreGalleryScroll?.('detail', this._savedDetailScrollTop || 0);
                } else {
                    this._viewMode = 'list';
                    this.listControls.style.display = 'flex';
                    this.detailControls.style.display = 'none';
                    const targetScrollTop = this._savedListScrollTop || this._savedScrollTop || 0;
                    this.renderPage(false);
                    this.restoreGalleryScroll?.('list', targetScrollTop);
                    this.recoverStaleListImages?.();
                }
            } else {
                this.loadGallery(1);
            }
        };

        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;

            this.galleryPage = 1;
            this.galleryTotalPages = 1;
            this.galleryAllItems = [];
            this._isLoading = false;
            this._viewMode = 'list';
            this._detailWorkId = null;
            this._detailImages = [];
            this._detailRaw = null;
            this._selectedDetailImage = null;
            this._timeOptions = [];
            this._monthlyOptions = [];
            this._savedScrollTop = 0;
            this._savedListScrollTop = 0;
            this._savedDetailScrollTop = 0;
            this._hasMoreGalleryItems = true;
            this._isAppendingGallery = false;
            this._lastLoadedGalleryQuery = null;
            this._titleBlacklist = readTitleBlacklist();
            this.galleryDisplayPage = 1;
            this._searchQueryValue = "";
            this._gallerySearchHistory = [];

            if (!this.properties) this.properties = {};

            this.ensureGalleryStyles();
            this.createGalleryUI();
            this.hideInternalWidgets?.();
            this.hideInternalInputs?.();

            fetchSiteConfig().then((cfg) => {
                if (cfg) {
                    this._timeOptions = getTimeRangeOptions(cfg.available_months);
                    this._monthlyOptions = getMonthlyOptions(cfg.available_months);
                    this.updateTimeSelect();
                    this.restoreGalleryState?.();
                    this.syncDrawInputs?.();
                }
            });
            this.loadTitleBlacklistFromDisk?.().then(() => {
                if (this._viewMode === "list" && this.galleryAllItems?.length) {
                    this.galleryAllItems = this.filterBlacklistedItems(this.galleryAllItems);
                    this.renderPage(false, { animate: false });
                }
            });

            requestAnimationFrame(() => this.tryRestoreOrLoad?.());
            setTimeout(() => {
                if (!this.galleryAllItems?.length && !this._isLoading) this.loadGallery(1);
            }, 800);
            return result;
        };

        nodeType.prototype.updateTimeSelect = function () {
            if (!this.timeSelect) return;
            const currentValue = this.timeSelect.value;
            const sort = this.sortSelect?.value || 'new';

            this.timeSelect.innerHTML = '<option value="all">📅 全部时间</option>';

            if (sort === 'monthly') {
                this.timeSelect.innerHTML += '<option value="current">📅 当前月份</option>';
                this._monthlyOptions.forEach(opt => {
                    this.timeSelect.innerHTML += `<option value="${opt.value}">${opt.label}</option>`;
                });
            } else {
                this._timeOptions.forEach(opt => {
                    this.timeSelect.innerHTML += `<option value="${opt.value}">${opt.label}</option>`;
                });
            }

            if ([...this.timeSelect.options].some(opt => opt.value === currentValue)) {
                this.timeSelect.value = currentValue;
            }
        };

        nodeType.prototype.goToPage = function (page) {
            this.hideHoverPreviews?.();
            const target = Math.max(1, Math.min(Number(page) || 1, this.galleryTotalPages || 1));
            if (!this._isLoading && target !== this.galleryPage) {
                this.galleryDisplayPage = target;
                this.syncPageControls?.();
                this.loadGallery(target);
            } else if (this.pageInput) {
                this.syncPageControls?.();
            }
        };

        nodeType.prototype.getCurrentGalleryQuery = function () {
            return normalizeGalleryQuery({
                searchQuery: this.getSearchQueryValue?.() || "",
                sort: this.sortSelect?.value || "new",
                timeRange: this.timeSelect?.value || "all"
            });
        };

        nodeType.prototype.updateSearchClearButton = function () {
            if (!this.searchClearButton || !this.searchInput) return;
            const hasSearch = Boolean((this.getSearchQueryValue?.() || "").trim() || this.searchInput.value.trim());
            this.searchClearButton.style.display = hasSearch ? "inline" : "none";
        };

        nodeType.prototype.getSearchQueryValue = function () {
            return this._searchQueryValue ?? this.searchInput?.value ?? "";
        };

        nodeType.prototype.createGalleryHistorySnapshot = function () {
            const query = normalizeGalleryQuery(this._lastLoadedGalleryQuery || this.getCurrentGalleryQuery?.() || {});
            const scrollTop = this._viewMode === "list"
                ? (this.galleryGrid?.scrollTop || this._savedListScrollTop || this._savedScrollTop || 0)
                : (this._savedListScrollTop || this._savedScrollTop || 0);

            return {
                query,
                page: this.galleryPage || 1,
                displayPage: this.galleryDisplayPage || this.galleryPage || 1,
                totalPages: this.galleryTotalPages || 1,
                items: Array.isArray(this.galleryAllItems) ? [...this.galleryAllItems] : [],
                scrollTop,
                hasMore: this._hasMoreGalleryItems !== false
            };
        };

        nodeType.prototype.pushGallerySearchHistory = function () {
            const snapshot = this.createGalleryHistorySnapshot?.();
            if (!snapshot) return;

            if (!Array.isArray(this._gallerySearchHistory)) this._gallerySearchHistory = [];
            const last = this._gallerySearchHistory[this._gallerySearchHistory.length - 1];
            if (last
                && areGalleryQueriesEqual(last.query, snapshot.query)
                && last.page === snapshot.page
                && last.scrollTop === snapshot.scrollTop
            ) {
                return;
            }

            this._gallerySearchHistory.push(snapshot);
            if (this._gallerySearchHistory.length > 20) this._gallerySearchHistory.shift();
            this.setSessionCache?.({ searchHistory: this._gallerySearchHistory });
            this.syncSearchHistoryButton?.();
        };

        nodeType.prototype.syncSearchHistoryButton = function () {
            if (!this.searchBackButton) return;
            const hasHistory = Array.isArray(this._gallerySearchHistory) && this._gallerySearchHistory.length > 0;
            this.searchBackButton.disabled = !hasHistory;
            this.searchBackButton.title = hasHistory ? "返回上一次搜索结果" : "没有可返回的搜索结果";
        };

        nodeType.prototype.renderSearchTerms = function () {
            if (!this.searchTermsWrap || !this.searchInput) return;
            const terms = splitSearchTerms(this.getSearchQueryValue?.() || "");
            this.searchTermsWrap.replaceChildren();

            terms.forEach((term, index) => {
                const chip = document.createElement("span");
                chip.className = "gallery-search-term";
                chip.title = term;

                const label = document.createElement("span");
                label.className = "gallery-search-term-label";
                label.textContent = getSearchTermLabel(term);

                const removeButton = document.createElement("button");
                removeButton.type = "button";
                removeButton.className = "gallery-search-term-remove";
                removeButton.textContent = "X";
                removeButton.title = "删除这个搜索词";
                removeButton.onclick = (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    this.removeSearchTermAtIndex?.(index);
                };

                chip.append(label, removeButton);
                this.searchTermsWrap.appendChild(chip);
            });

            this.searchInput.placeholder = terms.length
                ? "继续输入"
                : "搜索:作品id/作者id/简介/tags(日文)/投稿日期/AI类型/模型";
            this.updateSearchClearButton?.();
            this.updateSearchOverflowIndicator?.();
        };

        nodeType.prototype.updateSearchOverflowIndicator = function (options = {}) {
            const termsWrap = this.searchTermsWrap;
            const track = this.searchScrollTrack;
            const thumb = this.searchScrollThumb;
            const box = this.searchBox;
            if (!termsWrap || !track || !thumb || !box) return;

            const scrollWidth = termsWrap.scrollWidth;
            const clientWidth = termsWrap.clientWidth;
            const hasOverflow = scrollWidth > clientWidth + 1;
            track.style.display = hasOverflow ? "block" : "none";
            if (!hasOverflow) {
                box.classList.remove("is-scrolling");
                return;
            }

            const trackWidth = track.clientWidth || clientWidth;
            const thumbWidth = Math.max(28, Math.round((clientWidth / scrollWidth) * trackWidth));
            const maxScrollLeft = scrollWidth - clientWidth;
            const maxThumbLeft = Math.max(0, trackWidth - thumbWidth);
            const thumbLeft = maxScrollLeft > 0
                ? Math.round((termsWrap.scrollLeft / maxScrollLeft) * maxThumbLeft)
                : 0;

            thumb.style.width = `${thumbWidth}px`;
            thumb.style.transform = `translateX(${thumbLeft}px)`;

            if (options.show) {
                box.classList.add("is-scrolling");
                clearTimeout(this._searchScrollHideTimer);
                this._searchScrollHideTimer = setTimeout(() => {
                    box.classList.remove("is-scrolling");
                }, 650);
            }
        };

        nodeType.prototype.scrollSearchTermsToEnd = function () {
            const termsWrap = this.searchTermsWrap;
            if (!termsWrap) return;
            requestAnimationFrame(() => {
                termsWrap.scrollLeft = termsWrap.scrollWidth;
                this.updateSearchOverflowIndicator?.({ show: true });
            });
        };

        nodeType.prototype.setSearchQueryValue = function (searchQuery, options = {}) {
            if (!this.searchInput) return;
            this._searchQueryValue = String(searchQuery || "").trim();
            this.searchInput.value = options.keepInput ? this._searchQueryValue : "";
            this.renderSearchTerms?.();
            if (options.scrollToEnd) this.scrollSearchTermsToEnd?.();
            this.syncDrawInputs?.();
            if (options.save !== false) this.saveGalleryState?.();
        };

        nodeType.prototype.applySearchQuery = function (searchQuery, options = {}) {
            const nextQuery = String(searchQuery || "").trim();
            const previousQuery = normalizeGalleryQuery(this._lastLoadedGalleryQuery || this.getCurrentGalleryQuery?.() || {});
            const nextNormalized = normalizeGalleryQuery({
                searchQuery: nextQuery,
                sort: this.sortSelect?.value || previousQuery?.sort || "new",
                timeRange: this.timeSelect?.value || previousQuery?.timeRange || "all"
            });

            if (options.pushHistory !== false
                && previousQuery
                && !areGalleryQueriesEqual(previousQuery, nextNormalized)) {
                this.pushGallerySearchHistory?.();
            }

            this.hideHoverPreviews?.();
            this.setSearchQueryValue?.(nextQuery, { scrollToEnd: options.scrollToEnd });

            if (this.sortSelect && this.sortSelect.value !== "new" && nextQuery) {
                this.sortSelect.value = "new";
                this.updateTimeSelect?.();
            }

            if (options.search !== false) this.loadGallery(1);
        };

        nodeType.prototype.removeSearchTermAtIndex = function (index) {
            const terms = splitSearchTerms(this.getSearchQueryValue?.() || "");
            if (index < 0 || index >= terms.length) return;
            terms.splice(index, 1);
            this.applySearchQuery?.(buildSearchQueryFromTerms(terms), { pushHistory: true, search: true });
        };

        nodeType.prototype.restoreGallerySearchHistory = function () {
            if (!Array.isArray(this._gallerySearchHistory)) {
                const cache = this.getSessionCache?.();
                this._gallerySearchHistory = Array.isArray(cache?.searchHistory) ? cache.searchHistory : [];
            }
            this.syncSearchHistoryButton?.();
        };

        nodeType.prototype.goBackSearchHistory = function () {
            if (!Array.isArray(this._gallerySearchHistory) || !this._gallerySearchHistory.length) return;
            const snapshot = this._gallerySearchHistory.pop();
            this.setSessionCache?.({ searchHistory: this._gallerySearchHistory });
            this.syncSearchHistoryButton?.();
            if (!snapshot) return;

            this.hideHoverPreviews?.();
            this.clearListDomCache?.();
            if (this.sortSelect) this.sortSelect.value = snapshot.query?.sort || "new";
            this.updateTimeSelect?.();
            if (this.timeSelect) this.timeSelect.value = snapshot.query?.timeRange || "all";
            this.setSearchQueryValue?.(snapshot.query?.searchQuery || "", { save: false });
            this._lastLoadedGalleryQuery = normalizeGalleryQuery(snapshot.query || {});

            this.galleryAllItems = Array.isArray(snapshot.items) ? snapshot.items : [];
            this.galleryPage = snapshot.page || 1;
            this.galleryDisplayPage = snapshot.displayPage || snapshot.page || 1;
            this.galleryTotalPages = snapshot.totalPages || 1;
            this._hasMoreGalleryItems = snapshot.hasMore !== false;
            this._viewMode = "list";
            this._detailWorkId = null;
            this._detailRaw = null;
            this._detailImages = [];
            this._selectedDetailImage = null;
            this._savedListScrollTop = snapshot.scrollTop || 0;
            this._savedScrollTop = snapshot.scrollTop || 0;

            if (this.listControls) this.listControls.style.display = "flex";
            if (this.detailControls) this.detailControls.style.display = "none";
            this.syncDrawInputs?.();
            this.syncPageControls?.();
            this.setSessionCache?.({
                items: this.galleryAllItems,
                detailRaw: null,
                detailImages: []
            });

            if (this.galleryAllItems.length) {
                this.renderPage(false, { animate: false });
                this.restoreGalleryScroll?.("list", snapshot.scrollTop || 0);
                this.recoverStaleListImages?.();
                this.saveGalleryState?.();
            } else {
                this.loadGallery(snapshot.page || 1);
            }
        };

        nodeType.prototype.syncPageControls = function () {
            if (this.pageInput) {
                const currentPage = String(this.galleryDisplayPage || this.galleryPage || 1);
                this.pageInput.placeholder = currentPage;
                if (document.activeElement !== this.pageInput || this.pageInput.dataset.editing !== "1") {
                    this.pageInput.value = currentPage;
                    this.pageInput.dataset.editing = "0";
                }
            }
            if (this.pageTotalLabel) {
                this.pageTotalLabel.textContent = `/ ${this.galleryTotalPages || 1} 页`;
            }
        };

        nodeType.prototype.syncVisibleGalleryPageFromScroll = function () {
            if (!this.galleryGrid || this._viewMode !== "list") {
                this.syncPageControls?.();
                return;
            }

            const cards = this.galleryGrid.querySelectorAll("[data-gallery-page]");
            if (!cards.length) {
                this.galleryDisplayPage = this.galleryPage || 1;
                this.syncPageControls?.();
                return;
            }

            const gridRect = this.galleryGrid.getBoundingClientRect();
            const probeY = gridRect.top + 8;
            let bestPage = null;
            let bestDistance = Number.POSITIVE_INFINITY;

            cards.forEach((card) => {
                const page = Number(card.getAttribute("data-gallery-page"));
                if (!Number.isFinite(page) || page < 1) return;

                const rect = card.getBoundingClientRect();
                if (rect.bottom < gridRect.top || rect.top > gridRect.bottom) return;

                const distance = Math.abs(rect.top - probeY);
                if (distance < bestDistance) {
                    bestDistance = distance;
                    bestPage = page;
                }
            });

            this.galleryDisplayPage = bestPage || this.galleryDisplayPage || this.galleryPage || 1;
            this.syncPageControls?.();
        };

        nodeType.prototype.addSearchTerm = function (searchTerm, options = {}) {
            const term = String(searchTerm || "").trim();
            if (!term || !this.searchInput) return;

            this.hideHoverPreviews?.();
            const current = this.getSearchQueryValue?.().trim() || "";
            const termKey = getSearchTermCompareKey(term);
            const hasTerm = splitSearchTerms(current)
                .some((part) => getSearchTermCompareKey(part) === termKey);

            const nextQuery = current
                ? (hasTerm ? current : `${current} ${term}`)
                : term;
            this.applySearchQuery?.(nextQuery, {
                pushHistory: options.pushHistory !== false,
                search: options.search !== false,
                scrollToEnd: true
            });
        };

        nodeType.prototype.getTitleBlacklist = function () {
            if (!Array.isArray(this._titleBlacklist)) {
                this._titleBlacklist = readTitleBlacklist();
            }
            this._titleBlacklist = this._titleBlacklist.map(normalizeBlacklistEntry).filter(Boolean);
            return this._titleBlacklist;
        };

        nodeType.prototype.setTitleBlacklist = function (entries = []) {
            this._titleBlacklist = mergeTitleBlacklists(entries);
            writeTitleBlacklist(this._titleBlacklist);
            this.syncTitleBlacklistToDisk?.();
            this.renderBlacklistDialog?.();
        };

        nodeType.prototype.syncTitleBlacklistToDisk = function () {
            const snapshot = this.getTitleBlacklist();
            this._pendingTitleBlacklistSave = saveTitleBlacklist(snapshot)
                .then((savedEntries) => {
                    const merged = mergeTitleBlacklists(snapshot, savedEntries);
                    this._titleBlacklist = merged;
                    writeTitleBlacklist(merged);
                    this.renderBlacklistDialog?.();
                    return merged;
                })
                .catch((error) => {
                    console.warn("[Gallery] failed to sync title blacklist", error);
                    return snapshot;
                });
            return this._pendingTitleBlacklistSave;
        };

        nodeType.prototype.loadTitleBlacklistFromDisk = async function () {
            try {
                const localEntries = this.getTitleBlacklist();
                const diskEntries = await fetchTitleBlacklist();
                const merged = mergeTitleBlacklists(localEntries, diskEntries);
                this._titleBlacklist = merged;
                writeTitleBlacklist(merged);
                this.renderBlacklistDialog?.();
                if (merged.length !== diskEntries.length) this.syncTitleBlacklistToDisk?.();
                return merged;
            } catch (error) {
                console.warn("[Gallery] failed to load title blacklist", error);
                return this.getTitleBlacklist();
            }
        };

        nodeType.prototype.isTitleBlacklisted = function (title, userId) {
            const normalizedTitle = normalizeBlacklistTitle(title);
            const normalizedUserId = normalizeBlacklistUserId(userId);
            if (!normalizedTitle || !normalizedUserId) return false;
            return this.getTitleBlacklist().some((entry) => isBlacklistEntryMatch(entry, {
                title: normalizedTitle,
                userId: normalizedUserId
            }));
        };

        nodeType.prototype.isItemBlacklisted = function (item) {
            if (!item) return false;
            return this.getTitleBlacklist().some((entry) => isBlacklistEntryMatch(entry, item));
        };

        nodeType.prototype.filterBlacklistedItems = function (items = []) {
            if (!Array.isArray(items)) return [];
            return items.filter((item) => !this.isItemBlacklisted(item));
        };

        nodeType.prototype.addItemToBlacklist = function (item) {
            if (!item) return false;
            return this.addTitleToBlacklist(item?.title || "", getItemBlacklistAuthorId(item));
        };

        nodeType.prototype.addTitleToBlacklist = function (title, userId) {
            const normalizedTitle = normalizeBlacklistTitle(title);
            const normalizedUserId = normalizeBlacklistUserId(userId);
            if (!normalizedTitle || !normalizedUserId) {
                console.warn("[Gallery] cannot blacklist item without both title and author id", { title, userId });
                return false;
            }

            const entry = {
                title: normalizedTitle,
                userId: normalizedUserId
            };
            const targetScrollTop = this.galleryGrid?.scrollTop || this._savedListScrollTop || 0;

            if (!this.isTitleBlacklisted(entry.title, entry.userId)) {
                this.setTitleBlacklist([...this.getTitleBlacklist(), entry]);
            }

            if (Array.isArray(this.galleryAllItems)) {
                this.galleryAllItems = this.filterBlacklistedItems(this.galleryAllItems);
                this.setSessionCache?.({ items: this.galleryAllItems });
            }

            if (this._viewMode === "list") {
                this.renderPage(false, { animate: false });
                this.restoreGalleryScroll?.("list", targetScrollTop);
            }
            this.saveGalleryState?.();
            return true;
        };

        nodeType.prototype.removeTitleFromBlacklist = function (entryOrTitle, userId) {
            const entry = normalizeBlacklistEntry(
                typeof entryOrTitle === "object"
                    ? entryOrTitle
                    : { title: entryOrTitle, userId }
            );
            const key = getBlacklistEntryStorageKey(entry);
            if (!key) return;
            this.setTitleBlacklist(this.getTitleBlacklist().filter((blockedEntry) => getBlacklistEntryStorageKey(blockedEntry) !== key));
            this.saveGalleryState?.();
            if (this._viewMode === "list") this.loadGallery(this.galleryPage || 1);
        };

        nodeType.prototype.clearTitleBlacklist = function () {
            this.setTitleBlacklist([]);
            this.saveGalleryState?.();
            if (this._viewMode === "list") this.loadGallery(this.galleryPage || 1);
        };

        nodeType.prototype.renderBlacklistDialog = function () {
            if (!this.blacklistDialogList || !this.blacklistDialogEmpty) return;
            const entries = this.getTitleBlacklist();
            this.blacklistDialogList.innerHTML = "";
            this.blacklistDialogEmpty.style.display = entries.length ? "none" : "block";

            entries.forEach((entry) => {
                const row = document.createElement("div");
                row.style.cssText = "display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.08);";

                const text = document.createElement("div");
                const authorLabel = entry.userId ? `ID: ${entry.userId}` : "旧标题黑名单，缺少作者ID";
                text.textContent = `${entry.title} · ${authorLabel}`;
                text.title = `${entry.title}\n${authorLabel}`;
                text.style.cssText = "flex:1;min-width:0;color:#f4f4f5;font-size:12px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";

                const removeButton = document.createElement("button");
                removeButton.textContent = "移除";
                removeButton.style.cssText = "height:24px;padding:0 9px;border-radius:4px;border:1px solid rgba(248,113,113,0.38);background:rgba(127,29,29,0.45);color:#fecaca;cursor:pointer;font-size:11px;";
                removeButton.onclick = () => this.removeTitleFromBlacklist(entry);

                row.append(text, removeButton);
                this.blacklistDialogList.appendChild(row);
            });
        };

        nodeType.prototype.showBlacklistDialog = function () {
            if (!this.blacklistDialog) return;
            this.renderBlacklistDialog?.();
            this.blacklistDialog.style.display = "flex";
        };

        nodeType.prototype.hideBlacklistDialog = function () {
            if (this.blacklistDialog) this.blacklistDialog.style.display = "none";
        };

        nodeType.prototype.setWidgetValue = function (name, value) {
            if (!this.widgets) return;
            const nextValue = value == null ? "" : value;
            for (const w of this.widgets) {
                if (w.name === name) {
                    w.value = nextValue;
                    break;
                }
            }
        };

        nodeType.prototype.syncDrawInputs = function () {
            const query = this.getCurrentGalleryQuery();
            this.setWidgetValue?.("search_query", query.searchQuery);
            this.setWidgetValue?.("sort_mode", query.sort);
            this.setWidgetValue?.("time_range", query.timeRange);
            this.setWidgetValue?.("draw_enabled", !!this.drawToggleInput?.checked);
        };

        nodeType.prototype.setDrawButtonBusy = function (busy) {
            if (!this.randomDrawButton) return;
            this.randomDrawButton.disabled = !!busy;
            this.randomDrawButton.style.opacity = busy ? "0.72" : "1";
            this.randomDrawButton.style.cursor = busy ? "wait" : "pointer";
            this.randomDrawButton.textContent = busy ? "抽取中..." : "🎴 抽卡";
        };

        nodeType.prototype.showDrawOverlay = function (title, subtitle = "", badge = "") {
            if (!this.drawOverlay) return;
            if (this.drawOverlayTitle) this.drawOverlayTitle.textContent = title || "抽取中";
            if (this.drawOverlaySubtitle) this.drawOverlaySubtitle.textContent = subtitle || "";
            if (this.drawOverlayBadge) {
                this.drawOverlayBadge.textContent = badge || "";
                this.drawOverlayBadge.style.display = badge ? "inline-flex" : "none";
            }
            this.drawOverlay.classList.add("is-visible");
        };

        nodeType.prototype.hideDrawOverlay = function () {
            this.drawOverlay?.classList.remove("is-visible");
        };

        nodeType.prototype.flashDrawResult = function (title, subtitle = "", badge = "", duration = 720) {
            this.showDrawOverlay(title, subtitle, badge);
            setTimeout(() => {
                if (this._viewMode === "list") this.hideDrawOverlay?.();
            }, duration);
        };

        nodeType.prototype.loadNextGalleryPage = function () {
            if (this._viewMode !== 'list' || this._isLoading || this._isAppendingGallery || !this._hasMoreGalleryItems) return;
            if ((this.galleryPage || 1) >= (this.galleryTotalPages || 1)) return;
            this.hideHoverPreviews?.();
            this.loadGallery((this.galleryPage || 1) + 1, { append: true });
        };

        nodeType.prototype.drawRandomGalleryItem = async function () {
            this.hideHoverPreviews?.();
            if (this._isLoading || this._isDrawing) return;
            this._isDrawing = true;

            const currentQuery = this.getCurrentGalleryQuery();
            const previousLabel = this.loadingLabel?.textContent || "";
            this.setDrawButtonBusy?.(true);
            this.showDrawOverlay?.(
                "正在抽卡",
                currentQuery.searchQuery
                    ? `继承当前搜索：${currentQuery.searchQuery}`
                    : "继承当前筛选条件"
            );
            if (this.loadingLabel) this.loadingLabel.textContent = "抽卡中...";

            try {
                let totalPages = 1;
                let randomPage = 1;
                let candidateItems = [];
                let firstPageItems = [];

                if (areGalleryQueriesEqual(this._lastLoadedGalleryQuery, currentQuery)) {
                    totalPages = Math.max(1, Number(this.galleryTotalPages) || 1);
                    randomPage = Math.floor(Math.random() * totalPages) + 1;

                    if (totalPages === 1 && Array.isArray(this.galleryAllItems) && this.galleryAllItems.length > 0) {
                        candidateItems = this.galleryAllItems;
                    } else {
                        const randomPageData = await fetchGalleryPage({ page: randomPage, ...currentQuery });
                        candidateItems = Array.isArray(randomPageData?.items) ? randomPageData.items : [];
                    }
                    candidateItems = this.filterBlacklistedItems?.(candidateItems) || candidateItems;
                } else {
                    const firstPageData = await fetchGalleryPage({ page: 1, ...currentQuery });
                    firstPageItems = Array.isArray(firstPageData?.items) ? firstPageData.items : [];

                    const totalCount = Math.max(firstPageItems.length, Number(firstPageData?.total) || 0);
                    totalPages = Math.max(1, Math.ceil(totalCount / GALLERY_PAGE_SIZE));
                    randomPage = Math.floor(Math.random() * totalPages) + 1;

                    if (randomPage === 1) {
                        candidateItems = firstPageItems;
                    } else {
                        const randomPageData = await fetchGalleryPage({ page: randomPage, ...currentQuery });
                        candidateItems = Array.isArray(randomPageData?.items) ? randomPageData.items : [];
                    }

                    candidateItems = this.filterBlacklistedItems?.(candidateItems) || candidateItems;
                    firstPageItems = this.filterBlacklistedItems?.(firstPageItems) || firstPageItems;
                    if (!candidateItems.length && firstPageItems.length) {
                        randomPage = 1;
                        candidateItems = firstPageItems;
                    }
                }

                if (!candidateItems.length) {
                    throw new Error("No items found for current filters");
                }

                const randomIndex = Math.floor(Math.random() * candidateItems.length);
                const randomItem = candidateItems[randomIndex];
                if (!randomItem?.id) {
                    throw new Error("Random item is missing id");
                }

                const workTitle = String(randomItem.title || "已命中作品").trim() || "已命中作品";
                this.showDrawOverlay?.(
                    "抽卡命中",
                    workTitle.length > 28 ? `${workTitle.slice(0, 28)}...` : workTitle,
                    `第 ${randomPage} / ${totalPages} 页`
                );
                if (this.loadingLabel) this.loadingLabel.textContent = `命中第 ${randomPage}/${totalPages} 页`;
                await this.showDetailView(randomItem.id);
            } catch (error) {
                console.error("[Gallery] random draw failed", error);
                this.showDrawOverlay?.(
                    "抽卡失败",
                    "当前筛选条件下没有可用结果",
                    "请调整搜索或筛选"
                );
                if (this.loadingLabel) this.loadingLabel.textContent = "抽卡失败";
                setTimeout(() => {
                    if (this.loadingLabel && this._viewMode !== "detail") {
                        this.loadingLabel.textContent = previousLabel;
                    }
                    this.hideDrawOverlay?.();
                }, 1800);
                return;
            } finally {
                this._isDrawing = false;
                this.setDrawButtonBusy?.(false);
            }
            if (this.loadingLabel) this.loadingLabel.textContent = previousLabel;
        };

        nodeType.prototype.showListView = function () {
            this.hideHoverPreviews?.();
            this.hideDrawOverlay?.();
            this.setDrawButtonBusy?.(false);
            if (this.galleryGrid && this._viewMode === 'detail') {
                this._savedDetailScrollTop = this.galleryGrid.scrollTop;
            }

            const targetScrollTop = this._savedListScrollTop || this._savedScrollTop || 0;
            this._viewMode = 'list';
            this.listControls.style.display = 'flex';
            this.detailControls.style.display = 'none';

            const restoredDom = this.restoreListDomCache?.();
            if (!restoredDom) this.renderPage(false);
            this.restoreGalleryScroll?.('list', targetScrollTop);
            this.recoverStaleListImages?.();
            setTimeout(() => this.recoverStaleListImages?.(), 400);
            setTimeout(() => this.recoverStaleListImages?.(), 1600);
        };

        nodeType.prototype.showDetailView = async function (workId) {
            this.hideHoverPreviews?.();
            this.hideDrawOverlay?.();
            if (!this._isDrawing) this.setDrawButtonBusy?.(false);
            if (this.galleryGrid) {
                if (this._viewMode === 'list') {
                    this._savedListScrollTop = this.galleryGrid.scrollTop;
                } else {
                    this._savedDetailScrollTop = this.galleryGrid.scrollTop;
                }
            }

            if (this._viewMode === 'list') {
                this.stashListDomForDetail?.();
            }

            this._viewMode = 'detail';
            this._detailWorkId = workId;
            this._savedDetailScrollTop = 0;
            this.saveGalleryState?.();

            this.listControls.style.display = 'none';
            this.detailControls.style.display = 'flex';

            this.galleryGrid.replaceChildren();
            this.galleryGrid.innerHTML = `
                <div class="gallery-soft-loading">
                    <div class="gallery-soft-loading-spinner"></div>
                    <div>加载作品详情...</div>
                </div>
            `;

            const detail = await fetchWorkDetail(workId);
            if (!detail || !detail.images) {
                this.galleryGrid.innerHTML = `
                    <div class="gallery-centered-state">
                        <div style="color:#e74c3c;">❌ 加载失败</div>
                    </div>
                `;
                return;
            }

            this._detailRaw = detail;
            this._detailImages = detail.images;
            this._selectedDetailImage = null;
            this.setSessionCache({
                detailRaw: detail,
                detailImages: detail.images
            });

            this.renderDetailFromRaw(detail);
            this.restoreGalleryScroll?.('detail', 0);
        };

        nodeType.prototype.showLoading = function (msg, append = false) {
            this._isLoading = true;
            if (this.loadingLabel) this.loadingLabel.textContent = msg || '⏳ 加载中...';
            if (this.galleryGrid && !append) {
                this.galleryGrid.innerHTML = `
                    <div class="gallery-soft-loading">
                        <div class="gallery-soft-loading-spinner"></div>
                        <div>${msg || '加载中...'}</div>
                    </div>
                `;
            }
            if (append) this.setBottomLoadingVisible?.(true);
        };

        nodeType.prototype.setBottomLoadingVisible = function (visible) {
            if (!this.bottomLoading) return;
            if (visible) {
                this.bottomLoading.classList.add('is-visible');
            } else {
                requestAnimationFrame(() => {
                    this.bottomLoading?.classList.remove('is-visible');
                });
            }
        };

        nodeType.prototype.loadGallery = async function (page, options = {}) {
            this.hideHoverPreviews?.();
            const append = !!options.append;
            if (append) {
                this._isAppendingGallery = true;
            } else {
                this.clearListDomCache?.();
                this.galleryDisplayPage = page || 1;
                this.syncPageControls?.();
                this._viewMode = 'list';
                this.hideDrawOverlay?.();
                this.setDrawButtonBusy?.(false);
                this._savedScrollTop = 0;
                this._savedDetailScrollTop = 0;
                this._detailWorkId = null;
                this._detailRaw = null;
                this._detailImages = [];
                this._selectedDetailImage = null;
                this._hasMoreGalleryItems = true;
            }

            this.listControls.style.display = 'flex';
            this.detailControls.style.display = 'none';

            this.showLoading(append ? '⏳ 加载更多...' : '⏳ 加载列表中...', append);

            const query = this.getCurrentGalleryQuery();
            const searchQuery = query.searchQuery;
            let sort = query.sort;

            if (searchQuery && sort !== 'new') {
                sort = 'new';
                if (this.sortSelect) this.sortSelect.value = 'new';
                this.updateTimeSelect?.();
            }

            const timeRange = normalizeGalleryQuery({
                searchQuery,
                sort,
                timeRange: this.timeSelect?.value || query.timeRange || 'all'
            }).timeRange;
            this.syncDrawInputs?.();

            try {
                const data = await fetchGalleryPage({ page, sort, timeRange, searchQuery });
                this._lastLoadedGalleryQuery = { searchQuery, sort, timeRange };

                if (data.items && data.items.length > 0) {
                    const newItems = (this.filterBlacklistedItems?.(data.items) || data.items).map((item) => {
                        if (item && typeof item === "object") item._galleryPage = page;
                        return item;
                    });
                    this.galleryAllItems = append ? [...(this.galleryAllItems || []), ...newItems] : newItems;
                    this.galleryPage = page;
                    if (!append) this.galleryDisplayPage = page;
                    this.galleryTotalPages = Math.max(1, Math.ceil((data.total || data.items.length) / GALLERY_PAGE_SIZE));
                    this._hasMoreGalleryItems = this.galleryPage < this.galleryTotalPages;
                    this._isLoading = false;
                    this._isAppendingGallery = false;
                    this.setBottomLoadingVisible?.(false);
                    if (!append) this._savedListScrollTop = 0;
                    this.syncPageControls?.();

                    this.setSessionCache({
                        items: this.galleryAllItems,
                        detailRaw: null,
                        detailImages: []
                    });

                    if (this.loadingLabel) this.loadingLabel.textContent = `✅ ${this.galleryAllItems.length}张`;
                    if (append && this._galleryGridContainer) {
                        this.appendListItems(newItems);
                    } else {
                        this.renderPage(true);
                    }
                    this.saveGalleryState?.();
                } else {
                    this._isLoading = false;
                    this._isAppendingGallery = false;
                    this._hasMoreGalleryItems = false;
                    this.setBottomLoadingVisible?.(false);
                    if (!append) {
                        this.galleryAllItems = [];
                        this._savedListScrollTop = 0;
                        this.galleryPage = page;
                        this.galleryDisplayPage = page;
                        this.syncPageControls?.();
                        this.setSessionCache({ items: [], detailRaw: null, detailImages: [] });
                        this.galleryGrid.innerHTML = `
                            <div class="gallery-centered-state">
                                <div style="color:grey;">📭 没有找到图片</div>
                            </div>
                        `;
                    }
                    if (this.loadingLabel) this.loadingLabel.textContent = '📭';
                    this.saveGalleryState?.();
                }
            } catch (e) {
                this._isLoading = false;
                this._isAppendingGallery = false;
                this.setBottomLoadingVisible?.(false);
                if (!append) {
                    this.galleryGrid.innerHTML = `
                        <div class="gallery-centered-state">
                            <div style="color:#e74c3c;">❌ ${e.message}</div>
                        </div>
                    `;
                }
                if (this.loadingLabel) this.loadingLabel.textContent = '❌';
                this.saveGalleryState?.();
            }
        };

        nodeType.prototype.createGalleryUI = function () {
            if (this.customUI) return;

            const container = document.createElement('div');
            container.style.cssText = 'display:flex;flex-direction:column;width:100%;min-height:450px;';

            this.listControls = document.createElement('div');
            this.listControls.style.cssText = 'display:flex;flex-direction:column;gap:6px;';

            const searchRow = document.createElement('div');
            searchRow.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:3px;';

            const searchInputWrapper = document.createElement('div');
            searchInputWrapper.style.cssText = 'display:flex;align-items:center;gap:4px;flex:1;min-width:170px;';

            this.searchBackButton = document.createElement('button');
            this.searchBackButton.type = 'button';
            this.searchBackButton.className = 'gallery-search-back';
            this.searchBackButton.textContent = '<';
            this.searchBackButton.onclick = () => this.goBackSearchHistory?.();

            const searchBox = document.createElement('div');
            searchBox.className = 'gallery-search-box';
            this.searchBox = searchBox;
            searchBox.onclick = () => this.searchInput?.focus();

            this.searchTermsWrap = document.createElement('div');
            this.searchTermsWrap.className = 'gallery-search-terms';
            this.searchTermsWrap.addEventListener('scroll', () => {
                this.updateSearchOverflowIndicator?.({ show: true });
            });
            searchBox.addEventListener('wheel', (e) => {
                const termsWrap = this.searchTermsWrap;
                if (!termsWrap || termsWrap.scrollWidth <= termsWrap.clientWidth) return;
                const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
                if (!delta) return;
                termsWrap.scrollLeft += delta;
                this.updateSearchOverflowIndicator?.({ show: true });
                e.preventDefault();
            }, { passive: false });

            this.searchScrollTrack = document.createElement('div');
            this.searchScrollTrack.className = 'gallery-search-scrollbar';
            this.searchScrollThumb = document.createElement('div');
            this.searchScrollThumb.className = 'gallery-search-scrollbar-thumb';
            this.searchScrollTrack.appendChild(this.searchScrollThumb);

            this.searchInput = document.createElement('input');
            this.searchInput.type = 'text';
            this.searchInput.placeholder = '搜索:作品id/作者id/简介/tags(日文)/投稿日期/AI类型/模型(支持 -排除 与 OR 双引号精准)';
            this.searchInput.className = 'gallery-search-input';
            this.searchInput.addEventListener('keydown', (e) => {
                if (e.isComposing) return;
                if (e.key === 'Enter') {
                    e.preventDefault();
                    const typedTerm = this.searchInput.value.trim();
                    if (typedTerm) {
                        this.addSearchTerm?.(typedTerm, { pushHistory: true, search: true });
                    } else {
                        this.applySearchQuery(this.getSearchQueryValue?.() || "");
                    }
                }
            });
            this.searchInput.addEventListener('input', () => {
                this.updateSearchClearButton?.();
            });

            const clearBtn = document.createElement('span');
            clearBtn.textContent = '✕';
            clearBtn.style.cssText = 'position:absolute;right:8px;color:#888;cursor:pointer;font-size:10px;display:none;';
            clearBtn.onclick = () => {
                this.applySearchQuery?.("", { pushHistory: true, search: true });
            };
            this.searchClearButton = clearBtn;

            searchBox.append(this.searchTermsWrap, this.searchInput, clearBtn, this.searchScrollTrack);
            searchInputWrapper.append(this.searchBackButton, searchBox);
            this.syncSearchHistoryButton?.();

            this.sortSelect = document.createElement('select');
            this.sortSelect.style.cssText = 'padding:4px 6px;background:#3b4252;color:white;border:1px solid #4a5568;border-radius:3px;font-size:11px;height:26px;';
            this.sortSelect.innerHTML = '<option value="new">🆕 新作品排序</option><option value="monthly">🏆 每月排行榜</option>';
            this.sortSelect.onchange = () => {
                this.updateTimeSelect();
                this.syncDrawInputs?.();
                this.saveGalleryState?.();
                this.loadGallery(1);
            };

            this.timeSelect = document.createElement('select');
            this.timeSelect.style.cssText = 'padding:4px 6px;background:#3b4252;color:white;border:1px solid #4a5568;border-radius:3px;font-size:11px;height:26px;';
            this.timeSelect.onchange = () => {
                this.syncDrawInputs?.();
                this.saveGalleryState?.();
                this.loadGallery(1);
            };

            const drawToggleLabel = document.createElement('label');
            drawToggleLabel.style.cssText = 'display:flex;align-items:center;gap:5px;height:26px;padding:0 10px;background:#313741;color:#f4f4f5;border:1px solid #4a5568;border-radius:9999px;font-size:11px;cursor:pointer;user-select:none;';

            this.drawToggleInput = document.createElement('input');
            this.drawToggleInput.type = 'checkbox';
            this.drawToggleInput.style.cssText = 'margin:0;accent-color:#f59e0b;cursor:pointer;';
            this.drawToggleInput.onchange = () => {
                this.syncDrawInputs?.();
                this.saveGalleryState?.();
                this.setDirtyCanvas?.(true, true);
                if (app.graph) app.graph.change();
            };

            const drawToggleText = document.createElement('span');
            drawToggleText.textContent = '抽卡模式';
            drawToggleLabel.append(this.drawToggleInput, drawToggleText);

            this.randomDrawButton = document.createElement('button');
            this.randomDrawButton.textContent = '🎴 抽卡';
            this.randomDrawButton.title = '从当前搜索/筛选结果里随机抽一项';
            this.randomDrawButton.style.cssText = 'padding:4px 12px;background:linear-gradient(135deg,#f59e0b,#ea580c);color:white;border:none;border-radius:9999px;cursor:pointer;font-size:11px;height:26px;font-weight:700;box-shadow:0 8px 18px rgba(234,88,12,0.24);';
            this.randomDrawButton.onclick = () => this.drawRandomGalleryItem?.();

            this.loadingLabel = document.createElement('span');
            this.loadingLabel.style.cssText = 'color:#888;font-size:10px;white-space:nowrap;';

            this.syncDrawInputs?.();

            const pageInfoWrap = document.createElement('div');
            pageInfoWrap.style.cssText = 'display:flex;align-items:center;gap:4px;color:#ccc;font-size:10px;margin-left:auto;white-space:nowrap;';

            this.pageInput = document.createElement('input');
            this.pageInput.type = 'number';
            this.pageInput.min = '1';
            this.pageInput.step = '1';
            this.pageInput.value = '1';
            this.pageInput.placeholder = '1';
            this.pageInput.style.cssText = 'width:50px;padding:3px 6px;background:#313741;color:#fff;border:1px solid #4a5568;border-radius:4px;font-size:10px;height:24px;text-align:center;';

            const commitPageInput = () => {
                if (!this.pageInput.value.trim()) {
                    this.pageInput.dataset.editing = "0";
                    this.syncPageControls?.();
                    return;
                }
                const target = Number(this.pageInput.value);
                if (!Number.isFinite(target)) {
                    this.pageInput.dataset.editing = "0";
                    this.syncPageControls?.();
                    return;
                }
                this.pageInput.dataset.editing = "0";
                this.goToPage(target);
                this.syncPageControls?.();
            };

            this.pageInput.addEventListener('input', () => {
                this.pageInput.dataset.editing = "1";
            });
            this.pageInput.addEventListener('focus', () => {
                this.pageInput.dataset.editing = "1";
            });
            this.pageInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') commitPageInput();
            });
            this.pageInput.addEventListener('blur', commitPageInput);

            this.pageTotalLabel = document.createElement('span');
            this.pageTotalLabel.textContent = '/ 1 页';

            const jumpButton = document.createElement('button');
            jumpButton.textContent = '跳转';
            jumpButton.style.cssText = 'background:#3b4252;color:white;border:1px solid #4a5568;padding:3px 8px;border-radius:3px;cursor:pointer;font-size:10px;height:24px;';
            jumpButton.onclick = commitPageInput;

            const settingsButton = document.createElement('button');
            settingsButton.textContent = '⚙';
            settingsButton.title = '查看黑名单';
            settingsButton.style.cssText = 'background:#3b4252;color:white;border:1px solid #4a5568;padding:3px 8px;border-radius:3px;cursor:pointer;font-size:12px;height:24px;min-width:28px;line-height:1;';
            settingsButton.onclick = () => this.showBlacklistDialog?.();

            const refreshButton = document.createElement('button');
            refreshButton.textContent = '↻';
            refreshButton.title = '刷新并回到第一页';
            refreshButton.style.cssText = 'background:#3b4252;color:white;border:1px solid #4a5568;padding:3px 8px;border-radius:3px;cursor:pointer;font-size:12px;height:24px;min-width:28px;line-height:1;';
            refreshButton.onclick = () => {
                const query = this.getCurrentGalleryQuery();
                clearGalleryPageCache({ page: 1, ...query });
                this.galleryDisplayPage = 1;
                this.syncPageControls?.();
                this.loadGallery(1);
            };

            pageInfoWrap.append(this.pageInput, this.pageTotalLabel, jumpButton, settingsButton, refreshButton);
            searchRow.append(searchInputWrapper, this.sortSelect, this.timeSelect, drawToggleLabel, this.loadingLabel, pageInfoWrap);
            this.listControls.append(searchRow);

            this.detailControls = document.createElement('div');
            this.detailControls.style.cssText = 'display:none;flex-direction:column;gap:6px;';

            const backRow = document.createElement('div');
            backRow.style.cssText = 'display:flex;align-items:center;gap:8px;background:linear-gradient(135deg,#667eea 0%,#764ba2 50%,#f093fb 100%);padding:10px 12px;border-radius:10px;';

            this.backButton = document.createElement('button');
            this.backButton.textContent = '← 返回列表';
            this.backButton.style.cssText = 'background:rgba(255,255,255,0.2);color:white;border:1px solid rgba(255,255,255,0.3);padding:6px 14px;border-radius:20px;cursor:pointer;font-size:11px;';
            this.backButton.onclick = () => this.showListView();

            this.detailTitle = document.createElement('span');
            this.detailTitle.style.cssText = 'color:white;font-size:13px;font-weight:500;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

            this.detailVersionBadge = document.createElement('span');
            this.detailVersionBadge.style.cssText = 'color:white;padding:3px 10px;border-radius:6px;font-size:10px;font-weight:bold;';

            backRow.append(this.backButton, this.detailTitle, this.detailVersionBadge);
            this.detailControls.append(backRow);

            const galleryStage = document.createElement('div');
            galleryStage.style.cssText = 'position:relative;display:flex;flex:1;min-height:0;';

            this.galleryGrid = document.createElement('div');
            this.galleryGrid.style.cssText = 'position:relative;overflow-y:auto;flex:1;border-radius:6px;';
            this.galleryGrid.innerHTML = `
                <div class="gallery-centered-state">
                    <div style="color:grey;">准备中...</div>
                </div>
            `;
            this.galleryGrid.addEventListener('scroll', () => {
                if (this._isRestoringGalleryScroll) return;

                this.hideHoverPreviews?.();
                if (this._viewMode === 'list') {
                    this._savedListScrollTop = this.galleryGrid.scrollTop;
                    this.syncVisibleGalleryPageFromScroll?.();
                    this.prioritizeVisibleListImages?.();
                    const remaining = this.galleryGrid.scrollHeight - this.galleryGrid.scrollTop - this.galleryGrid.clientHeight;
                    if (remaining < 160) this.loadNextGalleryPage?.();
                } else if (this._viewMode === 'detail') {
                    this._savedDetailScrollTop = this.galleryGrid.scrollTop;
                }
                this.saveGalleryState?.();
            });

            this.bottomLoading = document.createElement('div');
            this.bottomLoading.className = 'gallery-bottom-loading';
            this.bottomLoading.innerHTML = '<div class="gallery-bottom-loading-spinner"></div><span>载入中...</span>';

            this.drawOverlay = document.createElement('div');
            this.drawOverlay.className = 'gallery-draw-overlay';

            const drawPanel = document.createElement('div');
            drawPanel.className = 'gallery-draw-panel';

            const drawRing = document.createElement('div');
            drawRing.className = 'gallery-draw-ring';

            this.drawOverlayTitle = document.createElement('div');
            this.drawOverlayTitle.className = 'gallery-draw-title';
            this.drawOverlayTitle.textContent = '正在抽卡';

            this.drawOverlaySubtitle = document.createElement('div');
            this.drawOverlaySubtitle.className = 'gallery-draw-subtitle';
            this.drawOverlaySubtitle.textContent = '将继承当前搜索与筛选条件';

            this.drawOverlayBadge = document.createElement('div');
            this.drawOverlayBadge.className = 'gallery-draw-badge';
            this.drawOverlayBadge.style.display = 'none';

            drawPanel.append(drawRing, this.drawOverlayTitle, this.drawOverlaySubtitle, this.drawOverlayBadge);
            this.drawOverlay.appendChild(drawPanel);

            this.blacklistDialog = document.createElement('div');
            this.blacklistDialog.style.cssText = 'position:absolute;inset:0;z-index:70;display:none;align-items:flex-start;justify-content:flex-end;padding:12px;box-sizing:border-box;background:rgba(7,10,18,0.42);backdrop-filter:blur(4px);';
            this.blacklistDialog.onclick = (e) => {
                if (e.target === this.blacklistDialog) this.hideBlacklistDialog?.();
            };

            const blacklistPanel = document.createElement('div');
            blacklistPanel.style.cssText = 'width:min(360px,100%);max-height:100%;display:flex;flex-direction:column;border-radius:8px;background:#181c28;border:1px solid rgba(122,138,255,0.28);box-shadow:0 18px 50px rgba(0,0,0,0.45);overflow:hidden;';

            const blacklistHeader = document.createElement('div');
            blacklistHeader.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,0.08);';

            const blacklistTitle = document.createElement('div');
            blacklistTitle.textContent = '黑名单';
            blacklistTitle.style.cssText = 'flex:1;color:#f4f7ff;font-size:13px;font-weight:700;';

            const clearBlacklistButton = document.createElement('button');
            clearBlacklistButton.textContent = '清空';
            clearBlacklistButton.style.cssText = 'height:24px;padding:0 9px;border-radius:4px;border:1px solid rgba(148,163,184,0.35);background:#242b3a;color:#dbe4ff;cursor:pointer;font-size:11px;';
            clearBlacklistButton.onclick = () => this.clearTitleBlacklist?.();

            const closeBlacklistButton = document.createElement('button');
            closeBlacklistButton.textContent = '✕';
            closeBlacklistButton.title = '关闭';
            closeBlacklistButton.style.cssText = 'width:24px;height:24px;border-radius:4px;border:1px solid rgba(148,163,184,0.35);background:#242b3a;color:#dbe4ff;cursor:pointer;font-size:11px;line-height:1;';
            closeBlacklistButton.onclick = () => this.hideBlacklistDialog?.();

            blacklistHeader.append(blacklistTitle, clearBlacklistButton, closeBlacklistButton);

            this.blacklistDialogEmpty = document.createElement('div');
            this.blacklistDialogEmpty.textContent = '暂无黑名单标题';
            this.blacklistDialogEmpty.style.cssText = 'padding:18px 12px;color:#8f99b3;font-size:12px;text-align:center;';

            this.blacklistDialogList = document.createElement('div');
            this.blacklistDialogList.style.cssText = 'padding:0 12px 10px 12px;overflow:auto;min-height:0;';

            blacklistPanel.append(blacklistHeader, this.blacklistDialogEmpty, this.blacklistDialogList);
            this.blacklistDialog.appendChild(blacklistPanel);

            galleryStage.append(this.galleryGrid, this.bottomLoading, this.drawOverlay, this.blacklistDialog);

            container.append(this.listControls, this.detailControls, galleryStage);
            
            // --- 修复冲突的关键代码 ---
            const domWidget = this.addDOMWidget("gallery_widget", "div", container);
            if (domWidget) {
                domWidget.value = "";
                domWidget.serialize = false;
            }
            // ------------------------

            this.customUI = container;
            if (typeof ResizeObserver !== 'undefined') {
                this._lastGalleryLayoutWidth = Math.round(container.getBoundingClientRect().width || 0);
                this._galleryResizeObserver = new ResizeObserver(() => {
                    const currentWidth = Math.round(container.getBoundingClientRect().width || 0);
                    const widthChanged = Math.abs(currentWidth - (this._lastGalleryLayoutWidth || 0)) > 2;
                    if (widthChanged) this._lastGalleryLayoutWidth = currentWidth;
                    if (widthChanged && this._viewMode === 'list' && this.galleryAllItems?.length && !this._isLoading) {
                        this.renderPage(false);
                    }
                });
                this._galleryResizeObserver.observe(container);
            }
            this.size = [860, 720];
            this.resizable = true;
        };

        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            origOnConfigure?.apply(this, arguments);

            if (!this.customUI) this.createGalleryUI();
            this.hideInternalWidgets?.();
            this.hideInternalInputs?.();
            this.loadTitleBlacklistFromDisk?.().then(() => {
                if (this._viewMode === "list" && this.galleryAllItems?.length) {
                    this.galleryAllItems = this.filterBlacklistedItems(this.galleryAllItems);
                    this.renderPage(false, { animate: false });
                }
            });
            setTimeout(() => {
                const restored = this.restoreGalleryState?.();
                if (restored && this.galleryAllItems?.length) {
                    if (this._viewMode === 'detail' && this._detailWorkId && this._detailRaw) {
                        this.renderDetailFromRaw(this._detailRaw);
                        this.restoreGalleryScroll?.('detail', this._savedDetailScrollTop || 0);
                    } else {
                        const targetScrollTop = this._savedListScrollTop || this._savedScrollTop || 0;
                        this.renderPage(false);
                        this.restoreGalleryScroll?.('list', targetScrollTop);
                        this.recoverStaleListImages?.();
                    }
                } else if (!this.galleryAllItems?.length) {
                    this.loadGallery(1);
                }
            }, 100);
        };
    }
});
