// 攻撃AI。ハンドラーは毎判断で全導線を評価して行動を選ぶ。
// オフボールは「自分への導線（パス×キャッチ後）」が最大になる位置へ動き、ディナイされたらバックドア。
// セットオフェンス（plays.ts）はスクリーン・カット・ハンドオフで導線を作る仕掛け。
import { n } from "./attrs";
import { RIM, SPOT, distRim, inCourt, isThree, perimeterSpots } from "./court";
import { ActiveMove, MoveId, chooseMove, readDefender, startMove, stepMove, MOVES } from "./duel";
import { SHOT_LABEL, ShotType, chooseShotType, contValue, finishPoint, holdValue, releaseHeight, releaseTime, shotEV, shotTypeRel } from "./eval";
import { COURT } from "./court";
import type { Game } from "./game";
import { Lane, LaneCtx, PASS_LABEL, bestPassLane, driveLane, passLane, passMinOpen, shotLane } from "./lanes";
import { V, V2, add, angleBetween, clamp, copy, dirTo, dist, dot, len, madd, mul, norm, right, rot, sub } from "./math";
import { CutInfo, Option, StepPlan, bestOf, evalOptions, receiveValue } from "./options";
import { PASS_ARC, Player, TWIST_MAX, Team } from "./player";
import { CallId, Play, chooseCall, createPlay } from "./plays";
import { Obstacle } from "./reach";
import { CUT_RATE, offRole, rimCrowd, roleSpots } from "./roles";
import { distToSeg } from "./math";

export type OffMode = "spot" | "screen" | "cut" | "roll" | "pop" | "crash" | "safety" | "handoff";
export type AfterScreen = "roll" | "pop" | "spot";

export interface OffState {
  mode: OffMode;
  /** 今の持ち場 */
  spot: V2;
  /** 本来の持ち場（リロケートしても戻れるように） */
  home: V2;
  path: V2[] | null;
  pathI: number;
  lob: boolean;
  endH: number;
  screenFor: Player | null;
  /** スクリーンを使う人が向かう先（スクリーナーはその守備者の進路に立つ） */
  screenDest: V2 | null;
  setT: number;
  used: boolean;
  holdMax: number;
  after: AfterScreen;
  afterSpot: V2 | null;
  t: number;
  relocT: number;
  waitT: number;
  /** セットプレーが動かしている（自動のカット等をしない） */
  scripted: boolean;
  /** スクリーンをセットした位置 */
  setPos: V2 | null;
  /** 持ち場での微調整（ずらし量と次に変えるまでの時間） */
  micro: V2;
  microT: number;
}

export interface HState {
  dribbled: boolean;
  catchT: number;
  move: ActiveMove | null;
  drive: { path: V2[]; i: number; t: number; re: number; force: boolean } | null;
  /** forced = 押し込めず無理に打つ（マークを背負ったまま＝ブロックされやすい） */
  shooting: { t: number; rel: number; jumped: boolean; type: ShotType; forced?: boolean } | null;
  passing: { t: number; rel: number; lane: Lane; jumped?: boolean } | null;
  decideT: number;
  lastMoveT: number;
  /** セットプレーが指示するドリブルの経路 */
  goal: V2[] | null;
  goalI: number;
  lastPasser: Player | null;
  lastPassT: number;
  holdT: number;
  /** 手渡し（DHO）の相手 */
  handoffTo: Player | null;
  /** ステップ導線で始めたムーブの見込み（着地後の判断のログ用） */
  stepPlan: StepPlan | null;
  /** 押し込みドリブル中（経過・前回確認したリムまでの距離・確認までの時間・パスを見直すまでの時間） */
  post: { t: number; lastD: number; checkT: number; re: number } | null;
  /** 押し込みに失敗した時刻（すぐに同じ押し込みを繰り返さない） */
  postFailT: number;
}

const newHState = (t: number): HState => ({
  dribbled: false, catchT: t, move: null, drive: null, shooting: null, passing: null, decideT: 0.15,
  lastMoveT: -9, goal: null, goalI: 0, lastPasser: null, lastPassT: -9, holdT: 0, handoffTo: null, stepPlan: null, post: null, postFailT: -9,
});

export class Offense {
  g: Game;
  team: Team = 0;
  pl: Player[] = [];
  st = new Map<Player, OffState>();
  hs: HState = newHState(0);
  call: CallId = "MOTION";
  play: Play | null = null;
  handler0!: Player;
  /** スローインで外から入れる人 */
  inbounder: Player | null = null;
  private ibThrown = false;
  private ibDecideT = 0;
  /** 今のルーズボールはシュートのリバウンドか（役割どおりに動く） */
  private reboundCtx = false;
  /** トランジション中（ボールを前へ運ぶ／走る）。前のコートで落ち着いたらコールする */
  transition = false;
  /** ハンドラーがアウトレットの位置で受けようとしている */
  private outlet = false;
  private transT = 0;
  /** コールしたプレーを始める時刻（持ち場へ動く時間を置く） */
  private pendingPlay: number | null = null;
  options: Option[] = [];
  lastMoveLabel = "";
  private holderPrev: Player | null = null;

  constructor(g: Game) {
    this.g = g;
  }

  // ------------------------------------------------------------------ 状態

  stOf(p: Player): OffState {
    let s = this.st.get(p);
    if (!s) {
      s = this.blank(p.p);
      this.st.set(p, s);
    }
    return s;
  }

  private blank(spot: V2): OffState {
    return {
      mode: "spot", spot: copy(spot), home: copy(spot), path: null, pathI: 0, lob: false, endH: 1.5,
      screenFor: null, screenDest: null, setT: 0, used: false, holdMax: 2.0, after: "spot", afterSpot: null,
      t: 0, relocT: 0, waitT: 0, scripted: false, setPos: null, micro: V(), microT: -1,
    };
  }

  handler(): Player | null {
    const h = this.g.holder();
    return h && h.team === this.team ? h : null;
  }

  lc(): LaneCtx {
    return { defs: this.g.defense, screens: this.screens() };
  }

  /** セットしたスクリーン（守備者の経路をふさぐ体） */
  screens(): Obstacle[] {
    const out: Obstacle[] = [];
    for (const p of this.pl) {
      const s = this.st.get(p);
      if (s && s.mode === "screen" && s.setT > 0) out.push({ p: p.p, r: p.radius + 0.05, hold: 0.25 + 0.2 * n(p.a.screen) });
    }
    return out;
  }

  screenerOf(p: Player): boolean {
    const s = this.st.get(p);
    return !!s && p.team === this.team && s.mode === "screen" && s.setT > 0;
  }

  /** 走っている途中の経路（リード/ロブの導線の元） */
  cuts(): Map<Player, CutInfo> {
    const m = new Map<Player, CutInfo>();
    for (const p of this.pl) {
      const s = this.st.get(p);
      if (!s || !s.path || (s.mode !== "cut" && s.mode !== "roll")) continue;
      const rest = [p.p, ...s.path.slice(s.pathI)];
      if (rest.length >= 2) m.set(p, { path: rest, lob: s.lob, endH: s.endH });
    }
    return m;
  }

  defOf(p: Player): Player | null {
    return this.g.def.markerOf(p);
  }

  // ------------------------------------------------------------------ セットプレーからの操作

  setSpot(p: Player, spot: V2, scripted = false): void {
    const s = this.stOf(p);
    s.mode = "spot";
    s.spot = inCourt(spot);
    s.home = copy(s.spot);
    s.path = null;
    s.t = 0;
    s.scripted = scripted;
    p.pushBoost = 1;
  }

  setScreen(p: Player, user: Player, dest: V2 | null, after: AfterScreen, afterSpot: V2 | null, holdMax = 2.0): void {
    const s = this.stOf(p);
    s.mode = "screen";
    s.screenFor = user;
    s.screenDest = dest;
    s.setT = 0;
    s.used = false;
    s.after = after;
    s.afterSpot = afterSpot;
    s.holdMax = holdMax;
    s.t = 0;
    s.scripted = true;
  }

  setCut(p: Player, path: V2[], lob: boolean, endH: number, label: string, mode: OffMode = "cut", afterSpot: V2 | null = null): void {
    const s = this.stOf(p);
    s.afterSpot = afterSpot;
    s.mode = mode;
    s.path = path.map((q) => inCourt(q, 0.25));
    s.pathI = 0;
    s.lob = lob;
    s.endH = endH;
    s.waitT = 0;
    s.t = 0;
    s.scripted = true;
    p.say(label, 1.2);
  }

  setGoal(path: V2[] | null): void {
    this.hs.goal = path ? path.map((q) => inCourt(q)) : null;
    this.hs.goalI = 0;
  }

  /** 全員を流れ（モーション）の持ち場へ */
  toFlow(): void {
    const h = this.handler();
    const taken: V2[] = [];
    if (h) {
      const hsSt = this.stOf(h);
      const role = roleSpots(offRole(h), null);
      hsSt.home = role.sort((a, b) => dist(a, h.p) - dist(b, h.p))[0] ?? SPOT.top();
    }
    // ビッグから先に（持ち場の選択肢が少ない）
    const order = this.pl.filter((p) => p !== h).sort((a, b) => (offRole(a) === "big" ? 0 : 1) - (offRole(b) === "big" ? 0 : 1));
    for (const p of order) {
      const s = this.stOf(p);
      if (s.mode === "screen" || s.mode === "cut" || s.mode === "roll") { s.scripted = false; continue; }
      let best: V2 | null = null, bd = 1e9;
      for (const q of roleSpots(offRole(p), h ? h.p : null)) {
        if (taken.some((t) => dist(t, q) < 3.0)) continue;
        const d = dist(q, p.p);
        if (d < bd) { bd = d; best = q; }
      }
      const spot = best ?? this.freeSpot(p);
      taken.push(spot);
      this.setSpot(p, spot, false);
    }
  }

