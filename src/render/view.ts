// Babylon 描画。sim 層（src/sim）の状態を読んで円柱・ボール・導線・重心を描くだけ。
// 座標: sim の (x,z) → Babylon の (x, y=上, z)。右手系(useRightHandedSystem)。
// 向き: 円柱モデルの前は「ノーズ」を置いた local +Z。yaw は facing ベクトルとの差から計算し、
//       回転の符号は起動時に Babylon の実際の変換で測って決める（ハードコードしない）。
import {
  ArcRotateCamera, Color3, Color4, DirectionalLight, DynamicTexture, Engine, HemisphericLight,
  LinesMesh, Matrix, Mesh, MeshBuilder, Quaternion, Scene, StandardMaterial, TransformNode, Vector3,
} from "@babylonjs/core";
import { BALL_R, COURT, CORNER_Z, NET, RIM } from "../sim/court";
import type { Game } from "../sim/game";
import { passHeight } from "../sim/lanes";
import { V2, clamp, dist, len, lerp } from "../sim/math";
import type { Option } from "../sim/options";
import type { Player } from "../sim/player";
import { Stadium } from "./stadium";
import { TEAMS } from "./teams";

export type LaneMode = "handler" | "all" | "off";
export type CamMode = "side" | "top" | "behind" | "follow";

const LANE_PTS = 20;
const TEAM_COL = TEAMS.map((t) => t.color);

interface PView {
  root: TransformNode; // 位置＋傾き（ワールド軸）
  yaw: TransformNode;  // 向き＋構えのスケール
  body: Mesh;
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
  camMode: CamMode = "side";
  private pv = new Map<number, PView>();
  private ball: Mesh;
  /** ネット（縦糸と横の輪の線）と揺れ。[0]=表示の +Z 側のゴール / [1]=−Z 側 */
  private nets: LinesMesh[] = [];
  private netSwing = [{ x: 0, z: 0, vx: 0, vz: 0 }, { x: 0, z: 0, vx: 0, vz: 0 }];
  private netBulge = [0, 0];
  /** 表示の向き: sim は攻撃側の座標なので、Game.flip なら x,z を反転して描く */
  private F = 1;
  private camZ = 0;
  private prevBall: { x: number; y: number; z: number } | null = null;
  private lanes: LinesMesh[] = [];
  private yawSign = 1;
  private tiltSign = 1;

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
    this.stadium.setSides(this.negZTeam(g));
    void this.stadium.setQuality("low");
    for (const p of g.players) this.pv.set(p.id, this.buildPlayer(p));

    this.ball = MeshBuilder.CreateSphere("ball", { diameter: 0.24, segments: 12 }, scene);
    const bm = new StandardMaterial("ballm", scene);
    bm.diffuseColor = new Color3(0.95, 0.5, 0.12);
    bm.emissiveColor = new Color3(0.3, 0.12, 0.02);
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
    probe.dispose();
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

