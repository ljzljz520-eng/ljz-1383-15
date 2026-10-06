import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.mjs';

const JSON_FINGERPRINT = (obj, needles) => {
  const s = JSON.stringify(obj);
  return needles.filter((n) => s.includes(n));
};

test('快照脱敏：公开响应/搜索/导出中绝不出现原始定位与私有字段', async () => {
  const t = await startTestServer();
  try {
    const { status, data } = await t.pub('/api/public/snapshot?id=latest');
    assert.equal(status, 200);

    // 种子中的精确原始点（爱心社旧址 116.3805,39.9122；新址 116.4692…；春雨 121.4581…）
    const secrets = ['116.3805', '39.9122', '116.4692', '39.9188', '121.4581', '31.2045',
      'pinnedRaw', '"raw"', 'authorizations', 'publicPoint', 'validUntil', '113.2735'];
    assert.deepEqual(JSON_FINGERPRINT(data, secrets), [], '公开快照泄漏了私有坐标或字段');

    // 未授权机构（春雨）不公开机构名；上海只出城市质心
    const sh = data.places.find((p) => p.cityCode === 'shanghai');
    assert.equal(sh.kind, 'city');
    assert.ok(!data.events.some((e) => /春雨/.test(JSON.stringify(e))), '未授权机构名不得公开');

    // 授权窗口内的历史事件（2019）使用当时授权点；2025 授权已撤销 -> 城市质心
    const ev2019 = data.events.find((e) => e.id === 'evt_2019_a');
    assert.equal(ev2019.granularity, 'org_point');
    assert.equal(ev2019.orgPublicName, '爱心互助社旧址服务点');
    const ev2025 = data.events.find((e) => e.id === 'evt_2025_a');
    assert.equal(ev2025.granularity, 'city');
    assert.equal(ev2025.orgPublicName, null);

    // 搜索接口同样只接触发数据
    const search = await t.pub('/api/public/places/search?q=上海');
    assert.equal(search.status, 200);
    assert.deepEqual(JSON_FINGERPRINT(search.data, secrets), []);

    // 导出 GeoJSON / CSV 均无精确点（GeoJSON 被解析为对象，CSV 为文本）
    const geo = await t.pub(`/api/public/export?format=geojson&snapshot=${data.snapshotId}`);
    const csv = await t.pub(`/api/public/export?format=csv&snapshot=${data.snapshotId}`);
    assert.ok(!JSON.stringify(geo.data).includes('116.4692') && !csv.data.includes('31.2045'));
    assert.equal(geo.data.features.length, data.places.length);
  } finally {
    await t.stop();
  }
});

test('机构更名/搬迁按有效期作用到相应经历，旧名称不被改写', async () => {
  const t = await startTestServer();
  try {
    const { data } = await t.pub('/api/public/snapshot?id=latest');
    // 2019 事件展示旧授权公开名；2022 事件展示新机构名（授权窗口内）
    const e19 = data.events.find((e) => e.id === 'evt_2019_a');
    const e22 = data.events.find((e) => e.id === 'evt_2022_a');
    assert.equal(e19.orgPublicName, '爱心互助社旧址服务点');
    assert.equal(e22.orgPublicName, '星原社区服务中心（朝阳）');

    // 新增更名版本不影响公开语义（按 asOf 解析），也不吊销快照
    const before = data.snapshotId;
    const r = await t.admin('/api/admin/orgs/org_demo_aixin/name', {
      method: 'POST', body: { validFrom: '2026-01-01', name: '星原公益联合会' },
    });
    assert.equal(r.status, 200);
    const again = await t.pub('/api/public/snapshot?id=' + before);
    assert.equal(again.status, 200, '仅更名不应吊销旧快照');
  } finally {
    await t.stop();
  }
});

test('搬迁新增地点版本：吊销旧快照（410），新快照位置更新；缓存不命中旧版本', async () => {
  const t = await startTestServer();
  try {
    const cur = await t.pub('/api/public/snapshot?id=latest');
    const oldId = cur.data.snapshotId;

    // 先制造一次网格搜索缓存命中
    const bboxQ = 'bbox=112.5,22.5,122.5,41.5';
    const first = await t.pub(`/api/public/places/search?${bboxQ}`);
    assert.equal(first.headers['x-cache'], 'miss');
    const second = await t.pub(`/api/public/places/search?${bboxQ}`);
    assert.equal(second.headers['x-cache'], 'hit');

    // 鹿鸣（广州）搬迁
    const r = await t.admin('/api/admin/orgs/org_demo_luming/locations', {
      method: 'POST',
      body: { validFrom: '2026-02-01', cityCode: 'guangzhou', coordSystem: 'wgs84', rawLng: 113.4, rawLat: 23.2 },
    });
    assert.equal(r.status, 200);

    // 旧快照必须 410
    const gone = await t.pub('/api/public/snapshot?id=' + oldId);
    assert.equal(gone.status, 410);
    assert.equal(gone.data.voided, true);

    // 发布新快照后，同一筛选参数在新快照下不命中旧缓存
    const pub = await t.admin('/api/admin/snapshots/publish', { method: 'POST', body: {} });
    assert.equal(pub.status, 200);
    const third = await t.pub(`/api/public/places/search?${bboxQ}`);
    assert.equal(third.headers['x-cache'], 'miss', '位置修订后筛选缓存不得命中旧版本');

    // 2022 年的历史事件仍解析旧地点版本，城市归属不变
    const fresh = await t.pub('/api/public/snapshot?id=latest');
    const oldEv = fresh.data.events.find((e) => e.id === 'evt_2022_c');
    assert.equal(oldEv.placeId.startsWith('P_org_org_demo_luming_loc_luming'), true);
  } finally {
    await t.stop();
  }
});

