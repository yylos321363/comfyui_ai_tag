export const TYPE_COLORS = {
    'NAI': '#0477fa',
    'COMFYUI': '#8a2be2',
    'SD': '#fb8a05',
    'NAI_X': '#3b3f51',
    'DEFAULT': '#667eea'
};

export function getTypeColor(type) {
    const t = String(type).toUpperCase();
    return TYPE_COLORS[t] || TYPE_COLORS['DEFAULT'];
}

export function formatDate(dateStr) {
    if (!dateStr) return '';
    try {
        return new Date(dateStr).toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });
    } catch (e) {
        return dateStr;
    }
}

export function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    if (typeof str !== 'string') str = String(str);
    return str.replace(/[&<>]/g, function (m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        return m;
    });
}

export function extractTagText(tag) {
    if (!tag) return '';
    if (typeof tag === 'string') return tag;
    if (typeof tag === 'object') {
        for (const key of ['name', 'tag', 'label', 'value']) {
            const value = tag[key];
            if (typeof value === 'string') return value;
            if (value && typeof value === 'object') {
                const nested = extractTagText(value);
                if (nested) return nested;
            }
        }
        if (tag.translation && typeof tag.translation === 'object') {
            const translated = tag.translation.en || tag.translation.zh || tag.translation.jp || tag.translation.ja;
            if (typeof translated === 'string') return translated;
        }
        return '';
    }
    return String(tag);
}

export function getTimeRangeOptions(months) {
    if (!months || !Array.isArray(months)) return [];
    const years = [...new Set(months.map(m => parseInt(m.split('-')[0])))].sort((a, b) => b - a);
    const options = [];
    years.forEach(year => {
        const yearMonths = months
            .filter(m => m.startsWith(String(year)))
            .map(m => parseInt(m.split('-')[1]))
            .sort((a, b) => a - b);

        const quarters = new Set();
        yearMonths.forEach(m => quarters.add(Math.ceil(m / 3)));

        options.push({ label: `${year}全年`, value: `y${year}` });

        const qNames = ['一', '二', '三', '四'];
        [...quarters].sort((a, b) => a - b).forEach(q => {
            options.push({ label: `${year}第${qNames[q - 1]}季度`, value: `q${year}Q${q}` });
        });
    });

    options.push({ label: '更早', value: 'older' });
    return options;
}

export function getMonthlyOptions(months) {
    if (!months || !Array.isArray(months)) return [];
    const options = months
        .sort((a, b) => b.localeCompare(a))
        .map(m => ({ label: m, value: `m${m}` }));
    options.push({ label: '更早', value: 'older' });
    return options;
}
