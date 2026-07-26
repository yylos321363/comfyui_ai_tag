export const sessionNodeCache = new Map();

export function installStateMethods(nodeType) {
    nodeType.prototype.getSessionCache = function () {
        if (this.id === undefined || this.id === null) return null;
        return sessionNodeCache.get(this.id) || null;
    };

    nodeType.prototype.setSessionCache = function (patch = {}) {
        if (this.id === undefined || this.id === null) return;
        const prev = sessionNodeCache.get(this.id) || {};
        sessionNodeCache.set(this.id, { ...prev, ...patch });
    };

    nodeType.prototype.saveGalleryState = function () {
        if (!this.properties) this.properties = {};

        let scrollTop = 0;
        if (this._viewMode === 'detail') {
            scrollTop = this.galleryGrid?.scrollTop || this._savedDetailScrollTop || 0;
        } else {
            scrollTop = this.galleryGrid?.scrollTop || this._savedListScrollTop || this._savedScrollTop || 0;
        }

        this.properties.gallery_state = {
            page: this.galleryPage || 1,
            totalPages: this.galleryTotalPages || 1,
            viewMode: this._viewMode || 'list',
            detailWorkId: this._detailWorkId || null,
            selectedDetailImagePath: this._selectedDetailImage?.image_path || null,
            searchQuery: this.getSearchQueryValue?.() || this.searchInput?.value || '',
            sort: this.sortSelect?.value || 'new',
            timeRange: this.timeSelect?.value || 'all',
            drawEnabled: !!this.drawToggleInput?.checked,
            scrollTop,
            listScrollTop: this._savedListScrollTop || 0,
            detailScrollTop: this._savedDetailScrollTop || 0
        };

        this.properties.draw_enabled = !!this.drawToggleInput?.checked;

        this.setSessionCache({
            items: this.galleryAllItems || [],
            detailRaw: this._detailRaw || null,
            detailImages: this._detailImages || [],
            searchHistory: this._gallerySearchHistory || []
        });
    };

    nodeType.prototype.restoreGalleryState = function () {
        const state = this.properties?.gallery_state;
        const cache = this.getSessionCache();

        if (!state && !cache) return false;

        if (state) {
            this.galleryPage = state.page || 1;
            this.galleryDisplayPage = state.page || 1;
            this.galleryTotalPages = state.totalPages || 1;
            this._viewMode = state.viewMode || 'list';
            this._detailWorkId = state.detailWorkId || null;
            this._savedScrollTop = state.scrollTop || 0;
            this._savedListScrollTop = state.listScrollTop ?? (state.viewMode === 'list' ? (state.scrollTop || 0) : 0);
            this._savedDetailScrollTop = state.detailScrollTop ?? (state.viewMode === 'detail' ? (state.scrollTop || 0) : 0);

            if (this.searchInput) {
                if (this.setSearchQueryValue) {
                    this.setSearchQueryValue(state.searchQuery || '', { save: false });
                } else {
                    this.searchInput.value = state.searchQuery || '';
                    this.updateSearchClearButton?.();
                }
            }
            if (this.sortSelect) this.sortSelect.value = state.sort || 'new';

            this.updateTimeSelect?.();

            if (this.timeSelect) this.timeSelect.value = state.timeRange || 'all';
            if (this.drawToggleInput) {
                this.drawToggleInput.checked = !!(state.drawEnabled ?? this.properties?.draw_enabled);
            }
        }

        if (cache) {
            this.galleryAllItems = this.filterBlacklistedItems?.(cache.items || []) || cache.items || [];
            this._detailRaw = cache.detailRaw || null;
            this._detailImages = cache.detailImages || [];
            this._gallerySearchHistory = Array.isArray(cache.searchHistory) ? cache.searchHistory : [];
        }

        this._selectedDetailImage = null;
        if (state?.selectedDetailImagePath && this._detailImages?.length) {
            this._selectedDetailImage = this._detailImages.find(
                img => img.image_path === state.selectedDetailImagePath
            ) || null;
        }

        this.syncDrawInputs?.();
        this.renderSearchTerms?.();
        this.syncSearchHistoryButton?.();
        this.syncPageControls?.();

        return true;
    };
}
