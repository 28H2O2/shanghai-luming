"""检查路名资料，按需制作可离线阅读的 HTML。只使用 Python 标准库。"""
import argparse
import base64
import json
import gzip
import hashlib
import math
import os
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data/roads.yaml"
TEMPLATE = ROOT / "templates/collection.html"
ART = ROOT / "assets/shanghai-tram.jpg"
BASEMAP = ROOT / "assets/shanghai-map.json.gz"
LANDMARKS = ROOT / "data/landmarks.json"
OUTLINE = ROOT / "data/shanghai-outline.json"
SIGNATURE = ROOT / "assets/signature.woff2"
ICON_SVG = ROOT / "assets/favicon.svg"
ICON_ICO = ROOT / "assets/favicon.ico"
MAP_STYLE = ROOT / "templates/map.css"
MAP_SCRIPT = ROOT / "templates/map.js"
OUTPUT = ROOT / "dist/index.html"
SITE = ROOT / "out"
AREAS = "老城厢 原公共租界 原法租界 虹口北外滩 江湾五角场 浦东 徐汇滨江 其他".split()
TYPES = "租界省市名 河道桥梁遗存 行业作坊 起讫型 谐音讹传 人名 纪念性改名 行政区名 当代新命名 其他".split()
STATES = ["已查证", "传说", "待考"]
REQUIRED = "name old_names district area_group naming_type story credibility sources notes".split()


def unique_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"字段 {key!r} 写了两次")
        result[key] = value
    return result


def has_text(value):
    return isinstance(value, str) and bool(value.strip())


def web_url(value):
    if not has_text(value) or any(c.isspace() or ord(c) < 32 or c == "\\" for c in value):
        return False
    try:
        url = urlsplit(value)
        _ = url.port
        return url.scheme in ("http", "https") and bool(url.hostname) and not url.username and not url.password
    except ValueError:
        return False


def source_errors(sources):
    if not isinstance(sources, list) or not sources:
        return ["至少需要一个出处，含 title 和 url"]
    errors = []
    for i, source in enumerate(sources, 1):
        if not isinstance(source, dict):
            errors.append(f"第 {i} 个出处应为对象")
            continue
        if not has_text(source.get("title")):
            errors.append(f"第 {i} 个出处缺少标题 title")
        if not web_url(source.get("url")):
            errors.append(f"第 {i} 个出处的 url 应为完整的 http(s) 链接")
        if "scope" in source and not has_text(source["scope"]):
            errors.append(f"第 {i} 个出处的 scope 应为非空文字")
    return errors


def coordinate(pair):
    if not isinstance(pair, list) or len(pair) != 2:
        return False
    if not all(type(v) in (int, float) and math.isfinite(v) for v in pair):
        return False
    lon, lat = pair
    return -180 <= lon <= 180 and -90 <= lat <= 90


def location_errors(loc):
    if not isinstance(loc, dict):
        return ["location 应为对象，尚待定位时可省略"]
    errors = []
    if loc.get("kind") not in ("line", "point", "area"):
        errors.append("location.kind 应为 line / point / area")
    if not coordinate(loc.get("point")):
        errors.append("location.point 应为 WGS84 [经度, 纬度]")
    if not has_text(loc.get("description")):
        errors.append("location.description 需说明位置与精度")
    errors.extend("location.sources：" + msg for msg in source_errors(loc.get("sources")))
    if loc.get("kind") == "line":
        paths = loc.get("paths")
        if not isinstance(paths, list) or not paths:
            errors.append("location.paths 至少需要一段道路折线")
        elif any(not isinstance(line, list) or len(line) < 2 or
                 not all(coordinate(pt) for pt in line) or
                 all(pt == line[0] for pt in line) for line in paths):
            errors.append("location.paths 每段至少需要两个不同的有效经纬度点")
    elif "paths" in loc:
        errors.append("路口或片区参考点不能填 location.paths")
    return errors


