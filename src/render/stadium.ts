// 会場（スタジアムの GLB）。背景としてだけ使い、床のコート面・ゴールは view.ts の物（sim の当たり判定と一致）。
// GLB は tools/stadium/prepare_stadium.py で作る（コート中心が原点・回転なし・ゴールとコート面は削除済み）。
//
// 色・ロゴの差し替え:
//  - BENCH_NEGZ / BENCH_POSZ の材質 → ベンチの椅子をチーム色に
//  - LOGO_* の材質 → スロットごとの DynamicTexture（エンブレム・画像・文字）に置き換え
//  - モデルに無いスロット（バックボードの帯・センターの床）はここで板を作る
// 軽さ: PBR → StandardMaterial に置き換えて freeze、ワールド行列も freeze、ピック対象外。
import {
  AssetContainer, Color3, DynamicTexture, LoadAssetContainerAsync, Mesh, MeshBuilder, PBRMaterial, Scene,
  StandardMaterial, TransformNode, Vector3, VertexData,
} from "@babylonjs/core";
import "@babylonjs/loaders/glTF";
import { BOARD } from "../sim/court";
import { LOGO_SLOTS, type LogoContent, type LogoSlot, TEAMS, type TeamBrand } from "./teams";

export type StadiumQuality = "off" | "low" | "high";
type Loaded = "low" | "high";

interface Slot {
  mat: StandardMaterial;
  tex: DynamicTexture;
  /** 背景を透かす（床のエンブレム） */
  clear: boolean;
  ver: number;
}

/** 床（コート面を消した跡）を覆う範囲: モデルの床板 25.1 x 38.1m */
const SURROUND = { w: 25.2, h: 38.2 };
const CENTER_LOGO = 3.2;

const hex = (c: Color3) => c.toHexString();

export class Stadium {
  quality: StadiumQuality = "off";
  private loaded = new Map<Loaded, Promise<AssetContainer | null>>();
  private roots = new Map<Loaded, TransformNode[]>();
  private want: StadiumQuality = "off";
  private brands: (TeamBrand & { name: string })[];
  /** 表示の −Z 側にベンチがあるチーム（＝ −Z のゴールを守るチーム） */
  private negZTeam: 0 | 1 = 0;
  private benchMat: Record<-1 | 1, StandardMaterial>;
  private slots = new Map<LogoSlot, Slot>();
  private images = new Map<string, Promise<HTMLImageElement | null>>();
  /** 会場をオンにしたときだけ出す自前の物（床の外周・ボードの帯・センターのロゴ） */
  private own: Mesh[] = [];

  constructor(private scene: Scene, names: string[]) {
    this.brands = TEAMS.map((t, i) => ({ ...t, name: t.name ?? names[i] ?? `TEAM${i + 1}` }));
    const bench = (side: -1 | 1) => {
      const m = new StandardMaterial(`bench${side}`, scene);
      m.specularColor = new Color3(0.08, 0.08, 0.08);
      return m;
    };
    this.benchMat = { [-1]: bench(-1), [1]: bench(1) } as Record<-1 | 1, StandardMaterial>;
    this.buildOwn();
    this.paintBench();
  }

  // ------------------------------------------------------------------ 公開

  /** 画質の切り替え（off / low / high）。GLB は初回だけ読み、以後は表示の切り替えだけ */
  async setQuality(q: StadiumQuality): Promise<void> {
    this.want = q;
    this.quality = q;
    for (const m of this.own) m.setEnabled(q !== "off");
    this.showOnly(q === "off" ? null : this.roots.has(q) ? q : null);
    if (q === "off" || this.roots.has(q)) return;
    const c = await this.load(q);
    if (!c) {
      if (this.want === q) { this.quality = "off"; for (const m of this.own) m.setEnabled(false); }
      return;
    }
    if (this.want === q) this.showOnly(q);
  }

  /** チームの色・名前・エンブレムを差し替える */
  setTeam(team: 0 | 1, brand: Partial<TeamBrand> & { name?: string }): void {
    this.brands[team] = { ...this.brands[team], ...brand, name: brand.name ?? this.brands[team].name };
    this.paintBench();
    this.redrawAll();
  }

