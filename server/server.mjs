/**
 * server.mjs —— 零依赖 HTTP 服务
 * 启动：node server/server.mjs  （可选 ADMIN_TOKEN / PORT）
 *
 * 安全边界：
 *  - /api/admin/* 需 X-Admin-Token；/api/public/* 与 /media/* 永远只读“脱敏快照 / 清洗图”；
 *  - data/private（原始照片与精确坐标库）不通过静态路径暴露；
 *  - 位置新增版本（搬迁）、授权撤销、粒度变更立即吊销旧快照，旧 id 返回 410；
 *  - 空间搜索 bbox 有最小面积并吸附网格；不提供半径/点选等可套点接口；
 *  - 导出（GeoJSON/CSV）只来自快照公开表示，绝不含原始定位。
 */
import http from 'node:http';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import { join, dirname, extname, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Buffer } from 'node:buffer';
import { JSONStore, genId, seed, nameAsOf, locationAsOf, currentLocation } from './storage.mjs';
import { publishSnapshot, getCurrentSnapshot, getSnapshot, voidPublishedSnapshots, cacheKey, buildSnapshotView } from './snapshot.mjs';
import { toWgs84 } from '../shared/geo.mjs';
import { stripMetadata, hasMetadataTrace, detectFormat } from './exif.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DB_PATH = process.env.VMAP_DB || join(ROOT, 'data', 'private', 'vmap.json');
const PRIVATE_PHOTOS = process.env.PRIVATE_PHOTOS || join(ROOT, 'data', 'private', 'photos');
const MEDIA_DIR = process.env.MEDIA_DIR || join(ROOT, 'data', 'media');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'changeme-dev-token';
const PORT = Number(process.env.PORT || 3000);

const store = new JSONStore(DB_PATH);
const searchCache = new Map(); // key: cacheKey(snapshotId, params)

// ---------------------------- 工具 ---------------------------------------
function json(res, code, obj, extra = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
  res.end(body);
}

async function readJson(req, limit = 25 * 1024 * 1024) {
  return new Promise((pResolve, pReject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { pReject(new Error('请求体过大')); req.destroy(); }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return pResolve({});
      try { pResolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { pReject(new Error('JSON 解析失败')); }
    });
    req.on('error', pReject);
  });
}

function requireAdmin(req, res) {
  if (req.headers['x-admin-token'] !== ADMIN_TOKEN) {
    json(res, 401, { error: '管理令牌无效' });
    return false;
  }
  return true;
}

function resolveSnapshotRef(db, id) {
  if (!id || id === 'latest') {
    const cur = getCurrentSnapshot(db);
    if (!cur) return { error: 404, body: { error: '尚未发布快照' } };
    return { snap: cur };
  }
  const s = getSnapshot(db, id);
  if (!s) return { error: 404, body: { error: '快照不存在' } };
  if (s.__voided) return { error: 410, body: { error: s.reason, voided: true } };
  return { snap: s };
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

async function serveStatic(res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[ 0]);
  if (rel === '/') rel = '/index.html';
  const filePath = normalize(join(ROOT, rel));
  // 防路径穿越 + 保护私有数据目录
  if (!filePath.startsWith(ROOT + '/') || filePath.includes('/data/') || filePath.includes('/server/')) {
    res.writeHead(403); return res.end('forbidden');
  }
  if (!existsSync(filePath)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('404');
  }
  const st = await stat(filePath);
  if (st.isDirectory()) { res.writeHead(403); return res.end('forbidden'); }
  res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream' });
  createReadStream(filePath).pipe(res);
}

function orgById(db, id) { return db.orgs.find((o) => o.id === id); }