def record_errors(road):
    if not isinstance(road, dict):
        return ["应为一个记录对象"]
    errors = [f"缺少必填字段 {key}" for key in REQUIRED if key not in road]
    for key in ("name", "district"):
        if key in road and not has_text(road[key]):
            errors.append(f"{key} 不能为空，须填写文字")
    for key in ("notes", "fun_fact", "story", "pinyin"):
        if key in road and not isinstance(road[key], str):
            errors.append(f"{key} 应为文字")
    for key, choices in (("credibility", STATES), ("area_group", AREAS)):
        if key in road and road[key] not in choices:
            errors.append(f"{key} 应为以下之一：{' / '.join(choices)}")
    for key in ("old_names", "naming_type"):
        if key not in road:
            continue
        items = road[key]
        if not isinstance(items, list) or not all(has_text(item) for item in items):
            errors.append(f"{key} 应为文字列表")
        elif key == "naming_type":
            for item in items:
                if item not in TYPES:
                    errors.append(f"naming_type 的「{item}」无效；可选 {' / '.join(TYPES)}")
            if road.get("credibility") == "已查证" and not items:
                errors.append("已查证记录须填写 naming_type，未被枚举涵盖的类型可选「其他」")
    story = road.get("story")
    state = road.get("credibility")
    if isinstance(story, str):
        if state == "待考" and story.strip() not in ("", "待考"):
            errors.append("待考记录的 story 须留空或仅写「待考」")
        if state in ("已查证", "传说") and not 100 <= len("".join(story.split())) <= 200:
            errors.append("story 须为 100～200 字（含标点、略去空白）")
    if "sources" in road:
        errors.extend("sources：" + msg for msg in source_errors(road["sources"]))
    if "location" in road:
        errors.extend(location_errors(road["location"]))
    if "legend" in road:
        legend = road["legend"]
        if not isinstance(legend, dict) or not has_text(legend.get("text")):
            errors.append("附录传说 legend 需要 text 和独立的 sources")
        else:
            errors.extend("legend.sources：" + msg for msg in source_errors(legend.get("sources")))
    return errors


def read_checked(path):
    try:
        roads = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_keys)
    except json.JSONDecodeError as error:
        raise ValueError(f"第 {error.lineno} 行第 {error.colno} 列：{error.msg}。请使用 README 中的 JSON 兼容 YAML 写法。") from error
    if not isinstance(roads, list):
        raise ValueError("文件最外层须为道路列表 […]")
    errors = []
    for i, road in enumerate(roads, 1):
        name = road.get("name", "未命名") if isinstance(road, dict) else "未命名"
        errors.extend(f"第 {i} 条「{name}」：{msg}" for msg in record_errors(road))
    if errors:
        raise ValueError("\n".join(errors))
    return roads


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")


