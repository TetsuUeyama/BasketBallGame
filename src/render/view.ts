// Babylon 描画。sim 層（src/sim）の状態を読んで円柱・ボール・導線・重心を描くだけ。
// 座標: sim の (x,z) → Babylon の (x, y=上, z)。右手系(useRightHandedSystem)。
// 向き: 円柱モデルの前は「ノーズ」を置いた local +Z。yaw は facing ベクトルとの差から計算し、
//       回転の符号は起動時に Babylon の実際の変換で測って決める（ハードコードしない）。
import {
  ArcRotateCamera, Color3, Color4, DirectionalLight, DynamicTexture, Engine, HemisphericLight,
  LinesMesh, Matrix, Mesh, MeshBuilder, Quaternion, Scene, StandardMaterial, TransformNode, Vector3,
} from "@babylonjs/core";
import { BALL_R, COURT, CORNER_Z, NET, RIM, netProfile } from "../sim/court";
import type { Game } from "../sim/game";
import { passFrac, passHeight } from "../sim/lanes";
import { V2, clamp, dist, len, lerp } from "../sim/math";
import type { Option } from "../sim/options";
import type { Player } from "../sim/player";
import { Stadium } from "./stadium";
import { TEAMS } from "./teams";

export type LaneMode = "handler" | "all" | "off";
export type CamMode = "side" | "top" | "behind" | "follow";

const LANE_PTS = 20;
/** リング・ネットの見た目の反応に使うボールの半径（本物 BALL_R より少し大きい。入る・入らないの判定は sim の BALL_R のまま） */
const FX_R = BALL_R + 0.05;
const TEAM_COL = TEAMS.map((t) => t.color);

interface PView {
  root: TransformNode; // 位置＋傾き（ワールド軸）
  yaw: TransformNode;  // 下半身の向き
  lowerN: TransformNode; // 下半身の付け根（足元）。前傾
  lower: Mesh;         // 下半身（足〜腰）
  upper: TransformNode; // 上半身の付け根（腰）。ひねり・前屈
  torso: Mesh;
  headN: TransformNode; // 頭（上半身の首の先。上半身とは別に向きを持つ）
  head: Mesh;
  nose: Mesh;
  mat: StandardMaterial;
  ring: Mesh;
  ringMat: StandardMaterial;
  com: Mesh;
  comMat: StandardMaterial;
  label: Mesh;
  hands: Mesh[];
  arms: LinesMesh[];
  tex: DynamicTexture;
  text: string;
}

export class View {
  engine: Engine;
  scene: Scene;
  cam: ArcRotateCamera;
  /** 会場（背景のスタジアム）。画質の切り替え・チーム色・ロゴの差し替え */
  stadium: Stadium;
  laneMode: LaneMode = "handler";
  showBalance = true;
  /** 頭の上の表示（背番号・ポジション・今やっていること） */
  showLabels = true;
  camMode: CamMode = "side";
  private pv = new Map<number, PView>();
  private ball: Mesh;
  /** ネット（縦糸と横の輪の線）と揺れ。[0]=表示の +Z 側のゴール / [1]=−Z 側 */
  private nets: LinesMesh[] = [];
  private netSwing = [{ x: 0, z: 0, vx: 0, vz: 0 }, { x: 0, z: 0, vx: 0, vz: 0 }];
  private netBulge = [0, 0];
  /** 網が下へ引っぱられる量（網の長さに対する割合）とその速さ */
  private netPull = [{ x: 0, v: 0 }, { x: 0, v: 0 }];
  /** リングの見た目の揺れの再発までの時間 */
  private rimCd = [0, 0];
  /** 表示の向き: sim は攻撃側の座標なので、Game.flip なら x,z を反転して描く */
  private F = 1;
  private camZ = 0;
  private prevBall: { x: number; y: number; z: number } | null = null;
  private lanes: LinesMesh[] = [];
  private yawSign = 1;
  private tiltSign = 1;
  private crossSign = 1;
  /** ワールド軸の回転 dq を今の回転 q の後に掛けるのが dq.multiply(q) か（calibrate で実測） */
  private worldPreMul = true;
  private ballPrev: Vector3 | null = null;
  /**
   * ゴールの揺れ（見た目だけ）。[0]=表示の +Z 側 / [1]=−Z 側。
   * bz = ボードの前後（コートの外向きが正）、by = ボードの上下（下が正）、ry = リングの沈み（下が正）。v… はその速さ
   */
  private goals: { assy: TransformNode; rimN: TransformNode; bz: number; bvz: number; by: number; bvy: number; ry: number; rvy: number }[] = [];
  private ballOmega = new Vector3(0, 0, 0);

  constructor(canvas: HTMLCanvasElement, g: Game) {
    this.engine = new Engine(canvas, true, { preserveDrawingBuffer: false, stencil: false });
    const scene = new Scene(this.engine);
    scene.useRightHandedSystem = true;
    scene.clearColor = new Color4(0.07, 0.08, 0.1, 1);
    this.scene = scene;

    this.calibrate();

    this.cam = new ArcRotateCamera("cam", 0, 1, 20, new Vector3(0, 0.5, 8), scene);
    this.cam.lowerRadiusLimit = 5;
    this.cam.upperRadiusLimit = 45;
    this.cam.wheelPrecision = 30;
    this.cam.attachControl(canvas, true);
    this.setCam("side");

    const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
    hemi.intensity = 0.75;
    const dl = new DirectionalLight("dl", new Vector3(-0.4, -1, 0.3), scene);
    dl.intensity = 0.55;

    this.buildCourt();
    this.stadium = new Stadium(scene, g.names);
    this.stadium.attachBoardLogo(1, this.goals[0].assy);
    this.stadium.attachBoardLogo(-1, this.goals[1].assy);
    this.stadium.setSides(this.negZTeam(g));
    void this.stadium.setQuality("low");
    for (const p of g.players) this.pv.set(p.id, this.buildPlayer(p));

    this.ball = MeshBuilder.CreateSphere("ball", { diameter: BALL_R * 2, segments: 16 }, scene);
    this.ball.rotationQuaternion = Quaternion.Identity();
    const bm = new StandardMaterial("ballm", scene);
    // 縫い目（経線4本＋赤道）を描いて回転が見えるように
    const btex = new DynamicTexture("balltex", { width: 256, height: 128 }, scene, true);
    const bctx = btex.getContext() as CanvasRenderingContext2D;
    bctx.fillStyle = "#e8792b";
    bctx.fillRect(0, 0, 256, 128);
    bctx.strokeStyle = "#1a1208";
    bctx.lineWidth = 4;
    bctx.beginPath();
    for (const x of [2, 66, 130, 194]) { bctx.moveTo(x, 0); bctx.lineTo(x, 128); }
    bctx.moveTo(0, 64); bctx.lineTo(256, 64);
    bctx.stroke();
    btex.update();
    bm.diffuseTexture = btex;
    bm.emissiveColor = new Color3(0.25, 0.12, 0.04);
    this.ball.material = bm;

    for (let i = 0; i < 40; i++) {
      const pts = Array.from({ length: LANE_PTS }, () => new Vector3(0, -5, 0));
      const l = MeshBuilder.CreateLines(`lane${i}`, { points: pts, updatable: true }, scene);
      l.isVisible = false;
      l.isPickable = false;
      this.lanes.push(l);
    }
  }

