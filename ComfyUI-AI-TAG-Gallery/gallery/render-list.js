import { buildAssetUrl, fetchWorkDetail, normalizeAssetPath } from "./api.js";
import { getTypeColor } from "./utils.js";

const CARD_IMAGE_LOAD_TIMEOUT_MS = 30000;
const CARD_IMAGE_RETRY_MS = 3500;
const CARD_IMAGE_MAX_RETRIES = 3;
const FIRST_SCREEN_EAGER_ROWS = 4;
const VISIBLE_IMAGE_PRELOAD_MARGIN = 1500;
const LIST_IMAGE_PRIORITY_THROTTLE_MS = 120;
const IMAGE_COUNT_MAX_CONCURRENT = 2;
const IMAGE_COUNT_IDLE_TIMEOUT_MS = 1800;

function getFallbackPath(item) {
    return `${item.AI_type || "SD"}/${item.userId}/${item.id}_p0.webp`;
}

function hideAllHoverPreviews(node) {
    node._activeListPreviewToken = null;
    node._activeDetailPreviewToken = null;
    if (node._listHoverPreview) {
        node._listHoverPreview.style.display = "none";
    }
    if (node._detailHoverPreview) {
        node._detailHoverPreview.style.display = "none";
    }
}

function ensureListHoverPreview(node) {
    if (node._listHoverPreview) return;

    node._listHoverPreview = document.createElement("div");
    node._listHoverPreview.style.cssText = `
        position: fixed;
        z-index: 999999;
        pointer-events: none;
        display: none;
        width: 320px;
        height: 240px;
        border-radius: 12px;
        overflow: hidden;
        background: rgba(20,20,30,0.96);
        border: 1px solid rgba(102,126,234,0.45);
        box-shadow: 0 18px 50px rgba(0,0,0,0.45);
        backdrop-filter: blur(6px);
        padding: 0;
    `;

    const previewImg = document.createElement("img");
    previewImg.style.cssText = `
        width: 100%;
        height: 100%;
        display: block;
        object-fit: contain;
        object-position: center;
        background: #111;
    `;

    node._listHoverPreviewImg = previewImg;
    node._listHoverPreview.appendChild(previewImg);
    document.body.appendChild(node._listHoverPreview);
}

function setPreviewBoxSize(node, src, done) {
    const temp = new Image();
    temp.onload = () => {
        const w = temp.naturalWidth || 1;
        const h = temp.naturalHeight || 1;
        const ratio = w / h;

        let boxW = 380;
        let boxH = 380;

        if (ratio >= 1.35) {
            boxW = 460;
            boxH = Math.round(boxW / ratio);
        } else if (ratio > 1.0) {
            boxW = 420;
            boxH = Math.round(boxW / ratio);
        } else if (ratio > 0.75) {
            boxH = 420;
            boxW = Math.round(boxH * ratio);
        } else {
            boxH = 460;
            boxW = Math.round(boxH * ratio);
        }

        boxW = Math.max(180, Math.min(boxW, 520));
        boxH = Math.max(180, Math.min(boxH, 520));

        if (node._listHoverPreview) {
            node._listHoverPreview.style.width = `${boxW}px`;
            node._listHoverPreview.style.height = `${boxH}px`;
        }

        done?.();
    };
    temp.onerror = () => {
        if (node._listHoverPreview) {
            node._listHoverPreview.style.width = "320px";
            node._listHoverPreview.style.height = "320px";
        }
        done?.();
    };
    temp.src = src;
}

function moveListPreview(node, e) {
    if (!node._listHoverPreview || node._listHoverPreview.style.display === "none") return;

    const rect = node._listHoverPreview.getBoundingClientRect();
    const previewW = rect.width || 320;
    const previewH = rect.height || 320;
    const offset = 18;

    let left = e.clientX + offset;
    let top = e.clientY + offset;

    if (left + previewW > window.innerWidth - 8) {
        left = e.clientX - previewW - offset;
    }
    if (top + previewH > window.innerHeight - 8) {
        top = window.innerHeight - previewH - 8;
    }
    if (top < 8) top = 8;
    if (left < 8) left = 8;

    node._listHoverPreview.style.left = `${left}px`;
    node._listHoverPreview.style.top = `${top}px`;
}

