#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把混淆产物替换进热更 zip，重算 sha256/size 与 manifest。

用法：
  python3 tools/make-update.py 0.22.63                  # 发新版，产出 web-0.22.63.zip
  python3 tools/make-update.py 0.22.61 --in-place       # 原地刷新当前包（版本号/说明都不变）
  python3 tools/make-update.py 0.22.63 --notes "说明"   # 需要更新说明时显式传

约定：不传 --notes 时新版本 manifest 不带 notes（不擅自添加任何说明）；
      --in-place 时原样保留已有 notes，不修改。
      DH_ROOT 可覆盖根目录（默认 /opt/dingerhuang）。
"""
import zipfile, hashlib, json, os, re, sys
from datetime import datetime, timezone

ROOT = os.environ.get('DH_ROOT', '/opt/dingerhuang')
UPD = os.path.join(ROOT, 'updates')
DIST = os.path.join(ROOT, 'dist')
WEB = os.path.join(ROOT, 'web')

args = sys.argv[1:]
if not args:
    raise SystemExit('用法: make-update.py <版本号> [--in-place] [--notes "说明"]')
ver = args[0]
in_place = '--in-place' in args
notes = args[args.index('--notes') + 1] if '--notes' in args else None


def vkey(name):
    m = re.search(r'web-([0-9.]+)\.zip$', name)
    return tuple(int(x) for x in m.group(1).split('.')) if m else ()


zips = [n for n in os.listdir(UPD) if vkey(n)]
if not zips:
    raise SystemExit('updates/ 里没有热更包')
base = max(zips, key=vkey)
dst = os.path.join(UPD, base if in_place else 'web-%s.zip' % ver)

# 混淆产物 → 包内条目
REPLACE = {}
for n in ('app.js', 'update.js'):
    p = os.path.join(DIST, 'web', n)
    if os.path.exists(p):
        REPLACE[n] = p
for f in ('game.js', 'cards.js', 'evaluator.js', 'ai.js', 'split.js'):
    p = os.path.join(DIST, 'engine', f)
    if os.path.exists(p):
        REPLACE['engine/' + f] = p
REPLACE['index.html'] = os.path.join(WEB, 'index.html')
# 样式表也要随包更新（否则改了布局/CSS 后热更包里仍是旧样式）
_css = os.path.join(WEB, 'style.css')
if os.path.exists(_css):
    REPLACE['style.css'] = _css

if 'app.js' not in REPLACE or 'update.js' not in REPLACE:
    raise SystemExit('缺少混淆产物，请先跑 obfuscate.mjs')

# 护栏：0.22.43 基座带来的闪白屏修复 / 热更闸门 / 地址注入，发版时不能丢
MUST_KEEP = ['id="dh-boot"', '__DH_WS__', '__dhHoldGate', 'html.dh-boot', 'html.dh-ready']
_html = open(REPLACE['index.html'], encoding='utf-8').read()
_missing = [k for k in MUST_KEEP if k not in _html]
if _missing:
    raise SystemExit('index.html 丢失基座安全措施: %s' % ', '.join(_missing))

# 发新版时同步 index.html 的 data-ver（原地刷新模式不动）
if not in_place:
    hp = os.path.join(WEB, 'index.html')
    html = open(hp, encoding='utf-8').read()
    html2, n = re.subn(r'data-ver="[0-9.]+"', 'data-ver="%s"' % ver, html, count=1)
    if n != 1:
        raise SystemExit('index.html 里找不到 data-ver')
    open(hp, 'w', encoding='utf-8').write(html2)
    REPLACE['index.html'] = hp

tmp = dst + '.tmp'
with zipfile.ZipFile(os.path.join(UPD, base)) as zin, \
     zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as zout:
    names = zin.namelist()
    for item in zin.infolist():
        # 跳过历史遗留的 .bak 备份文件，不把它们带进发布包
        if '.bak' in item.filename:
            continue
        data = (open(REPLACE[item.filename], 'rb').read()
                if item.filename in REPLACE else zin.read(item.filename))
        zout.writestr(item, data)
    for n in REPLACE:
        assert n in names, '基底包缺少 %s' % n
os.replace(tmp, dst)

# 包内 js 必须与混淆产物逐字节一致
with zipfile.ZipFile(dst) as z:
    for name, p in REPLACE.items():
        assert z.read(name) == open(p, 'rb').read(), '包内 %s 不是混淆产物' % name
    html = z.read('index.html').decode('utf-8')
    assert 'data-ver="%s"' % ver in html, 'index.html 的 data-ver 与 %s 不一致' % ver

sha = hashlib.sha256(open(dst, 'rb').read()).hexdigest()
size = os.path.getsize(dst)
mp = os.path.join(UPD, 'manifest.json')
manifest = json.load(open(mp, encoding='utf-8')) if os.path.exists(mp) else {}
cur = manifest.get('android', {})
entry = {
    'version': ver,
    'file': os.path.basename(dst),
    'sha256': sha,
    'size': size,
    'minNative': cur.get('minNative', 14),
    'publishedAt': datetime.now(timezone.utc).isoformat(),
}
if notes:
    entry['notes'] = notes
elif in_place and cur.get('notes'):
    entry['notes'] = cur['notes']          # 原样保留，不改说明
manifest['android'] = entry
with open(mp, 'w', encoding='utf-8') as f:
    json.dump(manifest, f, ensure_ascii=False, indent=2)

print('包:', os.path.basename(dst), ' 条目', len(names))
print('sha256:', sha)
print('size:', size)
print('manifest 已更新；notes:', '有' if entry.get('notes') else '无')
