import { app } from "/scripts/app.js";
import { buildAssetUrl, normalizeAssetPath } from "./api.js";
import { getTypeColor, formatDate, escapeHtml, extractTagText } from "./utils.js";

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

export function performSearch(node, searchTerm) {
    if (!searchTerm || searchTerm.trim() === "") return;
    if (node.addSearchTerm) {
        node.addSearchTerm(searchTerm, { search: true });
        return;
    }
    if (node.searchInput) {
        hideAllHoverPreviews(node);
        node.searchInput.value = searchTerm.trim();
        node.updateSearchClearButton?.();
        if (node.sortSelect && node.sortSelect.value !== "new") {
            node.sortSelect.value = "new";
            node.updateTimeSelect?.();
        }
        node.saveGalleryState?.();
        node.loadGallery(1);
    }
}

function ensureDetailHoverPreview(node) {
    if (node._detailHoverPreview) return;

    const preview = document.createElement("div");
    preview.style.cssText = `
        position: fixed;
        z-index: 999999;
        pointer-events: none;
        display: none;
        width: 340px;
        height: 260px;
        border-radius: 18px;
        overflow: hidden;
        background:
            linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.02)),
            rgba(18,20,30,0.96);
        border: 1px solid rgba(122, 138, 255, 0.35);
        box-shadow:
            0 24px 60px rgba(0,0,0,0.45),
            0 8px 18px rgba(0,0,0,0.22),
            inset 0 1px 0 rgba(255,255,255,0.06);
        backdrop-filter: blur(10px);
    `;

    const img = document.createElement("img");
    img.style.cssText = `
        width: 100%;
        height: 100%;
        display: block;
        object-fit: contain;
        object-position: center;
        background:
            radial-gradient(circle at center, rgba(60,66,120,0.20), rgba(10,10,16,0.95));
    `;

    preview.appendChild(img);
    node._detailHoverPreview = preview;
    node._detailHoverPreviewImg = img;
    document.body.appendChild(preview);
}

function setPreviewBoxSize(node, src, done) {
    const temp = new Image();
    temp.onload = () => {
        const w = temp.naturalWidth || 1;
        const h = temp.naturalHeight || 1;
        const ratio = w / h;

        let boxW = 400;
        let boxH = 400;

        if (ratio >= 1.4) {
            boxW = 500;
            boxH = Math.round(boxW / ratio);
        } else if (ratio > 1.0) {
            boxW = 450;
            boxH = Math.round(boxW / ratio);
        } else if (ratio > 0.75) {
            boxH = 440;
            boxW = Math.round(boxH * ratio);
        } else {
            boxH = 500;
            boxW = Math.round(boxH * ratio);
        }

        boxW = Math.max(180, Math.min(boxW, 560));
        boxH = Math.max(180, Math.min(boxH, 560));

        if (node._detailHoverPreview) {
            node._detailHoverPreview.style.width = `${boxW}px`;
            node._detailHoverPreview.style.height = `${boxH}px`;
        }

        done?.();
    };
    temp.onerror = () => {
        if (node._detailHoverPreview) {
            node._detailHoverPreview.style.width = "340px";
            node._detailHoverPreview.style.height = "260px";
        }
        done?.();
    };
    temp.src = src;
}

function moveDetailPreview(node, e) {
    if (!node._detailHoverPreview || node._detailHoverPreview.style.display === "none") return;

    const rect = node._detailHoverPreview.getBoundingClientRect();
    const previewW = rect.width || 340;
    const previewH = rect.height || 260;
    const offset = 20;

    let left = e.clientX + offset;
    let top = e.clientY + offset;

    if (left + previewW > window.innerWidth - 10) {
        left = e.clientX - previewW - offset;
    }
    if (top + previewH > window.innerHeight - 10) {
        top = window.innerHeight - previewH - 10;
    }

    if (top < 10) top = 10;
    if (left < 10) left = 10;

    node._detailHoverPreview.style.left = `${left}px`;
    node._detailHoverPreview.style.top = `${top}px`;
}

function showDetailPreview(node, src, e) {
    ensureDetailHoverPreview(node);
    if (!node._detailHoverPreview || !node._detailHoverPreviewImg) return;

    const token = Symbol("detail-preview");
    node._activeDetailPreviewToken = token;

    setPreviewBoxSize(node, src, () => {
        if (node._activeDetailPreviewToken !== token || node._viewMode !== "detail") return;
        node._detailHoverPreviewImg.src = src;
        node._detailHoverPreview.style.display = "block";
        moveDetailPreview(node, e);
    });
}