function showListPreview(node, src, e) {
    ensureListHoverPreview(node);
    if (!node._listHoverPreview || !node._listHoverPreviewImg) return;

    const token = Symbol("list-preview");
    node._activeListPreviewToken = token;

    setPreviewBoxSize(node, src, () => {
        if (node._activeListPreviewToken !== token || node._viewMode !== "list") return;
        node._listHoverPreviewImg.src = src;
        node._listHoverPreview.style.display = "block";
        moveListPreview(node, e);
    });
}

function hideListPreview(node) {
    node._activeListPreviewToken = null;
    if (node._listHoverPreview) {
        node._listHoverPreview.style.display = "none";
    }
}

function getStableColumnCount(node) {
    const gridWidth = Math.max(1, (node.galleryGrid?.clientWidth || node.size?.[0] || 860) - 16);
    const gap = 6;
    const minCardWidth = 150;
    return Math.max(1, Math.floor((gridWidth + gap) / (minCardWidth + gap)));
}

function getGalleryRootRect(node) {
    const root = node?.galleryGrid;
    if (root?.getBoundingClientRect) return root.getBoundingClientRect();
    return {
        top: 0,
        left: 0,
        right: window.innerWidth || 0,
        bottom: window.innerHeight || 0
    };
}

function isCardNearViewport(node, card, margin = 1200) {
    if (!card?.getBoundingClientRect) return true;
    const rect = card.getBoundingClientRect();
    const rootRect = getGalleryRootRect(node);
    return (
        rect.bottom >= rootRect.top - margin
        && rect.top <= rootRect.bottom + margin
        && rect.right >= rootRect.left - margin
        && rect.left <= rootRect.right + margin
    );
}

function stripGalleryRetryParam(src) {
    if (!src) return "";
    try {
        const url = new URL(src, window.location.href);
        url.searchParams.delete("_gallery_retry");
        return url.href;
    } catch (_) {
        return src;
    }
}

function withGalleryRetryParam(src, retryCount) {
    if (!src) return "";
    try {
        const url = new URL(src, window.location.href);
        url.searchParams.set("_gallery_retry", `${retryCount}_${Date.now()}`);
        return url.href;
    } catch (_) {
        const sep = src.includes("?") ? "&" : "?";
        return `${src}${sep}_gallery_retry=${retryCount}_${Date.now()}`;
    }
}

function getCardImageSource(img) {
    return img?.dataset?.originalSrc || img?.dataset?.src || img?.currentSrc || img?.src || "";
}

function scheduleImageCountPump(node) {
    if (!node || node._imageCountPumpScheduled) return;
    node._imageCountPumpScheduled = true;

    const run = () => {
        node._imageCountPumpScheduled = false;
        pumpImageCountQueue(node);
    };

    if (typeof requestIdleCallback === "function") {
        requestIdleCallback(run, { timeout: IMAGE_COUNT_IDLE_TIMEOUT_MS });
    } else {
        setTimeout(run, Math.min(800, IMAGE_COUNT_IDLE_TIMEOUT_MS));
    }
}

