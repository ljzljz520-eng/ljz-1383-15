/**
 * snapshot.mjs —— 发布快照（公开层唯一数据源）
 *
 * 不变式：
 *  1. 公开快照里绝不出现 raw / pinnedRaw / authorizations / 精确原址等私有字段；
 *  2. 授权公开点只在“事件发生日期落在授权有效期内”时才作为 org_point 发布，
 *     其余事件一律聚合到城市质心（或策略指定的模糊网格）；
 *  3. 时数统计按原始事件 ID 去重——一个事件即使在城市/机构层都被提及，也只累计一次；
 *  4. 快照内容寻址（canonical SHA-256）。位置修订、授权撤销、粒度调低会吊销旧快照，
 *     筛选缓存键含快照 id，换版后天然不命中旧缓存（见 cacheKey）。
 */
import crypto from 'node:crypto';
import { gridCell } from '../shared/geo.mjs';
import { genId, nameAsOf, locationAsOf } from './storage.mjs';

function authAt(location, date) {
  return (location.authorizations || []).find(
    (a) => a.validFrom <= date && (a.validUntil === null || a.validUntil >= date)) || null;
}

/**
 * 构建快照视图（不入库）。供发布与“变更影响分析”复用。
 */
export function buildSnapshotView(db, nowDate = new Date().toISOString().slice(0, 10)) {
  const cityById = Object.fromEntries(db.cities.map((c) => [c.code, c]));
  const orgById = Object.fromEntries(db.orgs.map((o) => [o.id, o]));
  const mode = db.policy.publicGranularity || 'city'; // city | grid
  const cellDeg = db.policy.gridCellDeg || 0.1;

  const places = new Map();
  const ensurePlace = (id, place) => {
    if (!places.has(id)) places.set(id, { id, ...place, eventIds: [] });
    return places.get(id);
  };

  // 按日期排序，事件是时数统计的原始去重单元
  const events = [...db.events].sort((a, b) => a.date.localeCompare(b.date));

  for (const ev of events) {
    const org = orgById[ev.orgId];
    const city = cityById[ev.cityCode || (org ? locationAsOf(org, ev.date).location?.cityCode : null)];
    if (!org || !city) continue;

    const { location, authorized } = locationAsOf(org, ev.date);
    const orgNameAtDate = nameAsOf(org, ev.date);
    let place;

    if (authorized && location) {
      const auth = authAt(location, ev.date);
      // 机构授权公开点（公开坐标由机构提供，不使用私有 raw）
      place = ensurePlace(`P_org_${org.id}_${location.id}`, {
        kind: 'org_point',
        granularity: 'org_point',
        name: auth?.publicName || orgNameAtDate,
        orgPublicName: auth?.publicName || null,
        cityCode: city.code,
        cityName: city.name,
        coords: { lng: auth.publicPoint[0], lat: auth.publicPoint[1] },
        authorized: true,
      });
    } else if (mode === 'grid' && location?.raw) {
      // 模糊网格：以机构地点（或事件钉点）吸附后的质心展示
      const src = ev.pinnedRaw || location.raw;
      const cell = gridCell(src.lng, src.lat, cellDeg);
      place = ensurePlace(cell.cellId, {
        kind: 'grid',
        granularity: 'grid',
        name: `${city.name} · 约 ${Math.round(cellDeg * 111)}km 网格`,
        cityCode: city.code,
        cityName: city.name,
        coords: { lng: cell.lng, lat: cell.lat },
        cellId: cell.cellId,
        authorized: false,
      });
    } else {
      // 城市质心：辨识度与推断风险最平衡的默认档
      place = ensurePlace(`P_city_${city.code}`, {
        kind: 'city',
        granularity: 'city',
        name: city.name,
        cityCode: city.code,
        cityName: city.name,
        coords: { lng: city.centroid[0], lat: city.centroid[1] },
        polygon: city.polygon || null, // 城市行政面（仅在足够粗时公开，可空）
        authorized: false,
      });
    }

    place.eventIds.push(ev.id);
  }

  // 公开事件投影：白名单字段，绝不复制整行
  const publicEvents = events.map((ev) => {
    const org = orgById[ev.orgId];
    const { location, authorized } = locationAsOf(org, ev.date);
    let placeId;
    if (authorized && location) {
      placeId = `P_org_${org.id}_${location.id}`;
    } else if (mode === 'grid') {
      const src = ev.pinnedRaw || location.raw;
      placeId = gridCell(src.lng, src.lat, cellDeg).cellId;
    } else {
      placeId = `P_city_${(ev.cityCode || location.cityCode)}`;
    }
    return {
      id: ev.id,
      placeId,
      granularity: places.get(placeId)?.granularity || mode,
      date: ev.date,
      year: Number(ev.date.slice(0, 4)),
      hours: Number(ev.hours) || 0,
      role: ev.role,
      title: ev.title,
      summary: ev.summary || '',
      // 未授权时不公开机构名（机构公开信息属第三域）
      orgPublicName: authorized ? (authAt(location, ev.date)?.publicName || nameAsOf(org, ev.date)) : null,
      photoIds: (ev.photoIds || []).filter(Boolean),
    };
  });

  // 同一 place 内事件去重；统计再按事件 ID 全局去重
  const placeList = [...places.values()].map((p) => {
    const ids = [...new Set(p.eventIds)].sort();
    return { ...p, eventIds: ids, eventCount: ids.length };
  });

  const seen = new Set();
  const byYear = {};
  let totalHours = 0;
  for (const ev of publicEvents) {
    if (seen.has(ev.id)) continue; // 原始事件去重：多地展示不重复累计
    seen.add(ev.id);
    totalHours += ev.hours;
    byYear[ev.year] = byYear[ev.year] || { year: ev.year, hours: 0, events: 0 };
    byYear[ev.year].hours += ev.hours;
    byYear[ev.year].events += 1;
  }

  return {
    schema: 'volunteer-snapshot/1',
    generatedForDate: nowDate,
    granularityPolicy: mode,
    places: placeList,
    events: publicEvents,
    years: Object.values(byYear).sort((a, b) => a.year - b.year),
    stats: {
      totalHours,
      eventCount: seen.size,
      placeCount: placeList.length,
      orgPointCount: placeList.filter((p) => p.kind === 'org_point').length,
    },
  };
}

