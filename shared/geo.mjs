/**
 * geo.mjs —— 坐标与空间表示的唯一事实来源（浏览器 + Node 共用 ESM）
 *
 * 隐私原则：
 *  - 原始定位（raw，WGS84）只允许存于私有库，公开层一律使用本模块派生的脱敏表示。
 *  - 公开表示三档：city（城市质心/城市范围）/ grid（模糊网格）/ org_point（机构授权公开点）。
 *  - 中国境内坐标存在 GCJ-02 偏移，入库/出图都经过本模块换算，杜绝“底图在中国偏移几百米”的换算错误。
 */

export const COORD_SYSTEMS = { WGS84: 'wgs84', GCJ02: 'gcj02' };

// ---- GCJ-02 火星坐标（国测局加偏）换算 -----------------------------------
const GCJ_A = 6378245.0;
const GCJ_EE = 0.00669342162296594323;

function outOfChina(lng, lat) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * Math.PI) + 160.0 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * Math.PI) + 150.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) / 3.0;
  return ret;
}

/** WGS84(GPS/原始) -> GCJ02(高德/腾讯等国内底图)。中国境外原样返回。 */
export function wgs84ToGcj02(lng, lat) {
  if (outOfChina(lng, lat)) return [lng, lat];
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - GCJ_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic)) * Math.PI);
  dLng = (dLng * 180.0) / ((GCJ_A / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return [lng + dLng, lat + dLat];
}

/** GCJ02 -> WGS84（管理页录入国内底图点时使用），迭代反算，境外原样返回。 */
export function gcj02ToWgs84(lng, lat) {
  if (outOfChina(lng, lat)) return [lng, lat];
  let wLng = lng;
  let wLat = lat;
  for (let i = 0; i < 5; i++) {
    const [gLng, gLat] = wgs84ToGcj02(wLng, wLat);
    wLng += lng - gLng;
    wLat += lat - gLat;
  }
  return [wLng, wLat];
}

/**
 * 统一入口：把任意坐标系的录入点归一为 WGS84 原始存储坐标。
 * @param source 录入坐标系统：'wgs84'(GPS/相机) | 'gcj02'(国内底图拾取)
 */
export function toWgs84(lng, lat, source = COORD_SYSTEMS.WGS84) {
  if (typeof lng !== 'number' || typeof lat !== 'number' || Number.isNaN(lng) || Number.isNaN(lat)) {
    throw new Error('坐标必须为数字');
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) throw new Error('坐标超出经纬度范围');
  return source === COORD_SYSTEMS.GCJ02 ? gcj02ToWgs84(lng, lat) : [lng, lat];
}

/**
 * 模糊网格：把原始点吸附到固定大小（默认约 11km）的网格单元质心。
 * 单元越大，辨识度越低、可推断风险越小。返回 WGS84 网格质心。
 */
export function gridCell(lng, lat, cellDeg = 0.1) {
  const wLng = Math.floor(lng / cellDeg) * cellDeg + cellDeg / 2;
  const wLat = Math.floor(lat / cellDeg) * cellDeg + cellDeg / 2;
  return {
    level: 'grid',
    cellDeg,
    cellId: `G${cellDeg}_${Math.floor(lng / cellDeg)}_${Math.floor(lat / cellDeg)}`,
    lng: Number(wLng.toFixed(6)),
    lat: Number(wLat.toFixed(6)),
  };
}

/** 点在多边形内（ray casting），用于城市面包含判定。 */
export function pointInPolygon(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** 等距圆柱投影（离线降级示意图用；按中心点纬度修正 x 比例）。 */
export function projectEquirect(lng, lat, centerLng, centerLat) {
  return {
    x: (lng - centerLng) * Math.cos((centerLat * Math.PI) / 180),
    y: lat - centerLat,
  };
}

/**
 * 公开空间搜索边界归一化：
 *  - bbox 必须达到最小面积（防止“画一个极小框套出精确点”）；
 *  - 边界吸附到吸附网格，缓存键与边界一致，修订后因快照版本变化自然不命中旧缓存。
 */
export function normalizeBbox(b, { minArea = 0.04, snapDeg = 0.05 } = {}) {
  const west = Number(b.west), south = Number(b.south), east = Number(b.east), north = Number(b.north);
  if ([west, south, east, north].some((n) => Number.isNaN(n))) throw new Error('bbox 参数非法');
  if (west >= east || south >= north) throw new Error('bbox 方向非法');
  const area = (east - west) * (north - south);
  if (area < minArea) {
    throw new Error(`查询范围过小（最小面积 ${minArea} 经纬度²，约 500km²），拒绝精确套点查询`);
  }
  const snap = (v) => Math.round(v / snapDeg) * snapDeg;
  return {
    west: Number(snap(west).toFixed(4)),
    south: Number(snap(south).toFixed(4)),
    east: Number(snap(east).toFixed(4)),
    north: Number(snap(north).toFixed(4)),
  };
}

/** 公开坐标的显示坐标系换算（WGS84 存储 -> GCJ02 国内底图）。 */
export function publicToDisplay(lng, lat) {
  return wgs84ToGcj02(lng, lat);
}