function parsePositiveCount(value) {
    const count = Number(value);
    return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function getItemImageCount(item) {
    const directCount =
        parsePositiveCount(item?.image_count)
        || parsePositiveCount(item?.imageCount)
        || parsePositiveCount(item?.images_count)
        || parsePositiveCount(item?.image_num)
        || parsePositiveCount(item?.page_count);
    if (directCount) return directCount;

    if (Array.isArray(item?.images) && item.images.length > 0) {
        return item.images.length;
    }

    return 1;
}

function isItemImageCountKnown(item) {
    if (!item || typeof item !== "object") return true;
    if (item.image_count_known === true || item.imageCountKnown === true) return true;
    if (Array.isArray(item.images)) return true;

    return (
        parsePositiveCount(item.imageCount) > 0
        || parsePositiveCount(item.images_count) > 0
        || parsePositiveCount(item.image_num) > 0
        || parsePositiveCount(item.page_count) > 0
        || parsePositiveCount(item.image_count) > 1
    );
}

function createImageCountBadge(count) {
    const badge = document.createElement("div");
    badge.setAttribute("data-role", "image-count-badge");
    badge.textContent = `${parsePositiveCount(count) || 1}`;
    badge.style.cssText = `
        position:absolute;
        top:10px;
        left:10px;
        background:#667eea;
        color:white;
        min-width:20px;
        box-sizing:border-box;
        padding:3px 9px;
        border-radius:9999px;
        font-size:10px;
        font-weight:700;
        text-align:center;
        z-index:5;
    `;
    return badge;
}

function createBlacklistButton(node, item) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "🚫";
    button.title = "加入黑名单";
    button.setAttribute("aria-label", "加入黑名单");
    button.style.cssText = `
        position:absolute;
        top:10px;
        right:10px;
        z-index:7;
        width:28px;
        height:28px;
        display:flex;
        align-items:center;
        justify-content:center;
        border-radius:999px;
        border:1px solid rgba(248,113,113,0.46);
        background:rgba(24,24,30,0.78);
        color:#fecaca;
        cursor:pointer;
        font-size:13px;
        line-height:1;
        opacity:0;
        transform:translateY(-2px);
        transition:opacity 0.16s ease, transform 0.16s ease, background 0.16s ease;
        box-shadow:0 8px 18px rgba(0,0,0,0.26);
    `;
    button.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        hideAllHoverPreviews(node);
        if (node.addItemToBlacklist) {
            node.addItemToBlacklist(item);
        } else {
            node.addTitleToBlacklist?.(item?.title || "", item?.userId || "");
        }
    };
    button.onmouseenter = () => {
        button.style.background = "rgba(127,29,29,0.86)";
    };
    button.onmouseleave = () => {
        button.style.background = "rgba(24,24,30,0.78)";
    };
    return button;
}

function updateCardBadge(card, count) {
    const badge = card.querySelector('[data-role="image-count-badge"]');
    const normalizedCount = parsePositiveCount(count) || 1;
    if (badge) {
        badge.textContent = `${normalizedCount}`;
    } else {
        card.appendChild(createImageCountBadge(normalizedCount));
    }
}

function applyDetailImageCount(item, detail, card) {
    const images = Array.isArray(detail?.images) ? detail.images : [];
    const selectedImage = images.find((entry) => entry?.image_path) || images[0];
    const recoveredPath = normalizeAssetPath(selectedImage?.image_path || "");
    const count = images.length || getItemImageCount(item);

    item.image_count = count;
    item.image_count_known = true;
    if (recoveredPath && !normalizeAssetPath(item.cover_image_path || "")) {
        item.cover_image_path = recoveredPath;
    }

    updateCardBadge(card, count);
}

function pumpImageCountQueue(node) {
    if (!node?._imageCountResolutionQueue) return;
    node._activeImageCountResolutions = node._activeImageCountResolutions || 0;

    while (
        node._activeImageCountResolutions < IMAGE_COUNT_MAX_CONCURRENT
        && node._imageCountResolutionQueue.length
    ) {
        const entry = node._imageCountResolutionQueue.shift();
        if (!entry?.item?.id) continue;
        if (isItemImageCountKnown(entry.item)) {
            updateCardBadge(entry.card, getItemImageCount(entry.item));
            continue;
        }

        node._activeImageCountResolutions += 1;
        fetchWorkDetail(entry.item.id)
            .then((detail) => {
                applyDetailImageCount(entry.item, detail, entry.card);
                if (Array.isArray(node.galleryAllItems) && node.galleryAllItems.includes(entry.item)) {
                    node.setSessionCache?.({ items: node.galleryAllItems });
                }
            })
            .catch((error) => {
                console.warn("[Gallery] image count lookup failed", entry.item?.id, error);
            })
            .finally(() => {
                node._activeImageCountResolutions = Math.max(0, (node._activeImageCountResolutions || 1) - 1);
                pumpImageCountQueue(node);
            });
    }
}

function enqueueImageCountResolution(node, item, card) {
    if (!item?.id) return;
    if (isItemImageCountKnown(item)) {
        updateCardBadge(card, getItemImageCount(item));
        return;
    }

    node._imageCountResolutionQueue = node._imageCountResolutionQueue || [];
    node._imageCountResolutionQueue.push({ item, card });
    scheduleImageCountPump(node);
}