def write_output(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("wb", dir=path.parent, delete=False) as tmp:
        tmp.write(data)
    os.replace(tmp.name, path)


def site_asset(stem, suffix, data):
    digest = hashlib.sha256(data).hexdigest()[:16]
    name = f"assets/{stem}-{digest}.{suffix}"
    if not (SITE / name).is_file():
        write_output(SITE / name, data)
    return name


def web_map(geography):
    overview, local, tiles = [], [], []
    for index, (kind, name, paths) in enumerate(geography["features"]):
        xs = [x for line in paths for x in line[::2]]
        ys = [y for line in paths for y in line[1::2]]
        box = (min(xs), min(ys), max(xs), max(ys))
        feature = [index, kind, name, paths]
        # Wide features cross many views. Keep them and the two central rivers in the first paint.
        if max(box[2]-box[0], box[3]-box[1]) >= 5500 or (kind == "river" and name in ("黄浦江", "苏州河")):
            overview.append(feature)
        else:
            local.append((box, feature))

    def partition(items):
        if not items:
            return
        box = [min(b[0] for b, _ in items), min(b[1] for b, _ in items),
               max(b[2] for b, _ in items), max(b[3] for b, _ in items)]
        if len(items) > 1500:
            axis = 0 if box[2]-box[0] >= box[3]-box[1] else 1
            items.sort(key=lambda item: item[0][axis] + item[0][axis+2])
            middle = len(items) // 2
            partition(items[:middle])
            partition(items[middle:])
            return
        data = compact([feature for _, feature in items]).encode()
        tiles.append({"box": box, "url": site_asset("map", "json", data)})

    partition(local)
    return {**geography, "features": overview, "tiles": tiles}


def build(roads):
    template = TEMPLATE.read_text(encoding="utf-8")
    style = MAP_STYLE.read_text(encoding="utf-8")
    script = MAP_SCRIPT.read_text(encoding="utf-8")
    dataset = compact(dict(roads=roads, areas=AREAS, types=TYPES, states=STATES))
    geography = json.loads(gzip.decompress(BASEMAP.read_bytes()))
    geography["landmarks"] = json.loads(LANDMARKS.read_text(encoding="utf-8"))
    geography["outline"] = json.loads(OUTLINE.read_text(encoding="utf-8"))
    illustration, signature = ART.read_bytes(), SIGNATURE.read_bytes()
    icon_svg, icon_ico = ICON_SVG.read_bytes(), ICON_ICO.read_bytes()

    def render(basemap, image_url, font_url, svg_url, ico_url, offline_note):
        return (template.replace("@@CSS@@", style.replace("@@SIGNATURE@@", font_url))
                .replace("@@MAPJS@@", script).replace("@@ART@@", image_url)
                .replace("@@ICON_SVG@@", svg_url).replace("@@ICON_ICO@@", ico_url)
                .replace("@@OFFLINE_NOTE@@", offline_note)
                .replace("@@BASEMAP@@", basemap).replace("@@ARCHIVE@@", dataset).encode())

    def data_url(mime, data):
        return f"data:{mime};base64," + base64.b64encode(data).decode()

    offline = render(compact(geography), data_url("image/jpeg", illustration),
                     data_url("font/woff2", signature), data_url("image/svg+xml", icon_svg),
                     data_url("image/x-icon", icon_ico), "地图可离线浏览。")
    hosted_map = web_map(geography)
    locations = [{k: road[k] for k in ("name", "district", "location")} for road in roads if "location" in road]
    hosted_map["download"] = site_asset("geography", "json", compact(dict(geography=geography, locations=locations)).encode())
    online = render(compact(hosted_map), site_asset("tram", "jpg", illustration),
                    site_asset("signature", "woff2", signature), site_asset("favicon", "svg", icon_svg),
                    site_asset("favicon", "ico", icon_ico), "在线地图按当前视野载入街道。")
    write_output(SITE / "favicon.ico", icon_ico)
    write_output(SITE / "index.html", online)
    write_output(OUTPUT, offline)


def check(path, make_page):
    try:
        roads = read_checked(path)
        if make_page:
            build(roads)
        print(f"校验通过，共 {len(roads)} 条道路。" + (" 已生成离线单页和在线地图。" if make_page else ""), flush=True)
        return True
    except (OSError, ValueError) as error:
        print(f"校验或生成失败（{path}）\n{error}", file=sys.stderr, flush=True)
        return False


def file_stamp(path):
    try:
        stat = path.stat()
        return stat.st_mtime_ns, stat.st_size, stat.st_ino
    except FileNotFoundError:
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", nargs="?", type=Path, default=DATA, help="供单独校验的数据文件")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--build", action="store_true", help="校验并生成离线页")
    mode.add_argument("--watch", action="store_true", help="监听保存，自动校验并更新离线页")
    args = parser.parse_args()
    if (args.build or args.watch) and args.path.resolve() != DATA:
        parser.error("制作页面时请使用项目的 data/roads.yaml")
    if not args.watch:
        return 0 if check(args.path, args.build) else 1
    print("正在监听路名数据、地图与页面素材。按 Ctrl+C 结束。", flush=True)
    previous = None
    try:
        while True:
            current = tuple(file_stamp(p) for p in (DATA, LANDMARKS, OUTLINE, TEMPLATE, MAP_STYLE, MAP_SCRIPT,
                                                    ART, SIGNATURE, ICON_SVG, ICON_ICO, BASEMAP))
            if current != previous:
                previous = current
                check(DATA, True)
            time.sleep(0.45)
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
