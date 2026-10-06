/**
 * volunteer.mjs —— 公开志愿服务地图
 * 数据只来自 /api/public/snapshot（发布快照）；不接触任何私有坐标接口。
 * 地图与统计共用同一个 snapshot 对象；年份切换为纯客户端过滤，
 * 分享链接携带年份与视图（?year=2024&view=list）。
 */
import { publicToDisplay } from '../shared/geo.mjs';
import { decideFallback, renderFallbackSvg, LOAD_TIMEOUT_MS } from './map-view.mjs';

const GRAN_LABEL = {
    org_point: '机构授权点',
    city: '城市质心',
    grid: '模糊网格',
};

const state = {
    snap: null,
    year: null,
    view: 'map',
    map: null,
    layer: null,
    mapFailed: false,
};

const $ = (id) => document.getElementById(id);

async function loadSnapshot() {
    const params = new URLSearchParams(location.search);
    const snapId = params.get('snapshot') || 'latest';
    const res = await fetch(`/api/public/snapshot?id=${encodeURIComponent(snapId)}`);
    if (res.status === 410) {
        const body = await res.json();
        throw new Error(body.error || '该分享版本已因位置/授权修订下线');
    }
    if (!res.ok) throw new Error((await res.json()).error || '快照读取失败');
    return res.json();
}

function filteredEvents() {
    const events = state.snap.events.filter((e) => !state.year || e.year === state.year);
    const ids = new Set(events.map((e) => e.id));
    const places = state.snap.places
        .map((p) => ({ ...p, eventIds: p.eventIds.filter((id) => ids.has(id)) }))
        .filter((p) => p.eventIds.length > 0);
    return { events, places };
}

function renderChips() {
    const box = $('year-chips');
    const chips = [['全部', null], ...state.snap.years.map((y) => [String(y.year), y.year])];
    box.innerHTML = '';
    for (const [label, value] of chips) {
        const b = document.createElement('button');
        b.className = `chip${state.year === value ? ' active' : ''}`;
        b.type = 'button';
        b.textContent = label;
        b.addEventListener('click', () => {
            state.year = value;
            syncUrl();
            renderAll();
        });
        box.appendChild(b);
    }
}

function renderStats() {
    const { events } = filteredEvents();
    const seen = new Set();
    let hours = 0;
    for (const e of events) {
        if (seen.has(e.id)) continue; // 同一原始事件只计一次，哪怕在多个图层出现
        seen.add(e.id);
        hours += e.hours;
    }
    const placeCount = new Set(events.map((e) => e.placeId)).size;
    const cards = [
        ['服务时数', `${hours} 小时`],
        ['原始事件数', seen.size],
        ['涉及公开位置', placeCount],
        ['位置粒度', state.snap.granularityPolicy === 'grid' ? '模糊网格' : '城市质心'],
    ];
    $('stats').innerHTML = cards
        .map(([l, v]) => `<div class="stat-card glass"><div class="stat-num">${v}</div><div class="stat-label">${l}</div></div>`)
        .join('');
}

function popupHtml(p, events) {
    const rows = events
        .map((e) => `<li>${e.date} · ${e.title}（${e.hours}h）${e.orgPublicName ? `<br><small>${escapeHtml(e.orgPublicName)}</small>` : ''}</li>`)
        .join('');
    return `<b>${escapeHtml(p.name)}</b><br>
      <span class="gran-tag ${p.granularity}">${GRAN_LABEL[p.granularity] || p.granularity}</span>
      <ul style="margin:.5rem 0 0 1.1rem;padding:0;">${rows}</ul>`;
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderMap() {
    const { places, events } = filteredEvents();
    const eventsByPlace = Object.groupBy?.(events, (e) => e.placeId)
        || Object.fromEntries(places.map((p) => [p.id, events.filter((e) => e.placeId === p.id)]));

    if (state.mapFailed || typeof L === 'undefined') return renderFallback(places, eventsByPlace);

    if (!state.map) initMap();
    if (!state.map) return renderFallback(places, eventsByPlace);

    if (state.layer) state.layer.clearLayers();
    state.layer = L.layerGroup().addTo(state.map);

    const bounds = [];
    for (const p of places) {
        // 快照坐标为 WGS84 公开表示；若未来切到 GCJ02 底图，统一经 publicToDisplay 换算
        const [dlng, dlat] = publicToDisplay(p.coords.lng, p.coords.lat);
        const marker = L.circleMarker([dlat, dlng], {
            radius: Math.min(8 + p.eventIds.length * 2, 18),
            color: p.kind === 'org_point' ? '#10b981' : '#6366f1',
            weight: 2, fillOpacity: 0.75,
        });
        marker.bindPopup(popupHtml(p, eventsByPlace[p.id] || []));
        marker.addTo(state.layer);
        bounds.push([dlat, dlng]);
    }
    if (bounds.length) state.map.fitBounds(bounds, { padding: [50, 50], maxZoom: 11 });
}

function initMap() {
    const startedAt = Date.now();
    try {
        const map = L.map('map', { preferCanvas: true, maxZoom: 12 }).setView([34.5, 112], 4);
        let tileErrors = 0;
        const tiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '&copy; OpenStreetMap contributors（公开位置为脱敏表示）',
        });
        tiles.on('tileerror', () => {
            tileErrors += 1;
            if (decideFallback({ hasLeaflet: typeof L !== 'undefined', tileErrors, loadedTiles: 0 })) switchToFallback();
        });
        tiles.addTo(map);
        state.map = map;
        // 瓦片服务可能静默失败：超时仍未加载出图块则降级
        setTimeout(() => {
            const loadedTiles = document.querySelectorAll('#map .leaflet-tile-loaded').length;
            if (decideFallback({ hasLeaflet: typeof L !== 'undefined', tileErrors, loadedTiles, elapsedMs: Date.now() - startedAt })) {
                switchToFallback();
            }
        }, LOAD_TIMEOUT_MS);
    } catch {
        switchToFallback();
    }
}