async function recoverListCardImage(node, item, img, card) {
    if (!item?.id || img.dataset.recovered === "1") return false;
    img.dataset.recovered = "1";

    try {
        const detail = await fetchWorkDetail(item.id);
        const images = Array.isArray(detail?.images) ? detail.images : [];
        const selectedImage = images.find((entry) => entry?.image_path) || images[0];
        const recoveredPath = normalizeAssetPath(selectedImage?.image_path || "");
        if (!recoveredPath) {
            card.classList.remove("is-loading");
            return false;
        }

        item.cover_image_path = recoveredPath;
        item.image_count = images.length || item.image_count || 1;
        item.image_count_known = true;
        updateCardBadge(card, item.image_count || 1);

        img.style.opacity = "0";
        card.classList.add("is-loading");
        bindCardImage(node, item, img, card, buildAssetUrl(recoveredPath));
        return true;
    } catch (error) {
        console.warn("[Gallery] list card image recovery failed", item?.id, error);
        card.classList.remove("is-loading");
        return false;
    }
}

function finalizeCardImageLoad(img, card, token = img._galleryLoadToken) {
    if (token && img._galleryLoadToken !== token) return;
    if (img._galleryLoadTimeout) {
        clearTimeout(img._galleryLoadTimeout);
        img._galleryLoadTimeout = null;
    }
    if (img._galleryRetryTimer) {
        clearTimeout(img._galleryRetryTimer);
        img._galleryRetryTimer = null;
    }
    card.classList.remove("is-loading");
    card.classList.remove("is-load-failed");
    img.style.opacity = "1";
    const overlay = card.querySelector('[data-role="loading-overlay"]');
    if (overlay) overlay.style.display = "none";
}

function finalizeCardImageFailure(img, card, token = img._galleryLoadToken) {
    if (token && img._galleryLoadToken !== token) return;
    if (img._galleryLoadTimeout) {
        clearTimeout(img._galleryLoadTimeout);
        img._galleryLoadTimeout = null;
    }
    if (img._galleryRetryTimer) {
        clearTimeout(img._galleryRetryTimer);
        img._galleryRetryTimer = null;
    }
    card.classList.remove("is-loading");
    card.classList.add("is-load-failed");
    img.style.opacity = "0.22";
    const overlay = card.querySelector('[data-role="loading-overlay"]');
    if (overlay) overlay.style.display = "none";
}

function scheduleCardImageRetry(node, item, img, card, token) {
    if (img._galleryLoadToken !== token) return false;
    const originalSrc = getCardImageSource(img);
    const retryCount = Number(img.dataset.retryCount || 0);
    if (!originalSrc || retryCount >= CARD_IMAGE_MAX_RETRIES) return false;

    if (img._galleryLoadTimeout) {
        clearTimeout(img._galleryLoadTimeout);
        img._galleryLoadTimeout = null;
    }

    const nextRetryCount = retryCount + 1;
    img.dataset.retryCount = String(nextRetryCount);
    img.style.opacity = "0";
    card.classList.add("is-loading");
    card.classList.remove("is-load-failed");

    const overlay = card.querySelector('[data-role="loading-overlay"]');
    if (overlay) overlay.style.display = "";

    if (img._galleryRetryTimer) {
        clearTimeout(img._galleryRetryTimer);
        img._galleryRetryTimer = null;
    }

    img._galleryRetryTimer = setTimeout(() => {
        img._galleryRetryTimer = null;
        if (img._galleryLoadToken !== token || !card.isConnected) return;
        bindCardImage(
            node,
            item || card._galleryItem || img._galleryItem || null,
            img,
            card,
            withGalleryRetryParam(originalSrc, nextRetryCount),
            { originalSrc }
        );
    }, CARD_IMAGE_RETRY_MS);

    return true;
}