function hideDetailPreview(node) {
    node._activeDetailPreviewToken = null;
    if (node._detailHoverPreview) {
        node._detailHoverPreview.style.display = "none";
    }
}

function serializeAiJson(value) {
    if (value == null) return "";
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value);
    } catch (e) {
        return "";
    }
}

function parseJsonField(value) {
    if (typeof value !== "string") return value || {};
    const text = value.trim();
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch (e) {
        return {};
    }
}

function normalizeTagList(value) {
    if (!value) return [];
    if (typeof value === "string") {
        const text = value.trim();
        if (!text) return [];
        if (text[0] === "[" || text[0] === "{") {
            try {
                return normalizeTagList(JSON.parse(text));
            } catch (e) {
                return text.split(",").map(tag => tag.trim()).filter(Boolean);
            }
        }
        return text.split(",").map(tag => tag.trim()).filter(Boolean);
    }
    if (Array.isArray(value)) {
        return value.map(tag => extractTagText(tag)).filter(Boolean);
    }
    if (typeof value === "object") {
        const nestedTags = value.tags || value.items || value.values;
        if (nestedTags) return normalizeTagList(nestedTags);
        const tagText = extractTagText(value);
        return tagText ? [tagText] : [];
    }
    return [String(value)];
}

function createTagChip(text, type = "default", dataAttr = "") {
    const colorMap = {
        default: {
            bg: "linear-gradient(135deg, rgba(102,126,234,0.14), rgba(118,75,162,0.12))",
            color: "#6f86ff",
            border: "rgba(122,138,255,0.28)"
        },
        pink: {
            bg: "linear-gradient(135deg, rgba(255,105,180,0.14), rgba(225,48,108,0.12))",
            color: "#e85f97",
            border: "rgba(232,95,151,0.24)"
        },
        green: {
            bg: "linear-gradient(135deg, rgba(80,200,120,0.14), rgba(39,174,96,0.12))",
            color: "#3cb371",
            border: "rgba(60,179,113,0.24)"
        },
        amber: {
            bg: "linear-gradient(135deg, rgba(255,190,60,0.16), rgba(255,140,0,0.12))",
            color: "#e6a800",
            border: "rgba(230,168,0,0.22)"
        }
    };

    const c = colorMap[type] || colorMap.default;

    return `
        <span ${dataAttr}
            style="
                display:inline-flex;
                align-items:center;
                gap:4px;
                padding:5px 12px;
                border-radius:999px;
                font-size:11px;
                line-height:1;
                cursor:pointer;
                user-select:none;
                white-space:nowrap;
                background:${c.bg};
                color:${c.color};
                border:1px solid ${c.border};
                box-shadow: inset 0 1px 0 rgba(255,255,255,0.05);
                transition: all .2s ease;
            ">
        `;
}