  /** Babylon の回転の符号を実測する（右手系での yaw と傾き） */
  private calibrate(): void {
    const m = new Matrix();
    Quaternion.RotationAxis(new Vector3(0, 1, 0), 0.5).toRotationMatrix(m);
    const v = Vector3.TransformCoordinates(new Vector3(0, 0, 1), m);
    this.yawSign = v.x > 0 ? 1 : -1;
    Quaternion.RotationAxis(new Vector3(0, 0, -1), 0.3).toRotationMatrix(m);
    const u = Vector3.TransformCoordinates(new Vector3(0, 1, 0), m);
    this.tiltSign = u.x > 0 ? 1 : -1;
    // 実際のノードで確認: facing=(+1,0) を与えたとき前(local +Z)がワールド +X を向くか
    const probe = new TransformNode("probe", this.scene);
    probe.rotationQuaternion = Quaternion.RotationAxis(new Vector3(0, 1, 0), this.yawSign * Math.atan2(1, 0));
    probe.computeWorldMatrix(true);
    const fwd = probe.getDirection(new Vector3(0, 0, 1));
    console.log(
      `[view] モデルの前 = local +Z（ノーズの位置） / yawSign=${this.yawSign} tiltSign=${this.tiltSign}` +
      ` / facing(+1,0) → world forward (${fwd.x.toFixed(3)}, ${fwd.y.toFixed(3)}, ${fwd.z.toFixed(3)})（期待値 (1,0,0)）`,
    );
    // 上半身の軸: local +Y(上) と +Z(前) が与えたベクトルを向くか、右(local +X)の外積の向きを実測で決める
    const tu = new Vector3(Math.sin(0.5), Math.cos(0.5), 0);
    const tf = new Vector3(Math.cos(0.5), -Math.sin(0.5), 0);
    let ok = false;
    for (const sgn of [1, -1]) {
      this.crossSign = sgn;
      probe.rotationQuaternion = this.basis(tu, tf);
      probe.computeWorldMatrix(true);
      const gy = probe.getDirection(new Vector3(0, 1, 0)), gz = probe.getDirection(new Vector3(0, 0, 1));
      if (Vector3.Distance(gy, tu) < 1e-3 && Vector3.Distance(gz, tf) < 1e-3) { ok = true; break; }
    }
    console.log(
      `[view] 上半身の軸: crossSign=${this.crossSign} / 前屈0.5rad・前(+X) → 上(${tu.x.toFixed(3)}, ${tu.y.toFixed(3)}, 0) 前(${tf.x.toFixed(3)}, ${tf.y.toFixed(3)}, 0)` +
      (ok ? "（一致）" : "（⚠️ 一致しない: 上半身の向きが正しく描けていない）"),
    );
    // 回転の合成の順: 「q0 の後にワールド軸の dq」が dq.multiply(q0) か q0.multiply(dq) か
    {
      const q0 = Quaternion.RotationAxis(new Vector3(1, 0, 0), 0.7);
      const dq = Quaternion.RotationAxis(new Vector3(0, 1, 0), 0.4);
      const m0 = new Matrix(), m1 = new Matrix(), mc = new Matrix();
      q0.toRotationMatrix(m0);
      dq.toRotationMatrix(m1);
      const want = Vector3.TransformCoordinates(Vector3.TransformCoordinates(new Vector3(0, 0, 1), m0), m1);
      dq.multiply(q0).toRotationMatrix(mc);
      const a = Vector3.TransformCoordinates(new Vector3(0, 0, 1), mc);
      this.worldPreMul = Vector3.Distance(a, want) < 1e-4;
      console.log(`[view] ボールの回転の合成: ${this.worldPreMul ? "dq.multiply(q)" : "q.multiply(dq)"}`);
    }
    probe.dispose();
  }

  /** local +Y を up、+Z を fwd へ向ける回転（右 = up × fwd、符号は calibrate で実測） */
  private basis(up: Vector3, fwd: Vector3): Quaternion {
    const right = Vector3.Cross(up, fwd).scaleInPlace(this.crossSign);
    return Quaternion.RotationQuaternionFromAxis(right, up, fwd);
  }

  /**
   * 表示の −Z 側のゴールを守るチーム（＝その側にベンチを置くチーム）。
   * 攻撃側は sim では +Z へ攻め、表示は F（flip なら −1）倍なので、攻撃側は表示の F 側へ攻める。
   */
  private negZTeam(g: Game): 0 | 1 {
    const F = g.flip ? -1 : 1;
    return (F > 0 ? g.offTeam : 1 - g.offTeam) as 0 | 1;
  }

  setCam(mode: CamMode): void {
    this.camMode = mode;
    const c = this.cam;
    switch (mode) {
      case "side":
        // 中継: サイドラインの外からボールに合わせて左右に追う（render で毎フレーム）
        c.target = new Vector3(0, 0.5, this.camZ);
        c.setPosition(new Vector3(-20, 12.5, this.camZ * 0.85));
        break;
      case "top":
        c.target = new Vector3(0, 0, 0);
        c.setPosition(new Vector3(0, 38, -1.5));
        break;
      case "behind":
      case "follow":
        c.target = new Vector3(0, 0.5, this.camZ);
        break;
    }
  }

  // ------------------------------------------------------------------ 構築