  bigs(): Player[] {
    return [...this.pl].sort((a, b) => (b.a.screen + b.a.height * 30) - (a.a.screen + a.a.height * 30));
  }

  // ------------------------------------------------------------------ ポゼッション

  reset(team: Team): void {
    this.team = team;
    this.pl = this.g.teams[team];
    this.st.clear();
    for (const p of this.pl) this.st.set(p, this.blank(p.p));
    // いちばんハンドリングの良い選手が運ぶ
    this.handler0 = [...this.pl].sort((a, b) => (b.a.handle + b.a.passing) - (a.a.handle + a.a.passing))[0];
    this.hs = newHState(this.g.t);
    this.call = chooseCall(this, this.g.rng);
    this.play = createPlay(this.call, this, this.g.rng);
    const spots = this.play.setup(this);
    for (const p of this.pl) {
      const s = this.stOf(p);
      const sp = spots.get(p) ?? SPOT.top();
      s.spot = inCourt(sp);
      s.home = copy(s.spot);
    }
    this.lastMoveLabel = "";
    for (const p of this.pl) { p.vCmd = null; p.pushBoost = 1; p.dribbling = false; p.hand = 1; }
  }

  updateSetup(_dt: number): void {
    const hasBall = this.g.holder() === this.handler0;
    for (const p of this.pl) {
      const s = this.stOf(p);
      p.vCmd = null;
      p.spd = 0.8;
      p.stanceCmd = 0;
      p.face = null;
      if (p === this.handler0) {
        p.tgt = hasBall ? s.spot : SPOT.check();
        p.dribbling = hasBall;
        if (hasBall) p.face = dirTo(p.p, RIM);
      } else {
        p.tgt = s.spot;
        if (dist(p.p, s.spot) < 0.6) p.face = dirTo(p.p, RIM);
      }
    }
  }

  setupDone(): boolean {
    for (const p of this.pl) {
      const s = this.stOf(p);
      if (dist(p.p, s.spot) > 1.0) return false;
    }
    return true;
  }

  /**
   * 生きたボールのまま攻守交代（守備リバウンド・スティール）。ハンドラーはボールを前へ運び、
   * 他は役割の持ち場へ全力で走る（走っている味方へはリードパスの導線ができる）。
   */
  resetTransition(team: Team, holder: Player | null): void {
    this.team = team;
    this.pl = this.g.teams[team];
    this.st.clear();
    for (const p of this.pl) this.st.set(p, this.blank(p.p));
    this.handler0 = [...this.pl].sort((a, b) => (b.a.handle + b.a.passing) - (a.a.handle + a.a.passing))[0];
    this.inbounder = null;
    this.hs = newHState(this.g.t);
    this.hs.dribbled = false;
    this.call = "MOTION";
    this.play = createPlay("MOTION", this, this.g.rng);
    this.lastMoveLabel = "";
    this.reboundCtx = false;
    for (const p of this.pl) { p.vCmd = null; p.pushBoost = 1; p.dribbling = false; p.screenSet = false; }
    this.startTransition(holder);
  }

  /** ジャンプボール: 攻撃側として状態だけ用意（誰も走らせない） */
  resetJump(team: Team): void {
    this.team = team;
    this.pl = this.g.teams[team];
    this.st.clear();
    for (const p of this.pl) this.st.set(p, this.blank(p.p));
    this.handler0 = [...this.pl].sort((a, b) => (b.a.handle + b.a.passing) - (a.a.handle + a.a.passing))[0];
    this.inbounder = null;
    this.hs = newHState(this.g.t);
    this.call = "MOTION";
    this.play = createPlay("MOTION", this, this.g.rng);
    this.transition = false;
    this.pendingPlay = null;
    this.reboundCtx = false;
    this.toFlow();
  }

  /** 走る: 役割の持ち場（遠ければカットの経路＝リードパスの的）。いちばん速いビッグはリムへ走る */
  private startTransition(holder: Player | null): void {
    this.transition = true;
    this.transT = this.g.t;
    this.pendingPlay = null;
    this.toFlow();
    this.outlet = false;
    if (holder) this.updateOutlet(holder);
    const bigs = this.pl.filter((p) => p !== holder && offRole(p) === "big").sort((a, b) => b.a.speed - a.a.speed);
    const rimRunner = bigs[0] ?? null;
    for (const p of this.pl) {
      if (p === holder || (p === this.handler0 && this.outlet)) continue;
      const s = this.stOf(p);
      if (p === rimRunner && p.p.z < 4) {
        this.setCut(p, [V(p.p.x * 0.4, 6), madd(RIM, dirTo(RIM, V(0, 6)), 1.0)], false, 1.6, "リムへ走る", "cut", SPOT.dunker(p.p.x >= 0 ? 1 : -1));
        s.scripted = false;
      } else if (dist(p.p, s.spot) > 6) {
        this.setCut(p, [s.spot], false, 1.5, "走る", "cut", s.spot);
        s.scripted = false;
      }
    }
  }

  /**
   * アウトレット（ハンドラー以外がボールを持っている間のハンドラーの受ける位置）。毎フレーム決め直す:
   *   持っている人が自分で運べる（ドリブル60以上）／ボールがセンターライン近くまで来た → 受ける必要はないので前の持ち場へ走る。
   *   ドリブルの苦手な人が自陣の奥で持っている → ボールより4m前のサイドライン寄りで受ける（ボールと一緒に前へ、後ろへは下がらない）。
   */
  private updateOutlet(h: Player): void {
    const H0 = this.handler0;
    if (h === H0 || this.g.ball.k !== "held") { this.outlet = false; return; }
    const s0 = this.stOf(H0);
    const canBring = n(h.a.handle) >= 0.6 || h.p.z > -2;
    if (canBring) {
      if (this.outlet) {
        this.outlet = false;
        this.setSpot(H0, this.freeSpot(H0));
        if (dist(H0.p, s0.spot) > 6) { this.setCut(H0, [s0.spot], false, 1.5, "走る", "cut", s0.spot); s0.scripted = false; }
      }
      return;
    }
    const side = Math.abs(h.p.x) > 1 ? (h.p.x > 0 ? 1 : -1) : (H0.p.x >= 0 ? 1 : -1);
    const z = Math.max(this.outlet ? s0.spot.z : -99, Math.min(4, h.p.z + 4), Math.min(H0.p.z, h.p.z + 9));
    if (!this.outlet || s0.mode !== "spot") this.setSpot(H0, inCourt(V(side * 5.2, z), 0.8), true);
    else s0.spot = inCourt(V(side * 5.2, z), 0.8);
    this.outlet = true;
  }

  /** トランジションの終わり: 前のコートで速攻の利点が無くなったらコール（守備も読み始める） */
  private updateTransition(h: Player | null): void {
    const g = this.g;
    if (this.pendingPlay !== null && g.t >= this.pendingPlay) {
      this.pendingPlay = null;
      this.play?.start(this);
      g.def.goLive();
    }
    if (!this.transition || !h) return;
    this.updateOutlet(h);
    const settled = h.p.z > 2.5 && !this.hs.drive && g.t - this.transT > 2.5;
    if (!settled && g.shotClock > 14) return;
    this.transition = false;
    this.handler0 = h;
    this.call = chooseCall(this, g.rng);
    this.play = createPlay(this.call, this, g.rng);
    const spots = this.play.setup(this);
    for (const p of this.pl) {
      if (p === h) { this.setGoal([spots.get(p) ?? SPOT.top()]); continue; }
      const sp = spots.get(p);
      if (sp) this.setSpot(p, sp, true);
    }
    this.pendingPlay = g.t + 1.2;
    g.log(`${g.tag(h)} がコール: ${g.callLabel()}`, "call", this.team);
  }

  /** スローインの準備: パスの上手い選手が外から入れる（いちばんのハンドラーは中で受ける） */
  resetThrowIn(team: Team, spot: V2): void {
    this.team = team;
    this.pl = this.g.teams[team];
    this.st.clear();
    for (const p of this.pl) this.st.set(p, this.blank(p.p));
    this.handler0 = [...this.pl].sort((a, b) => (b.a.handle + b.a.passing) - (a.a.handle + a.a.passing))[0];
    const cand = this.pl.filter((p) => p !== this.handler0);
    this.inbounder = cand.sort((a, b) => (b.a.passing + b.a.height * 20 - dist(b.p, spot) * 3) - (a.a.passing + a.a.height * 20 - dist(a.p, spot) * 3))[0];
    this.ibThrown = false;
    this.ibDecideT = 0.6;
    this.hs = newHState(this.g.t);
    this.call = "MOTION";
    this.play = createPlay("MOTION", this, this.g.rng);
    this.lastMoveLabel = "";
    for (const p of this.pl) { p.vCmd = null; p.pushBoost = 1; p.dribbling = false; p.screenSet = false; }
    this.toFlow();
    // 入れる人は外のスローイン地点へ（入れたあとに戻る持ち場は残す）
    const s = this.stOf(this.inbounder);
    s.spot = { x: spot.x, z: spot.z };
    this.transition = false;
    this.pendingPlay = null;
    if (spot.z < -COURT.baseZ + 1) {
      // 自陣のエンドラインから: ハンドラーは近くで受け、他は前へ
      const hs0 = this.stOf(this.handler0);
      hs0.spot = inCourt(V(spot.x * 2.2, spot.z + 4.0), 0.8);
      hs0.scripted = true;
    }
  }