function bindCardImage(node, item, img, card, src, options = {}) {
    if (img._galleryLoadTimeout) {
        clearTimeout(img._galleryLoadTimeout);
        img._galleryLoadTimeout = null;
    }
    if (img._galleryRetryTimer) {
        clearTimeout(img._galleryRetryTimer);
        img._galleryRetryTimer = null;
    }

    const originalSrc = stripGalleryRetryParam(options.originalSrc || src);
    if (!originalSrc) {
        finalizeCardImageFailure(img, card);
        return;
    }
    if (img.dataset.originalSrc !== originalSrc) {
        img.dataset.retryCount = "0";
    }
    img.dataset.originalSrc = originalSrc;
    img.dataset.src = originalSrc;
    img._galleryItem = item || card._galleryItem || null;

    const overlay = card.querySelector('[data-role="loading-overlay"]');
    if (overlay) overlay.style.display = "";
    card.classList.add("is-loading");
    card.classList.remove("is-load-failed");

    const token = Symbol("gallery-card-image-load");
    img._galleryLoadToken = token;
    img.dataset.loadStartedAt = String(Date.now());
    img.dataset.retryCount = img.dataset.retryCount || "0";

    img.onload = () => finalizeCardImageLoad(img, card, token);
    img.onerror = async () => {
        if (img._galleryLoadToken !== token) return;
        const recovered = await recoverListCardImage(node, item || card._galleryItem || null, img, card);
        if (img._galleryLoadToken !== token) return;
        if (recovered) return;
        if (scheduleCardImageRetry(node, item, img, card, token)) return;
        finalizeCardImageFailure(img, card, token);
    };
    img.src = src;
    img._galleryLoadTimeout = setTimeout(() => {
        if (img._galleryLoadToken !== token) return;
        if (!img.complete || img.naturalWidth <= 0) {
            if (!isCardNearViewport(node, card)) return;
            if (scheduleCardImageRetry(node, item, img, card, token)) return;
            finalizeCardImageFailure(img, card, token);
        }
    }, CARD_IMAGE_LOAD_TIMEOUT_MS);

    if (img.complete) {
        if (img.naturalWidth > 0) {
            finalizeCardImageLoad(img, card, token);
        } else {
            img.onerror?.();
        }
    }
}

export function recoverStaleListImages() {
    if (!this._galleryGridContainer || this._viewMode === "detail") return;

    const now = Date.now();
    this._galleryGridContainer.querySelectorAll("[data-image-id].is-loading").forEach((card) => {
        const img = card.querySelector("img");
        if (!img) {
            card.classList.remove("is-loading");
            return;
        }

        if (img.complete) {
            if (img.naturalWidth > 0) {
                finalizeCardImageLoad(img, card);
            } else {
                const token = img._galleryLoadToken;
                if (!scheduleCardImageRetry(this, card._galleryItem || img._galleryItem || null, img, card, token)) {
                    finalizeCardImageFailure(img, card);
                }
            }
            return;
        }

        const startedAt = Number(img.dataset.loadStartedAt || 0);
        const retryCount = Number(img.dataset.retryCount || 0);
        if (!startedAt || now - startedAt < CARD_IMAGE_RETRY_MS) return;
        if (retryCount >= CARD_IMAGE_MAX_RETRIES) {
            if (now - startedAt >= CARD_IMAGE_LOAD_TIMEOUT_MS && isCardNearViewport(this, card)) {
                finalizeCardImageFailure(img, card);
            }
            return;
        }
        if (!isCardNearViewport(this, card)) return;

        const src = getCardImageSource(img);
        if (!src) {
            finalizeCardImageFailure(img, card);
            return;
        }

        scheduleCardImageRetry(this, card._galleryItem || img._galleryItem || null, img, card, img._galleryLoadToken);
    });
}

export function prioritizeVisibleListImages() {
    if (!this._galleryGridContainer || this._viewMode === "detail") return;

    this._galleryGridContainer.querySelectorAll("[data-image-id].is-loading").forEach((card) => {
        if (!isCardNearViewport(this, card, VISIBLE_IMAGE_PRELOAD_MARGIN)) return;
        const img = card.querySelector("img");
        const src = getCardImageSource(img);
        if (!img || !src || img.complete) return;
        if (img.loading !== "eager") {
            img.loading = "eager";
            bindCardImage(this, card._galleryItem || img._galleryItem || null, img, card, src);
        }
    });
}

function schedulePrioritizeVisibleListImages(node) {
    if (!node || node._listImagePriorityScheduled) return;
    node._listImagePriorityScheduled = true;

    setTimeout(() => {
        node._listImagePriorityScheduled = false;
        node.prioritizeVisibleListImages?.();
    }, LIST_IMAGE_PRIORITY_THROTTLE_MS);
}

function installListImagePriorityListeners(node) {
    const target = node?.galleryGrid;
    if (!target) return;
    if (node._listImagePriorityScrollTarget === target && node._listImagePriorityScrollHandler) return;

    if (node._listImagePriorityScrollTarget && node._listImagePriorityScrollHandler) {
        node._listImagePriorityScrollTarget.removeEventListener("scroll", node._listImagePriorityScrollHandler);
    }

    const handler = () => schedulePrioritizeVisibleListImages(node);
    target.addEventListener("scroll", handler, { passive: true });
    node._listImagePriorityScrollTarget = target;
    node._listImagePriorityScrollHandler = handler;
}

