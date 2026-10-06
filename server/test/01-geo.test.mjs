import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wgs84ToGcj02, gcj02ToWgs84, toWgs84, gridCell, pointInPolygon, normalizeBbox,
} from '../../shared/geo.mjs';

test('坐标换算：WGS84↔GCJ02 往返一致，国内偏移量正确', () => {
  // 天安门（公开基准数据，WGS84 ≈ 116.3972,39.9087；GCJ02 ≈ 116.3908,39.9010 附近，
  // 偏移约 500~600m，是中国底图最常见的“坐标错误”来源）
  const w = [116.3972, 39.9087];
  const [gLng, gLat] = wgs84ToGcj02(w[0], w[1]);
  const dLngM = (gLng - w[0]) * 97300; // 该纬度 1° 经度 ≈ 85km -> 用近似换算检验量级
  const dLatM = (gLat - w[1]) * 111000;
  const offsetM = Math.hypot(dLngM, dLatM);
  assert.ok(offsetM > 300 && offsetM < 900, `预期偏移 300~900m，实际 ${offsetM.toFixed(1)}m`);

  // 反算往返误差 < 10cm
  const [bLng, bLat] = gcj02ToWgs84(gLng, gLat);
  assert.ok(Math.abs(bLng - w[0]) * 97300 < 0.1, '经度往返误差应 < 10cm');
  assert.ok(Math.abs(bLat - w[1]) * 111000 < 0.1, '纬度往返误差应 < 10cm');
});

test('坐标换算：境外点不做加偏（避免把境外点位改错）', () => {
  const [lng, lat] = wgs84ToGcj02(-73.9857, 40.7484); // 纽约帝国大厦
  assert.equal(lng, -73.9857);
  assert.equal(lat, 40.7484);
});

test('录入归一：GCJ02 录入点经 toWgs84 后与 WGS84 录入等价（同一物理位置）', () => {
  const wgs = [121.4737, 31.2304];
  const [gLng, gLat] = wgs84ToGcj02(...wgs);
  const back = toWgs84(gLng, gLat, 'gcj02');
  assert.ok(Math.abs(back[0] - wgs[0]) < 1e-6);
  assert.ok(Math.abs(back[1] - wgs[1]) < 1e-6);
  assert.deepEqual(toWgs84(wgs[0], wgs[1], 'wgs84'), wgs);
  assert.throws(() => toWgs84(200, 0), /超出/);
});

test('模糊网格：同片区点吸附到同一质心，且质心不等于原始点', () => {
  const a = gridCell(116.401, 39.905);
  const b = gridCell(116.409, 39.909);
  assert.equal(a.cellId, b.cellId);
  assert.ok(Math.abs(a.lng - 116.401) > 0.01 || Math.abs(a.lat - 39.905) > 0.01);
});

test('行政面包含判定（ray casting）', () => {
  const square = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.equal(pointInPolygon(5, 5, square), true);
  assert.equal(pointInPolygon(15, 5, square), false);
});

test('搜索边界：过小 bbox 被拒绝，合法 bbox 吸附到网格（防套点 + 缓存归一）', () => {
  assert.throws(() => normalizeBbox({ west: 116, south: 39, east: 116.001, north: 39.001 }), /范围过小/);
  const norm = normalizeBbox({ west: 115.971, south: 38.97, east: 117.41, north: 40.12 });
  const isSnapped = (v) => Math.abs(v / 0.05 - Math.round(v / 0.05)) < 1e-9;
  assert.ok(isSnapped(norm.west) && isSnapped(norm.north));
  assert.throws(() => normalizeBbox({ west: 10, south: 20, east: 9, north: 21 }), /方向非法/);
});