  private buildCourt(): void {
    const scene = this.scene;
    const ground = MeshBuilder.CreateGround("floor", { width: 18, height: 31 }, scene);
    ground.position = new Vector3(0, 0, 0);
    const gm = new StandardMaterial("floorm", scene);
    gm.diffuseColor = new Color3(0.72, 0.53, 0.33);
    gm.specularColor = new Color3(0.08, 0.08, 0.08);
    ground.material = gm;
    const pm = new StandardMaterial("paintm", scene);
    pm.diffuseColor = new Color3(0.62, 0.36, 0.24);
    pm.specularColor = new Color3(0, 0, 0);

    const y = 0.012;
    const white = new Color3(0.95, 0.95, 0.95);
    const line = (name: string, pts: Vector3[]) => {
      const l = MeshBuilder.CreateLines(name, { points: pts }, scene);
      l.color = white;
      l.isPickable = false;
    };
    const W = COURT.halfW, B = COURT.baseZ;
    line("bound", [new Vector3(-W, y, -B), new Vector3(W, y, -B), new Vector3(W, y, B), new Vector3(-W, y, B), new Vector3(-W, y, -B)]);
    line("mid", [new Vector3(-W, y, 0), new Vector3(W, y, 0)]);
    const circle = (cx: number, cz: number, r: number, n = 48) =>
      Array.from({ length: n + 1 }, (_, i) => new Vector3(cx + r * Math.cos((i / n) * Math.PI * 2), y, cz + r * Math.sin((i / n) * Math.PI * 2)));
    line("center", circle(0, 0, 1.8));
    const tmax = Math.asin(COURT.cornerX / COURT.threeR);
    const rm = new StandardMaterial("rimm", scene);
    rm.diffuseColor = new Color3(0.95, 0.35, 0.1);
    rm.emissiveColor = new Color3(0.35, 0.1, 0.02);
    const bbm = new StandardMaterial("boardm", scene);
    bbm.diffuseColor = new Color3(0.9, 0.92, 0.95);
    bbm.alpha = 0.55;
    const pom = new StandardMaterial("polem", scene);
    pom.diffuseColor = new Color3(0.25, 0.27, 0.3);

    // 両方のゴール（sg=+1 が表示の +Z 側）
    for (const sg of [1, -1]) {
      const P = (x: number, z: number) => new Vector3(x, y, z * sg);
      const arc = (cx: number, cz: number, r: number, a0: number, a1: number, n = 48) =>
        Array.from({ length: n + 1 }, (_, i) => {
          const a = lerp(a0, a1, i / n);
          return P(cx + r * Math.sin(a), cz - r * Math.cos(a));
        });
      const paint = MeshBuilder.CreateGround(`paint${sg}`, { width: COURT.paintHalfW * 2, height: B - COURT.ftZ }, scene);
      paint.position = new Vector3(0, 0.004, ((B + COURT.ftZ) / 2) * sg);
      paint.material = pm;
      line(`three${sg}`, [P(-COURT.cornerX, B), P(-COURT.cornerX, CORNER_Z), ...arc(RIM.x, RIM.z, COURT.threeR, -tmax, tmax, 64), P(COURT.cornerX, CORNER_Z), P(COURT.cornerX, B)]);
      line(`key${sg}`, [P(-COURT.paintHalfW, B), P(-COURT.paintHalfW, COURT.ftZ), P(COURT.paintHalfW, COURT.ftZ), P(COURT.paintHalfW, B)]);
      line(`ft${sg}`, arc(0, COURT.ftZ, 1.8, -Math.PI / 2, Math.PI / 2, 32));
      line(`ra${sg}`, arc(RIM.x, RIM.z, COURT.raR, -Math.PI / 2, Math.PI / 2, 24));

      // 揺れる部分: ボード・アーム・ブーム（assy）と、その中のリング（rimN）。支柱は動かない。
      // 親は原点・無回転なので、子の位置はこれまでどおりワールドの値
      const assy = new TransformNode(`goal${sg}`, scene);
      const rimN = new TransformNode(`rimN${sg}`, scene);
      rimN.parent = assy;
      this.goals[sg > 0 ? 0 : 1] = { assy, rimN, bz: 0, bvz: 0, by: 0, bvy: 0, ry: 0, rvy: 0 };
      const bb = MeshBuilder.CreateBox(`board${sg}`, { width: 1.8, height: 1.05, depth: 0.05 }, scene);
      bb.parent = assy;
      bb.position = new Vector3(0, 2.9 + 0.525, (COURT.boardZ + 0.025) * sg);
      bb.material = bbm;
      const net = MeshBuilder.CreateLineSystem(`net${sg}`, { lines: this.netLines(sg, -10, 0, this.netSwing[sg > 0 ? 0 : 1]), updatable: true }, scene);
      net.color = new Color3(0.95, 0.95, 0.95);
      net.alpha = 0.85;
      net.isPickable = false;
      this.nets[sg > 0 ? 0 : 1] = net;
      const rim = MeshBuilder.CreateTorus(`rim${sg}`, { diameter: COURT.rimR * 2, thickness: 0.025, tessellation: 32 }, scene);
      rim.position = new Vector3(RIM.x, COURT.rimH, RIM.z * sg);
      rim.material = rm;
      rim.parent = rimN;
      const arm = MeshBuilder.CreateBox(`rimarm${sg}`, { width: 0.06, height: 0.04, depth: COURT.boardZ - RIM.z - COURT.rimR }, scene);
      arm.position = new Vector3(0, COURT.rimH, ((COURT.boardZ + RIM.z + COURT.rimR) / 2) * sg);
      arm.material = rm;
      arm.parent = rimN;
      const pole = MeshBuilder.CreateBox(`pole${sg}`, { width: 0.25, height: 3.4, depth: 0.25 }, scene);
      pole.position = new Vector3(0, 1.7, (B + 1.0) * sg);
      pole.material = pom;
      const boom = MeshBuilder.CreateBox(`boom${sg}`, { width: 0.15, height: 0.15, depth: B + 1.0 - COURT.boardZ }, scene);
      boom.position = new Vector3(0, 3.3, ((B + 1.0 + COURT.boardZ) / 2) * sg);
      boom.material = pom;
      boom.parent = assy;
    }
  }