  /** スローイン中: 入れる人はパスの導線を探し、中の4人は導線を作るように動く */
  updateThrowIn(dt: number, spot: V2): void {
    const g = this.g;
    const ib = this.inbounder!;
    for (const p of this.pl) p.screenSet = false;
    for (const p of this.pl) {
      if (p === ib && !this.ibThrown) {
        p.vCmd = null;
        p.tgt = { x: spot.x, z: spot.z };
        p.spd = 0.9;
        p.dribbling = false;
        p.face = dist(p.p, spot) < 0.8 ? dirTo(spot, { x: 0, z: 7 }) : null;
        continue;
      }
      this.offBall(p, dt);
    }
    if (g.holder() !== ib) return;
    const hs = this.hs;
    if (hs.passing) {
      hs.passing.t += dt;
      ib.face = dirTo(ib.p, hs.passing.lane.target);
      if (hs.passing.t >= hs.passing.rel && ib.canPassTo(dirTo(ib.p, hs.passing.lane.target))) {
        const lane = hs.passing.lane;
        hs.passing = null;
        g.throwPass(ib, lane);
        this.ibThrown = true;
        if (lane.to) this.afterPass(ib, lane.to);
      }
      return;
    }
    this.ibDecideT -= dt;
    if (this.ibDecideT > 0) return;
    this.ibDecideT = 0.2;
    const lc = this.lc();
    let best: Lane | null = null, bv = -1;
    for (const m of this.pl) {
      if (m === ib) continue;
      const lane = bestPassLane(lc, ib, m, inCourt(madd(m.p, m.v, 0.3)));
      const v = lane.open * (0.6 + 0.4 * (m === this.handler0 ? 1 : 0.7));
      if (v > bv) { bv = v; best = lane; }
    }
    const held = g.t - hs.catchT;
    if (best && (best.open >= Math.max(0.55, passMinOpen(best)) || (held > 3.5 && best.open >= 0.25 && best.style !== "lob") || held > 4.5)) {
      hs.passing = { t: 0, rel: Math.max(0.1, best.T - dist(best.pts[0], best.target) / best.speed), lane: best };
      ib.say(PASS_LABEL[best.style], 0.8);
    }
  }

  /** スローインを中で受けてプレー再開 */
  goLiveInbound(): void {
    if (this.inbounder && !this.ibThrown) this.setSpot(this.inbounder, this.freeSpot(this.inbounder));
    this.ibThrown = true;
    this.play = createPlay("MOTION", this, this.g.rng);
    this.call = "MOTION";
    this.play.start(this);
    // 自陣側で受けたら運んで、前のコートでコールする
    const h = this.handler();
    if (h && h.p.z < 0) this.startTransition(h);
  }

  goLive(): void {
    this.hs = newHState(this.g.t);
    this.hs.dribbled = true;
    this.play?.start(this);
  }

  // ------------------------------------------------------------------ イベント

  onCatch(p: Player, from: Player | null): void {
    if (p.team !== this.team) return;
    this.hs = newHState(this.g.t);
    this.hs.lastPasser = from;
    this.hs.lastPassT = this.g.t;
    p.dribbling = false;
    p.vCmd = null;
    const s = this.stOf(p);
    s.mode = "spot";
    s.path = null;
  }

  /**
   * パスを投げた瞬間: 投げた人の次の動き（ギブ&ゴーかリロケート）を決める。
   * キャッチまで待つと、飛んでいる間は「ボールを受ける前の古い持ち場」へ戻ろうとしてしまう（2026-10-04 修正）。
   */
  private afterPass(from: Player, to: Player): void {
    const fs = this.stOf(from);
    const fd = this.defOf(from);
    const rimPath = [from.p, madd(RIM, dirTo(RIM, from.p), 1.0)];
    const fdBlocks = fd ? dot(dirTo(from.p, fd.p), dirTo(from.p, RIM)) > 0.3 : false;
    // 自分のマークが受け手（ボール）を見ていればカット
    const watch = fd ? !fdBlocks && dot(fd.f, dirTo(fd.p, to.p)) > 0.5 && dist(fd.p, from.p) > 1.0 : true;
    const clear = rimCrowd(this.pl, from) === 0 && !this.pl.some((o) => o !== from && (this.stOf(o).mode === "cut" || this.stOf(o).mode === "roll"));
    if (!fs.scripted && watch && clear && distRim(from.p) > 4 && from.p.z > 0 && this.g.rng.chance(CUT_RATE[offRole(from)] * (0.25 + 0.4 * n(from.a.offIQ)))) {
      this.setCut(from, rimPath, false, 1.5, "ギブ&ゴー");
      fs.scripted = false;
      return;
    }
    // 元の持ち場が自陣側／遠い（攻守交代でボールを取った地点のまま等）なら、前のコートの役割の持ち場へ。遠ければ走る
    const stale = fs.home.z < 0 || dist(fs.home, from.p) > 7;
    const spot = stale ? this.freeSpot(from, to) : fs.home;
    this.setSpot(from, spot, false);
    if (dist(from.p, spot) > 6) {
      this.setCut(from, [spot], false, 1.5, "走る", "cut", spot);
      this.stOf(from).scripted = false;
    }
  }

  /**
   * シュートが打たれたらリバウンドの役割を決める:
   *   飛び込む2人（リバウンド・身長・C/PF・リムへの近さ）＋リム下で打った本人は自分のシュートを追う／
   *   戻り役1人（ハンドリングの良い選手がトップ）／残りは外の空いた位置でキックアウトを待つ。
   */
  onShot(s: Player): void {
    this.reboundCtx = true;
    const others = this.pl.filter((p) => p !== s);
    const score = (p: Player) =>
      n(p.a.rebound) + (p.d.pos === "C" || p.d.pos === "PF" ? 0.35 : 0) + (p.a.height - 1.9) * 1.5 - 0.06 * distRim(p.p);
    const crashers = [...others].sort((a, b) => score(b) - score(a)).slice(0, 2);
    if (distRim(s.p) < 2.5) crashers.push(s);
    const rest = others.filter((p) => !crashers.includes(p));
    const safety = [...rest].sort((a, b) => (b.a.handle + b.a.passing) - (a.a.handle + a.a.passing))[0];
    const taken: V2[] = [];
    for (const p of this.pl) {
      const st = this.stOf(p);
      p.pushBoost = 1;
      p.stanceCmd = 0;
      if (crashers.includes(p)) { st.mode = "crash"; st.scripted = true; continue; }
      if (p === s) continue;
      if (p === safety) { st.mode = "safety"; st.spot = SPOT.top(); st.scripted = true; taken.push(st.spot); continue; }
      // 外の空いた位置（いちばん近い外周スポットで、他と重ならない所）
      let best = st.spot, bd = 1e9;
      for (const q of perimeterSpots()) {
        if (taken.some((t) => dist(t, q) < 3)) continue;
        const d = dist(q, p.p);
        if (d < bd) { bd = d; best = q; }
      }
      taken.push(best);
      st.mode = "spot";
      st.spot = best;
      st.scripted = true;
    }
  }

  /** リングで跳ねた: 役割はそのまま（全員は飛び込まない） */
  onRebound(): void {
    this.reboundCtx = true;
  }

  /** 弾かれた・こぼれた: リバウンドではないルーズボール（近い2人だけが取りに行く） */
  onLoose(): void {
    this.reboundCtx = false;
    this.hs = newHState(this.g.t);
  }

  onRegain(p: Player): void {
    this.transition = false;
    this.pendingPlay = null;
    this.reboundCtx = false;
    this.hs = newHState(this.g.t);
    this.hs.dribbled = false;
    p.dribbling = false;
    this.play = createPlay("MOTION", this, this.g.rng);
    this.call = "MOTION";
    for (const q of this.pl) {
      const s = this.stOf(q);
      s.mode = "spot";
      s.scripted = false;
      s.path = null;
    }
    this.toFlow();
  }

  // ------------------------------------------------------------------ 毎フレーム

  update(dt: number): void {
    const g = this.g;
    const b = g.ball;
    for (const p of this.pl) p.screenSet = false;
    const h = this.handler();
    if (h !== this.holderPrev) {
      this.holderPrev = h;
    }
    this.updateTransition(h);
    if (h && this.play && !this.play.done && this.pendingPlay === null) this.play.update(this, dt);

    for (const p of this.pl) {
      if (p === h) {
        this.handlerStep(p, dt);
        if (g.holder() === p) this.keepIn(p);
      } else this.offBall(p, dt);
    }
    if (!h) this.options = [];
    if (b.k === "loose") this.chaseLoose();
  }

  /**
   * ルーズボール: リバウンドなら飛び込む役だけが落下点へ（落下点の近くに居る人も取りに行く）、
   * それ以外（弾かれた等）は近い2人だけ。残りは自分の位置で次（キックアウト・セーフティ）に備える。
   */
  private chaseLoose(): void {
    const land = this.g.def.landing();
    const lb = this.g.ball;
    const near2 = [...this.pl].sort((a, b) => dist(a.p, land) - dist(b.p, land)).slice(0, 2);
    for (const p of this.pl) {
      const st = this.stOf(p);
      const chase = this.reboundCtx ? st.mode === "crash" || dist(p.p, land) < 2.2 : near2.includes(p);
      p.vCmd = null;
      if (chase) {
        p.face = null;
        p.stanceCmd = 0;
        p.spd = 1;
        p.effort = 1;
        p.urgency = 1;
        p.tgt = land;
        if (lb.k === "loose" && p.shouldJumpFor(lb.p, lb.v, lb.h, lb.vy)) p.jump(0.6, 0.15);
      } else {
        // 外で受けて打てる／戻れる位置で待つ
        p.tgt = st.mode === "safety" || st.mode === "spot" ? st.spot : p.p;
        p.spd = 0.8;
        p.face = dirTo(p.p, land);
        p.stanceCmd = 0.25;
        p.urgency = 0.4;
      }
    }
  }