test('授权撤销：精确点立即下线，历史快照 410，新发布只剩城市质心', async () => {
  const t = await startTestServer();
  try {
    const before = await t.pub('/api/public/snapshot?id=latest');
    assert.ok(before.data.places.some((p) => p.kind === 'org_point'));
    const oldId = before.data.snapshotId;

    const rev = await t.admin('/api/admin/orgs/org_demo_luming/revoke', {
      method: 'POST', body: { validUntil: '2022-12-31' },
    });
    assert.equal(rev.status, 200);
    assert.ok(rev.data.revoked >= 1);

    const gone = await t.pub('/api/public/snapshot?id=' + oldId);
    assert.equal(gone.status, 410);

    await t.admin('/api/admin/snapshots/publish', { method: 'POST', body: {} });
    const after = await t.pub('/api/public/snapshot?id=latest');
    const c = after.data.events.find((e) => e.id === 'evt_2022_c');
    // 撤销生效日 2022-12-31 晚于事件 2022-11-20：事件当时仍在授权窗内
    assert.equal(c.granularity, 'org_point', '撤销按有效期：不影响撤销日前的历史经历');

    // 撤销日提前到事件之前 -> 该事件降级为城市质心
    await t.admin('/api/admin/orgs/org_demo_luming/revoke', {
      method: 'POST', body: { validUntil: '2022-01-01' },
    });
    await t.admin('/api/admin/snapshots/publish', { method: 'POST', body: {} });
    const after2 = await t.pub('/api/public/snapshot?id=latest');
    const c2 = after2.data.events.find((e) => e.id === 'evt_2022_c');
    assert.equal(c2.granularity, 'city');
    assert.ok(!after2.data.places.some((p) => p.id.includes('org_demo_luming') && p.kind === 'org_point'));
  } finally {
    await t.stop();
  }
});

test('公开粒度调低 city->grid 再回 city：旧快照全部吊销，网格不还原原始点', async () => {
  const t = await startTestServer();
  try {
    const oldId = (await t.pub('/api/public/snapshot?id=latest')).data.snapshotId;
    const r = await t.admin('/api/admin/policy', { method: 'PUT', body: { publicGranularity: 'grid', gridCellDeg: 0.1 } });
    assert.equal(r.status, 200);
    assert.equal((await t.pub('/api/public/snapshot?id=' + oldId)).status, 410);

    await t.admin('/api/admin/snapshots/publish', { method: 'POST', body: {} });
    const g = await t.pub('/api/public/snapshot?id=latest');
    assert.equal(g.data.granularityPolicy, 'grid');
    const grid = g.data.places.find((p) => p.kind === 'grid');
    assert.ok(grid, '存在网格表示');
    assert.ok(!g.data.places.some((p) => p.kind === 'city' && p.eventIds.length > 0), '网格模式下事件不应再聚合到城市质心');
    // 网格质心不等于任何种子精确点
    assert.ok(!JSON.stringify(g.data).includes('121.4581'));
  } finally {
    await t.stop();
  }
});

test('时数按原始事件去重：同事件多地/多图展示不重复累计', async () => {
  const t = await startTestServer();
  try {
    const { data } = await t.pub('/api/public/snapshot?id=latest');
    // 种子总时数：4+6+5+3+3+3+8 = 32（含同一日两段记录各自 3h —— 它们是不同事件 id，合法计入）
    assert.equal(data.stats.totalHours, 32);
    assert.equal(data.stats.eventCount, 7);
    // 2024 年：两个事件 id，共 6h，而不是因同一地点展示被合并或翻倍
    const y2024 = data.years.find((y) => y.year === 2024);
    assert.deepEqual({ hours: y2024.hours, events: y2024.events }, { hours: 6, events: 2 });

    // 年份筛选下前端口径同样按 id 去重（模拟 volunteer.mjs 逻辑）
    const seen = new Set(); let hours = 0;
    for (const e of data.events.filter((e) => e.year === 2024)) {
      if (seen.has(e.id)) continue;
      seen.add(e.id); hours += e.hours;
    }
    assert.equal(hours, 6);
  } finally {
    await t.stop();
  }
});

test('管理接口鉴权：无令牌/错令牌拒绝', async () => {
  const t = await startTestServer();
  try {
    assert.equal((await t.pub('/api/admin/state')).status, 401);
    assert.equal((await t.pub('/api/admin/state', { token: 'wrong' })).status, 401);
    assert.equal((await t.admin('/api/admin/state')).status, 200);
  } finally {
    await t.stop();
  }
});
