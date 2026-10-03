# スタジアム（NVJ-6067 / NOI.obj, SketchUp書き出し）を Babylon 用の軽い GLB にする前処理。
#
#   "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" --background --factory-startup \
#       --python tools/stadium/prepare_stadium.py -- <NOI.obj> <出力フォルダ>
#   -> <出力フォルダ>/stadium-high.glb と stadium-low.glb
#
# やること:
#  1. コート中心が原点になるよう平行移動（回転・拡縮はしない。モデルの長辺は元から Z、上は Y）
#  2. モデルのリング・ボード・支柱と、コート面（25.1x38.1m の床・ライン）を削除
#     -> ゴールと床はゲーム側（view.ts）の物を使う。sim の当たり判定（RIM / BOARD）と一致させるため
#  3. ロゴの面を切り出し、スロット名の材質（LOGO_WALL / LOGO_AD1..4）を付けて UV を 0..1 に張り直す
#     -> 実行時にチームのエンブレム等へ差し替える（縦横比は extras.logoAspect）
#  4. ベンチの椅子（記録席側 +X の2列、センターから 2〜8.5m）を BENCH_NEGZ / BENCH_POSZ の材質に
#  5. 残りを「区画(東西南北) x 細かい物/建物」でまとめて結合（約2万オブジェクト -> 十数個）
#  6. 細かい物（客席など）だけ間引く（コートサイドは間引かない）。high / low の2段階
#
# 座標: 軸変換なしで読み込み（Blender 内も OBJ と同じ Y 上）、GLB も変換なし（export_yup=False）で書く。
#       -> GLB の座標 = OBJ の座標 - コート中心。
# ログは ASCII だけで出す（Windows の文字化け対策）。
import bpy, bmesh, sys, time
import numpy as np
from mathutils import Vector, Matrix

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
SRC = argv[0]
OUT_DIR = argv[1]
DECIMATE = {"high": 0.3, "low": 0.1}

# コート中心（OBJ 座標）: リング中心 x=12.55 / 両リングの中点 z=19.05（解析で確認済み）
CX, CZ = 12.55, 19.05
COURT_HX, COURT_HZ = 12.55 + 0.05, 19.05 + 0.05  # 削除するコート面（モデルの床板 25.1x38.1）

LOGO_MATS = {"logo2": "LOGO_WALL"}       # 壁の大型エンブレム
AD_MAT = "Copia_de_previewpooldf1"        # 記録席側の広告板（4枚）-> LOGO_AD1..4
BENCH_X = (10.4, 11.9)                    # ベンチの椅子の列（x）
BENCH_Z = (2.0, 8.5)                      # センターラインからの距離（|z|）