  // ------------------------------------------------------------------ ハンドラー

  private handlerStep(h: Player, dt: number): void {
    const g = this.g;
    const hs = this.hs;
    h.dribbling = hs.dribbled && !hs.shooting && !hs.passing;
    const C = contValue(g.shotClock);

    if (hs.shooting) {
      const sh = hs.shooting;
      sh.t += dt;
      h.urgency = 1;
      h.face = dirTo(h.p, RIM);
      const atRim = sh.type === "dunk" || sh.type === "layup" || sh.type === "floater";
      // リム周りは勢いのままリムへ踏み込んで跳ぶ。外は止まって打つ
      h.vCmd = atRim && !h.airborne ? mul(dirTo(h.p, RIM), Math.min(len(h.v), 3)) : V();
      if (!sh.jumped) {
        if (atRim) { sh.jumped = true; h.jump(sh.type === "dunk" ? 0.66 : sh.type === "layup" ? 0.6 : 0.45, sh.type === "floater" ? 0.5 : 0.75); }
        else if (sh.type === "jumper" && sh.t >= sh.rel * 0.45) { sh.jumped = true; h.jump(0.5, 0.25); }
      }
      if (sh.t >= sh.rel) {
        hs.shooting = null;
        const lane = shotLane(this.lc(), h, h.p, 0, 0, releaseHeight(h, sh.type));
        h.vCmd = null;
        g.releaseShot(h, lane.open, sh.type, sh.forced ?? false);
      }
      return;
    }
    if (hs.passing) {
      const pa = hs.passing;
      pa.t += dt;
      if (pa.lane.style === "jump" && !pa.jumped) { pa.jumped = true; h.jump(0.6, 0.35); }
      h.urgency = 0.7;
      h.vCmd = mul(h.v, 0.85);
      // 足の向きはそのまま、上半身をひねって投げる向きへ。ひねりきっても真横に入らない分だけ足を回す
      const dir = dirTo(h.p, pa.lane.target);
      const aF = angleBetween(h.f, dir);
      const over = Math.abs(aF) - PASS_ARC - TWIST_MAX;
      h.face = over > 0 ? rot(h.f, Math.sign(aF) * (over + 0.05)) : h.f;
      h.twistCmd = clamp(aF, -TWIST_MAX, TWIST_MAX);
      // パスは上半身の前から真横までしか出せない（向ききるまで待つ）
      if (pa.t >= pa.rel && h.canPassTo(dir)) {
        hs.passing = null;
        h.vCmd = null;
        g.throwPass(h, pa.lane);
        this.hs.lastPassT = g.t;
        if (pa.lane.to) this.afterPass(h, pa.lane.to);
      }
      return;
    }
    if (hs.move) {
      const done = stepMove(h, hs.move, dt);
      if (done) {
        const m = hs.move;
        hs.move = null;
        hs.decideT = 0;
        const plan = hs.stepPlan;
        hs.stepPlan = null;
        if (m.def.shot) {
          // ムーブの終わり: シュートとパス（ダンプオフ／キックアウト）、ステップならそこからの突破も期待値で比べる
          const opts = this.evaluate(h, C);
          const pass = this.okPass(h, bestPass(opts), C);
          const shoot = bestOf(opts, "shoot")!;
          if (m.def.id === "stepback" || m.def.id === "sidestep") {
            if (this.afterStep(h, m.def.label, opts, shoot, pass, C, plan)) return;
          } else {
            if (pass && pass.value > shoot.value + 0.03) { this.execute(h, pass); return; }
            if ((shoot.lane?.open ?? 0) > 0.35 || m.def.id === "euro" || g.shotClock < 3) { this.startShot(h, false); return; }
          }
        }
      } else return;
    }
    if (hs.drive) {
      if (this.driveStep(h, dt, C)) return;
    }
    if (hs.post) {
      if (this.postStep(h, dt, C)) return;
    }

    // キープ: 受けた直後（0.6秒）でなければボールを守れる（突破中・ムーブ中・パスやシュートの構え中はここまで来ない）
    const keep = g.t - hs.catchT > 0.6;
    h.protecting = keep;

    hs.decideT -= dt;
    const od = this.onBallDef(h);
    if (od && (od.airborne || od.bal.off) && hs.decideT > 0) hs.decideT = 0;
    if (hs.decideT > 0) {
      if (keep && this.protectBall(h)) return;
      this.holdOrGoal(h, dt);
      return;
    }
    hs.decideT = 0.16 - 0.06 * n(h.a.offIQ);
    this.decide(h, C);
  }

  /**
   * キープ: スティールを狙われたら（守備者が手の届く間合いまで詰めた・手を出してきた）、ボールを守備者から遠い側の手に持ち替え、
   * ドリブル中なら下がるか左右へずれて間合いを取る（守備者たちから最も離れられる所。バックコート・ラインへは行かない）。
   * まだドリブルしていない（トリプルスレット）なら足は動かせないので、体の陰にボールを置くだけ。狙われていなければ false。
   */
  private protectBall(h: Player): boolean {
    const g = this.g;
    let d: Player | null = null;
    let dd = 9;
    for (const x of g.defense) {
      const k = dist(x.p, h.p);
      if (k < dd) { dd = k; d = x; }
    }
    if (!d || d.bal.off || d.airborne) return false;
    const reach = h.radius + d.radius + d.armLen + 0.6;
    if (!(d.lungeT > 0 || dd < reach)) return false;
    // ボールを守備者から遠い側の手へ（右手 = +1）
    const dSide = dot(right(h.f), dirTo(h.p, d.p));
    if (this.hs.dribbled) h.hand = dSide > 0 ? -1 : 1;
    if (!this.hs.dribbled) return true;
    const away = dirTo(d.p, h.p);
    const lat = right(away);
    const cands = [madd(h.p, away, 1.2), madd(h.p, lat, 1.0), madd(h.p, lat, -1.0)]
      .map((q) => inCourt(q, 0.8))
      .filter((q) => q.z > 1.0);
    if (cands.length === 0) return true;
    let best = cands[0], bs = -1e9;
    for (const q of cands) {
      let m = 9;
      for (const x of g.defense) m = Math.min(m, dist(x.p, q));
      if (m > bs) { bs = m; best = q; }
    }
    h.vCmd = null;
    h.tgt = best;
    h.spd = 0.75;
    h.urgency = 0.8;
    h.stanceCmd = 0.5;
    h.face = dirTo(h.p, RIM);
    if (h.labelT <= 0) h.say("キープ", 0.6);
    return true;
  }

  /** ボールを運ぶ段階なら、許すパス（ハンドラーへ／逃がす／速攻）だけ通す */
  private okPass(h: Player, o: Option | null, C: number): Option | null {
    if (!o || !this.bringingUp(h)) return o;
    return this.bringUpPass(h, o, C) ? o : null;
  }

  /** ボールを運ぶ段階か（センターラインより自陣側、またはトランジション中で前のコートの浅い所） */
  bringingUp(h: Player): boolean {
    return h.p.z < 0.5 || (this.transition && h.p.z < 3);
  }

  /**
   * ボールを運ぶ段階で許すパス: "handler"=チームのハンドラーへ渡す／"relief"=マークに詰められて空いた味方へ逃がす／
   * "break"=速攻（リムの近くへ走り込んだ味方で得点の期待値が大きく上がる）。それ以外は null（自分で運ぶ）。
   */
  private bringUpPass(h: Player, o: Option, H: number): "handler" | "relief" | "break" | null {
    const to = o.to!;
    const lane = o.lane!;
    // ハンドラーへ渡すのは前方か横（後ろ向きに戻して遠くから運び直さない）
    if (h !== this.handler0 && to === this.handler0 && lane.open >= 0.5 && to.p.z >= h.p.z - 0.5) return "handler";
    const d = this.onBallDef(h);
    const trapped = this.g.defense.filter((x) => dist(x.p, h.p) < 2.5).length >= 2;
    if (((d && dist(d.p, h.p) < 1.6) || trapped) && lane.open >= 0.6) return "relief";
    if (distRim(to.p) < 4.5 && o.value > H * 1.3 && lane.open >= passMinOpen(lane)) return "break";
    return null;
  }

  /** パスの受け手: スクリーンをかけている最中の味方は除く（ロール/ポップに移れば受け手に戻る） */
  receivers(h: Player): Player[] {
    return this.pl.filter((p) => p !== h && this.stOf(p).mode !== "screen");
  }

  /** 持ち続けている時間。セットプレーの経路に従っている間（スクリーン待ち・スクリーンを使う途中）は数えない */
  holdTime(): number {
    if (this.play && !this.play.done && !this.play.iso) return 0;
    return this.g.t - this.hs.catchT;
  }

  private onBallDef(h: Player): Player | null {
    // 自分の前（リム側）2.6m以内でいちばん近い守備者
    let best: Player | null = null;
    let bd = 2.6;
    const axis = dirTo(h.p, RIM);
    for (const d of this.g.defense) {
      const dd = dist(d.p, h.p);
      if (dd < bd && dot(sub(d.p, h.p), axis) > -0.3) { bd = dd; best = d; }
    }
    return best;
  }

  private evaluate(h: Player, C: number): Option[] {
    const catchShoot = !this.hs.dribbled && this.g.t - this.hs.catchT < 1.2;
    const opts = evalOptions({
      lc: this.lc(), h, mates: this.receivers(h), cuts: this.cuts(), catchShoot, C, onBall: this.onBallDef(h), holdT: this.holdTime(), shotClock: this.g.shotClock,
    });
    this.options = opts;
    return opts;
  }