// ------------------------- 管理端动作 ------------------------------------
async function handleAdmin(req, res, url) {
  if (!requireAdmin(req, res)) return;
  const db = store.data;
  const body = ['POST', 'PUT', 'DELETE'].includes(req.method) ? await readJson(req) : {};
  const p = url.pathname.split('/').filter(Boolean); // ['api','admin',...]
  const today = new Date().toISOString().slice(0, 10);

  if (req.method === 'POST' && url.pathname === '/api/admin/login') {
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/state') {
    return json(res, 200, { db, helpers: { today } });
  }

  // ---- 机构：新建 / 更名版本 / 搬迁版本 / 授权 / 撤销 ----
  if (req.method === 'POST' && url.pathname === '/api/admin/orgs') {
    const name = String(body.name || '').trim();
    if (!name) return json(res, 400, { error: '机构名称必填' });
    const org = { id: genId('org'), currentName: name, names: [{ validFrom: body.validFrom || today, name }], locations: [] };
    db.orgs.push(org); store.bump();
    return json(res, 200, { org });
  }

  if (req.method === 'POST' && /^\/api\/admin\/orgs\/[^/]+\/name$/.test(url.pathname)) {
    const org = orgById(db, p[3]);
    if (!org) return json(res, 404, { error: '机构不存在' });
    if (!body.validFrom || !body.name) return json(res, 400, { error: 'validFrom 与 name 必填' });
    if (org.names.some((n) => n.validFrom === body.validFrom)) return json(res, 409, { error: '该生效日期已有名称版本' });
    org.names.push({ validFrom: body.validFrom, name: body.name });
    org.currentName = body.name; // 最新版本即当前名
    store.bump();
    return json(res, 200, { org }); // 更名不吊销旧快照：历史经历按有效期保留旧称
  }

  if (req.method === 'POST' && /^\/api\/admin\/orgs\/[^/]+\/locations$/.test(url.pathname)) {
    const org = orgById(db, p[3]);
    if (!org) return json(res, 404, { error: '机构不存在' });
    const city = db.cities.find((c) => c.code === body.cityCode);
    if (!city) return json(res, 400, { error: '城市不存在' });
    // 录入坐标按其坐标系归一为 WGS84（国内底图 GCJ-02 在此换算，避免坐标错误）
    const [lng, lat] = toWgs84(Number(body.rawLng), Number(body.rawLat), body.coordSystem || 'wgs84');
    org.locations.push({
      id: genId('loc'), validFrom: body.validFrom || today,
      raw: { lng, lat }, cityCode: city.code, authorizations: [],
    });
    voidPublishedSnapshots(store, '机构搬迁：新增地点版本，旧公开快照吊销');
    searchCache.clear();
    return json(res, 200, { org });
  }

  if (req.method === 'POST' && /^\/api\/admin\/orgs\/[^/]+\/authorizations$/.test(url.pathname)) {
    const org = orgById(db, p[3]);
    const loc = currentLocation(org);
    if (!loc) return json(res, 400, { error: '请先为机构录入地点' });
    if (!body.publicName || !Array.isArray(body.publicPoint) || body.publicPoint.length !== 2) {
      return json(res, 400, { error: 'publicName 与 publicPoint[lng,lat] 必填' });
    }
    loc.authorizations.push({
      validFrom: body.validFrom || today,
      validUntil: body.validUntil === undefined ? null : body.validUntil,
      publicPoint: [Number(body.publicPoint[0]), Number(body.publicPoint[1])],
      publicName: String(body.publicName),
    });
    voidPublishedSnapshots(store, '机构公开授权变更，旧公开快照吊销');
    searchCache.clear();
    return json(res, 200, { org });
  }

  if (req.method === 'POST' && /^\/api\/admin\/orgs\/[^/]+\/revoke$/.test(url.pathname)) {
    const org = orgById(db, p[3]);
    if (!org) return json(res, 404, { error: '机构不存在' });
    const until = body.validUntil || today;
    let n = 0;
    for (const loc of org.locations) {
      for (const a of loc.authorizations || []) {
        if (a.validUntil === null || a.validUntil > until) { a.validUntil = until; n++; }
      }
    }
    voidPublishedSnapshots(store, '机构授权撤销：精确公开点停止发布');
    searchCache.clear();
    return json(res, 200, { revoked: n, org });
  }

  // ---- 事件（服务经历） ----
  if (req.method === 'POST' && url.pathname === '/api/admin/events') {
    const org = orgById(db, String(body.orgId || ''));
    if (!org) return json(res, 400, { error: '请选择有效机构（多次活动共用机构地点）' });
    if (!body.date || !(Number(body.hours) > 0)) return json(res, 400, { error: '日期与正的时数必填' });
    const ev = {
      id: genId('evt'), orgId: org.id, date: body.date, hours: Number(body.hours),
      role: body.role || '志愿者', title: body.title || '', summary: body.summary || '',
      pinnedRaw: null, photoIds: [],
    };
    // 可选：事件级原始钉点（私有），同样按坐标系归一
    if (body.pinnedLng != null && body.pinnedLat != null) {
      const [lng, lat] = toWgs84(Number(body.pinnedLng), Number(body.pinnedLat), body.coordSystem || 'wgs84');
      ev.pinnedRaw = { lng, lat };
    }
    db.events.push(ev); store.bump();
    return json(res, 200, { event: ev });
  }

  if (req.method === 'DELETE' && /^\/api\/admin\/events\/[^/]+$/.test(url.pathname)) {
    const id = p[3];
    const idx = db.events.findIndex((e) => e.id === id);
    if (idx < 0) return json(res, 404, { error: '事件不存在' });
    const [removed] = db.events.splice(idx, 1);
    for (const pid of removed.photoIds || []) delete db.photos[pid];
    store.bump();
    return json(res, 200, { ok: true });
  }

  // ---- 照片：上传即清洗；原图仅存私有区 ----
  if (req.method === 'POST' && url.pathname === '/api/admin/photos') {
    const ev = db.events.find((e) => e.id === body.eventId);
    if (!ev) return json(res, 404, { error: '事件不存在' });
    let buf;
    try { buf = Buffer.from(String(body.dataBase64 || '').split(',')[0] === 'data:' ? String(body.dataBase64).split(',')[1] : body.dataBase64, 'base64'); }
    catch { return json(res, 400, { error: 'base64 数据非法' }); }
    if (!detectFormat(buf)) return json(res, 400, { error: '仅支持 JPEG/PNG/WebP' });
    const photoId = genId('photo');
    const { format, buffer: clean } = stripMetadata(buf);
    await writeFile(join(PRIVATE_PHOTOS, `${photoId}.orig`), buf, { flag: 'wx' });
    await writeFile(join(MEDIA_DIR, `${photoId}.${format}`), clean, { flag: 'wx' });
    const rec = { id: photoId, eventId: ev.id, filename: body.filename || `${photoId}.${format}`, ext: format, bytes: clean.length, cleanedAt: new Date().toISOString() };
    db.photos[photoId] = rec;
    ev.photoIds = ev.photoIds || [];
    if (!ev.photoIds.includes(photoId)) ev.photoIds.push(photoId);
    store.bump();
    return json(res, 200, { photo: rec, metadataStripped: true });
  }

  // 派生图审计/重处理：旧派生图即使混入元数据，也从私有原图重新清洗
  if (req.method === 'POST' && url.pathname === '/api/admin/photos/reprocess') {
    const results = [];
    for (const rec of Object.values(db.photos)) {
      const origPath = join(PRIVATE_PHOTOS, `${rec.id}.orig`);
      if (!existsSync(origPath)) { results.push({ id: rec.id, skipped: '原图缺失' }); continue; }
      const orig = await readFile(origPath);
      const { format, buffer: clean } = stripMetadata(orig);
      await writeFile(join(MEDIA_DIR, `${rec.id}.${format}`), clean);
      rec.ext = format; rec.bytes = clean.length; rec.cleanedAt = new Date().toISOString();
      results.push({ id: rec.id, ext: format, metadataStripped: !hasMetadataTrace(clean) });
    }
    store.bump();
    return json(res, 200, { results });
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/photos/audit') {
    const files = await readdir(MEDIA_DIR);
    const bad = [];
    for (const f of files) {
      if (f.startsWith('.')) continue;
      const b = await readFile(join(MEDIA_DIR, f));
      if (hasMetadataTrace(b)) bad.push(f);
    }
    return json(res, 200, { mediaCount: files.filter((f) => !f.startsWith('.')).length, filesWithMetadata: bad });
  }

  // ---- 粒度策略 ----
  if (req.method === 'PUT' && url.pathname === '/api/admin/policy') {
    if (!['city', 'grid'].includes(body.publicGranularity)) return json(res, 400, { error: '粒度仅支持 city / grid' });
    const prev = db.policy.publicGranularity;
    db.policy.publicGranularity = body.publicGranularity;
    if (body.gridCellDeg) db.policy.gridCellDeg = Number(body.gridCellDeg);
    voidPublishedSnapshots(store, `公开粒度由 ${prev} 调整为 ${body.publicGranularity}，旧快照吊销`);
    searchCache.clear();
    return json(res, 200, { policy: db.policy });
  }

  // ---- 发布快照（地图与统计的同一数据源） ----
  if (req.method === 'POST' && url.pathname === '/api/admin/snapshots/publish') {
    const r = publishSnapshot(store, body.note || '');
    searchCache.clear();
    return json(res, 200, r);
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/snapshots/preview') {
    return json(res, 200, buildSnapshotView(db));
  }

  return json(res, 404, { error: '未知管理接口' });
}

