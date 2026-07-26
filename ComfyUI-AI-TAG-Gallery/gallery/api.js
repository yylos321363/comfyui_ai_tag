let siteConfig = null;
let assetBaseUrl = "https://ai-img.10118899.xyz/";
const workDetailCache = {};
const galleryPageCache = {};
const pendingWorkDetailRequests = {};
const pendingGalleryPageRequests = {};
let pendingSiteConfigRequest = null;
const GALLERY_PAGE_CACHE_TTL = 60 * 1000;

function getGalleryPageCacheKey({ page, sort, timeRange, searchQuery }) {
    return JSON.stringify({
        page: Number(page) || 1,
        sort: sort || "new",
        timeRange: timeRange || "all",
        searchQuery: searchQuery || "",
    });
}

export function getAssetBaseUrl() {
    return assetBaseUrl;
}

export function normalizeAssetPath(imagePath) {
    let path = String(imagePath || "").trim().replace(/\\/g, "/");
    if (!path) return "";

    try {
        const url = new URL(path);
        path = url.pathname || "";
    } catch (_) {
        // Relative paths are expected from the gallery API.
    }

    path = path.replace(/^\/+/, "");
    const marker = "www/pixiv_ai_tag/";
    const markerIndex = path.indexOf(marker);
    if (markerIndex >= 0) {
        path = path.slice(markerIndex + marker.length);
    } else if (path.startsWith("pixiv_ai_tag/")) {
        path = path.slice("pixiv_ai_tag/".length);
    }

    return path.replace(/^\/+/, "");
}

export function buildAssetUrl(imagePath) {
    return `${getAssetBaseUrl()}${normalizeAssetPath(imagePath)}`;
}

export async function fetchSiteConfig() {
    if (siteConfig) return siteConfig;
    if (pendingSiteConfigRequest) return pendingSiteConfigRequest;

    pendingSiteConfigRequest = fetch('/gallery/api/config')
        .then((response) => response.json())
        .then((data) => {
            siteConfig = data;
            assetBaseUrl = data.asset_base_url || "https://ai-img.10118899.xyz/";
            return data;
        })
        .finally(() => {
            pendingSiteConfigRequest = null;
        });

    return pendingSiteConfigRequest;
}

export async function fetchGalleryPage({ page, sort, timeRange, searchQuery }) {
    const effectiveSort = searchQuery ? 'new' : sort;
    const cacheKey = getGalleryPageCacheKey({ page, sort: effectiveSort, timeRange, searchQuery });
    const cached = galleryPageCache[cacheKey];
    if (cached && (Date.now() - cached.ts) < GALLERY_PAGE_CACHE_TTL) {
        return cached.data;
    }
    if (pendingGalleryPageRequests[cacheKey]) {
        return pendingGalleryPageRequests[cacheKey];
    }

    let apiUrl = `/gallery/api/proxy?page=${page}&page_size=60&sort=${effectiveSort}&time_range=${timeRange}`;
    if (effectiveSort !== 'monthly' && searchQuery) {
        apiUrl += `&q=${encodeURIComponent(searchQuery)}`;
    }

    pendingGalleryPageRequests[cacheKey] = fetch(apiUrl)
        .then((response) => response.json())
        .then((data) => {
            galleryPageCache[cacheKey] = {
                ts: Date.now(),
                data,
            };
            return data;
        })
        .finally(() => {
            delete pendingGalleryPageRequests[cacheKey];
        });

    return pendingGalleryPageRequests[cacheKey];
}

export function clearGalleryPageCache({ page, sort, timeRange, searchQuery } = {}) {
    if (page == null && sort == null && timeRange == null && searchQuery == null) {
        Object.keys(galleryPageCache).forEach((key) => delete galleryPageCache[key]);
        Object.keys(pendingGalleryPageRequests).forEach((key) => delete pendingGalleryPageRequests[key]);
        return;
    }

    const effectiveSort = searchQuery ? "new" : (sort || "new");
    const cacheKey = getGalleryPageCacheKey({ page, sort: effectiveSort, timeRange, searchQuery });
    delete galleryPageCache[cacheKey];
    delete pendingGalleryPageRequests[cacheKey];
}

export async function fetchWorkDetail(workId) {
    if (workDetailCache[workId]) return workDetailCache[workId];
    if (pendingWorkDetailRequests[workId]) return pendingWorkDetailRequests[workId];

    pendingWorkDetailRequests[workId] = fetch(`/gallery/api/work/${workId}`)
        .then((response) => response.json())
        .then((data) => {
            workDetailCache[workId] = data;
            return data;
        })
        .finally(() => {
            delete pendingWorkDetailRequests[workId];
        });

    return pendingWorkDetailRequests[workId];
}

export async function fetchTitleBlacklist() {
    const response = await fetch("/gallery/api/title-blacklist");
    if (!response.ok) throw new Error(`Failed to load title blacklist: ${response.status}`);
    const data = await response.json();
    return Array.isArray(data?.items) ? data.items : [];
}

export async function saveTitleBlacklist(items = []) {
    const response = await fetch("/gallery/api/title-blacklist", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ items }),
    });
    if (!response.ok) throw new Error(`Failed to save title blacklist: ${response.status}`);
    const data = await response.json();
    return Array.isArray(data?.items) ? data.items : [];
}
