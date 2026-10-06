/**
 * storage.mjs —— 私有数据仓库（JSON 持久化，接口与 SQLite/PostGIS 可平替）
 *
 * 三个空间信息域严格分离：
 *  1. raw：原始定位（事件实际地点 / 机构精确原址），仅管理端可见，永不进公开响应；
 *  2. city：城市范围（质心、可选行政面 polygon、城市名），公开可安全展示；
 *  3. org-public：机构“授权公开”的信息（公开点名 + 公开名称），按授权有效期生效，
 *     撤销/过期立即从新发布快照中剔除，并吊销已发快照。
 *
 * 机构名称与位置都是“按有效期生效的版本切片”，事件只引用 orgId + 发生时间，
 * 展示时用 asOf(eventDate) 解析出当时的名称与地点——更名/搬迁只影响相应时间段的经历。
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

let _idSeq = 0;
export function genId(prefix) {
  _idSeq += 1;
  return `${prefix}_${Date.now().toString(36)}${_idSeq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export class JSONStore {
  constructor(path) {
    this.path = path;
    this.data = null;
  }

  async init(seedFn) {
    await mkdir(dirname(this.path), { recursive: true });
    if (existsSync(this.path)) {
      this.data = JSON.parse(readFileSync(this.path, 'utf8'));
    } else {
      this.data = seedFn();
      this.save();
    }
    return this.data;
  }

  save() {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }

  bump() {
    this.data.rev += 1;
    this.data.updatedAt = new Date().toISOString();
    this.save();
  }
}

// ---- 机构名称 / 地点版本切片 ---------------------------------------------
/** 取机构在某日期生效的名称（未命中任何版本时回退当前名）。 */
export function nameAsOf(org, date) {
  const v = [...(org.names || [])].sort((a, b) => b.validFrom.localeCompare(a.validFrom))
    .find((n) => n.validFrom <= date);
  return v ? v.name : org.currentName;
}

/**
 * 取机构在某日期生效的地点版本。
 * 返回 { location, public }：location 为该期精确点（私有），
 * public 为该版本是否在【该日期】已获授权（授权独立于地点版本按时间窗判断）。
 */
export function locationAsOf(org, date) {
  const locs = [...(org.locations || [])].sort((a, b) => b.validFrom.localeCompare(a.validFrom));
  const loc = locs.find((l) => l.validFrom <= date) || locs[locs.length - 1] || null;
  const authorized = !!locs.find((l) =>
    l.id === (loc && loc.id) && (l.authorizations || []).some(
      (a) => a.validFrom <= date && (a.validUntil === null || a.validUntil >= date)));
  return { location: loc, authorized };
}

/** 机构当前是否持有有效授权（发布/吊销判断用，参考日 today）。 */
export function isCurrentlyAuthorized(org, today = new Date().toISOString().slice(0, 10)) {
  return (org.locations || []).some((l) =>
    (l.authorizations || []).some((a) =>
      a.validFrom <= today && (a.validUntil === null || a.validUntil >= today)));
}

/** 当前地点版本（管理端展示/再次编辑用）。 */
export function currentLocation(org) {
  const locs = [...(org.locations || [])].sort((a, b) => b.validFrom.localeCompare(a.validFrom));
  return locs[0] || null;
}

