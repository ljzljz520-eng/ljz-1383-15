import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideFallback, renderFallbackSvg, LOAD_TIMEOUT_MS } from '../../js/map-view.mjs';

test('地图服务失效：库缺失 / 瓦片连续错误 / 静默超时 三种情况均降级', () => {
    assert.equal(decideFallback({ hasLeaflet: false }), true, 'CDN 未加载应降级');
    assert.equal(decideFallback({ tileErrors: 4, loadedTiles: 0 }), true, '瓦片服务报错应降级');
    assert.equal(decideFallback({ tileErrors: 3, loadedTiles: 0 }), false, '未达阈值不降级');
    assert.equal(decideFallback({ elapsedMs: LOAD_TIMEOUT_MS, loadedTiles: 0 }), true, '静默超时应降级');
    assert.equal(decideFallback({ elapsedMs: LOAD_TIMEOUT_MS, loadedTiles: 2 }), false, '已加载图块不降级');
});

test('降级示意图：用公开点渲染，且 HTML 转义防注入', () => {
    const places = [
        { id: 'a', kind: 'city', name: '上海', coords: { lng: 121.47, lat: 31.23 }, eventIds: ['e1'] },
        { id: 'b', kind: 'org_point', name: '广州点', coords: { lng: 113.26, lat: 23.13 }, eventIds: ['e2'] },
    ];
    const svg = renderFallbackSvg(places, { a: [{ date: '2024-01-01', title: '陪护' }], b: [] });
    assert.ok(svg.includes('上海') && svg.includes('广州点') && svg.includes('fb-dot org'));

    const evil = renderFallbackSvg([{ id: 'x', kind: 'city', name: '<script>x</script>', coords: { lng: 0, lat: 0 }, eventIds: [] }], {});
    assert.ok(!evil.includes('<script>'));
});

test('访客分享年份筛选：?year=&view=list 为纯视图参数，地图与统计同源快照', async () => {
    const { startTestServer } = await import('./helpers.mjs');
    const t = await startTestServer();
    try {
        const snap = await t.pub('/api/public/snapshot?id=latest');
        const id = snap.data.snapshotId;

        // 分享固定版本链接：其他人打开拿到完全一致的内容（发布快照不可变）
        const shared = await t.pub(`/api/public/snapshot?id=${id}`);
        assert.equal(shared.data.snapshotId, id);
        assert.deepEqual(shared.data.stats, snap.data.stats);

        // 年份过滤口径（前端 volunteer.mjs 同算法）：2024 = 两个原始事件共 6h
        const events2024 = snap.data.events.filter((e) => e.year === 2024);
        assert.equal(events2024.length, 2);
        const hours = events2024.reduce((s, e) => s + e.hours, 0);
        assert.equal(hours, 6);

        // 地图图层（按年份过滤后）与统计引用同一事件集合
        const visibleIds = new Set(events2024.map((e) => e.id));
        const mapEvents = snap.data.places
          .flatMap((p) => p.eventIds)
          .filter((id) => visibleIds.has(id));
        assert.equal(new Set(mapEvents).size, events2024.length, '地图层事件数与列表/统计一致');
    } finally {
        await t.stop();
    }
});

test('位置修订后分享旧链接返回 410，导出同样拒绝旧快照（导出不得残留精确点）', async () => {
  const { startTestServer } = await import('./helpers.mjs');
  const t = await startTestServer();
  try {
    const oldId = (await t.pub('/api/public/snapshot?id=latest')).data.snapshotId;
    await t.admin('/api/admin/orgs/org_demo_aixin/locations', {
      method: 'POST',
      body: { validFrom: '2026-03-01', cityCode: 'chengdu', coordSystem: 'wgs84', rawLng: 104.1, rawLat: 30.6 },
    });

    const oldSnap = await t.pub(`/api/public/snapshot?id=${oldId}`);
    assert.equal(oldSnap.status, 410);
    const oldExport = await t.pub(`/api/public/export?format=geojson&snapshot=${oldId}`);
    assert.equal(oldExport.status, 410);

    await t.admin('/api/admin/snapshots/publish', { method: 'POST', body: {} });
    const fresh = await t.pub('/api/public/export?format=geojson&snapshot=latest');
    assert.equal(fresh.status, 200);
    assert.equal(fresh.data.metadata.granularityPolicy, 'city');
    // 导出的 Feature 数与快照公开位置数一致
    const snap = await t.pub('/api/public/snapshot?id=latest');
    assert.equal(fresh.data.features.length, snap.data.places.length);
    // 导出坐标只允许出现在公开坐标集合内
    const publicCoords = new Set(snap.data.places.map((p) => `${p.coords.lng},${p.coords.lat}`));
    for (const f of fresh.data.features) {
      assert.ok(publicCoords.has(`${f.geometry.coordinates[0]},${f.geometry.coordinates[1]}`),
        '导出出现了非公开坐标');
    }
  } finally {
    await t.stop();
  }
});