// ------------------------- 公开端动作 ------------------------------------
function eventsOfPlaces(view, placeIds) {
  const set = new Set(placeIds);
  // 只回传白名单字段，源头即快照，永不触达私有库
  return view.events
    .filter((e) => set.has(e.placeId))
    .map((e) => ({ id: e.id, placeId: e.placeId, date: e.date, year: e.year, hours: e.hours, role: e.role, title: e.title, orgPublicName: e.orgPublicName }));
}

async function handlePublic(req, res, url) {
  const db = store.data;

  if (url.pathname === '/api/public/snapshot') {
    const ref = resolveSnapshotRef(db, url.searchParams.get('id') || 'latest');
    if (ref.error) return json(res, ref.error, ref.body);
    const { payload } = ref.snap;
    return json(res, 200, {
      snapshotId: ref.snap.id, status: 'published', generatedForDate: payload.generatedForDate,
      granularityPolicy: payload.granularityPolicy, stats: payload.stats, years: payload.years,
      places: payload.places, events: payload.events,
    });
  }

  if (url.pathname === '/api/public/places/search') {
    const ref = resolveSnapshotRef(db, url.searchParams.get('snapshot') || 'latest');
    if (ref.error) return json(res, ref.error, ref.body);
    const view = ref.snap.payload;
    const bbox = url.searchParams.get('bbox');
    let params;
    let matched;
    if (bbox) {
      const [west, south, east, north] = bbox.split(',').map(Number);
      let norm;
      try { norm = (await import('../shared/geo.mjs')).normalizeBbox({ west, south, east, north }); }
      catch (e) { return json(res, 400, { error: e.message }); }
      params = { kind: 'bbox', ...norm };
      const key = cacheKey(ref.snap.id, params);
      if (searchCache.has(key)) return json(res, 200, searchCache.get(key), { 'x-cache': 'hit' });
      matched = view.places.filter(
        (p) => p.coords.lng >= norm.west && p.coords.lng <= norm.east && p.coords.lat >= norm.south && p.coords.lat <= norm.north);
    } else {
      const q = (url.searchParams.get('q') || '').trim();
      const cityCode = url.searchParams.get('cityCode') || '';
      if (q.length < 2 && !cityCode) return json(res, 400, { error: '请提供至少 2 个字符的关键词，或精确的城市编码' });
      params = { kind: 'text', q: q.toLowerCase(), cityCode };
      const key = cacheKey(ref.snap.id, params);
      if (searchCache.has(key)) return json(res, 200, searchCache.get(key), { 'x-cache': 'hit' });
      matched = view.places.filter((p) => {
        if (cityCode && p.cityCode !== cityCode) return false;
        if (!q) return true;
        return [p.name, p.cityName, p.orgPublicName].filter(Boolean).some((s) => s.toLowerCase().includes(q));
      });
    }
    const placeIds = matched.map((p) => p.id);
    const out = { snapshotId: ref.snap.id, params, places: matched, events: eventsOfPlaces(view, placeIds) };
    if (searchCache.size > 500) searchCache.clear();
    searchCache.set(cacheKey(ref.snap.id, params), out);
    return json(res, 200, out, { 'x-cache': 'miss' });
  }

  if (url.pathname === '/api/public/export') {
    const ref = resolveSnapshotRef(db, url.searchParams.get('snapshot') || 'latest');
    if (ref.error) return json(res, ref.error, ref.body);
    const view = ref.snap.payload;
    const format = url.searchParams.get('format') || 'geojson';
    const resDisposition = { 'content-disposition': `attachment; filename="volunteer-${ref.snap.id}.${format === 'csv' ? 'csv' : 'geojson'}"` };
    if (format === 'csv') {
      const rows = [['event_id', 'date', 'year', 'hours', 'role', 'title', 'granularity', 'place_name', 'public_lng', 'public_lat', 'org_public_name']];
      const placeById = Object.fromEntries(view.places.map((p) => [p.id, p]));
      for (const e of view.events) {
        const p = placeById[e.placeId];
        rows.push([e.id, e.date, e.year, e.hours, e.role || '', (e.title || '').replace(/[,\n]/g, ' '), e.granularity,
          p ? p.name : '', p ? p.coords.lng : '', p ? p.coords.lat : '', e.orgPublicName || '']);
      }
      const csv = '﻿' + rows.map((r) => r.map((c) => String(c).replace(/"/g, '""')).map((c) => `"${c}"`).join(',')).join('\n');
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', ...resDisposition });
      return res.end(csv);
    }
    const geojson = {
      type: 'FeatureCollection',
      metadata: {
        snapshotId: ref.snap.id, note: '坐标均为公开脱敏表示（city=城市质心 / grid=模糊网格 / org_point=机构授权公开点），非原始定位',
        granularityPolicy: view.granularityPolicy, stats: view.stats,
      },
      features: view.places.map((p) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.coords.lng, p.coords.lat] },
        properties: { id: p.id, kind: p.kind, granularity: p.granularity, name: p.name, cityCode: p.cityCode, eventCount: p.eventCount },
      })),
    };
    res.writeHead(200, { 'content-type': 'application/geo+json; charset=utf-8', ...resDisposition });
    return res.end(JSON.stringify(geojson, null, 2));
  }

  return json(res, 404, { error: '未知公开接口' });
}