function scheduleListImageRecovery(node) {
    requestAnimationFrame(() => {
        node.prioritizeVisibleListImages?.();
        node.recoverStaleListImages?.();
        setTimeout(() => node.prioritizeVisibleListImages?.(), 180);
        setTimeout(() => node.prioritizeVisibleListImages?.(), 700);
        setTimeout(() => node.recoverStaleListImages?.(), CARD_IMAGE_RETRY_MS);
        setTimeout(() => node.recoverStaleListImages?.(), CARD_IMAGE_LOAD_TIMEOUT_MS + 250);
    });
}

function createListCard(node, item, index = 0, columnCount = 1) {
    const fallbackPath = getFallbackPath(item);
    const imgUrl = buildAssetUrl(item.cover_image_path || fallbackPath);
    const realImageCount = getItemImageCount(item);
    const currentType = item.AI_type || "Unknown";

    const card = document.createElement("div");
    card._galleryItem = item;
    card.setAttribute("data-image-id", item.id);
    card.setAttribute("data-gallery-page", String(item._galleryPage || node.galleryDisplayPage || node.galleryPage || 1));
    card.style.cssText = `
        position: relative;
        width: 100%;
        min-width: 0;
        background: #1a1a2e;
        border-radius: 10px;
        overflow: hidden;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        cursor: pointer;
        transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
        aspect-ratio: 3 / 4;
    `;

    const loadingOverlay = document.createElement("div");
    loadingOverlay.setAttribute("data-role", "loading-overlay");
    loadingOverlay.style.cssText = `
        position:absolute;
        inset:0;
        background:
            linear-gradient(110deg, rgba(255,255,255,0.04) 8%, rgba(255,255,255,0.16) 18%, rgba(255,255,255,0.04) 33%),
            linear-gradient(180deg, #23273a 0%, #1c2030 100%);
        background-size: 200% 100%, 100% 100%;
        animation: gallery-card-shimmer 1.15s linear infinite;
        z-index:1;
        pointer-events:none;
        opacity:0;
        transition: opacity 0.18s ease;
    `;

    const img = document.createElement("img");
    const shouldLoadImmediately = index < Math.max(columnCount * FIRST_SCREEN_EAGER_ROWS, columnCount);
    img.loading = shouldLoadImmediately ? "eager" : "lazy";
    img.decoding = "async";
    img.style.cssText = `
        width:100%;
        height:100%;
        display:block;
        object-fit:cover;
        object-position:center;
        border-radius:10px;
        transition: transform 0.3s ease;
        background:transparent;
        opacity:0;
        transition: opacity 0.22s ease, transform 0.3s ease;
        color:transparent;
    `;
    bindCardImage(node, item, img, card, imgUrl);

    updateCardBadge(card, realImageCount);
    enqueueImageCountResolution(node, item, card);
    const blacklistButton = createBlacklistButton(node, item);

    const infoBar = document.createElement("div");
    infoBar.style.cssText = `
        position:absolute;
        bottom:0;
        left:0;
        right:0;
        background:linear-gradient(transparent, rgba(0,0,0,0.9));
        color:white;
        font-size:10px;
        padding:16px 10px 8px;
        z-index:4;
    `;
    infoBar.innerHTML = `
        <div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:500;">${(item.title || "Untitled").substring(0, 22)}</div>
        <div style="display:flex;justify-content:space-between;margin-top:4px;align-items:center;">
            <span style="opacity:0.9;">View ${item.total_view || 0} Fav ${item.total_bookmarks || 0}</span>
            <span style="background:${getTypeColor(currentType)};padding:2px 6px;border-radius:4px;font-weight:bold;font-size:9px;">${currentType}</span>
        </div>
    `;

    card.onmouseenter = (e) => {
        card.style.transform = "scale(1.04)";
        card.style.boxShadow = "0 16px 32px rgba(0,0,0,0.45)";
        img.style.transform = "scale(1.08)";
        blacklistButton.style.opacity = "1";
        blacklistButton.style.transform = "translateY(0)";
        const previewSrc = getCardImageSource(img);
        if (previewSrc && (card.classList.contains("is-load-failed") || (card.classList.contains("is-loading") && !img.complete))) {
            img.dataset.retryCount = "0";
            img.loading = "eager";
            bindCardImage(node, item, img, card, previewSrc);
        }
        if (previewSrc) showListPreview(node, previewSrc, e);
    };

    card.onmousemove = (e) => {
        moveListPreview(node, e);
    };

    card.onmouseleave = () => {
        card.style.transform = "";
        card.style.boxShadow = "0 4px 12px rgba(0,0,0,0.3)";
        img.style.transform = "";
        blacklistButton.style.opacity = "0";
        blacklistButton.style.transform = "translateY(-2px)";
        hideListPreview(node);
    };

    card.onclick = () => {
        hideAllHoverPreviews(node);
        node.showDetailView(item.id);
    };

    card.append(loadingOverlay, img, infoBar, blacklistButton);
    return card;
}