  /** スロットに出すものを差し替える（LOGO_SLOTS の既定値を上書き） */
  setLogo(slot: LogoSlot, content: LogoContent): void {
    LOGO_SLOTS[slot] = content;
    const s = this.slots.get(slot);
    if (s) void this.draw(slot, s);
  }

  /** どちらのチームが表示の −Z 側にベンチを持つか（＝ −Z のゴールを守るか）。変わったときだけ塗り直す */
  setSides(negZTeam: 0 | 1): void {
    if (negZTeam === this.negZTeam) return;
    this.negZTeam = negZTeam;
    this.paintBench();
    this.redrawAll();
  }

  // ------------------------------------------------------------------ 読み込み

  private load(q: Loaded): Promise<AssetContainer | null> {
    let p = this.loaded.get(q);
    if (p) return p;
    const url = `${import.meta.env.BASE_URL}stadium/stadium-${q}.glb`;
    p = LoadAssetContainerAsync(url, this.scene)
      .then((c) => {
        c.addAllToScene();
        this.prepare(c, q);
        this.roots.set(q, c.rootNodes.filter((n): n is TransformNode => n instanceof TransformNode));
        return c;
      })
      .catch((e) => {
        console.error(`[stadium] ${url} を読めなかった`, e);
        this.loaded.delete(q);
        return null;
      });
    this.loaded.set(q, p);
    return p;
  }

  private showOnly(q: Loaded | null): void {
    for (const [k, nodes] of this.roots) for (const n of nodes) n.setEnabled(k === q);
  }

  /** 読み込んだ会場を軽くし、ベンチとロゴの材質を差し替える */
  private prepare(c: AssetContainer, q: Loaded): void {
    const conv = new Map<PBRMaterial, StandardMaterial>();
    let tris = 0;
    const check: string[] = [];
    for (const m of c.meshes) {
      m.isPickable = false;
      if (!(m instanceof Mesh) || m.getTotalIndices() === 0) continue;
      tris += m.getTotalIndices() / 3;
      const name = m.material?.name ?? "";
      if (name === "BENCH_NEGZ" || name === "BENCH_POSZ") {
        m.material = this.benchMat[name === "BENCH_NEGZ" ? -1 : 1];
        m.computeWorldMatrix(true);
        const ctr = m.getBoundingInfo().boundingBox.centerWorld;
        check.push(`${name} 中心 (${ctr.x.toFixed(2)}, ${ctr.y.toFixed(2)}, ${ctr.z.toFixed(2)})（期待 x≈+11, z の符号 ${name === "BENCH_NEGZ" ? "−" : "+"}）`);
      } else if (name.startsWith("LOGO_")) {
        const slot = name.slice(5) as LogoSlot;
        m.computeWorldMatrix(true);
        const bb = m.getBoundingInfo().boundingBox;
        const ext = bb.maximumWorld.subtract(bb.minimumWorld);
        const aspect = Math.hypot(ext.x, ext.z) / Math.max(0.01, ext.y);
        m.material = this.slot(slot, aspect, false).mat;
        const ctr = bb.centerWorld;
        check.push(`${name} 中心 (${ctr.x.toFixed(2)}, ${ctr.y.toFixed(2)}, ${ctr.z.toFixed(2)}) 横:縦=${aspect.toFixed(2)}`);
      } else if (m.material instanceof PBRMaterial) {
        let s = conv.get(m.material);
        if (!s) { s = this.toStandard(m.material); conv.set(m.material, s); }
        m.material = s;
      }
      m.freezeWorldMatrix();
      m.doNotSyncBoundingInfo = true;
    }
    for (const pbr of conv.keys()) pbr.dispose(false, false); // テクスチャは StandardMaterial が使うので残す
    console.log(`[stadium] ${q}: メッシュ ${c.meshes.length} / 三角形 ${Math.round(tris).toLocaleString()} / 材質 ${conv.size}`);
    for (const s of check) console.log(`[stadium] ${s}`);
  }

  private toStandard(p: PBRMaterial): StandardMaterial {
    const s = new StandardMaterial(p.name, this.scene);
    s.diffuseColor = p.albedoColor.clone();
    s.diffuseTexture = p.albedoTexture;
    s.specularColor = new Color3(0.04, 0.04, 0.04);
    s.alpha = p.alpha;
    s.backFaceCulling = p.backFaceCulling;
    s.transparencyMode = p.transparencyMode;
    s.useAlphaFromDiffuseTexture = p.useAlphaFromAlbedoTexture;
    s.freeze();
    return s;
  }