t0 = time.time()
def log(*a):
    print("[prep]", "%6.1fs" % (time.time() - t0), *a, flush=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
# forward=Y / up=Z は Blender の既定の向き = 変換しない
bpy.ops.wm.obj_import(filepath=SRC, use_split_objects=True, use_split_groups=True, forward_axis='Y', up_axis='Z')
objs = [o for o in bpy.data.objects if o.type == 'MESH']
log("imported", len(objs), "objects", sum(len(o.data.polygons) for o in objs), "faces")
non_identity = [o for o in objs if o.matrix_world != Matrix.Identity(4)]
log("objects with non-identity transform:", len(non_identity))
for o in non_identity:  # 念のため（あれば頂点へ焼き込む）
    if o.data.users > 1:
        o.data = o.data.copy()
    o.data.transform(o.matrix_world)
    o.matrix_world = Matrix.Identity(4)

# ---------------------------------------------------------------- 1. 平行移動
T = Matrix.Translation((-CX, 0.0, -CZ))
for me in {o.data for o in objs}:
    me.transform(T)
    me.update()

def bbox(o):
    """頂点から直接求める bbox（bound_box は depsgraph 更新まで古いので使わない）"""
    me = o.data
    co = np.empty(len(me.vertices) * 3, dtype=np.float32)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    mn, mx = co.min(0), co.max(0)
    return (float(mn[0]), float(mx[0])), (float(mn[1]), float(mx[1])), (float(mn[2]), float(mx[2]))

def mats_of(o):
    return {m.name for m in o.data.materials if m}

# 位置合わせの確認: モデルのリングがゲームの RIM（z=+-12.425, y=3.05）付近に来ているか
for o in objs:
    if mats_of(o) == {"Color_B01"} and len(o.data.polygons) < 40:
        (x0, x1), (y0, y1), (z0, z1) = bbox(o)
        log("rim-part %s x %.3f..%.3f y %.3f..%.3f z %.3f..%.3f" % (o.name.split()[0], x0, x1, y0, y1, z0, z1))

# ---------------------------------------------------------------- 2. ゴールとコート面を削除
def is_hoop(o):
    (x0, x1), (y0, y1), (z0, z1) = bbox(o)
    inside = abs(x0) < 1.0 and abs(x1) < 1.0 and min(abs(z0), abs(z1)) > 12.0 and max(abs(z0), abs(z1)) < 17.3 and z0 * z1 > 0
    return inside and (y0 > 0.8 or y1 > 2.0)

hoops = [o for o in objs if is_hoop(o)]
log("delete hoop objects", len(hoops), sum(len(o.data.polygons) for o in hoops), "faces:",
    " ".join(sorted(o.name.split()[0] for o in hoops)))
for o in hoops:
    bpy.data.objects.remove(o, do_unlink=True)
objs = [o for o in bpy.data.objects if o.type == 'MESH']

removed_floor = 0
for o in objs:
    (x0, x1), (y0, y1), (z0, z1) = bbox(o)
    if y0 > 0.03 or x1 < -COURT_HX or x0 > COURT_HX or z1 < -COURT_HZ or z0 > COURT_HZ:
        continue
    bm = bmesh.new(); bm.from_mesh(o.data)
    dels = []
    for f in bm.faces:
        vs = [v.co for v in f.verts]
        if all(v.y < 0.03 for v in vs) and abs(f.normal.y) > 0.9 and all(abs(v.x) <= COURT_HX and abs(v.z) <= COURT_HZ for v in vs):
            dels.append(f)
    if dels:
        removed_floor += len(dels)
        bmesh.ops.delete(bm, geom=dels, context='FACES')
        bm.to_mesh(o.data)
    bm.free()
log("delete court floor faces", removed_floor)
for o in [o for o in objs if len(o.data.polygons) == 0]:
    bpy.data.objects.remove(o, do_unlink=True)
objs = [o for o in bpy.data.objects if o.type == 'MESH']

# ---------------------------------------------------------------- 3. ロゴ
def split_faces(o, mat_names, new_name):
    """o の材質 mat_names の面を新しいオブジェクトへ切り出す"""
    me = o.data
    idx = {i for i, m in enumerate(me.materials) if m and m.name in mat_names}
    if not idx:
        return None
    nme = me.copy()
    for target, keep in ((nme, True), (me, False)):
        bm = bmesh.new(); bm.from_mesh(target)
        dels = [f for f in bm.faces if (f.material_index in idx) != keep]
        bmesh.ops.delete(bm, geom=dels, context='FACES')
        bm.to_mesh(target); bm.free()
    no = bpy.data.objects.new(new_name, nme)
    scene.collection.objects.link(no)
    return no

def slot_material(name, base):
    m = base.copy() if base else bpy.data.materials.new(name)
    m.name = name
    return m

UP = Vector((0, 1, 0))

def planar_uv(o):
    """面を正面から見た向きで UV を 0..1 に張る。正面 = コート中心の側（文字が鏡像にならない向き）"""
    me = o.data
    n = Vector((0, 0, 0)); c = Vector((0, 0, 0)); area = 0.0
    for p in me.polygons:
        n += p.normal * p.area
        c += p.center * p.area
        area += p.area
    c /= area
    n.y = 0
    n.normalize()
    if n.dot(Vector((-c.x, 0, -c.z))) < 0:
        n = -n
    right = (-n).cross(UP)  # 見る人の前 = -n、右 = 前 x 上（右手系）
    us = [v.co.dot(right) for v in me.vertices]; vs = [v.co.y for v in me.vertices]
    u0, u1, v0, v1 = min(us), max(us), min(vs), max(vs)
    uv = me.uv_layers.active or me.uv_layers.new(name="UVMap")
    for loop in me.loops:
        co = me.vertices[loop.vertex_index].co
        uv.data[loop.index].uv = ((co.dot(right) - u0) / (u1 - u0), (co.y - v0) / (v1 - v0))
    o["logoAspect"] = round((u1 - u0) / (v1 - v0), 4)
    log("logo %-10s center (%.2f, %.2f, %.2f) faces-toward (%.2f, %.2f, %.2f) right (%.2f, %.2f, %.2f) size %.2f x %.2f m" %
        (o.name, c.x, c.y, c.z, n.x, n.y, n.z, right.x, right.y, right.z, u1 - u0, v1 - v0))

logos = []
for o in list(objs):
    for src, slot in LOGO_MATS.items():
        if src in mats_of(o):
            lo = split_faces(o, {src}, slot)
            lo.data.materials.clear(); lo.data.materials.append(slot_material(slot, None))
            logos.append(lo)
ads = []
for o in list(objs):
    if AD_MAT in mats_of(o):
        ads.append(split_faces(o, {AD_MAT}, "AD_tmp"))
ads.sort(key=lambda a: bbox(a)[2][0])  # -Z 側から順に AD1..AD4
for i, lo in enumerate(ads):
    slot = "LOGO_AD%d" % (i + 1)
    lo.name = slot
    lo.data.materials.clear(); lo.data.materials.append(slot_material(slot, None))
    logos.append(lo)
for lo in logos:
    planar_uv(lo)
objs = [o for o in bpy.data.objects if o.type == 'MESH' and o not in logos]
for o in [o for o in objs if len(o.data.polygons) == 0]:
    bpy.data.objects.remove(o, do_unlink=True)
objs = [o for o in bpy.data.objects if o.type == 'MESH' and o not in logos]

# ---------------------------------------------------------------- 4. ベンチ
charcoal = bpy.data.materials.get("_Charcoal_")
bench_mat = {-1: slot_material("BENCH_NEGZ", charcoal), 1: slot_material("BENCH_POSZ", charcoal)}
bench = {}
for o in objs:
    if mats_of(o) != {"_Charcoal_"}:
        continue
    (x0, x1), (y0, y1), (z0, z1) = bbox(o)
    cx, cz = (x0 + x1) / 2, (z0 + z1) / 2
    if x1 - x0 < 0.8 and z1 - z0 < 0.8 and y1 < 1.0 and BENCH_X[0] <= cx <= BENCH_X[1] and BENCH_Z[0] <= abs(cz) <= BENCH_Z[1]:
        sg = 1 if cz > 0 else -1
        if o.data.users > 1:
            o.data = o.data.copy()
        for i in range(len(o.data.materials)):
            o.data.materials[i] = bench_mat[sg]
        bench[o.name] = "BENCH_POSZ" if sg > 0 else "BENCH_NEGZ"
log("bench chairs -Z:", sum(1 for v in bench.values() if v == "BENCH_NEGZ"),
    " +Z:", sum(1 for v in bench.values() if v == "BENCH_POSZ"))

# ---------------------------------------------------------------- 5. 区画ごとに結合
def category(o):
    if o.name in bench:
        return bench[o.name]
    (x0, x1), (y0, y1), (z0, z1) = bbox(o)
    cx, cz = (x0 + x1) / 2, (z0 + z1) / 2
    size = max(x1 - x0, y1 - y0, z1 - z0)
    if abs(cx) < 16 and abs(cz) < 23 and y1 < 1.6:
        return "courtside"
    sector = ("E" if cx > 0 else "W") if abs(cx) / 40 > abs(cz) / 45 else ("N" if cz > 0 else "S")
    return "%s_%s" % (sector, "detail" if size < 3.0 else "arch")

groups = {}
for o in objs:
    groups.setdefault(category(o), []).append(o)

def join_all(lst):
    """bpy.ops.object.join は数千個だと非常に遅いので、500個ずつ段階的に結合する"""
    while len(lst) > 1:
        nxt = []
        for i in range(0, len(lst), 500):
            chunk = lst[i:i + 500]
            if len(chunk) > 1:
                with bpy.context.temp_override(active_object=chunk[0], object=chunk[0], selected_objects=chunk, selected_editable_objects=chunk):
                    bpy.ops.object.join()
            nxt.append(chunk[0])
        lst = nxt
    return lst[0]

joined = []
for name, lst in sorted(groups.items()):
    faces = sum(len(o.data.polygons) for o in lst)
    j = join_all(lst)
    j.name = "STADIUM_" + name
    joined.append(j)
    (x0, x1), (y0, y1), (z0, z1) = bbox(j)
    log("join %-14s objs %6d faces %7d  x %.1f..%.1f y %.1f..%.1f z %.1f..%.1f" % (name, len(lst), faces, x0, x1, y0, y1, z0, z1))

# ---------------------------------------------------------------- 6. 間引いて書き出す（high / low）
def tri_count():
    n = 0
    for o in bpy.data.objects:
        if o.type == 'MESH':
            o.data.calc_loop_triangles()
            n += len(o.data.loop_triangles)
    return n

details = [j for j in joined if j.name.endswith("_detail")]
originals = {j.name: j.data.copy() for j in details}  # 間引く前の形（品質ごとにここから作り直す）
log("triangles before decimate", tri_count())

for q, ratio in DECIMATE.items():
    dg = bpy.context.evaluated_depsgraph_get()
    for j in details:
        old = j.data
        j.data = originals[j.name].copy()
        if old.users == 0:
            bpy.data.meshes.remove(old)
        mod = j.modifiers.new("dec", 'DECIMATE')
        mod.ratio = ratio
        mod.use_collapse_triangulate = True
        dg.update()
        me = bpy.data.meshes.new_from_object(j.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
        j.modifiers.clear()
        old = j.data
        j.data = me
        bpy.data.meshes.remove(old)
    log("[%s] objects %d triangles %d" % (q, len([o for o in bpy.data.objects if o.type == 'MESH']), tri_count()))
    out = "%s/stadium-%s.glb" % (OUT_DIR, q)
    bpy.ops.export_scene.gltf(
        filepath=out, export_format='GLB', use_selection=False, export_apply=True, export_yup=False,
        export_extras=True, export_lights=False, export_cameras=False, export_animations=False,
    )
    log("wrote", out)