export function appendListItems(items = []) {
    if (!this._galleryGridContainer || this._viewMode === "detail") return;
    const visibleItems = this.filterBlacklistedItems?.(items) || items;
    const fragment = document.createDocumentFragment();
    const columnCount = getStableColumnCount(this);
    visibleItems.forEach((item, index) => {
        fragment.appendChild(createListCard(this, item, index, columnCount));
    });
    this._galleryGridContainer.appendChild(fragment);
    this.syncVisibleGalleryPageFromScroll?.();
    scheduleListImageRecovery(this);
}

export function renderPage(scrollToTop = false, options = {}) {
    if (!this.galleryGrid || this._viewMode === "detail") return;

    hideAllHoverPreviews(this);
    this.clearListDomCache?.();
    this.galleryGrid.style.padding = "";
    this.galleryGrid.style.boxSizing = "";

    const items = this.filterBlacklistedItems?.(this.galleryAllItems) || this.galleryAllItems;
    this.syncPageControls?.();

    if (!items || items.length === 0) {
        this.galleryGrid.innerHTML = `
            <div class="gallery-centered-state">
                <div style="color:grey;">No images found</div>
            </div>
        `;
        return;
    }

    this.galleryGrid.innerHTML = "";
    if (scrollToTop) this.galleryGrid.scrollTop = 0;

    const gridWrapper = document.createElement("div");
    gridWrapper.style.cssText = "width:100%; padding:3px; box-sizing:border-box;";

    const gridContainer = document.createElement("div");
    this._galleryGridContainer = gridContainer;
    gridContainer.setAttribute("data-gallery-list-container", "1");
    const columnCount = getStableColumnCount(this);
    gridContainer.style.cssText = `
        display: grid;
        grid-template-columns: repeat(${columnCount}, minmax(0, 1fr));
        gap: 6px;
        width: 100%;
        justify-content: start;
        align-content: start;
        box-sizing: border-box;
    `;

    {
        const style = document.getElementById("gallery-card-loading-style") || document.createElement("style");
        style.id = "gallery-card-loading-style";
        style.textContent = `
            @keyframes gallery-card-shimmer {
                0% { background-position: 200% 0, 0 0; }
                100% { background-position: -200% 0, 0 0; }
            }
            [data-image-id] [data-role="loading-overlay"] {
                opacity: 0;
                transition: opacity 0.18s ease;
            }
            [data-image-id].is-loading [data-role="loading-overlay"] {
                opacity: 1;
            }
        `;
        if (!style.parentNode) document.head.appendChild(style);
    }

    const fragment = document.createDocumentFragment();
    items.forEach((item, index) => {
        fragment.appendChild(createListCard(this, item, index, columnCount));
    });
    gridContainer.appendChild(fragment);

    gridWrapper.appendChild(gridContainer);
    this.galleryGrid.appendChild(gridWrapper);
    installListImagePriorityListeners(this);

    if (options.animate !== false) {
        this.galleryGrid.classList.remove("gallery-fade-in");
        void this.galleryGrid.offsetWidth;
        this.galleryGrid.classList.add("gallery-fade-in");
    } else {
        this.galleryGrid.classList.remove("gallery-fade-in");
    }

    this.galleryGrid.onmouseleave = () => hideAllHoverPreviews(this);
    this.galleryGrid.onblur = () => hideAllHoverPreviews(this);
    this.syncVisibleGalleryPageFromScroll?.();
    scheduleListImageRecovery(this);
}