  private buildPlayer(p: Player): PView {
    const scene = this.scene;
    const root = new TransformNode(`p${p.id}`, scene);
    const yaw = new TransformNode(`p${p.id}yaw`, scene);
    yaw.parent = root;
    const mat = new StandardMaterial(`p${p.id}m`, scene);
    mat.diffuseColor = TEAM_COL[p.team];
    mat.specularColor = new Color3(0.15, 0.15, 0.15);
    // 高さ1・底が原点の円柱（高さはスケールで毎フレーム合わせる）
    const unitCyl = (name: string, parent: TransformNode): Mesh => {
      const m = MeshBuilder.CreateCylinder(name, { height: 1, diameter: p.radius * 2, tessellation: 20 }, scene);
      m.bakeTransformIntoVertices(Matrix.Translation(0, 0.5, 0));
      m.parent = parent;
      m.material = mat;
      return m;
    };
    // 下半身（足〜腰）: 足元を原点に、下半身の向きへの前傾を毎フレーム回転で与える
    const lowerN = new TransformNode(`p${p.id}lowerN`, scene);
    lowerN.parent = root;
    const lower = unitCyl(`p${p.id}lower`, lowerN);
    // 上半身（腰〜首）: 腰を原点に、ひねり・前屈を毎フレーム回転で与える
    const upper = new TransformNode(`p${p.id}upper`, scene);
    upper.parent = root;
    const torso = unitCyl(`p${p.id}torso`, upper);
    // 頭
    const head = MeshBuilder.CreateSphere(`p${p.id}head`, { diameter: 0.24, segments: 10 }, scene);
    const headN = new TransformNode(`p${p.id}headN`, scene);
    headN.parent = root;
    head.parent = headN;
    const hm = new StandardMaterial(`p${p.id}hm`, scene);
    hm.diffuseColor = new Color3(0.85, 0.72, 0.6);
    head.material = hm;
    // 目（頭の前 = local +Z）。頭の向きが上半身・足と別に見える
    const eyes = MeshBuilder.CreateBox(`p${p.id}eyes`, { width: 0.14, height: 0.045, depth: 0.05 }, scene);
    eyes.parent = headN;
    eyes.position = new Vector3(0, 0.02, 0.11);
    const em = new StandardMaterial(`p${p.id}em`, scene);
    em.diffuseColor = new Color3(0.08, 0.08, 0.1);
    em.emissiveColor = new Color3(0.05, 0.05, 0.08);
    eyes.material = em;
    // ノーズ（上半身の前 = local +Z、胸の高さ）
    const nm = new StandardMaterial(`p${p.id}nm`, scene);
    nm.diffuseColor = new Color3(0.95, 0.95, 0.95);
    nm.emissiveColor = new Color3(0.3, 0.3, 0.3);
    const nose = MeshBuilder.CreateBox(`p${p.id}nose`, { width: 0.12, height: 0.1, depth: 0.16 }, scene);
    nose.parent = upper;
    nose.material = nm;
    // つま先（下半身の前 = local +Z）。上半身をひねると胸のノーズとずれて見える
    const toe = MeshBuilder.CreateBox(`p${p.id}toe`, { width: 0.14, height: 0.06, depth: 0.14 }, scene);
    toe.parent = yaw;
    toe.position = new Vector3(0, 0.03, p.radius + 0.04);
    toe.material = nm;

    const ring = MeshBuilder.CreateTorus(`p${p.id}ring`, { diameter: 1, thickness: 0.018, tessellation: 32 }, scene);
    const ringMat = new StandardMaterial(`p${p.id}rm`, scene);
    ringMat.emissiveColor = new Color3(0.3, 0.9, 0.4);
    ringMat.disableLighting = true;
    ring.material = ringMat;
    const com = MeshBuilder.CreateCylinder(`p${p.id}com`, { diameter: 0.09, height: 0.01, tessellation: 12 }, scene);
    const comMat = new StandardMaterial(`p${p.id}cm`, scene);
    comMat.emissiveColor = new Color3(1, 1, 1);
    comMat.disableLighting = true;
    com.material = comMat;

    const label = MeshBuilder.CreatePlane(`p${p.id}label`, { width: 1.6, height: 0.8 }, scene);
    label.billboardMode = Mesh.BILLBOARDMODE_ALL;
    label.isPickable = false;
    const tex = new DynamicTexture(`p${p.id}tex`, { width: 256, height: 128 }, scene, true);
    tex.hasAlpha = true;
    const lm = new StandardMaterial(`p${p.id}lm`, scene);
    lm.diffuseTexture = tex;
    lm.emissiveColor = new Color3(1, 1, 1);
    lm.disableLighting = true;
    lm.useAlphaFromDiffuseTexture = true;
    lm.backFaceCulling = false;
    label.material = lm;

    // 手（球）と腕（肩→手の線）
    const handMat = new StandardMaterial(`p${p.id}handm`, scene);
    handMat.diffuseColor = new Color3(0.9, 0.78, 0.66);
    handMat.emissiveColor = TEAM_COL[p.team].scale(0.35);
    const hands: Mesh[] = [];
    const arms: LinesMesh[] = [];
    for (let i = 0; i < 2; i++) {
      const hm2 = MeshBuilder.CreateSphere(`p${p.id}hand${i}`, { diameter: 0.12, segments: 8 }, scene);
      hm2.material = handMat;
      hm2.isPickable = false;
      hands.push(hm2);
      const arm = MeshBuilder.CreateLines(`p${p.id}arm${i}`, { points: [Vector3.Zero(), Vector3.Zero()], updatable: true }, scene);
      arm.color = TEAM_COL[p.team].scale(1.15);
      arm.isPickable = false;
      arms.push(arm);
    }

    return { root, yaw, lowerN, lower, upper, torso, headN, head, nose, mat, ring, ringMat, com, comMat, label, tex, text: "", hands, arms };
  }