  private decide(h: Player, C: number): void {
    const g = this.g;
    const hs = this.hs;
    const opts = this.evaluate(h, C);
    const iq = n(h.a.offIQ);
    const jit = () => (g.rng.next() - 0.5) * 0.12 * (1 - iq);

    type Cand = { o: Option; v: number; force?: boolean };
    const cands: Cand[] = [];
    const shoot = bestOf(opts, "shoot")!;
    // 比べる基準は「この人が持ち続ける価値」（ビッグが持っていれば低い／持ちすぎると下がる）
    const H = holdValue(h, C, this.holdTime());
    // ゴール下（2m以内）は導線の開きを条件にしない（守備者は必ず近くに居る）。外れても攻撃リバウンドがあるので少し積極的に
    const rimShot = distRim(h.p) < 2.0;
    const putback = rimShot && !hs.dribbled && g.t - hs.catchT < 1.2;
    if (shoot.lane && (rimShot ? shoot.value > H * 0.92 : shoot.lane.open > 0.3 && shoot.value > H * 1.06 + 0.02)) {
      cands.push({ o: shoot, v: shoot.value + (putback ? 0.15 : 0) + jit() });
    }
    for (const o of opts) {
      if ((o.kind === "pass" || o.kind === "lead" || o.kind === "lob") && o.lane && o.to) {
        let v = o.value + jit();
        if (o.to === hs.lastPasser && g.t - hs.lastPassT < 1.5) v -= 0.15;
        // ボールを運ぶ段階: ハンドラーへ渡す／詰められて逃がす／速攻 以外のパスはしない
        if (this.bringingUp(h)) {
          const why = this.bringUpPass(h, o, H);
          if (!why) continue;
          if (why === "handler") { cands.push({ o, v: Math.max(v, H * 1.02 + 0.05) }); continue; }
        }
        if (o.lane.open >= passMinOpen(o.lane) && v > H * 1.01) cands.push({ o, v });
      }
    }
    const drive = bestOf(opts, "drive")!;
    // マークの状態: 跳んだ/崩れた → ドライブ最優先、密着 → 抜く、離れている → 打つ、詰めてくる → 逆を突く
    const md = this.onBallDef(h);
    const rd = md ? readDefender(h, md) : null;
    const beatable = !!rd && (rd.air || rd.off);
    let driveBonus = 0.03;
    if (rd) {
      if (beatable) driveBonus += 0.3;
      if (rd.tight) driveBonus += 0.08;
      if (rd.closing && hs.dribbled) driveBonus += 0.06;
      if (rd.sag && shoot.lane && shoot.lane.open > 0.3) cands.forEach((c) => { if (c.o === shoot) c.v += 0.08; });
    }
    const minDrive = beatable ? 0.3 : 0.5;
    if (drive.lane && (drive.lane.open >= minDrive || (drive.lane.freeD > 2.5 && drive.value > H + 0.05))) {
      cands.push({ o: drive, v: drive.value + driveBonus + jit() });
    } else if (md && distRim(h.p) < 9.5 && !this.bringingUp(h)) {
      // 導線が開ききらなくても、スピードかパワーで勝っていれば押し込む（強引なドライブ）
      const adv = this.attackAdv(h, md);
      const drives = opts.filter((o) => o.kind === "drive" && o.lane && o.lane.open >= 0.15);
      const fd = drives.sort((a, b) => b.lane!.open - a.lane!.open)[0];
      if (fd && (adv > -0.02 || rd?.tight)) {
        cands.push({ o: fd, v: H + 0.04 + 0.35 * Math.max(0, adv) + 0.1 * fd.lane!.open + (rd?.tight ? 0.05 : 0) + jit(), force: true });
      }
    }
    // 押し込みドリブル: パワーで勝っていれば、マークを背中で押してゴール下へ（ドリブルが下手でも着実に進める）
    // 力が同じか負けていても試みる: ビッグ（C/PF・役割 big）はゴール下へ近づく手段として、価値が持ち続ける価値に届かなくても候補に。
    // それ以外は価値で判断。押し込みに失敗した直後（3秒）は繰り返さない
    const post = bestOf(opts, "post");
    if (post?.lane && !this.bringingUp(h) && g.t - hs.postFailT > 3) {
      const big = h.d.pos === "C" || h.d.pos === "PF" || offRole(h) === "big";
      if (post.value > H * 1.02 + 0.02) cands.push({ o: post, v: post.value + jit() });
      else if (big) cands.push({ o: post, v: H + 0.03 + jit() });
    }
    // ステップ導線: 左右・後ろへステップしてマークをずらす（着地してシュート、またはそれを見せて突破）
    const step = bestOf(opts, "step");
    if (step?.lane && step.step && md && !this.bringingUp(h) && g.t - hs.lastMoveT > 0.6 &&
      step.lane.open >= 0.4 && step.value > H * 1.03 + 0.02) {
      cands.push({ o: step, v: step.value + jit() });
    }
    // ショットクロックが無い: 何でもいいから撃つ／投げる
    if (g.shotClock < 2.5 && cands.length === 0) cands.push({ o: shoot, v: 1 });

    if (cands.length > 0) {
      cands.sort((a, b) => b.v - a.v);
      if (cands[0].o === shoot && putback) { h.say("プットバック", 1.0); g.log(`${g.tag(h)} リバウンドからそのままプットバック`, "move", h.team); }
      this.execute(h, cands[0].o, cands[0].force ?? false);
      return;
    }

    // ゴール下で持ったまま何もできない → 一番空いている味方へ戻して攻め直す
    if (distRim(h.p) < 3.5 && g.t - hs.catchT > 1.2) {
      const out = opts.filter((o) => (o.kind === "pass" || o.kind === "lead") && o.lane && o.lane.open >= 0.25 && o.lane.style !== "lob")
        .sort((a, b) => b.lane!.open - a.lane!.open)[0];
      if (out) {
        g.log(`${g.tag(h)} ゴール下で詰まって外へ戻す`, "pass", h.team);
        this.execute(h, out);
        return;
      }
    }

    // 導線が無い → 1on1のムーブで導線を作る（崩す・押しのける）
    const d = this.onBallDef(h);
    const sinceMove = g.t - hs.lastMoveT;
    hs.holdT += 0.16;
    if (d && sinceMove > 0.3 && ((this.play?.iso ?? true) || this.play?.done || hs.holdT > 1.5)) {
      const others = g.defense.filter((x) => x !== d);
      const mc = chooseMove(h, d, !hs.dribbled, others, g.rng);
      if (mc && g.rng.chance(0.35 + 0.5 * n(h.a.handle) + Math.min(0.3, hs.holdT * 0.1))) {
        this.beginMove(h, mc.id, mc.s);
        return;
      }
    }
  }

  /**
   * ボールを持っているときはラインへ向かう速度を、近いほど削る（0.45m より内側で必ず内へ戻る）。
   * 位置を書き換えるのではなく「その向きへ行かない」判断として速度指令と行き先を変える。
   */
  private keepIn(h: Player): void {
    h.tgt = inCourt(h.tgt, 0.6);
    const v = h.vCmd;
    if (!v) return;
    const soft = 1.3, hard = 0.45;
    const guard = (toLine: number, out: number): number => {
      if (toLine < hard) return Math.min(out, -0.8);
      if (toLine < soft && out > 0) return (out * (toLine - hard)) / (soft - hard);
      return out;
    };
    const W = COURT.halfW, B = COURT.baseZ;
    let vx = v.x, vz = v.z;
    vx = guard(W - h.p.x, vx);
    vx = -guard(W + h.p.x, -vx);
    vz = guard(B - h.p.z, vz);
    vz = -guard(h.p.z + COURT.baseZ, -vz);
    h.vCmd = { x: vx, z: vz };
  }

  /** ムーブの横の向きがすぐ近くのラインへ向くなら逆にする */
  private sideAwayFromLine(h: Player, s: number): number {
    const lat = right(dirTo(h.p, RIM));
    const go = { x: h.p.x + lat.x * s * 1.8, z: h.p.z + lat.z * s * 1.8 };
    const inside = Math.abs(go.x) < COURT.halfW - 0.4 && Math.abs(go.z) < COURT.baseZ - 0.4;
    return inside ? s : -s;
  }

  /** fixedSide: ステップ導線で向きと着地点を決めてある（ライン際の向きの入れ替えをしない）。note はログに足す説明 */
  private beginMove(h: Player, id: MoveId, s: number, fixedSide = false, note = ""): void {
    const g = this.g;
    // ライン際では外へ向かうムーブをしない（下がるムーブはセンターライン際では使わない）
    if (id === "retreat" && h.p.z < -COURT.baseZ + 2.5) return;
    if (id === "stepback" && (h.p.z < 1.8 || (!fixedSide && distRim(h.p) > 8.2))) return;
    if (!fixedSide) s = this.sideAwayFromLine(h, s);
    const def = MOVES[id];
    const risk = Math.max(0, def.diff - n(h.a.handle)) * 0.25 + (h.bal.off ? 0.15 : 0);
    if (g.rng.chance(risk * 0.4)) { g.fumble(h); return; }
    if (id !== "jab" && id !== "pump") this.hs.dribbled = true;
    this.hs.move = startMove(h, id, s, RIM);
    this.hs.lastMoveT = g.t;
    this.hs.holdT = 0;
    this.lastMoveLabel = def.label;
    const d = this.onBallDef(h);
    g.log(`${g.tag(h)} ${def.label}${note}${d ? ` vs ${g.tag(d)}` : ""}`, "move", h.team);
  }