      const bb = MeshBuilder.CreateBox(`board${sg}`, { width: 1.8, height: 1.05, depth: 0.05 }, scene);
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
      const arm = MeshBuilder.CreateBox(`rimarm${sg}`, { width: 0.06, height: 0.04, depth: COURT.boardZ - RIM.z - COURT.rimR }, scene);
      arm.position = new Vector3(0, COURT.rimH, ((COURT.boardZ + RIM.z + COURT.rimR) / 2) * sg);
      arm.material = rm;
      const pole = MeshBuilder.CreateBox(`pole${sg}`, { width: 0.25, height: 3.4, depth: 0.25 }, scene);
      pole.position = new Vector3(0, 1.7, (B + 1.0) * sg);
      pole.material = pom;
      const boom = MeshBuilder.CreateBox(`boom${sg}`, { width: 0.15, height: 0.15, depth: B + 1.0 - COURT.boardZ }, scene);
      boom.position = new Vector3(0, 3.3, ((B + 1.0 + COURT.boardZ) / 2) * sg);
      boom.material = pom;
    }
  }

  private buildPlayer(p: Player): PView {
    const scene = this.scene;
    const root = new TransformNode(`p${p.id}`, scene);
    const yaw = new TransformNode(`p${p.id}yaw`, scene);
    yaw.parent = root;
    const h = p.a.height;
    const body = MeshBuilder.CreateCylinder(`p${p.id}body`, { height: h * 0.92, diameter: p.radius * 2, tessellation: 20 }, scene);
    body.parent = yaw;
    body.position = new Vector3(0, (h * 0.92) / 2, 0);
    const mat = new StandardMaterial(`p${p.id}m`, scene);
    mat.diffuseColor = TEAM_COL[p.team];
    mat.specularColor = new Color3(0.15, 0.15, 0.15);
    body.material = mat;
    // 頭
    const head = MeshBuilder.CreateSphere(`p${p.id}head`, { diameter: 0.24, segments: 10 }, scene);
    head.parent = yaw;
    head.position = new Vector3(0, h * 0.92 + 0.1, 0);
    const hm = new StandardMaterial(`p${p.id}hm`, scene);
    hm.diffuseColor = new Color3(0.85, 0.72, 0.6);
    head.material = hm;
    // ノーズ（前 = local +Z）
    const nose = MeshBuilder.CreateBox(`p${p.id}nose`, { width: 0.12, height: 0.1, depth: 0.16 }, scene);
    nose.parent = yaw;
    nose.position = new Vector3(0, h * 0.72, p.radius + 0.05);
    const nm = new StandardMaterial(`p${p.id}nm`, scene);
    nm.diffuseColor = new Color3(0.95, 0.95, 0.95);
    nm.emissiveColor = new Color3(0.3, 0.3, 0.3);
    nose.material = nm;

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

    return { root, yaw, body, mat, ring, ringMat, com, comMat, label, tex, text: "", hands, arms };
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
    const holder = g.holder();
    for (const p of g.players) {
      const v = this.pv.get(p.id)!;
      v.root.position.set(p.p.x * F, p.airY(), p.p.z * F);
      // 向き: モデルの前(+Z)と facing（表示の向き）の差
      v.yaw.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), this.yawSign * Math.atan2(p.f.x * F, p.f.z * F));
      const st = p.stance;
      v.yaw.scaling.set(1 + 0.22 * st, 1 - 0.14 * st, 1 + 0.22 * st);
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
      } else if (cl > 1e-4 || p.bend > 0.05) {
        // 重心のずれの傾き＋かがむ（前へ）傾き
        const bx = (cl > 1e-4 ? (c.x / cl) * tilt : 0) + p.f.x * F * p.bend * 0.7;
        const bz = (cl > 1e-4 ? (c.z / cl) * tilt : 0) + p.f.z * F * p.bend * 0.7;
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
        const col = p.bal.off ? new Color3(1, 0.15, 0.15) : r > 0.75 ? new Color3(1, 0.8, 0.15) : new Color3(0.3, 0.9, 0.4);
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

      v.label.position.set(p.p.x * F, p.a.height + 0.75 + p.airY(), p.p.z * F);
      this.drawLabel(v, p, p.team === 0 ? "#ff8a80" : "#82b1ff");
    }

    const bp = g.ballPos();
    const bx = bp.p.x * F, bz = bp.p.z * F;
    this.ball.position.set(bx, bp.h, bz);

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

  // ------------------------------------------------------------------ ネット

  /** ネットの形: 縦糸12本（各4節）と横の輪4段。ballY の高さで膨らみ、下ほど揺れ(sw)でずれる。sg=表示のどちらのゴールか */
  private netLines(sg: number, ballY: number, bulge: number, sw: { x: number; z: number }): Vector3[][] {
    const N = 12, SEG = 4;
    const top = COURT.rimH;
    const cz = RIM.z * sg;
    const pt = (i: number, k: number): Vector3 => {
      const u = k / SEG; // 0=リム 1=下の口
      const a = (i / N) * Math.PI * 2 + (k % 2) * (Math.PI / N); // 網目らしく交互にずらす
      // 網の長さは変えない（下へ伸ばさない）
      const y = top - NET.len * u;
      let r = lerp(COURT.rimR, NET.rBottom, u);
      // ボールが居る高さでは網がボールを包む太さまで押し広げられる
      const wrap = Math.exp(-(((y - ballY) / 0.13) ** 2)) * bulge;
      r += Math.max(0, BALL_R + 0.012 - r) * wrap + 0.015 * wrap;
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

  /** ボールがネットの中を通ると膨らみ、通った勢いで揺れて戻る（ばね）。表示の座標で受け取る */
  private updateNet(bx: number, by: number, bz: number, free: boolean): void {
    const dt = Math.min(0.05, this.engine.getDeltaTime() / 1000);
    const cur = { x: bx, y: by, z: bz };
    let vx = 0, vz = 0;
    if (this.prevBall && dt > 0) {
      vx = (cur.x - this.prevBall.x) / dt;
      vz = (cur.z - this.prevBall.z) / dt;
    }
    this.prevBall = cur;
    for (const sg of [1, -1]) {
      const i = sg > 0 ? 0 : 1;
      const sw = this.netSwing[i];
      const dRim = Math.hypot(bx - RIM.x, bz - RIM.z * sg);
      const inNet = free && dRim < COURT.rimR + 0.08 && by < COURT.rimH + 0.1 && by > COURT.rimH - NET.len - 0.1;
      // リムに当たって跳ねる（リムの高さのすぐ外）ときも少し揺らす
      const onRim = free && dRim < COURT.rimR + 0.3 && Math.abs(by - COURT.rimH) < 0.25 && !inNet;
      if (inNet) {
        this.netBulge[i] = Math.min(1, this.netBulge[i] + dt * 10);
        sw.vx += vx * dt * 6 + (Math.random() - 0.5) * 0.02;
        sw.vz += vz * dt * 6 + (Math.random() - 0.5) * 0.02;
      } else {
        this.netBulge[i] = Math.max(0, this.netBulge[i] - dt * 4);
        if (onRim) { sw.vx += vx * dt * 1.5; sw.vz += vz * dt * 1.5; }
      }
      // ばね（揺れて戻る）
      const k = 60, c = 5;
      sw.vx += (-k * sw.x - c * sw.vx) * dt;
      sw.vz += (-k * sw.z - c * sw.vz) * dt;
      sw.x = clamp(sw.x + sw.vx * dt, -0.12, 0.12);
      sw.z = clamp(sw.z + sw.vz * dt, -0.12, 0.12);
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
          case "pass":
          case "lead":
          case "lob": {
            // パスの種類どおりの高さ（バウンズは床で弾む・オーバーヘッドは頭上から・ロブは山なり）
            const a0 = L.pts[0];
            const Ll = dist(a0, L.target);
            put(Array.from({ length: LANE_PTS }, (_, i) => {
              const s = i / (LANE_PTS - 1);
              return new Vector3(lerp(a0.x, L.target.x, s), passHeight(L.style, L.h0, L.endH, s, Ll), lerp(a0.z, L.target.z, s));
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
          const s = i / (LANE_PTS - 1);
          return new Vector3(lerp(b.p0.x, b.p1.x, s), passHeight(b.style, b.h0, b.h1, s, b.L), lerp(b.p0.z, b.p1.z, s));
        });
        put(pts, new Color3(1, 1, 1), 0.9);
      }
    }
    for (let i = k; i < this.lanes.length; i++) this.lanes[i].isVisible = false;
  }
}