  private drawLabel(v: PView, p: Player, team: string): void {
    const action = p.labelT > 0 ? p.label : "";
    const text = `${p.d.num}|${p.d.pos}|${action}`;
    if (text === v.text) return;
    v.text = text;
    const ctx = v.tex.getContext() as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, 256, 128);
    ctx.textAlign = "center";
    ctx.font = "bold 34px sans-serif";
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(68, 6, 120, 42);
    ctx.fillStyle = team;
    ctx.fillText(`#${p.d.num} ${p.d.pos}`, 128, 40);
    if (action) {
      ctx.font = "bold 28px sans-serif";
      const w = Math.min(250, ctx.measureText(action).width + 16);
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.fillRect(128 - w / 2, 62, w, 40);
      ctx.fillStyle = "#ffe066";
      ctx.fillText(action, 128, 92);
    }
    v.tex.update();
  }

  // ------------------------------------------------------------------ 毎フレーム

  render(g: Game): void {
    const F = g.flip ? -1 : 1;
    this.F = F;
    this.stadium.setSides(this.negZTeam(g));
    this.shakeGoals(g, F);
    const holder = g.holder();
    for (const p of g.players) {
      const v = this.pv.get(p.id)!;
      v.root.position.set(p.p.x * F, p.airY(), p.p.z * F);
      // 向き: モデルの前(+Z)と facing（表示の向き）の差
      v.yaw.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), this.yawSign * Math.atan2(p.f.x * F, p.f.z * F));
      // 下半身: 足元から下半身の向き f へ前傾 lt、長さ legLen（構え・かがむで縮む）。太さは上半身と同じ
      const lt = p.lowerTilt;
      const ls = Math.sin(lt), lc = Math.cos(lt);
      v.lowerN.rotationQuaternion = this.basis(
        new Vector3(p.f.x * F * ls, lc, p.f.z * F * ls),
        new Vector3(p.f.x * F * lc, -ls, p.f.z * F * lc),
      );
      v.lower.scaling.set(1, p.legLen, 1);
      // 上半身: 腰から、ひねった向き fu へ前屈 th。軸の向きをベクトルで与える（回転角のハードコードなし）
      const fu = p.upperF();
      const th = p.trunkNow;
      const sn = Math.sin(th), cs = Math.cos(th);
      const up = new Vector3(fu.x * F * sn, cs, fu.z * F * sn);
      const fwd = new Vector3(fu.x * F * cs, -sn, fu.z * F * cs);
      // 腰（下半身の先端）から上半身
      v.upper.position.set(p.f.x * F * p.hipFwd, p.hipY, p.f.z * F * p.hipFwd);
      v.upper.rotationQuaternion = this.basis(up, fwd);
      const upperLen = p.torsoLen * (0.4 / 0.29);
      v.torso.scaling.y = upperLen;
      // 頭: 首の先（上半身の軸の先）に置き、上半身の前から headYaw だけ回した向きへ（上半身の軸に直交させる）
      const hip = new Vector3(p.f.x * F * p.hipFwd, p.hipY, p.f.z * F * p.hipFwd);
      v.headN.position.copyFrom(hip.add(up.scale(upperLen + 0.1)));
      const hf = p.headF();
      const hv = new Vector3(hf.x * F, 0, hf.z * F);
      const hfp = hv.subtract(up.scale(Vector3.Dot(hv, up)));
      if (hfp.lengthSquared() > 1e-6) v.headN.rotationQuaternion = this.basis(up, hfp.normalize());
      v.nose.position.set(0, p.torsoLen * 0.69, p.radius + 0.05);
      // 傾き: 重心のずれの向きへ（崩れているほど大きく）
      const c = { x: p.bal.c.x * F, z: p.bal.c.z * F };
      const cl = len(c);
      const R = p.supportR();
      const tilt = clamp((cl / R) * 0.16 + (p.bal.off ? 0.12 : 0), 0, 0.42);
      if (p.fallen) {
        // 転倒: 倒れた向きへ床まで（最初の0.25秒で倒れ、最後の0.35秒で起き上がる）
        const elapsed = p.fallDur - p.fallT;
        const k = Math.min(1, elapsed / 0.25, p.fallT / 0.35);
        const fd = { x: p.fallDir.x * F, z: p.fallDir.z * F };
        v.root.rotationQuaternion = Quaternion.RotationAxis(new Vector3(fd.z, 0, -fd.x), this.tiltSign * lerp(tilt, 1.38, k));
      } else if (cl > 1e-4) {
        // 重心のずれの傾き（かがむ・前屈は下半身の高さと上半身の回転で表す）
        let bx = (c.x / cl) * tilt;
        let bz = (c.z / cl) * tilt;
        if (p.staggering) {
          // ふらつき: 崩れた向きと直角に左右へよろめく（約2回/秒、選手ごとに位相をずらす）
          const w = 0.14 * Math.sin(g.t * 13 + p.id * 1.7);
          bx += (-c.z / cl) * w;
          bz += (c.x / cl) * w;
        }
        const ang = Math.hypot(bx, bz);
        v.root.rotationQuaternion = ang > 1e-4 ? Quaternion.RotationAxis(new Vector3(bz / ang, 0, -bx / ang), this.tiltSign * ang) : Quaternion.Identity();
      } else v.root.rotationQuaternion = Quaternion.Identity();

      const isOff = p.team === g.offTeam;
      v.mat.emissiveColor = p === holder ? new Color3(0.45, 0.4, 0.1) : g.off.screenerOf(p) ? new Color3(0.35, 0.35, 0.35) : isOff ? new Color3(0.06, 0.06, 0.06) : new Color3(0, 0, 0);
      v.mat.alpha = 1;

      v.ring.isVisible = this.showBalance;
      v.com.isVisible = this.showBalance;
      if (this.showBalance) {
        v.ring.position.set(p.p.x * F, 0.02, p.p.z * F);
        v.ring.scaling.set(R * 2, 1, R * 2);
        const r = p.bal.ratio;
        const col = p.staggering ? new Color3(1, 0.5, 0.05) : p.bal.off ? new Color3(1, 0.15, 0.15) : r > 0.75 ? new Color3(1, 0.8, 0.15) : new Color3(0.3, 0.9, 0.4);
        v.ringMat.emissiveColor = col;
        v.com.position.set(p.p.x * F + c.x, 0.03, p.p.z * F + c.z);
        v.comMat.emissiveColor = col;
      }

      // 腕と手にも胴体と同じ傾き（足元を支点）を掛ける。掛けないと倒れた胴体から腕が離れて見える
      const tiltM = new Matrix();
      (v.root.rotationQuaternion ?? Quaternion.Identity()).toRotationMatrix(tiltM);
      const foot = new Vector3(p.p.x * F, p.airY(), p.p.z * F);
      const tilted = (x: number, y: number, z: number): Vector3 =>
        Vector3.TransformCoordinates(new Vector3(x * F, y, z * F).subtract(foot), tiltM).addInPlace(foot);
      for (let i = 0; i < 2; i++) {
        const hw = p.handW(i);
        const sh = p.shoulder(i);
        const hv = tilted(hw.x, hw.y, hw.z);
        v.hands[i].position.copyFrom(hv);
        MeshBuilder.CreateLines(v.arms[i].name, { points: [tilted(sh.x, sh.y, sh.z), hv], instance: v.arms[i] });
      }

      v.label.isVisible = this.showLabels;
      if (this.showLabels) {
        v.label.position.set(p.p.x * F, p.a.height + 0.75 + p.airY(), p.p.z * F);
        this.drawLabel(v, p, p.team === 0 ? "#ff8a80" : "#82b1ff");
      }
    }

    const bp = g.ballPos();
    const bx = bp.p.x * F, bz = bp.p.z * F;
    this.ball.position.set(bx, bp.h, bz);
    this.spinBall(g, bx, bp.h, bz);

    this.updateNet(bx, bp.h, bz, g.ball.k === "dead" || g.ball.k === "shot" || g.ball.k === "loose");
    this.drawLanes(g);

    // カメラ: ボールに合わせて左右に追う
    const followZ = holder ? holder.p.z * F : bz;
    this.camZ = lerp(this.camZ, clamp(followZ, -9, 9), 0.04);
    const cam = this.cam;
    if (this.camMode === "side") {
      cam.target = new Vector3(0, 0.5, this.camZ);
      cam.setPosition(new Vector3(-20, 12.5, this.camZ * 0.85));
    } else if (this.camMode === "behind") {
      // 攻めている向きの後ろから（攻撃のゴールは表示の F 側）
      cam.target = new Vector3(0, 1, this.camZ + 4 * F);
      cam.setPosition(new Vector3(0, 9.5, this.camZ - 14 * F));
    } else if (this.camMode === "follow") {
      const t = holder ? { x: holder.p.x * F, z: holder.p.z * F } : { x: bx, z: bz };
      const tg = cam.target;
      cam.target = new Vector3(lerp(tg.x, t.x, 0.06), 0.5, lerp(tg.z, t.z, 0.06));
    }
    this.scene.render();
  }

  // ------------------------------------------------------------------ ボールの回転（見た目だけ）

  /**
   * シュート・パスはバックスピン（上側が進む向きと逆へ回る）、床を転がるボールは転がりの回転、
   * 空中のルーズボールは回転が残り、持っている間は止まっていく。
   */
  private spinBall(g: Game, x: number, y: number, z: number): void {
    const dt = Math.min(0.05, this.engine.getDeltaTime() / 1000);
    const prev = this.ballPrev;
    this.ballPrev = new Vector3(x, y, z);
    if (!prev || dt <= 0) return;
    const v = new Vector3((x - prev.x) / dt, 0, (z - prev.z) / dt);
    const vh = v.length();
    if (vh > 25) return; // 攻守交代などで表示の座標が飛んだ
    const up = new Vector3(0, 1, 0);
    const k = g.ball.k;
    if ((k === "shot" || k === "pass" || k === "inbound") && vh > 0.3) {
      // バックスピン 約2.5回転/秒: 軸 = 進む向き × 上（上側の点が進む向きと逆へ動く）
      this.ballOmega = Vector3.Cross(v.scale(1 / vh), up).scaleInPlace(2.5 * Math.PI * 2);
    } else if ((k === "loose" || k === "dead") && y <= BALL_R + 0.02) {
      // 床を転がる: 接地点が滑らない回転 ω = 上 × v / r
      this.ballOmega = Vector3.Cross(up, v).scaleInPlace(1 / BALL_R);
    } else if (k === "held") {
      this.ballOmega.scaleInPlace(Math.exp(-dt * 8));
    } else {
      this.ballOmega.scaleInPlace(Math.exp(-dt * 0.3));
    }
    const w = this.ballOmega.length();
    if (w < 1e-3) return;
    const dq = Quaternion.RotationAxis(this.ballOmega.scale(1 / w), w * dt);
    const q = this.ball.rotationQuaternion!;
    // ワールド軸の回転を今の向きの「後に」掛ける（掛ける順は calibrate で実測）
    this.ball.rotationQuaternion = (this.worldPreMul ? dq.multiply(q) : q.multiply(dq)).normalize();
  }

  // ------------------------------------------------------------------ リング・ボードの揺れ（見た目だけ）

  /**
   * sim が記録した当たり（g.impacts）で、リング・ボードをばねで揺らす。
   * リング: 当たると沈んで細かく震える（8Hz）。ボード: 当たると外へ押されて前後に揺れる（4.5Hz）、上下にも少し（6Hz）。
   * リングに当たってもボードは少し揺れる。強さは当たった速さに比例（ダンクは強く）。
   */
  private shakeGoals(g: Game, F: number): void {
    for (const e of g.impacts) {
      const G = this.goals[e.z * F > 0 ? 0 : 1];
      if (!G) continue;
      const sp = Math.min(16, e.speed);
      if (e.part === "rim") { G.rvy += 0.2 * sp; G.bvy += 0.04 * sp; G.bvz += 0.03 * sp; }
      else { G.bvz += 0.12 * sp; G.bvy += 0.02 * sp; }
    }
    g.impacts.length = 0;
    const dt = Math.min(0.05, this.engine.getDeltaTime() / 1000);
    // ばね x'' = −ω²x − 2ζωx'（半陰的オイラー、安定のため刻みを細かく）
    const spring = (x: number, v: number, f: number, zeta: number, h: number): [number, number] => {
      const w = 2 * Math.PI * f;
      v += (-w * w * x - 2 * zeta * w * v) * h;
      return [x + v * h, v];
    };
    const n = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / n;
    this.goals.forEach((G, i) => {
      for (let k = 0; k < n; k++) {
        [G.bz, G.bvz] = spring(G.bz, G.bvz, 4.5, 0.06, h);
        [G.by, G.bvy] = spring(G.by, G.bvy, 6, 0.08, h);
        [G.ry, G.rvy] = spring(G.ry, G.rvy, 8, 0.12, h);
      }
      G.bz = clamp(G.bz, -0.06, 0.06);
      G.by = clamp(G.by, -0.04, 0.04);
      G.ry = clamp(G.ry, -0.03, 0.08);
      const sg = i === 0 ? 1 : -1;
      G.assy.position.set(0, -G.by, G.bz * sg);
      G.rimN.position.set(0, -G.ry, 0);
    });
  }

  // ------------------------------------------------------------------ ネット

  /** ネットの形: 縦糸12本（各4節）と横の輪4段。ballY の高さで膨らみ、下ほど揺れ(sw)でずれる。sg=表示のどちらのゴールか */
  private netLines(sg: number, ballY: number, bulge: number, sw: { x: number; z: number }): Vector3[][] {
    const N = 12, SEG = 4;
    // リング・ボードの揺れに付いていく
    const gl = this.goals[sg > 0 ? 0 : 1];
    const gl2 = this.netPull[sg > 0 ? 0 : 1];
    const top = COURT.rimH - (gl ? gl.by + gl.ry : 0);
    const cz = RIM.z * sg + (gl ? gl.bz * sg : 0);
    const pt = (i: number, k: number): Vector3 => {
      const u = k / SEG; // 0=リム 1=下の口
      const a = (i / N) * Math.PI * 2 + (k % 2) * (Math.PI / N); // 網目らしく交互にずらす
      // 落ちてきたボールに引っぱられて網が下へ伸びる（下ほど大きく、ばねで戻る）
      const y = top - NET.len * u * (1 + (gl2 ? gl2.x : 0) * u);
      let r = netProfile(u); // sim と同じ網の形
      // ボールが居る高さでは網がボールを包む太さまで押し広げられる
      // 見た目の反応は本物のボールより少し大きい FX_R で（大きく膨らむ）
      const wrap = Math.exp(-(((y - ballY) / 0.18) ** 2)) * bulge;
      r += Math.max(0, FX_R + 0.012 - r) * wrap + 0.025 * wrap;
      return new Vector3(RIM.x + Math.cos(a) * r + sw.x * u * u, y, cz + Math.sin(a) * r + sw.z * u * u);
    };
    const lines: Vector3[][] = [];
    for (let i = 0; i < N; i++) {
      const l: Vector3[] = [];
      for (let k = 0; k <= SEG; k++) l.push(pt(i, k));
      lines.push(l);
    }
    for (let k = 1; k <= SEG; k++) {
      const ring: Vector3[] = [];
      for (let i = 0; i <= N; i++) ring.push(pt(i % N, k));
      lines.push(ring);
    }
    return lines;
  }

  /**
   * ボールがネットの中を通ると膨らみ・下へ引っぱられ、通った勢いで揺れて戻る（ばね）。表示の座標で受け取る。
   * 見た目の反応だけは本物のボールより少し外側（FX_R）で起こす（入る・入らないの判定は sim のまま）。
   * ボールがリングのすぐ近くを通ったときもリングを少し揺らす（同じゴールは0.3秒に1回まで）。
   */
  private updateNet(bx: number, by: number, bz: number, free: boolean): void {
    const dt = Math.min(0.05, this.engine.getDeltaTime() / 1000);
    const cur = { x: bx, y: by, z: bz };
    let vx = 0, vy = 0, vz = 0;
    if (this.prevBall && dt > 0) {
      vx = (cur.x - this.prevBall.x) / dt;
      vy = (cur.y - this.prevBall.y) / dt;
      vz = (cur.z - this.prevBall.z) / dt;
    }
    this.prevBall = cur;
    const jump = Math.hypot(vx, vz) > 25; // 攻守交代などで表示の座標が飛んだ
    for (const sg of [1, -1]) {
      const i = sg > 0 ? 0 : 1;
      const sw = this.netSwing[i];
      const dRim = Math.hypot(bx - RIM.x, bz - RIM.z * sg);
      const inNet = free && !jump && dRim < COURT.rimR + FX_R && by < COURT.rimH + FX_R && by > COURT.rimH - NET.len - FX_R;
      // 網のすぐ外を通った（外れて落ちる等）: 網の外側に当たって少し押される
      const brush = free && !jump && !inNet && dRim < COURT.rimR + FX_R + 0.12 && by < COURT.rimH && by > COURT.rimH - NET.len;
      // リムに当たって跳ねる（リムの高さのすぐ外）ときも少し揺らす
      const onRim = free && !jump && dRim < COURT.rimR + 0.3 && Math.abs(by - COURT.rimH) < 0.25 && !inNet;
      if (inNet) {
        this.netBulge[i] = Math.min(1, this.netBulge[i] + dt * 12);
        sw.vx += vx * dt * 10 + (Math.random() - 0.5) * 0.04;
        sw.vz += vz * dt * 10 + (Math.random() - 0.5) * 0.04;
        // 落ちる勢いで網が下へ引っぱられる
        if (vy < 0) this.netPull[i].v += -vy * dt * 2.2;
      } else {
        this.netBulge[i] = Math.max(0, this.netBulge[i] - dt * 4);
        if (onRim) { sw.vx += vx * dt * 2.5; sw.vz += vz * dt * 2.5; }
        if (brush) {
          const ax = (RIM.x - bx) / Math.max(1e-3, dRim), az = (RIM.z * sg - bz) / Math.max(1e-3, dRim);
          sw.vx += ax * dt * 3; sw.vz += az * dt * 3;
        }
      }
      // リングのすぐ近く（リングの管からボールの中心まで FX_R 以内）をシュート・ゴール後のボールが通った → リングを少し揺らす
      this.rimCd[i] = Math.max(0, this.rimCd[i] - dt);
      const ringD = Math.hypot(dRim - COURT.rimR, by - COURT.rimH);
      if (free && !jump && this.rimCd[i] <= 0 && ringD < FX_R + 0.0125) {
        const G = this.goals[i];
        if (G) { G.rvy += 0.08 * Math.hypot(vx, vy, vz); this.rimCd[i] = 0.3; }
      }
      // ばね（揺れて戻る）
      const k = 60, c = 5;
      sw.vx += (-k * sw.x - c * sw.vx) * dt;
      sw.vz += (-k * sw.z - c * sw.vz) * dt;
      sw.x = clamp(sw.x + sw.vx * dt, -0.18, 0.18);
      sw.z = clamp(sw.z + sw.vz * dt, -0.18, 0.18);
      const pl = this.netPull[i];
      pl.v += (-90 * pl.x - 7 * pl.v) * dt;
      pl.x = clamp(pl.x + pl.v * dt, -0.1, 0.4);
      MeshBuilder.CreateLineSystem(`net${sg}`, { lines: this.netLines(sg, inNet ? by : -10, this.netBulge[i], sw), instance: this.nets[i] });
    }
  }

  // ------------------------------------------------------------------ 導線

  private laneColor(open: number): Color3 {
    // 0=赤(消されている) → 0.5=黄 → 1=緑(通っている)
    if (open < 0.5) return new Color3(0.95, 0.2 + open * 1.3, 0.15);
    return new Color3(0.95 - (open - 0.5) * 1.5, 0.85, 0.2);
  }

  private drawLanes(g: Game): void {
    let k = 0;
    const F = this.F;
    const put = (pts0: Vector3[], col: Color3, alpha: number) => {
      if (k >= this.lanes.length) return;
      const pts = pts0.map((q) => new Vector3(q.x * F, q.y, q.z * F));
      const l = this.lanes[k++];
      const full: Vector3[] = [];
      for (let i = 0; i < LANE_PTS; i++) full.push(pts[Math.min(pts.length - 1, Math.floor((i * pts.length) / LANE_PTS))]);
      full[LANE_PTS - 1] = pts[pts.length - 1];
      MeshBuilder.CreateLines(l.name, { points: full, instance: l });
      l.color = col;
      l.alpha = alpha;
      l.isVisible = true;
    };
    const straight = (a: V2, ha: number, b: V2, hb: number): Vector3[] =>
      Array.from({ length: LANE_PTS }, (_, i) => {
        const s = i / (LANE_PTS - 1);
        return new Vector3(lerp(a.x, b.x, s), lerp(ha, hb, s), lerp(a.z, b.z, s));
      });
    const arc = (a: V2, ha: number, b: V2, hb: number, apex: number): Vector3[] =>
      Array.from({ length: LANE_PTS }, (_, i) => {
        const s = i / (LANE_PTS - 1);
        return new Vector3(lerp(a.x, b.x, s), lerp(ha, hb, s) + 4 * apex * s * (1 - s), lerp(a.z, b.z, s));
      });
    const poly = (pts: V2[], hgt: number): Vector3[] => pts.map((q) => new Vector3(q.x, hgt, q.z));

    if (this.laneMode !== "off") {
      const h = g.off.handler();
      const all: Option[] = h ? g.off.options : [];
      const topDrives = new Set(all.filter((o) => o.kind === "drive").sort((a, b) => b.value - a.value).slice(0, 3));
      const opts = all.filter((o) => o.kind !== "drive" || topDrives.has(o));
      for (const o of opts) {
        if (!o.lane || o.kind === "hold") continue;
        const L = o.lane;
        const col = this.laneColor(L.open);
        switch (o.kind) {
          case "shoot":
            put(arc(L.from.p, L.from.a.height + 0.2, RIM, COURT.rimH, 0.9 + 0.08 * dist(L.from.p, RIM)), col, 0.95);
            break;
          case "drive":
            put(poly(L.pts, 0.04), col, 0.95);
            break;
          case "post":
            // 押し込みドリブル: 今の位置からゴール下の手前まで（少し高めの線）
            put(poly(L.pts, 0.1), col, 0.95);
            break;
          case "step": {
            // ステップの線（少し高く）と、着地してからの狙い（シュートの弧／突破の線）を薄く
            put(poly(L.pts, 0.08), col, 0.95);
            const A = o.after;
            if (A?.kind === "shot") put(arc(L.target, L.from.a.height + 0.2, RIM, COURT.rimH, 0.9 + 0.08 * dist(L.target, RIM)), this.laneColor(A.open), 0.4);
            else if (A?.kind === "drive") put(poly(A.pts, 0.04), this.laneColor(A.open), 0.4);
            break;
          }
          case "pass":
          case "lead":
          case "lob": {
            // パスの種類どおりの高さ（バウンズは床で弾む・オーバーヘッドは頭上から・ロブは山なり）
            // 重力の放物線＋空気抵抗（sim と同じ関数）。u = 飛行時間の割合
            const a0 = L.pts[0];
            const Ll = dist(a0, L.target);
            const Tf = Ll / Math.max(0.1, L.speed);
            put(Array.from({ length: LANE_PTS }, (_, i) => {
              const u = i / (LANE_PTS - 1);
              const s = passFrac(u, Ll);
              return new Vector3(lerp(a0.x, L.target.x, s), passHeight(L.style, L.h0, L.endH, u, Tf), lerp(a0.z, L.target.z, s));
            }), col, o.kind === "pass" ? 0.85 : 1);
            if (this.laneMode === "all" && o.after) {
              const A = o.after;
              put(arc(L.target, 2.2, RIM, COURT.rimH, 0.8), this.laneColor(A.open), 0.35);
            }
            break;
          }
        }
        // 導線を消している守備者 → 導線の最寄り点
        if (this.laneMode === "all" && L.closer && L.open < 0.5) {
          const c = L.closer.p;
          const a = L.pts[0], b = L.pts[L.pts.length - 1];
          const abx = b.x - a.x, abz = b.z - a.z;
          const l2 = abx * abx + abz * abz || 1;
          const t = clamp(((c.x - a.x) * abx + (c.z - a.z) * abz) / l2, 0, 1);
          const q = { x: a.x + abx * t, z: a.z + abz * t };
          put(straight(c, 1.0, q, 1.0), new Color3(1, 1, 1), 0.5);
        }
      }
      // ジャンプボール: 各ジャンパーが手を合わせにいく高さ（チーム色の横線）
      for (const m of g.jumpBallMarks()) {
        const col = m.team === 0 ? new Color3(1, 0.45, 0.4) : new Color3(0.45, 0.65, 1);
        const lp = g.loosePath[0];
        if (lp) put([new Vector3(lp.x - 0.35, m.h, lp.z), new Vector3(lp.x + 0.35, m.h, lp.z)], col, 1);
      }
      // ルーズボール（リバウンド・ジャンプボール）の予測軌道
      if (g.loosePath.length > 1) {
        const lp = g.loosePath;
        put(lp.filter((_, i) => i % 2 === 0).map((q) => new Vector3(q.x, q.h, q.z)), new Color3(1, 0.65, 0.2), 0.75);
      }
      // 飛んでいるパス
      const b = g.ball;
      if (b.k === "pass") {
        const pts = Array.from({ length: LANE_PTS }, (_, i) => {
          const u = i / (LANE_PTS - 1);
          const s = passFrac(u, b.L);
          return new Vector3(lerp(b.p0.x, b.p1.x, s), passHeight(b.style, b.h0, b.h1, u, b.T), lerp(b.p0.z, b.p1.z, s));
        });
        put(pts, new Color3(1, 1, 1), 0.9);
      }
    }
    for (let i = k; i < this.lanes.length; i++) this.lanes[i].isVisible = false;
  }
}
