"""坐标处理：校验、坐标系换算(WGS-84/GCJ-02)、模糊网格吸附、搜索边界量化。

安全约束：本模块输出的"吸附/质心/区域"结果才可进入公开层；
原始坐标只允许写入 service_events.raw_lat/raw_lng（私有列）。
"""
import math

GRID_SIZE = 0.05  # 模糊网格边长（度）。纬度方向约 5.5km，可推断精度上限即网格分辨率


class CoordError(ValueError):
    """坐标换算/校验错误 -> HTTP 400 COORD_CONVERSION_ERROR。"""


def _to_float(value, name):
    try:
        f = float(value)
    except (TypeError, ValueError):
        raise CoordError("坐标换算错误：%s 不是有效数字: %r" % (name, value))
    if math.isnan(f) or math.isinf(f):
        raise CoordError("坐标换算错误：%s 为 NaN/Inf" % name)
    return f


def validate_latlng(lat, lng):
    """校验经纬度范围，返回 (lat, lng) 浮点。越界抛 CoordError。"""
    lat = _to_float(lat, "lat")
    lng = _to_float(lng, "lng")
    if not -90.0 <= lat <= 90.0:
        raise CoordError("坐标换算错误：纬度越界 lat=%s（合法范围 [-90,90]）" % lat)
    if not -180.0 <= lng <= 180.0:
        raise CoordError("坐标换算错误：经度越界 lng=%s（合法范围 [-180,180]）" % lng)
    return lat, lng


# ---- GCJ-02（国测局火星坐标） <-> WGS-84 ----
_A = 6378245.0
_EE = 0.00669342162296594323


def _in_china(lat, lng):
    return 72.004 <= lng <= 137.8347 and 0.8293 <= lat <= 55.8271


def _transform_lat(x, y):
    ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * math.sqrt(abs(x))
    ret += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
    ret += (20.0 * math.sin(y * math.pi) + 40.0 * math.sin(y / 3.0 * math.pi)) * 2.0 / 3.0
    ret += (160.0 * math.sin(y / 12.0 * math.pi) + 320 * math.sin(y * math.pi / 30.0)) * 2.0 / 3.0
    return ret


def _transform_lng(x, y):
    ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * math.sqrt(abs(x))
    ret += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
    ret += (20.0 * math.sin(x * math.pi) + 40.0 * math.sin(x / 3.0 * math.pi)) * 2.0 / 3.0
    ret += (150.0 * math.sin(x / 12.0 * math.pi) + 300.0 * math.sin(x / 30.0 * math.pi)) * 2.0 / 3.0
    return ret


def wgs84_to_gcj02(lat, lng):
    lat, lng = validate_latlng(lat, lng)
    if not _in_china(lat, lng):
        return lat, lng
    dlat = _transform_lat(lng - 105.0, lat - 35.0)
    dlng = _transform_lng(lng - 105.0, lat - 35.0)
    radlat = lat / 180.0 * math.pi
    magic = math.sin(radlat)
    magic = 1 - _EE * magic * magic
    sqrtmagic = math.sqrt(magic)
    dlat = (dlat * 180.0) / ((_A * (1 - _EE)) / (magic * sqrtmagic) * math.pi)
    dlng = (dlng * 180.0) / (_A / sqrtmagic * math.cos(radlat) * math.pi)
    return lat + dlat, lng + dlng


def gcj02_to_wgs84(lat, lng):
    """迭代反解 GCJ-02 -> WGS-84；不收敛抛 CoordError。"""
    lat, lng = validate_latlng(lat, lng)
    if not _in_china(lat, lng):
        return lat, lng
    wlat, wlng = lat, lng
    for _ in range(8):
        glat, glng = wgs84_to_gcj02(wlat, wlng)
        wlat += lat - glat
        wlng += lng - glng
    glat, glng = wgs84_to_gcj02(wlat, wlng)
    if abs(glat - lat) > 1e-6 or abs(glng - lng) > 1e-6:
        raise CoordError("坐标换算错误：GCJ-02 反解不收敛")
    return round(wlat, 7), round(wlng, 7)


def to_wgs84(lat, lng, coord_system="wgs84"):
    """把指定坐标系的输入统一换算为 WGS-84 存储。未知坐标系抛 CoordError。"""
    system = (coord_system or "wgs84").lower()
    if system == "wgs84":
        return validate_latlng(lat, lng)
    if system == "gcj02":
        return gcj02_to_wgs84(*validate_latlng(lat, lng))
    raise CoordError("坐标换算错误：不支持的坐标系 %r（支持 wgs84/gcj02）" % coord_system)


# ---- 脱敏空间表示 ----

def snap_to_grid(lat, lng, size=GRID_SIZE):
    """吸附到模糊网格中心。同一网格内所有原始点得到完全相同的输出（确定性、可缓存）。"""
    lat, lng = validate_latlng(lat, lng)
    clat = (math.floor(lat / size) + 0.5) * size
    clng = (math.floor(lng / size) + 0.5) * size
    clat = min(max(clat, -90.0), 90.0)
    clng = min(max(clng, -180.0), 180.0)
    return round(clat, 6), round(clng, 6)


def quantize_bbox(min_lng, min_lat, max_lng, max_lat, size=GRID_SIZE):
    """把检索边界量化到网格整数倍：防止通过自适应 bbox 二分推断精确位置，
    同时让相近 bbox 命中同一缓存。"""
    min_lat, min_lng = validate_latlng(min_lat, min_lng)
    max_lat, max_lng = validate_latlng(max_lat, max_lng)
    if min_lng > max_lng or min_lat > max_lat:
        raise CoordError("坐标换算错误：bbox 最小值大于最大值")
    q = (
        math.floor(min_lng / size) * size,
        math.floor(min_lat / size) * size,
        math.ceil(max_lng / size) * size,
        math.ceil(max_lat / size) * size,
    )
    return tuple(round(v, 6) for v in q)


def nearest_centroid(lat, lng, centroids):
    """centroids: iterable[(name, lat, lng)]，返回最近城市 (name, lat, lng)。"""
    lat, lng = validate_latlng(lat, lng)
    best = None
    best_d = None
    for name, clat, clng in centroids:
        x = math.radians(lng - clng) * math.cos(math.radians((lat + clat) / 2.0))
        y = math.radians(lat - clat)
        d = x * x + y * y
        if best_d is None or d < best_d:
            best_d = d
            best = (name, clat, clng)
    if best is None:
        raise CoordError("坐标换算错误：无可用城市质心参考数据")
    return best


def point_in_polygon(lat, lng, ring):
    """射线法。ring: [[lng, lat], ...]（GeoJSON 顺序）。"""
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > lat) != (yj > lat):
            x_cross = (xj - xi) * (lat - yi) / (yj - yi) + xi
            if lng < x_cross:
                inside = not inside
        j = i
    return inside


def find_region(lat, lng, regions):
    """regions: iterable[dict(name=..., ring=[[lng,lat]...], rep_lat=..., rep_lng=...)]。
    命中包含面则返回之，否则返回代表点最近的面。"""
    lat, lng = validate_latlng(lat, lng)
    regions = list(regions)
    for reg in regions:
        if point_in_polygon(lat, lng, reg["ring"]):
            return reg
    best = None
    best_d = None
    for reg in regions:
        d = (lat - reg["rep_lat"]) ** 2 + (lng - reg["rep_lng"]) ** 2
        if best_d is None or d < best_d:
            best_d = d
            best = reg
    if best is None:
        raise CoordError("坐标换算错误：无可用行政区域参考数据")
    return best