  /**
   * ステップ（サイドステップ／ステップバック）の着地: その場のシュート・パス・そこからの突破を期待値で比べる。
   * 撃つ構えに守備者が詰めてきた／跳んだ／崩れたなら突破の導線が開いている（ステップをフェイクにして抜く）。
   * 何も開いていなければ false（次の判断へ）。
   */
  private afterStep(h: Player, label: string, opts: Option[], shoot: Option, pass: Option | null, C: number, plan: StepPlan | null): boolean {
    const g = this.g;
    const H = holdValue(h, C, this.holdTime());
    const md = this.onBallDef(h);
    const rd = md ? readDefender(h, md) : null;
    const bit = !!rd && (rd.air || rd.off || rd.closing);
    const drive = bestOf(opts, "drive");
    const sv = (shoot.lane?.open ?? 0) > 0.35 && shoot.value >= H * 0.95 ? shoot.value : -1;
    const dv = drive?.lane && drive.lane.open >= (bit ? 0.3 : 0.5) ? drive.value + (bit ? 0.1 : 0) : -1;
    const pv = pass ? pass.value : -1;
    const best = Math.max(sv, dv, pv);
    if (best < 0) {
      if (g.shotClock < 3) { this.startShot(h, false); return true; }
      return false;
    }
    if (pass && pv === best) { this.execute(h, pass); return true; }
    if (drive && dv === best) {
      this.execute(h, drive);
      const why = bit && md ? `（${g.tag(md)} が${rd!.air ? "跳んだ" : rd!.off ? "崩れた" : "詰めた"}）` : "";
      g.log(`${g.tag(h)} ${label}${plan?.follow === "shoot" ? "からのシュート" : ""}を見せて突破${why}`, "move", h.team);
      h.say(`${label}→突破`, 1.0);
      return true;
    }
    this.startShot(h, false);
    return true;
  }

  /** 1on1で押し込めるか: スピードの優位とパワー（筋力×体重）の優位の大きい方 */
  private attackAdv(h: Player, d: Player): number {
    const spd = (n(h.a.speed) + n(h.a.handle) + n(h.a.agility)) / 3 - (n(d.a.perD) + n(d.a.speed) + n(d.a.agility)) / 3;
    const pw = (h.mass * (0.6 + 0.8 * n(h.a.strength))) / (d.mass * (0.6 + 0.8 * n(d.a.strength))) - 1;
    return Math.max(spd, pw * 0.5);
  }

  private execute(h: Player, o: Option, force = false): void {
    const g = this.g;
    const hs = this.hs;
    hs.holdT = 0;
    switch (o.kind) {
      case "shoot":
        this.startShot(h, !hs.dribbled && g.t - hs.catchT < 1.2);
        return;
      case "pass":
      case "lead":
      case "lob": {
        const lane = o.lane!;
        hs.passing = { t: 0, rel: Math.max(0.08, lane.T - dist(h.p, lane.target) / lane.speed), lane };
        h.say(PASS_LABEL[lane.style], 0.8);
        return;
      }
      case "step": {
        const sp = o.step!;
        hs.stepPlan = sp;
        this.beginMove(h, sp.id, sp.s, true, `でずらす（狙い: ${sp.follow === "shoot" ? "シュート" : "突破"} 導線 ${((o.lane?.open ?? 0) * 100).toFixed(0)}%）`);
        if (!hs.move) hs.stepPlan = null;
        return;
      }
      case "post": {
        hs.dribbled = true;
        hs.drive = null;
        hs.goal = null;
        hs.post = { t: 0, lastD: distRim(h.p), checkT: 0, re: 0.2 };
        h.say("押し込み", 1.0);
        const d = o.lane?.closer;
        g.log(`${g.tag(h)} 押し込みドリブル（押し勝ち ${((o.lane?.speed ?? 0) / 1.8 * 100).toFixed(0)}% / 導線 ${((o.lane?.open ?? 0) * 100).toFixed(0)}%）${d ? ` vs ${g.tag(d)}` : ""}`, "move", h.team);
        return;
      }
      case "drive": {
        hs.dribbled = true;
        hs.drive = { path: o.path!.map(copy), i: 1, t: 0, re: 0.1, force };
        hs.goal = null;
        h.say(force ? "強引に突破" : "ドライブ", 0.9);
        g.log(`${g.tag(h)} ${force ? "強引にドライブ" : "ドライブ"}（導線 ${((o.lane?.open ?? 0) * 100).toFixed(0)}%）`, "move", h.team);
        return;
      }
      default:
        return;
    }
  }

  /** 手渡しなど、導線の評価を経ずに渡す */
  forcePass(h: Player, to: Player, label: string): void {
    const lane = passLane(this.lc(), h, to, to.p);
    this.hs.passing = { t: 0, rel: 0.05, lane };
    h.say(label, 1.0);
  }

  startShot(h: Player, catchShoot: boolean, forced = false): void {
    // 今どれだけ空いているかで打ち方を選ぶ
    const sl = shotLane(this.lc(), h, h.p, 0, releaseTime(h, h.p, catchShoot));
    const type = chooseShotType(h, h.p, sl.open);
    this.hs.shooting = { t: 0, rel: shotTypeRel(h, h.p, catchShoot, type), jumped: false, type, forced };
    this.hs.drive = null;
    this.hs.move = null;
    h.say(SHOT_LABEL[type] + (isThree(h.p) ? "(3P)" : ""), 1.0);
  }

  /**
   * 押し込みドリブル中: ゴールに背を向け（顔はリングと逆）、リングの方へ下がりながらマークを背中で押す。
   * 実際に進めるかは押し合いの物理（contact.ts）次第。ゴール下（リングまで1.7m）に着いたら振り向いてシュート（レイアップ・ダンク）。
   * 1秒ごとに進み具合を確かめ、0.15m も進めていなければ（押し返されている）やめて次の判断へ。
   * 0.2秒ごとにパスを見直し、ヘルプが寄って味方が空けばパス。5秒かショットクロック残り1.5秒でシュート。
   */
  private postStep(h: Player, dt: number, C: number): boolean {
    const g = this.g;
    const ps = this.hs.post!;
    ps.t += dt;
    const d = this.onBallDef(h);
    const toRim = dirTo(h.p, RIM);
    h.postUp = true;
    h.protecting = true;
    h.dribbling = true;
    h.effort = 1;
    h.urgency = 1;
    h.stanceCmd = 0.9;
    h.face = mul(toRim, -1);
    h.vCmd = mul(toRim, 1.6);
    // ボールはマークから遠い側の手で
    if (d) h.hand = dot(right(h.f), dirTo(h.p, d.p)) > 0 ? -1 : 1;
    const dr = distRim(h.p);
    if (dr < 1.7) {
      this.hs.post = null;
      h.vCmd = null;
      g.log(`${g.tag(h)} ゴール下まで押し込んで振り向く`, "move", h.team);
      this.startShot(h, false);
      return true;
    }
    // 0.5秒ごとに進み具合を確認。8cm 未満（止められている）か押し戻されていたら、早々に見切る
    ps.checkT += dt;
    if (ps.checkT >= 0.5) {
      const gain = ps.lastD - dr;
      ps.checkT = 0;
      ps.lastD = dr;
      if (gain < 0.08) {
        this.hs.post = null;
        this.hs.postFailT = g.t;
        h.vCmd = null;
        const back = gain < 0;
        g.log(`${g.tag(h)} 押し込めない（${d ? g.tag(d) : "マーク"} が${back ? "押し返す" : "踏ん張る"}）`, "def", h.team);
        // 味方へ早々にパス（多少危なくても出せる導線＝開き0.25以上の中で 開き×価値 が最も良いもの）。
        // 無ければ、背負ったまま無理にシュート（リリースが低く、ブロックされやすい）
        const opts = this.evaluate(h, C);
        let pass: Option | null = null;
        for (const o of opts) {
          if ((o.kind !== "pass" && o.kind !== "lead" && o.kind !== "lob") || !o.lane || o.lane.open < 0.25) continue;
          if (!this.okPass(h, o, C)) continue;
          if (!pass || o.lane.open * o.value > pass.lane!.open * pass.value) pass = o;
        }
        if (pass) {
          h.say(back ? "押し返された→パス" : "押し込めない→パス", 1.0);
          this.execute(h, pass);
          return true;
        }
        h.say(back ? "押し返された→無理に打つ" : "押し込めない→無理に打つ", 1.0);
        this.startShot(h, false, true);
        return true;
      }
    }
    ps.re -= dt;
    if (ps.re <= 0) {
      ps.re = 0.2;
      const opts = this.evaluate(h, C);
      const pass = this.okPass(h, bestPass(opts), C);
      const keep = bestOf(opts, "post")?.value ?? C;
      if (pass && pass.value > keep + 0.05) {
        this.hs.post = null;
        h.vCmd = null;
        this.execute(h, pass);
        g.log(`${g.tag(h)} 押し込みにヘルプが寄る → パス`, "pass", h.team);
        return true;
      }
    }
    if (ps.t > 5 || g.shotClock < 1.5) {
      this.hs.post = null;
      h.vCmd = null;
      this.startShot(h, false);
      return true;
    }
    return true;
  }