export function seed() {
  const today = new Date().toISOString().slice(0, 10);
  return {
    rev: 1,
    updatedAt: new Date().toISOString(),
    policy: { publicGranularity: 'city', gridCellDeg: 0.1 }, // city | grid ：无授权时的默认公开粒度
    cities: [
      { code: 'beijing', name: '北京', centroid: [116.4074, 39.9042] },
      { code: 'shanghai', name: '上海', centroid: [121.4737, 31.2304] },
      { code: 'guangzhou', name: '广州', centroid: [113.2644, 23.1291] },
      { code: 'chengdu', name: '成都', centroid: [104.0665, 30.5728] },
    ],
    orgs: [
      {
        // 更名 + 搬迁 + 授权撤销 的完整时间线示例
        id: 'org_demo_aixin',
        currentName: '星原社区服务中心',
        names: [
          { validFrom: '2018-01-01', name: '爱心互助社' },
          { validFrom: '2021-06-01', name: '星原社区服务中心' },
        ],
        locations: [
          {
            id: 'loc_old', validFrom: '2018-01-01',
            raw: { lng: 116.3805, lat: 39.9122 }, cityCode: 'beijing',
            authorizations: [
              { validFrom: '2019-01-01', validUntil: '2021-05-31',
                publicPoint: [116.381, 39.912], publicName: '爱心互助社旧址服务点' },
            ],
          },
          {
            id: 'loc_new', validFrom: '2021-06-01',
            raw: { lng: 116.4692, lat: 39.9188 }, cityCode: 'beijing',
            authorizations: [
              { validFrom: '2021-06-01', validUntil: '2024-12-31',
                publicPoint: [116.4695, 39.919], publicName: '星原社区服务中心（朝阳）' },
              // 2024-12-31 后授权撤销：新快照不再出机构点，旧快照被吊销
            ],
          },
        ],
      },
      {
        id: 'org_demo_chunyu',
        currentName: '春雨长者陪护队',
        names: [{ validFrom: '2020-01-01', name: '春雨长者陪护队' }],
        locations: [
          {
            id: 'loc_chunyu', validFrom: '2020-01-01',
            raw: { lng: 121.4581, lat: 31.2045 }, cityCode: 'shanghai',
            authorizations: [], // 从未授权公开：只出上海城市质心
          },
        ],
      },
      {
        id: 'org_demo_luming',
        currentName: '鹿鸣环保行动组',
        names: [{ validFrom: '2022-01-01', name: '鹿鸣环保行动组' }],
        locations: [
          {
            id: 'loc_luming', validFrom: '2022-01-01',
            raw: { lng: 113.2735, lat: 23.1560 }, cityCode: 'guangzhou',
            authorizations: [
              { validFrom: '2022-01-01', validUntil: null,
                publicPoint: [113.275, 23.156], publicName: '鹿鸣环保行动组（天河）' },
            ],
          },
        ],
      },
    ],
    events: [
      {
        id: 'evt_2019_a', orgId: 'org_demo_aixin', date: '2019-05-18', hours: 4,
        role: '志愿者', title: '社区敬老日', summary: '陪伴社区老人共进午餐。',
        pinnedRaw: null, photoIds: [],
      },
      {
        id: 'evt_2022_a', orgId: 'org_demo_aixin', date: '2022-09-10', hours: 6,
        role: '协调人', title: '教师节助学活动', summary: '组织助学物资分发。',
        pinnedRaw: null, photoIds: [],
      },
      {
        id: 'evt_2025_a', orgId: 'org_demo_aixin', date: '2025-03-08', hours: 5,
        role: '志愿者', title: '搬迁后新址服务', summary: '新中心首次公开服务日。',
        pinnedRaw: null, photoIds: [],
      },
      {
        id: 'evt_2023_b', orgId: 'org_demo_chunyu', date: '2023-04-02', hours: 3,
        role: '志愿者', title: '长者春日陪护', summary: '', pinnedRaw: null, photoIds: [],
      },
      {
        id: 'evt_2024_b1', orgId: 'org_demo_chunyu', date: '2024-04-06', hours: 3,
        role: '志愿者', title: '春日陪护（第二期）', summary: '', pinnedRaw: null, photoIds: [],
      },
      {
        id: 'evt_2024_b2', orgId: 'org_demo_chunyu', date: '2024-04-06', hours: 3,
        role: '志愿者', title: '同一服务日的第二段记录', summary: '', pinnedRaw: null, photoIds: [],
      },
      {
        id: 'evt_2022_c', orgId: 'org_demo_luming', date: '2022-11-20', hours: 8,
        role: '领队', title: '河涌净滩行动', summary: '带领 30 人清理河岸垃圾。',
        pinnedRaw: null, photoIds: [],
      },
    ],
    photos: {},
    snapshots: {},
    voidedSnapshotIds: [],
  };
}