function canonicalHash(view) {
  return crypto.createHash('sha256').update(JSON.stringify(view)).digest('hex');
}

/** 发布：内容相同则复用同一快照，否则创建新版本并指向 current。 */
export function publishSnapshot(store, note = '') {
  const db = store.data;
  const view = buildSnapshotView(db);
  const hash = canonicalHash(view);
  const previousCurrent = db.currentSnapshotId;
  let snap = Object.values(db.snapshots).find((s) => s.hash === hash && s.status === 'published');
  const reused = !!(snap && snap.id === previousCurrent);
  if (!snap) {
    const id = genId('snap');
    snap = {
      id, status: 'published', hash, note,
      createdAt: new Date().toISOString(),
      sourceRev: db.rev,
      payload: view,
    };
    db.snapshots[id] = snap;
  }
  db.currentSnapshotId = snap.id;
  store.bump();
  return { id: snap.id, hash, reused };
}

export function getCurrentSnapshot(db) {
  const s = db.snapshots[db.currentSnapshotId];
  return s && s.status === 'published' ? s : null;
}

export function getSnapshot(db, id) {
  const s = db.snapshots[id];
  if (!s) return null;
  if (s.status === 'voided' || db.voidedSnapshotIds.includes(id)) {
    return { __voided: true, reason: s.voidReason || '位置或授权已修订，旧快照停止公开' };
  }
  return s.status === 'published' ? s : null;
}

/**
 * 位置修订 / 授权撤销 / 粒度调低时吊销已发布快照（精确旧点不允许留在旧版本里）。
 * 更名不触发（按有效期解析，旧经历保留旧名称是正确语义）。
 */
export function voidPublishedSnapshots(store, reason) {
  const db = store.data;
  const ids = [];
  for (const s of Object.values(db.snapshots)) {
    if (s.status === 'published') {
      s.status = 'voided';
      s.voidReason = reason;
      s.voidedAt = new Date().toISOString();
      ids.push(s.id);
      if (!db.voidedSnapshotIds.includes(s.id)) db.voidedSnapshotIds.push(s.id);
    }
  }
  db.currentSnapshotId = null;
  store.bump();
  return ids;
}

/**
 * 筛选缓存键：含快照 id + 归一化参数。
 * 位置修订后 current 指向新快照 id，旧键自然不命中——无需依赖逐个失效。
 */
export function cacheKey(snapshotId, params) {
  const canonical = Object.keys(params).sort().map((k) => `${k}=${JSON.stringify(params[k])}`).join('&');
  const h = crypto.createHash('sha1').update(canonical).digest('hex').slice(0, 16);
  return `vmap:${snapshotId}:${h}`;
}
