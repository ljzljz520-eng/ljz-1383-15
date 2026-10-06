/**
 * map-view.mjs —— 地图失效判定与离线降级渲染（纯逻辑，便于测试）
 */
import { projectEquirect } from '../shared/geo.mjs';

export const TILE_FAIL_THRESHOLD = 4;
export const LOAD_TIMEOUT_MS = 4000;

/**
 * 是否应降级：
 *  - Leaflet 库未加载（CDN 被墙/网络失效）；
 *  - 连续瓦片错误达到阈值（瓦片服务失效）；
 *  - 超时后仍无任意图块成功（静默失败）。
 */
export function decideFallback({ hasLeaflet = true, tileErrors = 0, loadedTiles = 0, elapsedMs = 0 } = {}) {
    if (!hasLeaflet) return true;
    if (tileErrors >= TILE_FAIL_THRESHOLD) return true;
    if (elapsedMs >= LOAD_TIMEOUT_MS && loadedTiles === 0) return true;
    return false;
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * 依据快照公开点生成离线示意图 SVG 字符串（纯函数）。
 * 注意：不使用精确底图投影，仅做等距圆柱的相对排布，无法用于定位放大。
 */
export function renderFallbackSvg(places, eventsByPlace = {}, W = 1000, H = 520, PAD = 80) {
    if (!places.length) {
        return '<text x="500" y="260" text-anchor="middle" fill="#94a3b8">当前筛选无记录</text>';
    }
    const lngs = places.map((p) => p.coords.lng);
    const lats = places.map((p) => p.coords.lat);
    const cLng = (Math.min(...lngs) + Math.max(...lngs)) / 2;
    const cLat = (Math.min(...lats) + Math.max(...lats)) / 2;
    const proj = places.map((p) => ({ p, pt: projectEquirect(p.coords.lng, p.coords.lat, cLng, cLat) }));
    const xs = proj.map((q) => q.pt.x);
    const ys = proj.map((q) => q.pt.y);
    const range = (arr) => Math.max(Math.max(...arr) - Math.min(...arr), 0.001);
    const s = Math.min((W - PAD * 2) / range(xs), (H - PAD * 2) / range(ys));
    const toXY = (pt) => [W / 2 + pt.x * s, H / 2 - pt.y * s];

    const frame = `<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="18" fill="none" stroke="rgba(255,255,255,.12)"/>`;
    const dots = proj.map(({ p, pt }) => {
        const [x, y] = toXY(pt);
        const r = Math.min(8 + (p.eventIds?.length || eventsByPlace[p.id]?.length || 1) * 2, 20);
        const titles = (eventsByPlace[p.id] || []).map((e) => `${e.date} ${e.title}`).join(' / ');
        return `<circle class="fb-dot ${p.kind === 'org_point' ? 'org' : ''}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}">`
            + `<title>${escapeHtml(p.name)}：${escapeHtml(titles)}</title></circle>`
            + `<text class="fb-label" x="${(x + r + 6).toFixed(1)}" y="${(y + 4).toFixed(1)}">${escapeHtml(p.name)}</text>`;
    }).join('');
    return frame + dots;
}