  /** ドライブ中。続けるなら true */
  private driveStep(h: Player, dt: number, C: number): boolean {
    const g = this.g;
    const dr = this.hs.drive!;
    dr.t += dt;
    const wp = dr.path[Math.min(dr.i, dr.path.length - 1)];
    if (dist(h.p, wp) < 0.5 && dr.i < dr.path.length - 1) dr.i++;
    const dir = dirTo(h.p, dr.path[Math.min(dr.i, dr.path.length - 1)]);
    h.vCmd = mul(dir, h.speedNow());
    h.effort = dr.force ? 1 : 0.75;
    h.urgency = 1;
    if (dr.force) {
      h.pushBoost = 1.2 + 0.6 * n(h.a.strength);
      // 進路の正面に守備者が居て、力で勝っていれば肩で押し込む（パワードライブ）
      const block = g.defense.find((d) => dist(d.p, h.p) < 1.0 && dot(sub(d.p, h.p), dir) > 0.3);
      if (block && dr.t > 0.15 && this.attackAdv(h, block) > 0.05 && g.t - this.hs.lastMoveT > 0.8) {
        const s = dot(sub(block.p, h.p), right(dir)) > 0 ? -1 : 1;
        this.hs.drive = null;
        h.vCmd = null;
        this.beginMove(h, "power", s);
        return true;
      }
    }
    h.face = dir;
    h.stanceCmd = 0.3;
    const atRim = distRim(h.p) < 1.7;
    dr.re -= dt;
    if (dr.re > 0 && !atRim) return true;
    dr.re = 0.1;
    const rest = [h.p, ...dr.path.slice(dr.i)];
    const lane = driveLane(this.lc(), h, rest);
    // ドライブ中も毎回パスの導線を見る（ヘルプが寄った瞬間のダンプオフ／キックアウト）
    const opts = this.evaluate(h, C);
    const pass = this.okPass(h, bestPass(opts), C);
    const shoot = bestOf(opts, "shoot")!;
    const closer = lane.closer;
    const helpTxt = closer ? ` ${g.tag(closer)} がヘルプ` : "ヘルプ";
    const passLabel = (p: Option) => (p.kind === "lob" ? "ロブ" : distRim(p.to!.p) < 3.5 ? "ダンプオフ" : "キックアウト");
    if (atRim) {
      this.hs.drive = null;
      h.vCmd = null;
      if (pass && pass.value > shoot.value + 0.05) {
        this.execute(h, pass);
        g.log(`${g.tag(h)} リムで${helpTxt} → ${passLabel(pass)}`, "pass", h.team);
      } else this.startShot(h, false);
      return true;
    }
    const keepDriving = dr.force ? (lane.open >= 0.08 || dr.t < 0.7) && dr.t < 2.8 : lane.open >= 0.25 && dr.t < 2.8;
    const driveVal = keepDriving ? C + (shoot.value - C) * 0.3 + lane.open * 0.4 : 0;
    if (pass && pass.value > Math.max(shoot.value, driveVal) + 0.03 && (!keepDriving || lane.open < 0.7)) {
      this.hs.drive = null;
      h.vCmd = null;
      this.execute(h, pass);
      g.log(`${g.tag(h)} のドライブに${helpTxt} → ${passLabel(pass)}`, "pass", h.team);
      return true;
    }
    if (keepDriving) return true;
    // 導線が消された → パス／ユーロ／プルアップ／止まるを期待値で比べる
    this.hs.drive = null;
    h.vCmd = null;
    const euroV = distRim(h.p) < 3.6 && closer
      ? shotEV(h, finishPoint(h.p), Math.min(1, (shoot.lane?.open ?? 0) + 0.25 + 0.25 * n(h.a.handle)))
      : -1;
    const best = Math.max(pass?.value ?? -1, euroV, shoot.value);
    if (pass && pass.value === best) {
      this.execute(h, pass);
      g.log(`${g.tag(h)} のドライブに${helpTxt} → ${passLabel(pass)}`, "pass", h.team);
      return true;
    }
    if (euroV === best && closer) {
      const lat = right(dirTo(h.p, RIM));
      const s = dot(sub(closer.p, h.p), lat) > 0 ? -1 : 1;
      this.beginMove(h, "euro", s);
      return true;
    }
    if (shoot.value > C * 0.85) { this.startShot(h, false); return true; }
    return false;
  }

  private holdOrGoal(h: Player, _dt: number): void {
    const hs = this.hs;
    h.urgency = hs.goal ? 0.7 : 0.4;
    h.vCmd = null;
    h.pushBoost = 1;
    h.stanceCmd = 0.35;
    if (hs.goal && hs.goalI < hs.goal.length) {
      const wp = hs.goal[hs.goalI];
      if (dist(h.p, wp) < 0.6) hs.goalI++;
      if (hs.goalI < hs.goal.length) {
        if (!hs.dribbled) hs.dribbled = true;
        h.tgt = hs.goal[hs.goalI];
        h.spd = hs.goalI >= 2 ? 1 : 0.85;
        h.face = null;
        return;
      }
      hs.goal = null;
    }
    // 自陣側・遠い: ボールを前へ運ぶ（トランジションは急ぐ）
    if (distRim(h.p) > 9.5) {
      if (!hs.dribbled) hs.dribbled = true;
      h.tgt = h.p.x >= 0 ? (Math.abs(h.p.x) > 3 ? SPOT.wing(1) : SPOT.top()) : (Math.abs(h.p.x) > 3 ? SPOT.wing(-1) : SPOT.top());
      h.spd = this.transition ? 1 : 0.8;
      h.urgency = 0.7;
      h.face = null;
      return;
    }
    // 止まってゴールを見る。少しずつリムへ探る
    h.tgt = hs.dribbled ? madd(h.p, dirTo(h.p, RIM), 0.15) : h.p;
    h.spd = 0.4;
    h.face = dirTo(h.p, RIM);
  }

  // ------------------------------------------------------------------ オフボール

  private offBall(p: Player, dt: number): void {
    const g = this.g;
    const b = g.ball;
    const s = this.stOf(p);
    s.t += dt;
    p.vCmd = null;
    if (s.mode !== "screen") p.pushBoost = 1;
    const h = this.handler();

    if (b.k === "pass" && b.to === p) {
      p.urgency = 0.7;
      p.tgt = b.p1;
      p.spd = 1;
      p.face = dirTo(p.p, b.p0);
      p.stanceCmd = 0.2;
      return;
    }

    switch (s.mode) {
      case "spot": {
        // ゴール下の持ち場はポジション争い（押されたら押し返す）
        if (distRim(s.spot) < 3.8) p.effort = 0.9;
        p.tgt = s.spot;
        p.spd = 0.75;
        p.face = h && dist(p.p, s.spot) < 1.5 ? dirTo(p.p, h.p) : null;
        p.stanceCmd = 0.2;
        if (h && dist(p.p, s.spot) < 0.9) this.idleAdjust(p, s, h, dt);
        if (h && !s.scripted) {
          s.relocT -= dt;
          if (s.relocT <= 0) {
            s.relocT = 0.45 + g.rng.next() * 0.2;
            if (!this.maybeCut(p, s, h)) this.relocate(p, s, h);
          }
        }
        return;
      }
      case "cut":
      case "roll": {
        this.followPath(p, s);
        return;
      }
      case "screen":
        this.screenStep(p, s, dt);
        return;
      case "pop": {
        p.urgency = 0.5;
        p.tgt = s.spot;
        p.spd = 1;
        p.face = null;
        p.stanceCmd = 0;
        if (dist(p.p, s.spot) < 0.6) { s.mode = "spot"; s.scripted = false; }
        return;
      }
      case "handoff": {
        // 手渡しを受けに寄る
        if (h) {
          p.tgt = madd(h.p, dirTo(h.p, p.p), 0.9);
          p.spd = 0.9;
          p.face = dirTo(p.p, h.p);
        }
        return;
      }
      case "crash": {
        p.effort = 1;
        p.urgency = 1;
        const land = g.def.landing();
        p.tgt = madd(land, dirTo(land, p.p), 0.3);
        p.spd = 1;
        p.face = null;
        p.stanceCmd = 0.3;
        if (b.k === "loose" && p.shouldJumpFor(b.p, b.v, b.h, b.vy)) p.jump(0.6, 0.15);
        return;
      }
      case "safety": {
        p.tgt = s.spot;
        p.spd = 0.8;
        p.face = dirTo(p.p, RIM);
        return;
      }
    }
  }

  /**
   * 持ち場での微調整: 棒立ちにしない。左右（外周に沿って）や前後に半歩ずつ動き直し、
   * ボールとリムの両方が見える向きへ。マークが近ければときどきリムへ一歩踏み込んで戻る（揺さぶり）。
   */
  private idleAdjust(p: Player, s: OffState, h: Player, dt: number): void {
    const g = this.g;
    // 選手ごとのリズム: 攻撃IQが高いほどよく動き直す × 個性（±25%）
    const period = (0.7 + 1.4 * (1 - n(p.a.offIQ))) * (0.75 + 0.5 * p.quirk(1));
    if (s.microT < 0) s.microT = g.rng.next() * period; // 初回は選手ごとにばらばら
    s.microT -= dt;
    if (s.microT <= 0) {
      s.microT = period * (0.6 + 0.8 * g.rng.next());
      const amp = 0.35 + 0.25 * p.quirk(2);
      const tang = right(dirTo(s.spot, RIM));
      const toR = dirTo(s.spot, RIM);
      const d = this.defOf(p);
      const close = d ? dist(d.p, p.p) < 1.6 : false;
      if (close && g.rng.chance(0.3)) {
        // 揺さぶり: リムへ踏み込む（次の微調整で戻る）
        s.micro = mul(toR, 0.6);
      } else {
        s.micro = madd(mul(tang, (g.rng.next() - 0.5) * 2 * amp), toR, (g.rng.next() - 0.5) * 0.4);
      }
    }
    p.tgt = inCourt(add(s.spot, s.micro), 0.3);
    p.spd = 0.4;
    p.stanceCmd = 0.3;
    // ボールとリムの両方が見える向き
    p.face = norm(add(dirTo(p.p, h.p), mul(dirTo(p.p, RIM), 0.55)));
  }