function switchToFallback() {
    if (state.mapFailed) return;
    state.mapFailed = true;
    if (state.map) state.map.remove();
    state.map = null;
    $('map').hidden = true;
    $('map-fallback').hidden = false;
    const { places, events } = filteredEvents();
    const eventsByPlace = Object.groupBy?.(events, (e) => e.placeId)
        || Object.fromEntries(places.map((p) => [p.id, events.filter((e) => e.placeId === p.id)]));
    renderFallback(places, eventsByPlace);
}

function renderFallback(places, eventsByPlace) {
    $('map').hidden = true;
    $('map-fallback').hidden = false;
    $('fallback-svg').innerHTML = renderFallbackSvg(places, eventsByPlace);
}

function renderList() {
    const { events } = filteredEvents();
    const placeById = Object.fromEntries(state.snap.places.map((p) => [p.id, p]));
    $('view-list').innerHTML = events
        .map((e) => {
            const p = placeById[e.placeId];
            const photos = (e.photoIds || [])
                .map((id) => `<img src="/media/${id}" alt="服务照片（已去除定位元数据）" loading="lazy">`)
                .join('');
            return `<article class="event-card glass">
                <span class="gran-tag ${e.granularity}">${GRAN_LABEL[e.granularity] || e.granularity}</span>
                <h3>${escapeHtml(e.title)}</h3>
                <div class="event-meta">
                    <span>📅 ${e.date}</span><span>⏱ ${e.hours} 小时</span><span>🧭 ${escapeHtml(p?.name || '')}</span>
                    ${e.orgPublicName ? `<span>🏛 ${escapeHtml(e.orgPublicName)}</span>` : ''}
                </div>
                ${e.summary ? `<p style="color:var(--text-muted);margin-top:.6rem;font-size:.9rem;">${escapeHtml(e.summary)}</p>` : ''}
                ${photos ? `<div class="event-photos">${photos}</div>` : ''}
            </article>`;
        })
        .join('') || '<p style="color:var(--text-muted)">该年份暂无记录。</p>';
}

function renderAll() {
    renderChips();
    renderStats();
    if (state.view === 'map') {
        $('view-map').hidden = false;
        $('view-list').hidden = true;
        renderMap();
    } else {
        $('view-map').hidden = true;
        $('view-list').hidden = false;
        renderList();
    }
}

function syncUrl() {
    const params = new URLSearchParams();
    if (state.year) params.set('year', state.year);
    if (state.view !== 'map') params.set('view', state.view);
    history.replaceState(null, '', params.toString() ? `?${params}` : location.pathname);
}

function bindToolbar() {
    $('btn-map').addEventListener('click', () => setView('map'));
    $('btn-list').addEventListener('click', () => setView('list'));
    $('btn-share').addEventListener('click', async () => {
        const url = location.href;
        try {
            await navigator.clipboard.writeText(url);
            window.showToast?.('已复制分享链接（含年份筛选与视图）', 'success');
        } catch {
            window.showToast?.(url, 'success');
        }
    });
}

function setView(v) {
    state.view = v;
    $('btn-map').classList.toggle('active', v === 'map');
    $('btn-list').classList.toggle('active', v === 'list');
    syncUrl();
    renderAll();
}

function wireExport() {
    const id = state.snap.snapshotId;
    $('btn-export-geo').href = `/api/public/export?format=geojson&snapshot=${encodeURIComponent(id)}`;
    $('btn-export-csv').href = `/api/public/export?format=csv&snapshot=${encodeURIComponent(id)}`;
}

async function main() {
    bindToolbar();
    try {
        state.snap = await loadSnapshot();
        const params = new URLSearchParams(location.search);
        if (params.get('year')) state.year = Number(params.get('year'));
        if (params.get('view') === 'list') state.view = 'list';
        setView(state.view);
        wireExport();
        $('map-loading').remove();
        $('snap-meta').textContent =
            `发布快照 ${state.snap.snapshotId} · 生成基准日 ${state.snap.generatedForDate} · 统计口径：按原始事件去重`;
    } catch (err) {
        $('map-loading').textContent = `加载失败：${err.message}`;
        window.showToast?.(err.message, 'error');
    }
}

main();