// ----------------------------- 路由 --------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/admin/')) return await handleAdmin(req, res, url);
    if (url.pathname.startsWith('/api/public/')) return await handlePublic(req, res, url);

    if (url.pathname.startsWith('/media/')) {
      const id = decodeURIComponent(url.pathname.split('/').pop()).replace(/\.[a-z0-9]+$/i, '');
      const rec = store.data.photos[id];
      if (!rec) { res.writeHead(404); return res.end('not found'); }
      const filePath = join(MEDIA_DIR, `${id}.${rec.ext}`);
      if (!existsSync(filePath) || hasMetadataTrace(await readFile(filePath))) {
        // 双保险：任何残留元数据的派生图都不允许对外
        res.writeHead(409); return res.end('media pending sanitization');
      }
      res.writeHead(200, { 'content-type': MIME[`.${rec.ext}`] || 'application/octet-stream', 'cache-control': 'private, max-age=3600' });
      return createReadStream(filePath).pipe(res);
    }

    return await serveStatic(res, url.pathname);
  } catch (err) {
    return json(res, 500, { error: String(err && err.message || err) });
  }
});

if (process.env.VMAP_AUTOSTART === '1' && process.argv[1] === fileURLToPath(import.meta.url)) {
  await store.init(seed);
  await import('node:fs/promises').then((fs) => Promise.all([
    fs.mkdir(PRIVATE_PHOTOS, { recursive: true }),
    fs.mkdir(MEDIA_DIR, { recursive: true }),
  ]));
  // 首次启动若无快照则自动发布一份
  if (!getCurrentSnapshot(store.data)) publishSnapshot(store, '初始发布');
  server.listen(PORT, () => {
    console.log(`志愿服务地图服务: http://localhost:${PORT}/volunteer.html  管理: /admin.html`);
    if (!process.env.ADMIN_TOKEN) console.warn('警告: 未设置 ADMIN_TOKEN，使用开发默认令牌');
  });
}

export { server, store, searchCache };