export function renderDetailFromRaw(detail) {
    const node = this;

    if (!detail || !detail.images) {
        hideAllHoverPreviews(node);
        node.showListView();
        return;
    }

    hideAllHoverPreviews(node);

    node._detailRaw = detail;
    node._detailImages = detail.images || [];
    node._viewMode = "detail";

    const work = detail.work || {};
    const jsonData = parseJsonField(work.json);

    const user = jsonData.user || {};
    const pixivId = work.id || jsonData.id || "";
    const authorId = user.id || work.userid || work.userId || "";
    const authorName = user.name || "未知作者";
    const aiType = work.AI_type || work.ai_type || jsonData.AI_type || "Unknown";
    const titleText = work.title || jsonData.title || "作品详情";
    const createDate = jsonData.create_date || work.create_date || "";

    const tags = normalizeTagList(jsonData.tags || work.tags || detail.tags);

    node.listControls.style.display = "none";
    node.detailControls.style.display = "flex";

    if (node.detailVersionBadge) {
        node.detailVersionBadge.textContent = aiType;
        node.detailVersionBadge.style.background = `linear-gradient(135deg, ${getTypeColor(aiType)}, ${getTypeColor(aiType)}dd)`;
        node.detailVersionBadge.style.color = "#fff";
        node.detailVersionBadge.style.boxShadow = "0 6px 14px rgba(0,0,0,0.18)";
    }

    node.galleryGrid.innerHTML = "";
    node.galleryGrid.style.padding = "8px";
    node.galleryGrid.style.boxSizing = "border-box";

    const shell = document.createElement("div");
    shell.style.cssText = `
        width: 100%;
        display: flex;
        flex-direction: column;
        gap: 12px;
        box-sizing: border-box;
    `;

    const infoCard = document.createElement("div");
    infoCard.style.cssText = `
        position: relative;
        overflow: hidden;
        border-radius: 18px;
        padding: 12px 14px 10px 14px;
        background:
            radial-gradient(circle at top right, rgba(122,138,255,0.16), transparent 35%),
            radial-gradient(circle at left bottom, rgba(232,95,151,0.10), transparent 32%),
            linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.02)),
            linear-gradient(135deg, rgba(26,30,48,0.98), rgba(18,22,36,0.98));
        border: 1px solid rgba(122,138,255,0.18);
        box-shadow:
            0 10px 28px rgba(0,0,0,0.18),
            inset 0 1px 0 rgba(255,255,255,0.05);
    `;

    const titleBlock = document.createElement("div");
    titleBlock.style.cssText = `
    display:flex;
    align-items:flex-start;
    justify-content:space-between;
    gap:10px;
    margin-bottom:8px;
    flex-wrap:nowrap;
`;

    titleBlock.innerHTML = `
    <div style="min-width:0;flex:1;">
        <div style="
            font-size:16px;
            font-weight:700;
            color:#f4f7ff;
            line-height:1.3;
            margin-bottom:4px;
            word-break:break-word;
            letter-spacing:.2px;
        ">
            ${escapeHtml(titleText)}
        </div>
        <div style="
            display:flex;
            align-items:center;
            gap:8px;
            flex-wrap:wrap;
            color:#9aa4c0;
            font-size:10px;
        ">
            <span style="
                padding:3px 8px;
                border-radius:999px;
                background:rgba(255,255,255,0.04);
                border:1px solid rgba(255,255,255,0.05);
            ">📅 ${formatDate(createDate)}</span>
            <span style="
                padding:3px 8px;
                border-radius:999px;
                background:rgba(255,255,255,0.04);
                border:1px solid rgba(255,255,255,0.05);
            ">🖼 ${detail.images.length} 张</span>
        </div>
    </div>

    <div style="
        display:flex;
        align-items:center;
        justify-content:flex-end;
        gap:6px;
        flex-wrap:wrap;
        flex-shrink:0;
        max-width:45%;
        padding-top:1px;
    ">
        <span style="
            display:inline-flex;
            align-items:center;
            gap:4px;
            padding:4px 8px;
            border-radius:999px;
            font-size:10px;
            color:#6f86ff;
            background:rgba(102,126,234,0.10);
            border:1px solid rgba(122,138,255,0.20);
            white-space:nowrap;
        ">👁 ${escapeHtml(String(jsonData.total_view || work.total_view || 0))}</span>

        <span style="
            display:inline-flex;
            align-items:center;
            gap:4px;
            padding:4px 8px;
            border-radius:999px;
            font-size:10px;
            color:#e85f97;
            background:rgba(232,95,151,0.10);
            border:1px solid rgba(232,95,151,0.20);
            white-space:nowrap;
        ">❤ ${escapeHtml(String(jsonData.total_bookmarks || work.total_bookmarks || 0))}</span>

        <span style="
            display:inline-flex;
            align-items:center;
            gap:4px;
            padding:4px 8px;
            border-radius:999px;
            font-size:10px;
            color:#46c37b;
            background:rgba(70,195,123,0.10);
            border:1px solid rgba(70,195,123,0.20);
            white-space:nowrap;
        ">🤖 ${escapeHtml(String(aiType))}</span>
    </div>
`;
    infoCard.appendChild(titleBlock);

    const authorRow = document.createElement("div");
authorRow.style.cssText = `
    display:flex;
    align-items:center;
    justify-content:space-between;
    gap:8px;
    flex-wrap:wrap;
    padding:7px 0 6px 0;
    border-top:1px solid rgba(255,255,255,0.04);
    border-bottom:1px solid rgba(255,255,255,0.04);
    margin-bottom:8px;
`;
    let authorHtml = `
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <div style="
                width:30px;
                height:30px;
                border-radius:50%;
                display:flex;
                align-items:center;
                justify-content:center;
                color:#fff;
                font-size:13px;
                background:linear-gradient(135deg, #667eea, #764ba2);
                box-shadow:0 6px 14px rgba(102,126,234,0.22);
                flex-shrink:0;
            ">👤</div>
            <div style="display:flex;flex-direction:column;gap:1px;">
                <div style="font-size:12px;font-weight:600;color:#eef2ff;line-height:1.2;">
                    ${escapeHtml(authorName)}
                </div>
                <div style="font-size:10px;color:#97a0b8;line-height:1.2;">
                    作者信息 / 作品来源
                </div>
            </div>
        </div>
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
    `;

    if (authorId) {
        authorHtml += `
            <span class="clickable-search" data-search-term="${escapeHtml(authorId)}"
                style="
                    display:inline-flex;
                    align-items:center;
                    gap:4px;
                    padding:4px 10px;
                    border-radius:999px;
                    font-size:10px;
                    cursor:pointer;
                    color:#6f86ff;
                    background:linear-gradient(135deg, rgba(102,126,234,0.14), rgba(118,75,162,0.12));
                    border:1px solid rgba(122,138,255,0.25);
                    transition:all .2s ease;
                ">
                🆔 ${escapeHtml(authorId)}
            </span>
        `;
    }

    if (pixivId) {
        authorHtml += `
            <span class="clickable-pixiv" data-pixiv-id="${escapeHtml(pixivId)}"
                style="
                    display:inline-flex;
                    align-items:center;
                    gap:4px;
                    padding:4px 10px;
                    border-radius:999px;
                    font-size:10px;
                    cursor:pointer;
                    color:#e85f97;
                    background:linear-gradient(135deg, rgba(255,105,180,0.14), rgba(225,48,108,0.12));
                    border:1px solid rgba(232,95,151,0.25);
                    transition:all .2s ease;
                ">
                🎨 Pixiv ${escapeHtml(pixivId)}
            </span>
        `;
    }

    authorHtml += `</div>`;
    authorRow.innerHTML = authorHtml;
    infoCard.appendChild(authorRow);

    if (tags && tags.length > 0) {
        const tagWrap = document.createElement("div");
        tagWrap.style.cssText = `
            display:flex;
            align-items:flex-start;
            gap:8px;
            flex-wrap:wrap;
        `;

        const label = document.createElement("div");
        label.textContent = "🏷️ 标签";
        label.style.cssText = `
            color:#9aa4c0;
            font-size:10px;
            padding-top:3px;
            min-width:42px;
        `;

        const tagsBox = document.createElement("div");
        tagsBox.style.cssText = `
            display:flex;
            flex-wrap:wrap;
            gap:6px;
            flex:1;
            min-width:0;
        `;

        tags.forEach(tag => {
            const chip = document.createElement("span");
            chip.className = "clickable-tag";
            chip.setAttribute("data-tag", tag);
            chip.textContent = `#${tag.substring(0, 30)}`;
            chip.style.cssText = `
                display:inline-flex;
                align-items:center;
                gap:4px;
                padding:4px 10px;
                border-radius:999px;
                font-size:10px;
                line-height:1;
                cursor:pointer;
                white-space:nowrap;
                color:#6f86ff;
                background:linear-gradient(135deg, rgba(102,126,234,0.14), rgba(118,75,162,0.12));
                border:1px solid rgba(122,138,255,0.25);
                box-shadow: inset 0 1px 0 rgba(255,255,255,0.04);
                transition: all .2s ease;
            `;
            chip.onmouseenter = () => {
                chip.style.transform = "translateY(-1px)";
                chip.style.borderColor = "rgba(122,138,255,0.45)";
                chip.style.boxShadow = "0 8px 16px rgba(80,90,180,0.14)";
            };
            chip.onmouseleave = () => {
                chip.style.transform = "";
                chip.style.borderColor = "rgba(122,138,255,0.25)";
                chip.style.boxShadow = "inset 0 1px 0 rgba(255,255,255,0.04)";
            };
            tagsBox.appendChild(chip);
        });

        tagWrap.appendChild(label);
        tagWrap.appendChild(tagsBox);
        infoCard.appendChild(tagWrap);
    }

    shell.appendChild(infoCard);

    const sectionTitle = document.createElement("div");
    sectionTitle.style.cssText = `
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:10px;
        padding:0 2px;
    `;
    sectionTitle.innerHTML = `
        <div style="font-size:13px;font-weight:700;color:#dfe6ff;letter-spacing:.2px;">
            作品图片
        </div>
        <div style="font-size:11px;color:#8f99b3;">
            点击图片可写入节点参数
        </div>
    `;
    shell.appendChild(sectionTitle);

    const imagesPanel = document.createElement("div");
    imagesPanel.style.cssText = `
        border-radius: 20px;
        padding: 12px;
        background:
            linear-gradient(180deg, rgba(255,255,255,0.035), rgba(255,255,255,0.015)),
            rgba(16,18,28,0.95);
        border: 1px solid rgba(122,138,255,0.14);
        box-shadow:
            0 10px 28px rgba(0,0,0,0.18),
            inset 0 1px 0 rgba(255,255,255,0.03);
    `;

    const imagesContainer = document.createElement("div");
    imagesContainer.style.cssText = `
        display:grid;
        grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
        gap:12px;
        width:100%;
        box-sizing:border-box;
    `;

    detail.images.forEach((imgData, index) => {
        const normalizedImagePath = normalizeAssetPath(imgData.image_path);
        const imgUrl = buildAssetUrl(normalizedImagePath);
        const selectedPath = normalizeAssetPath(node._selectedDetailImage?.image_path);
        const isSelected = selectedPath === normalizedImagePath;

        const card = document.createElement("div");
        card.setAttribute("data-detail-id", normalizedImagePath);
        card.style.cssText = `
            position:relative;
            width:100%;
            min-width:0;
            aspect-ratio: 3 / 4;
            border-radius:16px;
            overflow:hidden;
            cursor:pointer;
            box-sizing:border-box;
            background:
                linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01)),
                #171a24;
            border:${isSelected ? "2px solid #7a8aff" : "1px solid rgba(255,255,255,0.06)"};
            box-shadow:
                ${isSelected
                ? "0 14px 32px rgba(122,138,255,0.22), inset 0 1px 0 rgba(255,255,255,0.05)"
                : "0 8px 20px rgba(0,0,0,0.22), inset 0 1px 0 rgba(255,255,255,0.03)"};
            transition: all .24s cubic-bezier(.4,0,.2,1);
        `;

        const img = document.createElement("img");
        img.src = imgUrl;
        img.loading = "lazy";
        img.style.cssText = `
            width:100%;
            height:100%;
            display:block;
            object-fit:cover;
            object-position:center;
            transition: transform .28s ease, filter .28s ease;
            background: transparent;
        `;

        const gradientTop = document.createElement("div");
        gradientTop.style.cssText = `
            position:absolute;
            top:0;
            left:0;
            width:100%;
            height:72px;
            background:linear-gradient(180deg, rgba(0,0,0,0.50), rgba(0,0,0,0));
            pointer-events:none;
            z-index:1;
        `;

        const gradientBottom = document.createElement("div");
        gradientBottom.style.cssText = `
            position:absolute;
            left:0;
            bottom:0;
            width:100%;
            height:86px;
            background:linear-gradient(0deg, rgba(0,0,0,0.58), rgba(0,0,0,0));
            pointer-events:none;
            z-index:1;
        `;

        const overlay = document.createElement("div");
        overlay.className = "gallery-overlay";
        overlay.style.cssText = `
            position:absolute;
            inset:0;
            background:
                radial-gradient(circle at center, rgba(122,138,255,0.16), rgba(122,138,255,0.04)),
                rgba(0,0,0,0.16);
            opacity:${isSelected ? "1" : "0"};
            transition:opacity .2s ease;
            pointer-events:none;
            z-index:1;
        `;

        const indexBadge = document.createElement("div");
        indexBadge.style.cssText = `
            position:absolute;
            top:10px;
            left:10px;
            z-index:2;
            padding:5px 10px;
            border-radius:999px;
            font-size:11px;
            font-weight:700;
            color:#fff;
            background:linear-gradient(135deg, rgba(102,126,234,0.96), rgba(118,75,162,0.96));
            box-shadow:0 8px 18px rgba(88,102,216,0.28);
            letter-spacing:.2px;
        `;
        indexBadge.textContent = `#${index + 1}`;

        const selectBadge = document.createElement("div");
        selectBadge.className = "gallery-check";
        selectBadge.style.cssText = `
            position:absolute;
            top:10px;
            right:10px;
            z-index:2;
            width:28px;
            height:28px;
            border-radius:50%;
            display:flex;
            align-items:center;
            justify-content:center;
            color:#fff;
            font-size:15px;
            font-weight:700;
            background:${isSelected ? "linear-gradient(135deg, #7a8aff, #8d6bff)" : "rgba(0,0,0,0.35)"};
            border:${isSelected ? "1px solid rgba(255,255,255,0.18)" : "1px solid rgba(255,255,255,0.10)"};
            box-shadow:${isSelected ? "0 8px 16px rgba(122,138,255,0.26)" : "none"};
            transition:all .2s ease;
        `;
        selectBadge.textContent = isSelected ? "✓" : "";

        const bottomBar = document.createElement("div");
        bottomBar.style.cssText = `
            position:absolute;
            left:0;
            right:0;
            bottom:0;
            z-index:2;
            padding:10px 12px 11px 12px;
            display:flex;
            align-items:flex-end;
            justify-content:space-between;
            gap:8px;
            pointer-events:none;
        `;

        const leftInfo = document.createElement("div");
        leftInfo.style.cssText = `
            min-width:0;
            display:flex;
            flex-direction:column;
            gap:4px;
        `;

        const mainText = document.createElement("div");
        mainText.textContent = imgData.image_type || aiType || "SD";
        mainText.style.cssText = `
            font-size:11px;
            font-weight:700;
            color:#ffffff;
            text-shadow:0 1px 2px rgba(0,0,0,0.35);
            letter-spacing:.2px;
        `;

        const subText = document.createElement("div");
        subText.textContent = normalizedImagePath ? String(normalizedImagePath).split("/").pop() : "";
        subText.style.cssText = `
            font-size:10px;
            color:rgba(255,255,255,0.78);
            text-shadow:0 1px 2px rgba(0,0,0,0.35);
            max-width:100%;
            overflow:hidden;
            text-overflow:ellipsis;
            white-space:nowrap;
        `;

        leftInfo.appendChild(mainText);
        leftInfo.appendChild(subText);

        const rightHint = document.createElement("div");
        rightHint.style.cssText = `
            padding:4px 8px;
            border-radius:999px;
            font-size:10px;
            color:#fff;
            background:rgba(255,255,255,0.10);
            border:1px solid rgba(255,255,255,0.10);
            white-space:nowrap;
            text-shadow:0 1px 2px rgba(0,0,0,0.22);
        `;
        rightHint.textContent = isSelected ? "已选中" : "点击选择";

        bottomBar.appendChild(leftInfo);
        bottomBar.appendChild(rightHint);

        card.onmouseenter = (e) => {
            card.style.transform = "translateY(-4px) scale(1.015)";
            card.style.boxShadow = isSelected
                ? "0 20px 40px rgba(122,138,255,0.24), inset 0 1px 0 rgba(255,255,255,0.06)"
                : "0 18px 36px rgba(0,0,0,0.28), inset 0 1px 0 rgba(255,255,255,0.05)";
            img.style.transform = "scale(1.06)";
            img.style.filter = "saturate(1.03)";
            if (!isSelected) overlay.style.opacity = "1";
            showDetailPreview(node, imgUrl, e);
        };

        card.onmousemove = (e) => {
            moveDetailPreview(node, e);
        };

        card.onmouseleave = () => {
            card.style.transform = "";
            card.style.boxShadow = isSelected
                ? "0 14px 32px rgba(122,138,255,0.22), inset 0 1px 0 rgba(255,255,255,0.05)"
                : "0 8px 20px rgba(0,0,0,0.22), inset 0 1px 0 rgba(255,255,255,0.03)";
            img.style.transform = "";
            img.style.filter = "";
            overlay.style.opacity = isSelected ? "1" : "0";
            hideDetailPreview(node);
        };

        card.onclick = () => {
            hideAllHoverPreviews(node);
            node._selectedDetailImage = imgData;

            node.galleryGrid.querySelectorAll("[data-detail-id]").forEach(c => {
                const selected = c.getAttribute("data-detail-id") === normalizedImagePath;
                const ov = c.querySelector(".gallery-overlay");
                const cm = c.querySelector(".gallery-check");
                c.style.border = selected ? "2px solid #7a8aff" : "1px solid rgba(255,255,255,0.06)";
                c.style.boxShadow = selected
                    ? "0 14px 32px rgba(122,138,255,0.22), inset 0 1px 0 rgba(255,255,255,0.05)"
                    : "0 8px 20px rgba(0,0,0,0.22), inset 0 1px 0 rgba(255,255,255,0.03)";
                if (ov) ov.style.opacity = selected ? "1" : "0";
                if (cm) {
                    cm.textContent = selected ? "✓" : "";
                    cm.style.background = selected
                        ? "linear-gradient(135deg, #7a8aff, #8d6bff)"
                        : "rgba(0,0,0,0.35)";
                    cm.style.border = selected
                        ? "1px solid rgba(255,255,255,0.18)"
                        : "1px solid rgba(255,255,255,0.10)";
                    cm.style.boxShadow = selected ? "0 8px 16px rgba(122,138,255,0.26)" : "none";
                }
                const hintNode = c.querySelector(".detail-select-hint");
                if (hintNode) hintNode.textContent = selected ? "已选中" : "点击选择";
            });

            if (node.widgets) {
                for (const w of node.widgets) {
                    if (w.name === "user_id") w.value = String(imgData.author_id || "");
                    if (w.name === "image_id") w.value = String(imgData.work_id || "");
                    if (w.name === "ai_type") w.value = imgData.image_type || "SD";
                    if (w.name === "image_path") w.value = normalizedImagePath || "";
                    if (w.name === "ai_json") w.value = serializeAiJson(imgData.ai_json);
                    if (w.name === "prompt_text") w.value = imgData.prompt_text || "";
                }
            }

            rightHint.textContent = "已选中";
            rightHint.className = "detail-select-hint";

            node.syncDrawInputs?.();
            node.saveGalleryState?.();
            node.setDirtyCanvas(true, true);
            if (app.graph) app.graph.change();
        };

        rightHint.className = "detail-select-hint";

        card.appendChild(img);
        card.appendChild(gradientTop);
        card.appendChild(gradientBottom);
        card.appendChild(overlay);
        card.appendChild(indexBadge);
        card.appendChild(selectBadge);
        card.appendChild(bottomBar);

        imagesContainer.appendChild(card);
    });

    imagesPanel.appendChild(imagesContainer);
    shell.appendChild(imagesPanel);
    node.galleryGrid.appendChild(shell);

    node.detailTitle.textContent = titleText.length > 40 ? titleText.substring(0, 38) + "..." : titleText;

    node.galleryGrid.querySelectorAll(".clickable-pixiv").forEach(span => {
        span.onmouseenter = () => {
            span.style.transform = "translateY(-1px)";
            span.style.borderColor = "rgba(232,95,151,0.45)";
            span.style.boxShadow = "0 8px 16px rgba(232,95,151,0.15)";
        };
        span.onmouseleave = () => {
            span.style.transform = "";
            span.style.borderColor = "rgba(232,95,151,0.25)";
            span.style.boxShadow = "";
        };
        span.onclick = (e) => {
            e.stopPropagation();
            hideAllHoverPreviews(node);
            const pid = span.getAttribute("data-pixiv-id");
            if (pid) window.open(`https://www.pixiv.net/artworks/${pid}`, "_blank");
        };
    });

    node.galleryGrid.querySelectorAll(".clickable-search").forEach(span => {
        span.onmouseenter = () => {
            span.style.transform = "translateY(-1px)";
            span.style.borderColor = "rgba(122,138,255,0.45)";
            span.style.boxShadow = "0 8px 16px rgba(122,138,255,0.14)";
        };
        span.onmouseleave = () => {
            span.style.transform = "";
            span.style.borderColor = "rgba(122,138,255,0.25)";
            span.style.boxShadow = "";
        };
        span.onclick = (e) => {
            e.stopPropagation();
            hideAllHoverPreviews(node);
            performSearch(node, span.getAttribute("data-search-term"));
        };
    });

    node.galleryGrid.querySelectorAll(".clickable-tag").forEach(span => {
        span.onclick = (e) => {
            e.stopPropagation();
            hideAllHoverPreviews(node);
            performSearch(node, span.getAttribute("data-tag"));
        };
    });

    node.galleryGrid.classList.remove("gallery-fade-in");
    void node.galleryGrid.offsetWidth;
    node.galleryGrid.classList.add("gallery-fade-in");

    requestAnimationFrame(() => {
        if (node.galleryGrid) {
            node.galleryGrid.scrollTop = node._savedDetailScrollTop || 0;
        }
    });

    node.galleryGrid.onmouseleave = () => hideAllHoverPreviews(node);
    node.galleryGrid.onblur = () => hideAllHoverPreviews(node);

    node.saveGalleryState?.();
}