  // ------------------------------------------------------------------ 自前の物

  private buildOwn(): void {
    const scene = this.scene;
    // コート面を消した跡を覆う外周の床（view.ts の床 18x31 より少し下）
    const sur = MeshBuilder.CreateGround("stadiumSurround", { width: SURROUND.w, height: SURROUND.h }, scene);
    sur.position.y = -0.01;
    const sm = new StandardMaterial("stadiumSurroundm", scene);
    sm.diffuseColor = new Color3(0.1, 0.1, 0.11);
    sm.specularColor = new Color3(0.05, 0.05, 0.05);
    sm.freeze();
    sur.material = sm;
    this.own.push(sur);

    // センターのロゴ: 横の中継カメラ（−X 側から +X を見る）から正立して見える向き。
    // 画像の上 = +X（奥）、画像の右 = 前(+X) × 上(+Y) = +Z。UV は glTF と同じく v=0 が画像の上。
    const S = CENTER_LOGO, y = 0.006;
    this.own.push(this.quad("logoCENTER", (u, v) => new Vector3((0.5 - v) * S, y, (u - 0.5) * S), this.slot("CENTER", 1, true).mat));

    // バックボード上端の帯: コートからゴールを見たとき正立する向き。
    // 前 = (0,0,sg)、右 = 前 × 上 = (−sg,0,0)。ボードの前面（z = BOARD.z·sg）のすぐ手前に置く。
    const W = 1.1, H = 0.2;
    for (const sg of [-1, 1] as const) {
      const z = (BOARD.z - 0.004) * sg;
      const top = BOARD.y1 - 0.03;
      const slot: LogoSlot = sg < 0 ? "BOARD_NEGZ" : "BOARD_POSZ";
      this.own.push(this.quad(`logo${slot}`, (u, v) => new Vector3(-sg * (u - 0.5) * W, top - v * H, z), this.slot(slot, W / H, false).mat));
    }
    for (const m of this.own) {
      m.isPickable = false;
      m.freezeWorldMatrix();
      m.setEnabled(false);
    }
  }

  /** 4隅を (u,v)→位置 で決める板（回転を使わず向きをデータで決める） */
  private quad(name: string, at: (u: number, v: number) => Vector3, mat: StandardMaterial): Mesh {
    const m = new Mesh(name, this.scene);
    const c = [at(0, 0), at(1, 0), at(1, 1), at(0, 1)];
    const vd = new VertexData();
    vd.positions = c.flatMap((p) => [p.x, p.y, p.z]);
    vd.uvs = [0, 0, 1, 0, 1, 1, 0, 1];
    vd.indices = [0, 1, 2, 0, 2, 3];
    const normals: number[] = [];
    VertexData.ComputeNormals(vd.positions, vd.indices, normals);
    vd.normals = normals;
    vd.applyToMesh(m);
    m.material = mat;
    return m;
  }

  // ------------------------------------------------------------------ 色とロゴ

  private paintBench(): void {
    for (const side of [-1, 1] as const) {
      const team = side < 0 ? this.negZTeam : ((1 - this.negZTeam) as 0 | 1);
      this.benchMat[side].diffuseColor = this.brands[team].color.clone();
    }
  }

  /** スロットの材質とテクスチャ（無ければ作る）。aspect = 横/縦 */
  private slot(slot: LogoSlot, aspect: number, clear: boolean): Slot {
    let s = this.slots.get(slot);
    if (s) return s;
    const a = Math.max(0.1, Math.min(10, aspect));
    const w = a >= 1 ? Math.min(2048, Math.round(256 * a)) : 256;
    const h = a >= 1 ? 256 : Math.min(2048, Math.round(256 / a));
    const tex = new DynamicTexture(`logo${slot}tex`, { width: w, height: h }, this.scene, true);
    tex.hasAlpha = clear; // 透かすところはアルファテスト
    const mat = new StandardMaterial(`logo${slot}m`, this.scene);
    mat.diffuseTexture = tex;
    mat.emissiveColor = new Color3(1, 1, 1);
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    s = { mat, tex, clear, ver: 0 };
    this.slots.set(slot, s);
    void this.draw(slot, s);
    return s;
  }