  private followPath(p: Player, s: OffState): void {
    if (!s.path) { s.mode = "spot"; return; }
    const end = s.path[s.path.length - 1];
    if (s.pathI < s.path.length && dist(p.p, s.path[s.pathI]) < 0.55) s.pathI++;
    if (s.pathI < s.path.length) {
      p.urgency = 0.85;
      p.tgt = s.path[s.pathI];
      p.spd = 1;
      p.face = null;
      p.stanceCmd = 0;
      return;
    }
    // 終点で少し待つ（待ち合わせのパス）
    s.waitT += 1 / 60;
    p.tgt = end;
    p.face = this.handler() ? dirTo(p.p, this.handler()!.p) : null;
    if (s.waitT > 0.9) {
      s.path = null;
      s.scripted = false;
      this.setSpot(p, s.afterSpot ?? this.freeSpot(p));
      s.afterSpot = null;
    }
  }

  /** 空いている外周のスポット。h = ボールを持つ人（パスが飛んでいる間は受け手を渡す） */
  freeSpot(p: Player, h: Player | null = this.handler()): V2 {
    let best = SPOT.top();
    let bs = -1e9;
    for (const q of roleSpots(offRole(p), h ? h.p : null)) {
      let crowd = 0;
      for (const o of this.pl) {
        if (o === p) continue;
        const at = o === h ? o.p : this.stOf(o).spot;
        crowd += Math.max(0, 3.8 - dist(q, at));
      }
      const sc = -crowd - 0.08 * dist(q, p.p);
      if (sc > bs) { bs = sc; best = q; }
    }
    return best;
  }

  /** 自分への導線が最大になる位置へ微調整（ドライブにはドリフト／リフト） */
  private relocate(p: Player, s: OffState, h: Player): void {
    const lc = this.lc();
    const role = offRole(p);
    const cands: V2[] = [s.spot, ...roleSpots(role, h.p)];
    if (role !== "big") {
      // 今の持ち場から外周に沿って少しずらす（パスコースを自分で作る）
      const tang = right(dirTo(s.spot, RIM));
      cands.push(inCourt(madd(s.spot, tang, 1.3)), inCourt(madd(s.spot, tang, -1.3)));
    }
    let best = s.spot;
    let bs = -1e9;
    for (const c of cands) {
      if (dist(c, h.p) < 3.2) continue;
      let crowd = 0;
      for (const o of this.pl) {
        if (o === p || o === h) continue;
        const os = this.stOf(o);
        crowd += Math.max(0, 3.8 - Math.min(dist(c, os.spot), dist(c, o.p))) * 0.15;
      }
      const sc = receiveValue(lc, h, p, c)
        - crowd
        - 0.12 * Math.max(0, 4.5 - dist(c, h.p))           // ハンドラーの周りを空ける
        + 0.03 * Math.min(5, distToSeg(c, h.p, RIM))         // マークをドライブの線から遠ざける
        - 0.025 * dist(c, p.p)
        - (c === s.spot ? 0 : 0.03);
      if (sc > bs) { bs = sc; best = c; }
    }
    s.spot = best;
  }

  /** ディナイされたらバックドア／ボールを見ている守備者の裏へ */
  private maybeCut(p: Player, s: OffState, h: Player): boolean {
    const g = this.g;
    const role = offRole(p);
    if (this.hs.drive || distRim(p.p) < 4.5 || distRim(h.p) < 5 || CUT_RATE[role] <= 0) return false;
    if (this.pl.some((o) => o !== p && (this.stOf(o).mode === "cut" || this.stOf(o).mode === "roll"))) return false;
    const d = this.defOf(p);
    if (!d) return false;
    const lc = this.lc();
    const lane = receiveLane(lc, h, p);
    const toD = dirTo(p.p, d.p);
    // マークがボール側に出ている（オーバープレー）＝裏が空いている
    const denied = lane.closer === d && lane.open < 0.3 && dot(toD, dirTo(p.p, h.p)) > 0.3;
    // マークが自分とゴールの間に居るならカットしても入れない
    const defBlocksRim = dot(toD, dirTo(p.p, RIM)) > 0.3 && dist(d.p, p.p) < 3.5;
    const watching = !defBlocksRim && dist(d.p, p.p) > 2.0 && dot(d.f, dirTo(d.p, h.p)) > 0.7;
    const rimFront = madd(RIM, dirTo(RIM, p.p), 1.0);
    const rimClear = rimCrowd(this.pl, h) === 0;
    if ((denied || watching) && rimClear && g.rng.chance(CUT_RATE[role] * (0.3 + 0.5 * n(p.a.offIQ)))) {
      this.setCut(p, [madd(p.p, dirTo(p.p, RIM), 0.8), rimFront], false, 1.5, denied ? "バックドア" : "ベースカット");
      s.scripted = false;
      g.log(`${g.tag(p)} ${denied ? "ディナイされてバックドア" : "マークの裏へカット"}`, "move", p.team);
      return true;
    }
    // ディナイされているが裏も無い → Vカット（一歩ゴールへ踏み込んで、外へ出直してパスコースを作る）
    if (lane.closer === d && lane.open < 0.3 && g.rng.chance(0.3 + 0.4 * n(p.a.offIQ))) {
      const out = inCourt(madd(madd(s.spot, dirTo(RIM, s.spot), 0.6), dirTo(s.spot, h.p), 1.0));
      this.setCut(p, [madd(p.p, dirTo(p.p, RIM), 1.0), out], false, 1.5, "Vカット", "cut", out);
      s.scripted = false;
      return true;
    }
    return false;
  }

  private screenStep(p: Player, s: OffState, dt: number): void {
    const g = this.g;
    const user = s.screenFor;
    const ud = user ? this.defOf(user) : null;
    if (!user || !ud) { this.afterScreen(p, s); return; }
    if (s.setT <= 0) {
      let dest = s.screenDest;
      if (!dest) {
        // オンボール: 使う人が横へ抜ける向き（守備者の横に立つ）
        const lat = right(dirTo(user.p, RIM));
        dest = madd(user.p, lat, 2.5 * this.playSide());
      }
      // 守備者の死角（背中側）かつ、守備者が付いていく方向をふさぐ位置
      const go = dirTo(ud.p, dest);
      const back = { x: -ud.f.x, z: -ud.f.z };
      const dir = norm({ x: go.x * 0.75 + back.x * 0.65, z: go.z * 0.75 + back.z * 0.65 });
      // 接する距離ではなく少し間を空ける（守備者の方から当たってくる位置）
      const pt = madd(ud.p, dir, ud.radius + p.radius + 0.22);
      // 守備者の視界（前）を横切らないよう、背中側から回り込んで入る
      const front = dot(sub(p.p, ud.p), ud.f) > 0.2 && dist(p.p, ud.p) < 3.5;
      p.tgt = inCourt(front ? madd(pt, back, 1.0) : pt, 0.2);
      p.urgency = 0.5;
      // 近づいたら減速して入る（走ったまま当たる＝ムービングスクリーンにしない）
      p.spd = Math.max(0.35, Math.min(1, dist(p.p, pt) / 1.5));
      p.face = dirTo(p.p, ud.p);
      p.stanceCmd = 0.3;
      if (dist(p.p, pt) < 0.3 && len(p.v) < 0.35) {
        s.setT = 1e-3;
        s.setPos = copy(p.p);
        p.say("スクリーン", 1.2);
      }
      if (s.t > 4.5) this.afterScreen(p, s);
      return;
    }
    s.setT += dt;
    // セットしたらその場で止まって構え、当たってきた守備者を受け止める（押しに行かない）
    p.screenSet = true;
    p.tgt = s.setPos ?? p.p;
    p.vCmd = V();
    p.spd = 0.3;
    p.stanceCmd = 1;
    if (s.screenFor) p.face = dirTo(p.p, s.screenFor.p);
    p.pushBoost = 1.3 + 0.7 * n(p.a.screen);
    const du = dist(user.p, p.p);
    if (du < 1.5) s.used = true;
    if ((s.used && du > 1.9) || s.setT > s.holdMax) this.afterScreen(p, s);
  }

  /** PnR の向き（+1/-1）。プレーが決める */
  playSide(): number {
    return this.play?.side ?? 1;
  }

  private afterScreen(p: Player, s: OffState): void {
    p.pushBoost = 1;
    p.stanceCmd = 0;
    s.setT = 0;
    const g = this.g;
    switch (s.after) {
      case "roll": {
        const alley = p.reachMax >= 3.32 && (this.handler()?.a.passing ?? 0) >= 60;
        const path = [madd(p.p, dirTo(p.p, RIM), 1.2), madd(RIM, dirTo(RIM, p.p), 1.0)];
        this.setCut(p, path, alley, alley ? 3.2 : 1.6, alley ? "ロール(ロブ待ち)" : "ロール", "roll");
        g.log(`${g.tag(p)} スクリーンからロール`, "screen", p.team);
        return;
      }
      case "pop": {
        s.mode = "pop";
        s.spot = inCourt(s.afterSpot ?? this.freeSpot(p));
        s.home = copy(s.spot);
        p.say("ポップ", 1.0);
        g.log(`${g.tag(p)} スクリーンから外へポップ`, "screen", p.team);
        return;
      }
      default:
        this.setSpot(p, s.afterSpot ?? this.freeSpot(p));
    }
  }
}

/** p が今いる場所で受ける導線 */
function receiveLane(lc: LaneCtx, h: Player, p: Player): Lane {
  return bestPassLane(lc, h, p, p.p, true);
}

/** 開いているパスの中で期待値が最大のもの */
function bestPass(opts: Option[]): Option | null {
  let b: Option | null = null;
  for (const o of opts) {
    if ((o.kind !== "pass" && o.kind !== "lead" && o.kind !== "lob") || !o.lane || !o.to || o.lane.open < passMinOpen(o.lane)) continue;
    if (!b || o.value > b.value) b = o;
  }
  return b;
}