  private redrawAll(): void {
    for (const [slot, s] of this.slots) void this.draw(slot, s);
  }

  private teamOf(c: LogoContent): (TeamBrand & { name: string }) | null {
    if ("team" in c) return this.brands[c.team];
    if ("side" in c) return this.brands[c.side < 0 ? this.negZTeam : 1 - this.negZTeam];
    return null;
  }

  private image(url: string): Promise<HTMLImageElement | null> {
    let p = this.images.get(url);
    if (!p) {
      const img = new Image();
      img.src = url.startsWith("http") || url.startsWith("/") ? url : `${import.meta.env.BASE_URL}${url}`;
      p = img.decode().then(() => img).catch(() => { console.error(`[stadium] 画像を読めなかった: ${url}`); return null; });
      this.images.set(url, p);
    }
    return p;
  }

  private async draw(slot: LogoSlot, s: Slot): Promise<void> {
    const ver = ++s.ver;
    const c = LOGO_SLOTS[slot];
    const brand = this.teamOf(c);
    const imgUrl = "image" in c ? c.image : brand?.emblem;
    const img = imgUrl ? await this.image(imgUrl) : null;
    if (ver !== s.ver) return; // 待っている間に描き直しが来た
    const ctx = s.tex.getContext() as CanvasRenderingContext2D;
    const { width: W, height: H } = s.tex.getSize();
    ctx.clearRect(0, 0, W, H);
    const bg = "bg" in c && c.bg ? c.bg : brand ? hex(brand.color.scale(0.3)) : "#15171c";
    if (!s.clear) { ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H); }

    if ("text" in c) {
      fitText(ctx, c.text, W / 2, H / 2, W * 0.9, H * 0.7, c.color ?? "#ffffff");
    } else if (brand) {
      const wide = W / H > 1.8;
      const r = wide ? H * 0.4 : Math.min(W, H) * (s.clear ? 0.48 : 0.36);
      const cx = wide ? H * 0.55 : W / 2;
      const cy = wide || s.clear || H < W * 1.15 ? H / 2 : H * 0.42;
      drawEmblem(ctx, cx, cy, r, brand, img);
      if (wide) fitText(ctx, brand.name, (cx + r + W) / 2, H / 2, W - cx - r - H * 0.3, H * 0.5, hex(brand.accent));
      else if (!s.clear && H >= W * 1.15) fitText(ctx, brand.name, W / 2, H * 0.84, W * 0.9, H * 0.12, hex(brand.accent));
    } else if (img) {
      const k = Math.min((W * 0.92) / img.width, (H * 0.92) / img.height);
      ctx.drawImage(img, (W - img.width * k) / 2, (H - img.height * k) / 2, img.width * k, img.height * k);
    }
    s.tex.update(false); // glTF と同じく v=0 が画像の上（Babylon の glTF ローダーは invertY:false）
  }
}

/** エンブレム: 画像があれば円の中に収めて描く。無ければチーム色の円に頭文字 */
function drawEmblem(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, b: TeamBrand & { name: string }, img: HTMLImageElement | null): void {
  if (img) {
    const k = Math.min((r * 2) / img.width, (r * 2) / img.height);
    ctx.drawImage(img, cx - (img.width * k) / 2, cy - (img.height * k) / 2, img.width * k, img.height * k);
    return;
  }
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = hex(b.accent);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.88, 0, Math.PI * 2);
  ctx.fillStyle = hex(b.color);
  ctx.fill();
  const words = b.name.trim().split(/\s+/);
  const ini = (words.length > 1 ? words.map((w) => w[0]).join("") : b.name).slice(0, 3).toUpperCase();
  fitText(ctx, ini, cx, cy, r * 1.4, r * 0.9, hex(b.accent));
}

function fitText(ctx: CanvasRenderingContext2D, text: string, cx: number, cy: number, maxW: number, maxH: number, color: string): void {
  let size = maxH;
  ctx.font = `900 ${size}px system-ui, sans-serif`;
  const w = ctx.measureText(text).width;
  if (w > maxW) size *= maxW / w;
  ctx.font = `900 ${size}px system-ui, sans-serif`;
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, cx, cy);
}
