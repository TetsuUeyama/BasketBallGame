// 試合進行（ハーフコート。両チームが同じゴールを交互に攻める）。
import { PlayerDef, makeTeam, n } from "./attrs";
import { BALL_R, BOARD, COURT, NET, RIM, SPOT, baselineInbound, distRim, outOfBounds, throwInSpot } from "./court";
import { dot } from "./math";
import { resolveContacts } from "./contact";
import { Defense } from "./defense";
import { SHOT_LABEL, ShotType, pMakeType, shotBase } from "./eval";
import { Lane, LaneKind, PASS_LABEL, PassStyle, passHeight } from "./lanes";
import { V, V2, add, clamp, copy, dirTo, dist, len, lerp, lerpV, madd, mul, norm, Rng } from "./math";
import { Offense } from "./offense";
import { DT, Player, Team, V3, dist3 } from "./player";
import { aimHands } from "./hands";
import { steerAll } from "./steer";
import { CALL_LABEL, COVER_LABEL, CallId, CoverageId } from "./plays";

export type Phase = "setup" | "jumpball" | "throwin" | "live" | "dead" | "gameover";

export type BallState =
  | { k: "held"; owner: Player }
  | { k: "pass"; from: Player; to: Player; p0: V2; p1: V2; h0: number; h1: number; T: number; t: number; lob: boolean; style: PassStyle; L: number; tried: Set<number>; lane: LaneKind; open: number }
  | { k: "shot"; by: Player; p0: V2; h0: number; T: number; t: number; made: boolean; pts: number; open: number; tried: Set<number>; rim: boolean; apex: number; type: ShotType; dev: V2; tipped: boolean }
  | { k: "loose"; p: V2; v: V2; h: number; vy: number; t: number; lastTouch: Team; noGrab?: number; noGrabT?: number }
  | { k: "dead"; p: V2; h: number; v?: V2; vy?: number }
  | { k: "inbound"; p0: V2; h0: number; to: Player; t: number; T: number };

export type EvKind = "score" | "miss" | "move" | "break" | "pass" | "to" | "call" | "def" | "screen" | "info";

export interface GEvent {
  t: number;
  text: string;
  team: Team | -1;
  kind: EvKind;
}

export interface TeamStats {
  fga: number; fgm: number; tpa: number; tpm: number; to: number; stl: number; breaks: number; oreb: number;
}

const WIN = 21;

export class Game {
  rng: Rng;
  t = 0;
  players: Player[] = [];
  teams: Player[][] = [[], []];
  names = ["RED", "BLUE"];
  score = [0, 0];
  stats: TeamStats[] = [this.blankStats(), this.blankStats()];
  offTeam: Team = 0;
  phase: Phase = "setup";
  phaseT = 0;
  shotClock = 24;
  ball: BallState;
  /** 表示の向き: true なら sim の座標を180°回して描く（チーム1が攻撃中） */
  flip = false;
  off: Offense;
  def: Defense;
  events: GEvent[] = [];
  /** 表示用: いま評価されている導線 */
  viewLanes: Lane[] = [];
  /** 表示用: 直近のシュートの導線の開き */
  lastShotOpen = -1;
  private contactPairs = new Set<string>();
  /** 直前のルーズボールがシュートの外れか */
  private lastWasShot = false;
  /** ルーズボールの予測軌道（表示と手の狙い用、毎フレーム更新） */
  loosePath: { x: number; z: number; h: number; t: number }[] = [];
  /** ジャンプボール中のジャンパー（弾くまで他は触れない） */
  private jb: { a: Player; b: Player; tapped: boolean; offA: number; offB: number } | null = null;
  private nextPoss: Team = 0;
  private deadReason = "";
  /** 次はこの地点からスローイン（null ならトップからのチェックボール） */
  private throwSpot: V2 | null = null;
  private throwClock = 24;
  /** スローインする人がボールを持ってからの時間（5秒） */
  private throwHeldT = 0;

  constructor(seed = 12345) {
    this.rng = new Rng(seed);
    const defs: PlayerDef[][] = [makeTeam(this.rng), makeTeam(this.rng)];
    let id = 0;
    for (const team of [0, 1] as Team[]) {
      defs[team].forEach((d, slot) => {
        const x = (slot - 2) * 2.2;
        const p = new Player(id++, team, slot, d, V(x, team === 0 ? -3 : 3), V(0, team === 0 ? 1 : -1));
        this.players.push(p);
        this.teams[team].push(p);
      });
    }
    this.ball = { k: "dead", p: V(0, 0), h: 0.2 };
    this.off = new Offense(this);
    this.def = new Defense(this);
    this.startJumpBall();
  }

  private blankStats(): TeamStats {
    return { fga: 0, fgm: 0, tpa: 0, tpm: 0, to: 0, stl: 0, breaks: 0, oreb: 0 };
  }

  get offense(): Player[] { return this.teams[this.offTeam]; }
  get defense(): Player[] { return this.teams[1 - this.offTeam]; }
  get call(): CallId { return this.off.call; }
  get coverage(): CoverageId { return this.def.coverage; }
  callLabel(): string { return CALL_LABEL[this.off.call]; }
  coverLabel(): string { return COVER_LABEL[this.def.coverage]; }

  holder(): Player | null {
    return this.ball.k === "held" ? this.ball.owner : null;
  }

  log(text: string, kind: EvKind, team: Team | -1 = -1): void {
    this.events.push({ t: this.t, text, team, kind });
    if (this.events.length > 60) this.events.shift();
  }

  tag(p: Player): string {
    return `${this.names[p.team]}#${p.d.num}`;
  }

  // ------------------------------------------------------------------ 進行

  startPossession(team: Team): void {
    this.offTeam = team;
    this.phase = "setup";
    this.phaseT = 0;
    this.shotClock = 20;
    // ハーフコートの「チェックボール」: 持っている人がいれば手元に置き、新ハンドラーへ渡し直す
    if (this.ball.k === "held") {
      const o = this.ball.owner;
      this.ball = { k: "dead", p: copy(o.handPos()), h: 1.0 };
    } else if (this.ball.k !== "dead") {
      const bp = this.ballPos();
      this.ball = { k: "dead", p: copy(bp.p), h: bp.h };
    }
    this.off.reset(team);
    this.def.reset(1 - team as Team);
    this.log(`${this.names[team]} の攻撃。コール: ${this.callLabel()}`, "call", team);
  }

  /**
   * ジャンプボール: センターサークルで各チームの最も高く手が届く選手が向かい合い、残りは自陣側のサークルの外。
   * （デッドボールの配置なので位置を置く）。審判が真上へ投げ上げ、先に手が触れたジャンパーが味方へ弾く。
   */
  private startJumpBall(): void {
    if (this.offTeam !== 0) { this.flipFrame(); this.offTeam = 0; }
    this.phase = "jumpball";
    this.phaseT = 0;
    this.shotClock = 24;
    const pick = (t: Team) => [...this.teams[t]].sort((a, b) => b.reachMax - a.reachMax)[0];
    const a = pick(0), b = pick(1);
    const place = (p: Player, x: number, z: number, fz: number) => {
      p.p = V(x, z); p.v = V(); p.tgt = V(x, z); p.f = V(0, fz); p.vCmd = null; p.face = V(0, fz);
      p.bal.reset(V()); p.airT = 0; p.fallT = 0; p.stanceCmd = 0.3;
    };
    place(a, 0, -0.5, 1);
    place(b, 0, 0.5, -1);
    const spots0 = [V(-2.5, -1.4), V(2.5, -1.4), V(-4.2, -4.5), V(4.2, -4.5)];
    this.teams[0].filter((p) => p !== a).forEach((p, i) => place(p, spots0[i].x, spots0[i].z, 1));
    this.teams[1].filter((p) => p !== b).forEach((p, i) => place(p, -spots0[i].x, -spots0[i].z, -1));
    this.off.resetJump(0);
    this.def.reset(1);
    // 跳ぶタイミングのずれ（反応が遅いほど早すぎ・遅すぎになりやすい）
    const off = (p: Player) => (this.rng.next() - 0.5) * 0.18 * (1.2 - n(p.a.reaction));
    this.jb = { a, b, tapped: false, offA: off(a), offB: off(b) };
    this.ball = { k: "loose", p: V(0, 0), v: V(), h: 1.9, vy: 6.4, t: 0, lastTouch: 0 };
    this.log(`ジャンプボール: ${this.tag(a)} vs ${this.tag(b)}`, "call", -1);
  }

  /**
   * ジャンプボール: 落ちてくるボールが自分の手の最高到達点に来る時刻を軌道から計算し、
   * ジャンプの最高点がそこに重なるように跳ぶ（タイミングのずれは反応で決まる）。
   */
  private updateJumpBall(): void {
    const jb = this.jb!;
    const b = this.ball;
    for (const p of this.players) {
      p.vCmd = null;
      p.tgt = p.p;
      p.stanceCmd = 0.35;
      p.face = dirTo(p.p, V(0, 0));
      if ((p !== jb.a && p !== jb.b) || b.k !== "loose" || p.airborne) continue;
      const tHit = this.jumpTouchTime(p);
      if (tHit === null) continue;
      const tApex = Math.sqrt((2 * p.jumpH) / 9.8);
      if (tHit - tApex <= (p === jb.a ? jb.offA : jb.offB)) p.jump(0.7, 0);
    }
  }

  /** 落ちてくるボールがこのジャンパーの最高到達点（−0.1m）に来るまでの時間 */
  private jumpTouchTime(p: Player): number | null {
    const b = this.ball;
    if (b.k !== "loose") return null;
    const hT = p.reachMax - 0.1;
    const disc = b.vy * b.vy + 19.6 * (b.h - hT);
    if (disc < 0) return null;
    return (b.vy + Math.sqrt(disc)) / 9.8;
  }

  /** 表示用: ジャンプボールで各ジャンパーが手を合わせにいく高さ */
  jumpBallMarks(): { team: Team; h: number }[] {
    if (!this.jb || this.jb.tapped) return [];
    return [this.jb.a, this.jb.b].map((p) => ({ team: p.team, h: p.reachMax - 0.1 }));
  }

  /** シュート中のボールの dt 秒後の位置 */
  shotPosAt(dt: number): V3 {
    const b = this.ball;
    if (b.k !== "shot") { const bp = this.ballPos(); return { x: bp.p.x, y: bp.h, z: bp.p.z }; }
    const s = clamp((b.t + dt) / b.T, 0, 1);
    const end = add(RIM, b.dev);
    const p = lerpV(b.p0, end, s);
    return { x: p.x, y: lerp(b.h0, COURT.rimH + 0.1, s) + 4 * b.apex * s * (1 - s) * 0.5, z: p.z };
  }

  /** ルーズボールの軌道の予測（重力・床・ボード）。dt=1/30 */
  predictLoose(T: number): { x: number; z: number; h: number; t: number }[] {
    const b = this.ball;
    if (b.k !== "loose") return [];
    let p = copy(b.p), v = copy(b.v), h = b.h, vy = b.vy;
    const out = [{ x: p.x, z: p.z, h, t: 0 }];
    const dt = 1 / 30;
    for (let t = dt; t <= T; t += dt) {
      vy -= 9.8 * dt;
      h += vy * dt;
      const z0 = p.z;
      p = madd(p, v, dt);
      const sg = p.z >= 0 ? 1 : -1;
      if (Math.abs(p.x) < BOARD.halfW + 0.12 && h > BOARD.y0 - 0.12 && h < BOARD.y1 + 0.12 && z0 * sg <= BOARD.z - 0.12 && p.z * sg > BOARD.z - 0.12) {
        p = { x: p.x, z: (BOARD.z - 0.12) * sg };
        v = { x: v.x * 0.8, z: -Math.abs(v.z) * 0.6 * sg };
        vy = Math.max(vy, 0) * 0.7 + 0.6;
      }
      if (h < 0.12) { h = 0.12; if (vy < 0) vy = -vy * 0.55; if (vy < 0.4) vy = 0; v = mul(v, 0.8); }
      if (vy === 0) v = mul(v, Math.exp(-dt * 1.2));
      out.push({ x: p.x, z: p.z, h, t });
    }
    return out;
  }

  /** 攻守交代: 全員とボールを180°回した座標へ置き換え、表示の向きを反転（画面上は動かない） */
  private flipFrame(): void {
    const ng = (v: V2): V2 => ({ x: -v.x, z: -v.z });
    for (const p of this.players) p.flipFrame();
    const b = this.ball;
    switch (b.k) {
      case "pass": b.p0 = ng(b.p0); b.p1 = ng(b.p1); break;
      case "shot": b.p0 = ng(b.p0); b.dev = ng(b.dev); break;
      case "loose": b.p = ng(b.p); b.v = ng(b.v); break;
      case "dead": b.p = ng(b.p); if (b.v) b.v = ng(b.v); break;
      case "inbound": b.p0 = ng(b.p0); break;
      default: break;
    }
    this.flip = !this.flip;
  }

  /** 生きたボールのまま攻守交代（守備リバウンド・スティール）→ そのままトランジション */
  private changeLive(team: Team, why: string): void {
    const h = this.holder();
    this.offTeam = team;
    this.flipFrame();
    this.phase = "live";
    this.phaseT = 0;
    this.shotClock = 24;
    this.off.resetTransition(team, h);
    this.def.resetTransition((1 - team) as Team);
    this.log(`${this.names[team]} ボール（${why}）→ トランジション`, "call", team);
    this.lastWasShot = false;
  }

  /** ラインの外からのスローイン（spot は今の座標。攻撃側が替わるなら座標を回してから） */
  private startThrowIn(team: Team, spot: V2): void {
    if (team !== this.offTeam) {
      this.flipFrame();
      spot = { x: -spot.x, z: -spot.z };
      this.throwSpot = spot;
    }
    this.throwSpot = spot;
    this.offTeam = team;
    this.phase = "throwin";
    this.phaseT = 0;
    this.throwHeldT = 0;
    if (this.ball.k !== "dead") {
      const bp = this.ballPos();
      this.ball = { k: "dead", p: copy(bp.p), h: bp.h };
    }
    this.off.resetThrowIn(team, spot);
    this.def.reset(1 - team as Team);
    // 自陣エンドラインからのスローイン（得点のあと等）: 守備側は全員自陣へ戻る
    if (spot.z < -COURT.baseZ + 1) this.def.beginGetBack();
    this.log(`${this.names[team]} のスローイン（${this.tag(this.off.inbounder!)} が入れる）`, "call", team);
  }

  private updateThrowIn(dt: number): void {
    const spot = this.throwSpot!;
    const ib = this.off.inbounder!;
    this.off.updateThrowIn(dt, spot);
    const b = this.ball;
    if (b.k === "dead") {
      this.def.updateSetup(dt);
      // 審判からボールを受け取る
      if (dist(ib.p, spot) < 0.7) {
        this.ball = { k: "held", owner: ib };
        this.off.onCatch(ib, null);
        this.throwHeldT = 0;
      }
      return;
    }
    this.def.update(dt);
    if (b.k === "held" && b.owner === ib) {
      this.throwHeldT += dt;
      if (this.throwHeldT > 5) {
        this.log(`${this.tag(ib)} 5秒以内に入れられずバイオレーション → ${this.names[1 - ib.team]} のスローイン`, "to", ib.team);
        this.stats[ib.team].to++;
        this.endPossession((1 - ib.team) as Team, "5sec", spot, 24);
      }
      return;
    }
    // 中の味方が受けた／弾かれてルーズ → プレー再開
    if ((b.k === "held" && b.owner.team === this.offTeam) || b.k === "loose") {
      this.phase = "live";
      this.phaseT = 0;
      this.shotClock = this.throwClock;
      this.off.goLiveInbound();
      this.def.goLive();
    }
  }

  private endPossession(next: Team, reason: string, throwSpot: V2 | null = null, clock = 20): void {
    this.phase = "dead";
    this.phaseT = 0;
    this.nextPoss = next;
    this.deadReason = reason;
    this.throwSpot = throwSpot;
    this.throwClock = clock;
    for (const p of this.players) { p.vCmd = null; p.face = null; p.stanceCmd = 0; p.dribbling = false; p.pushBoost = 1; p.screenSet = false; }
  }

  update(dt: number): void {
    this.t += dt;
    this.phaseT += dt;
    for (const p of this.players) { p.effort = 0.25; p.urgency = 0.2; p.bendCmd = 0; }

    if (this.phase === "gameover") {
      for (const p of this.players) { p.vCmd = null; p.tgt = p.p; p.update(dt); }
      if (this.phaseT > 4) {
        this.score = [0, 0];
        this.stats = [this.blankStats(), this.blankStats()];
        this.log("新しい試合", "info");
        this.startJumpBall();
      }
      this.updateBall(dt);
      return;
    }

    if (this.phase === "dead") {
      for (const p of this.players) { p.tgt = p.p; }
      if (this.phaseT > 1.2) {
        if (this.score[0] >= WIN || this.score[1] >= WIN) {
          const w = this.score[0] >= WIN ? 0 : 1;
          this.log(`試合終了 ${this.names[w]} の勝ち ${this.score[0]}-${this.score[1]}`, "score", w as Team);
          this.phase = "gameover";
          this.phaseT = 0;
        } else {
          this.startThrowIn(this.nextPoss, this.throwSpot ?? baselineInbound(1));
        }
      }
    } else if (this.phase === "setup") {
      this.off.updateSetup(dt);
      this.def.updateSetup(dt);
      const h = this.off.handler0;
      if (this.ball.k === "dead" && dist(h.p, SPOT.check()) < 1.2) {
        const bp = this.ball.p;
        this.ball = { k: "inbound", p0: copy(bp), h0: Math.max(0.3, this.ball.h), to: h, t: 0, T: clamp(dist(bp, h.p) / 9, 0.4, 1.4) };
      }
      if (this.ball.k === "held" && (this.off.setupDone() || this.phaseT > 6)) {
        this.phase = "live";
        this.phaseT = 0;
        this.shotClock = 20;
        this.off.goLive();
        this.def.goLive();
      }
    } else if (this.phase === "jumpball") {
      this.updateJumpBall();
    } else if (this.phase === "throwin") {
      this.updateThrowIn(dt);
    } else if (this.phase === "live") {
      // ボールを持ったままラインを越えたらアウト → 相手のスローイン
      const hh = this.holder();
      if (hh && hh.team === this.offTeam && outOfBounds(hh.p)) {
        this.log(`${this.tag(hh)} がボールを持ったままラインの外へ → ${this.names[1 - hh.team]} のスローイン`, "to", hh.team);
        this.stats[hh.team].to++;
        this.ball = { k: "dead", p: copy(hh.handPos()), h: 1.0 };
        this.endPossession((1 - hh.team) as Team, "oob", throwInSpot(hh.p), 24);
      }
    }
    if (this.phase === "live") {
      if (this.ball.k === "held" || this.ball.k === "pass") {
        this.shotClock -= dt;
        if (this.shotClock <= 0) {
          this.log(`${this.names[this.offTeam]} ショットクロック・バイオレーション`, "to", this.offTeam);
          this.stats[this.offTeam].to++;
          this.endPossession((1 - this.offTeam) as Team, "24", baselineInbound(this.rng.sign()), 24);
        }
      }
      if (this.phase === "live") {
        this.off.update(dt);
        this.def.update(dt);
      }
    }

    this.loosePath = this.ball.k === "loose" ? this.predictLoose(1.2) : [];
    steerAll(this);
    aimHands(this);
    for (const p of this.players) {
      const res = p.update(dt);
      if (res === 2) this.onFall(p);
      else if (res === 1 && this.phase === "live") this.onBreak(p);
    }
    this.contactPairs = resolveContacts(this.players, this.contactPairs, (a, b, vrel) => this.onContact(a, b, vrel), (w, l) => this.onShove(w, l), dt);
    this.boardCollide();
    this.updateBall(dt);
  }

  private onFall(p: Player): void {
    p.say("転倒！", 1.6);
    this.log(`${this.tag(p)} が転倒（${p.fallWhy || "重心が大きく外れた"}）`, "break", p.team);
    if (p.team !== this.offTeam && this.phase === "live") this.stats[this.offTeam].breaks++;
    // ボールを持っていたらこぼす
    if (this.holder() === p) this.fumble(p);
  }

  private onBreak(p: Player): void {
    p.say("崩れた！", 1.0);
    const h = this.holder();
    if (p.team !== this.offTeam && h) {
      this.stats[this.offTeam].breaks++;
      this.log(`${this.tag(p)} の重心が崩れた（${this.tag(h)} の${this.off.lastMoveLabel || "動き"}）`, "break", this.offTeam);
    } else {
      this.log(`${this.tag(p)} がバランスを崩した`, "break", p.team);
    }
  }

  private onShove(w: Player, l: Player): void {
    w.say("押しのけた", 0.9);
    l.say("押し出された", 0.9);
    const b = this.ball;
    const why = b.k === "loose" || b.k === "shot" ? "リバウンド争い" : "ポジション争い";
    this.log(`${this.tag(w)} が ${this.tag(l)} を押しのけた（${why}）`, "break", w.team);
  }

  private onContact(a: Player, b: Player, vrel: number): void {
    if (this.phase !== "live" || vrel < 1.2) return;
    const scr = this.off.screenerOf(a) ? a : this.off.screenerOf(b) ? b : null;
    if (scr) {
      const other = scr === a ? b : a;
      if (other.team !== scr.team) {
        this.def.noticeScreen(other, scr);
        other.say("スクリーンに掛かった", 0.9);
        this.log(`${this.tag(scr)} のスクリーンに ${this.tag(other)} が引っかかった`, "screen", scr.team);
      }
    }
  }

  /** 跳んだ体（頭）と手がバックボードを抜けないように（両ゴール。z の符号で鏡に映して判定） */
  private boardCollide(): void {
    const fz = BOARD.z, bz = BOARD.z + BOARD.depth;
    for (const p of this.players) {
      const sg = p.p.z >= 0 ? 1 : -1;
      const pz = p.p.z * sg;
      const top = p.a.height + 0.1 + p.airY();
      const r = p.radius;
      if (top > BOARD.y0 && Math.abs(p.p.x) < BOARD.halfW + r && pz > fz - r && pz < bz + r) {
        const nz = pz < (fz + bz) / 2 ? fz - r : bz + r;
        p.p = { x: p.p.x, z: nz * sg };
        if ((p.v.z * sg > 0 && nz < fz) || (p.v.z * sg < 0 && nz > bz)) p.v = { x: p.v.x, z: 0 };
      }
      for (let i = 0; i < 2; i++) {
        const hw = p.handW(i);
        if (Math.abs(hw.x) > BOARD.halfW + 0.06 || hw.y < BOARD.y0 - 0.06 || hw.y > BOARD.y1 + 0.06) continue;
        const hz = hw.z * sg;
        if (pz < fz && hz > fz - 0.06) p.hands[i].off.z -= (hz - (fz - 0.06)) * sg;
        else if (pz > bz && hz < bz + 0.06) p.hands[i].off.z += (bz + 0.06 - hz) * sg;
      }
    }
  }

  // ------------------------------------------------------------------ ボール

  ballPos(): { p: V2; h: number } {
    const b = this.ball;
    switch (b.k) {
      case "held": {
        const o = b.owner;
        const hb = o.ballHand();
        if (o.dribbling) {
          // 手と床の間を弾む
          const ph = (this.t * 3.2 + o.id * 0.37) % 1;
          return { p: { x: hb.x, z: hb.z }, h: 0.12 + (hb.y - 0.2) * Math.abs(Math.sin(ph * Math.PI)) };
        }
        return { p: { x: hb.x, z: hb.z }, h: hb.y };
      }
      case "pass": {
        const s = clamp(b.t / b.T, 0, 1);
        const h = passHeight(b.style, b.h0, b.h1, s, b.L);
        return { p: lerpV(b.p0, b.p1, s), h };
      }
      case "shot": {
        const s = clamp(b.t / b.T, 0, 1);
        // 指先で触れられたシュートは着地点が逸れる
        const end = add(RIM, b.dev);
        return { p: lerpV(b.p0, end, s), h: lerp(b.h0, COURT.rimH + 0.1, s) + 4 * b.apex * s * (1 - s) * 0.5 };
      }
      case "loose":
        return { p: b.p, h: b.h };
      case "dead":
        return { p: b.p, h: b.h };
      case "inbound": {
        const s = clamp(b.t / b.T, 0, 1);
        const tp = b.to.ballHand();
        return { p: lerpV(b.p0, { x: tp.x, z: tp.z }, s), h: lerp(b.h0, tp.y, s) + 1.2 * s * (1 - s) };
      }
    }
  }

  private updateBall(dt: number): void {
    const b = this.ball;
    switch (b.k) {
      case "held":
        return;
      case "inbound":
        b.t += dt;
        if (b.t >= b.T) {
          this.ball = { k: "held", owner: b.to };
          this.off.onCatch(b.to, null);
        }
        return;
      case "pass":
        b.t += dt;
        this.checkIntercept(b);
        if (this.ball !== b) return;
        if (b.t >= b.T) {
          const r = b.to;
          const bp = this.ballPos();
          const B: V3 = { x: bp.p.x, y: bp.h, z: bp.p.z };
          const handOk = Math.min(dist3(r.handW(0), B), dist3(r.handW(1), B)) < 0.6;
          if ((handOk || dist(r.p, b.p1) < 0.7) && !r.bal.off) {
            this.ball = { k: "held", owner: r };
            this.off.onCatch(r, b.from);
          } else {
            const dir = norm({ x: b.p1.x - b.p0.x, z: b.p1.z - b.p0.z });
            this.ball = { k: "loose", p: copy(b.p1), v: mul(dir, 3), h: b.h1, vy: 0, t: 0, lastTouch: this.offTeam };
            this.log(`${this.tag(r)} へのパスが合わずルーズボール`, "to", this.offTeam);
          }
        }
        return;
      case "shot":
        b.t += dt;
        this.checkBlock(b);
        if (this.ball !== b) return;
        if (b.t >= b.T) this.resolveShot(b);
        return;
      case "loose":
        this.updateLoose(b, dt);
        return;
      case "dead":
        if (b.vy !== undefined && b.v) {
          b.vy -= 9.8 * dt;
          // ネットの中: 網に擦れて落ちる速さが抑えられ、リムの中心へ寄せられて下の口から抜ける
          const inNet = distRim(b.p) < COURT.rimR + 0.05 && b.h < COURT.rimH + 0.05 && b.h > COURT.rimH - NET.len;
          if (inNet) {
            // 網の広いところ（ボールより太い）は普通に落ち、網がボールより細くなる所で絞られて急に遅くなる
            const depth = clamp((COURT.rimH - b.h) / NET.len, 0, 1);
            const rAt = lerp(COURT.rimR, NET.rBottom, depth);
            if (rAt < BALL_R) {
              b.vy = Math.max(b.vy, -0.9);
              b.v = mul(b.v, Math.exp(-dt * 12));
            }
            b.p = lerpV(b.p, RIM, Math.min(1, dt * 5));
          }
          b.h += b.vy * dt;
          b.p = madd(b.p, b.v, dt);
          if (b.h < 0.12) {
            b.h = 0.12;
            b.vy = b.vy < 0 ? -b.vy * 0.55 : b.vy;
            if (b.vy < 0.4) b.vy = 0;
            b.v = mul(b.v, 0.7);
          }
          if (b.vy === 0) b.v = mul(b.v, Math.exp(-dt * 1.5));
        } else {
          b.h = Math.max(0.12, b.h - dt * 2);
        }
        return;
    }
  }

  /**
   * パスへの手の接触。確保できるかは 触れた手の数・ボールの速さ・体がボールの方を向いているか・
   * 飛び込みながらか で決まる。確保できなければ弾く（ルーズボール）。
   */
  private checkIntercept(b: Extract<BallState, { k: "pass" }>): void {
    const { p, h } = this.ballPos();
    const s = b.t / b.T;
    if (s < 0.1) return;
    const B: V3 = { x: p.x, y: h, z: p.z };
    const ballDir = norm({ x: b.p1.x - b.p0.x, z: b.p1.z - b.p0.z });
    const speed = b.L / Math.max(0.05, b.T);
    for (const d of this.defense) {
      if (b.tried.has(d.id)) continue;
      let touch = 0;
      for (let i = 0; i < 2; i++) if (dist3(d.handW(i), B) < 0.2) touch++;
      if (touch === 0) continue;
      b.tried.add(d.id);
      const pr = clamp(0.45 + 0.4 * n(d.a.steal) - 0.2 * n(b.from.a.passing) + (touch === 2 ? 0.15 : 0), 0.1, 0.92);
      if (!this.rng.chance(pr)) { d.say("届かず", 0.6); continue; }
      this.def.stealDone(d);
      const facing = dot(d.f, { x: -ballDir.x, z: -ballDir.z });
      const pc = (touch === 2 ? 0.75 : 0.2) * (d.lunge > 0.5 ? 0.55 : 1) * (speed > 10 ? 0.7 : 1) * (facing > 0.3 ? 1 : 0.6) * (0.7 + 0.3 * n(d.a.steal));
      if (this.rng.chance(pc)) {
        this.ball = { k: "held", owner: d };
        d.say("スティール！", 1.2);
        this.log(`${this.tag(d)} がパスの導線に飛び込んで確保！`, "to", d.team);
      } else {
        // 弾く: ボールの勢いを殺し、手の向き（体の向き）へ逸らす
        const dir = norm({ x: ballDir.x * 0.4 + d.f.x + (this.rng.next() - 0.5) * 0.6, z: ballDir.z * 0.4 + d.f.z + (this.rng.next() - 0.5) * 0.6 });
        this.ball = { k: "loose", p: copy(p), v: mul(dir, 2.0 + speed * 0.2), h, vy: 0.8, t: 0, lastTouch: d.team, noGrab: d.id, noGrabT: 0.3 };
        d.say("弾いた！", 1.0);
        this.log(`${this.tag(d)} が手を伸ばしてパスを弾いた`, "to", d.team);
        this.off.onLoose();
        this.def.onLoose();
      }
      this.stats[d.team].stl++;
      this.stats[this.offTeam].to++;
      if (this.ball.k === "held") this.changeLive(d.team, "スティール");
      return;
    }
  }

  // ------------------------------------------------------------------ 攻撃側からの呼び出し

  throwPass(from: Player, lane: Lane): void {
    const to = lane.to!;
    const lob = lane.kind === "lob";
    this.ball = {
      // リリース点は導線を計算したときと同じ（左右どちらかの手）
      k: "pass", from, to, p0: copy(lane.pts[0]), p1: copy(lane.target), h0: lane.h0,
      // 構え(リリース)の時間は投げる側で既に使っているので、ここは飛行時間だけ
      h1: lane.endH, T: Math.max(0.12, dist(lane.pts[0], lane.target) / lane.speed),
      t: 0, lob, style: lane.style, L: dist(lane.pts[0], lane.target), tried: new Set(), lane: lane.kind, open: lane.open,
    };
    from.dribbling = false;
    const kindTxt = lane.kind === "lob" ? (lane.endH > 3 ? "アリウープのロブ" : "ロブパス") : lane.kind === "lead" ? `リードの${PASS_LABEL[lane.style]}` : PASS_LABEL[lane.style];
    this.log(`${this.tag(from)} → ${this.tag(to)} ${kindTxt}（導線 ${(lane.open * 100).toFixed(0)}%）`, "pass", from.team);
  }

  releaseShot(s: Player, open: number, type: ShotType): void {
    if (!s.airborne) s.landT = Math.max(s.landT, 0.3);
    const base = shotBase(s, s.p);
    let p = pMakeType(s, s.p, open, type);
    // リリース点の目の前に手があれば精度が落ちる（ハンド・イン・フェイス）
    const R = s.ballHand();
    let face = 9;
    for (const d of this.defense) for (let i = 0; i < 2; i++) face = Math.min(face, dist3(d.handW(i), R));
    if (face < 0.7) p *= 0.82 + 0.18 * (face / 0.7);
    this.stats[s.team].fga++;
    if (base.pts === 3) this.stats[s.team].tpa++;
    this.lastShotOpen = open;
    const made = this.rng.chance(p);
    const L = dist(s.p, RIM);
    // 打ち方ごとの飛び方: ダンクは叩き込む／レイアップは低く／フローターは高く山なり／外は放物線
    // ジャンプシュート・セットシュートの頂点はリリース点とリングを結ぶ線より 0.35+0.23×距離 上（3Pで約2m＝地上約5m）
    const peak = 0.35 + 0.23 * L;
    const T = type === "dunk" ? 0.12 : type === "layup" ? 0.35 : type === "floater" ? clamp(0.6 + L * 0.08, 0.6, 0.95) : clamp(2 * Math.sqrt((2 * peak) / 9.8), 0.7, 1.45);
    const apex = type === "dunk" ? 0 : type === "layup" ? 0.4 : type === "floater" ? 1.6 + 0.3 * L : 2 * peak;
    this.ball = { k: "shot", by: s, p0: { x: R.x, z: R.z }, h0: R.y, T, t: 0, made, pts: base.pts, open, tried: new Set(), rim: type === "dunk" || type === "layup" || type === "floater", apex, type, dev: V(), tipped: false };
    const kindTxt = SHOT_LABEL[type] + (base.pts === 3 ? "(3P)" : "");
    this.log(`${this.tag(s)} ${kindTxt}（導線 ${(open * 100).toFixed(0)}% / 成功率 ${(p * 100).toFixed(0)}%）`, "info", s.team);
    this.afterShotRelease(s, false);
  }

  private afterShotRelease(s: Player, _blocked: boolean): void {
    this.off.onShot(s);
    this.def.onShot(s);
  }

  private resolveShot(b: Extract<BallState, { k: "shot" }>): void {
    const team = b.by.team;
    if (b.made) {
      this.score[team] += b.pts;
      this.stats[team].fgm++;
      if (b.pts === 3) this.stats[team].tpm++;
      this.log(`${this.tag(b.by)} 成功 +${b.pts}  ${this.names[0]} ${this.score[0]} - ${this.score[1]} ${this.names[1]}`, "score", team);
      // リムの中からネットへ落ちる（飛んできた向きの勢いが少し残る）
      this.ball = { k: "dead", p: copy(RIM), h: COURT.rimH - 0.02, v: mul(dirTo(b.p0, RIM), 0.5), vy: -2.6 };
      this.endPossession((1 - team) as Team, "made", baselineInbound(this.rng.sign()), 24);
      return;
    }
    this.log(`${this.tag(b.by)} 外れ${b.tipped ? "（触れられて逸れた）" : ""}`, "miss", team);
    // リングに当たって跳ねる
    const ang = (this.rng.next() - 0.5) * Math.PI * 1.4;
    const back = dirTo(RIM, b.p0);
    const c = Math.cos(ang), s = Math.sin(ang);
    const dir = V(back.x * c - back.z * s, back.x * s + back.z * c);
    // リングに当たって上へ跳ねる（横へは控えめ。3Pは少し長く）
    const sp = (b.pts === 3 ? 1.4 : 0.8) + this.rng.next() * 0.8;
    this.ball = { k: "loose", p: madd(RIM, dir, 0.25), v: mul(dir, sp), h: COURT.rimH + 0.1, vy: 3.0 + this.rng.next() * 1.2, t: 0, lastTouch: team };
    this.lastWasShot = true;
    this.off.onRebound();
    this.def.onRebound();
  }

  /** 打ち上がっていくボールに守備者の手が触れたらブロック（落ちてくる球は触らない＝ゴールテンディング無し） */
  /**
   * 打ち上がっていくボールに守備者の手が触れた（落ちてくる球は触らない＝ゴールテンディング無し）。
   * 当たり方で結果が変わる: かする（軌道が逸れて続く）／叩き落とす（足元へ）／弾き飛ばす（遠くへ・外へ出ることも）。
   */
  private checkBlock(b: Extract<BallState, { k: "shot" }>): void {
    const s = b.t / b.T;
    if (s > (b.rim ? 0.7 : 0.42)) return;
    const bp = this.ballPos();
    const B: V3 = { x: bp.p.x, y: bp.h, z: bp.p.z };
    for (const d of this.defense) {
      if (b.tried.has(d.id)) continue;
      let hi = -1, hd = 9;
      for (let i = 0; i < 2; i++) {
        const di = dist3(d.handW(i), B);
        if (di < 0.22 && di < hd) { hd = di; hi = i; }
      }
      if (hi < 0) continue;
      b.tried.add(d.id);
      // 当たりの強さ: 手のどこに当たったか × ブロックの上手さ × ボールがまだ上がっているか
      const rising = s < (b.rim ? 0.45 : 0.3);
      const q = clamp((1 - hd / 0.22) * (0.55 + 0.45 * n(d.a.block)) * (rising ? 1 : 0.7) * (0.85 + 0.3 * this.rng.next()) - 0.1 * n(b.by.a.release), 0, 1);
      const hw = d.handW(hi);
      const swing = norm(add(dirTo({ x: hw.x, z: hw.z }, bp.p), mul(d.f, 0.6)));

      if (q < 0.38) {
        // かする: シュートは続くが軌道が逸れて入りにくくなる
        const side = { x: -swing.z, z: swing.x };
        b.dev = madd(mul(swing, 0.15 + 0.3 * q), side, (this.rng.next() - 0.5) * 0.4 * (0.5 + q));
        b.tipped = true;
        if (b.made && this.rng.chance(0.35 + 0.8 * q)) b.made = false;
        b.T += 0.05;
        d.say("指先に当てた", 1.0);
        this.log(`${this.tag(d)} の指先が ${this.tag(b.by)} のシュートに触れた（軌道が逸れる）`, "to", d.team);
        continue;
      }

      let v: V2, vy: number, kind: string;
      if (this.rng.chance(clamp(0.15 + 0.45 * n(d.a.block) * q, 0, 0.6))) {
        // 叩き落とす（キャッチブロック）: 勢いを殺して足元近くへ
        v = mul(swing, 0.8 + 0.8 * this.rng.next());
        vy = -1.5;
        kind = "叩き落とした";
      } else {
        // 弾き飛ばす: 手を振った向きへ強く（外へ出ることもある）
        v = mul(norm(add(swing, V((this.rng.next() - 0.5) * 0.7, (this.rng.next() - 0.5) * 0.7))), 3 + 4 * q);
        vy = (this.rng.next() - 0.3) * 2.5;
        kind = "弾き飛ばした";
      }
      this.ball = { k: "loose", p: copy(bp.p), v, h: bp.h, vy, t: 0, lastTouch: d.team, noGrab: d.id, noGrabT: 0.3 };
      d.say(kind === "叩き落とした" ? "叩き落とした！" : "ブロック！", 1.2);
      this.log(`${this.tag(d)} が ${this.tag(b.by)} のシュートを${kind}！`, "to", d.team);
      this.off.onLoose();
      this.def.onLoose();
      return;
    }
  }

  private updateLoose(b: Extract<BallState, { k: "loose" }>, dt: number): void {
    b.t += dt;
    b.vy -= 9.8 * dt;
    b.h += b.vy * dt;
    const z0 = b.p.z;
    b.p = madd(b.p, b.v, dt);
    // バックボードに当たったら跳ね返る（表からも裏からも抜けない。両ゴール）
    const BR = 0.12;
    const sg = b.p.z >= 0 ? 1 : -1;
    const za = z0 * sg, zb = b.p.z * sg;
    if (Math.abs(b.p.x) < BOARD.halfW + BR && b.h > BOARD.y0 - BR && b.h < BOARD.y1 + BR) {
      if (za <= BOARD.z - BR && zb > BOARD.z - BR) {
        b.p = { x: b.p.x, z: (BOARD.z - BR) * sg };
        b.v = { x: b.v.x * 0.8, z: -Math.abs(b.v.z) * 0.6 * sg };
        b.vy = Math.max(b.vy, 0) * 0.7 + 0.6;
      } else if (za >= BOARD.z + BOARD.depth + BR && zb < BOARD.z + BOARD.depth + BR) {
        b.p = { x: b.p.x, z: (BOARD.z + BOARD.depth + BR) * sg };
        b.v = { x: b.v.x * 0.8, z: Math.abs(b.v.z) * 0.6 * sg };
      }
    }
    if (b.h < 0.12) {
      b.h = 0.12;
      if (b.vy < 0) b.vy = -b.vy * 0.55;
      if (b.vy < 0.4) b.vy = 0;
      b.v = mul(b.v, 0.8);
    }
    if (b.vy === 0) b.v = mul(b.v, Math.exp(-dt * 1.2));
    if (outOfBounds(b.p, 0.12)) {
      const next = (1 - b.lastTouch) as Team;
      this.log(`アウトオブバウンズ → ${this.names[next]} ボール`, "to", next);
      if (next !== this.offTeam) this.stats[this.offTeam].to++;
      this.ball = { k: "dead", p: copy(b.p), h: b.h };
      // 攻撃側が続けるならショットクロックは続き（最低5秒）、相手ボールなら20秒から
      this.endPossession(next, "oob", throwInSpot(b.p), next === this.offTeam ? Math.max(5, this.shotClock) : 24);
      return;
    }
    // ジャンプボール: 弾くまではジャンパーだけが触れる。手が触れたら自陣側の最も近い味方へ弾く
    if (this.jb && !this.jb.tapped) {
      const B0: V3 = { x: b.p.x, y: b.h, z: b.p.z };
      const hd = (p: Player) => Math.min(dist3(p.handW(0), B0), dist3(p.handW(1), B0));
      const da = hd(this.jb.a), db = hd(this.jb.b);
      const touchA = da <= 0.25, touchB = db <= 0.25;
      if (touchA || touchB) {
        // 先に触れた方の勝ち。同時なら手の高さ・跳躍・タイミングで
        let j = touchA ? this.jb.a : this.jb.b;
        if (touchA && touchB) {
          const sc = (p: Player) => p.reachNow + 0.3 * n(p.a.vertical) + 0.2 * n(p.a.reaction) + this.rng.next() * 0.15;
          j = sc(this.jb.a) >= sc(this.jb.b) ? this.jb.a : this.jb.b;
        }
        const other = j === this.jb.a ? this.jb.b : this.jb.a;
        // はっきり勝った（相手の手が遠い）ほど、狙いどおり自陣の味方へ強く弾ける。競り合うと方向がぶれ弱くなる
        const dom = clamp((hd(other) - 0.15) / 0.5 + (j.reachNow - other.reachNow) * 0.8, 0, 1);
        const back = j.team === 0 ? -1 : 1;
        const mates = this.teams[j.team].filter((m) => m !== j && (m.p.z - j.p.z) * back > 0);
        const to = mates.sort((m1, m2) => dist(m1.p, j.p) - dist(m2.p, j.p))[0];
        const aim = to ? dirTo(b.p, to.p) : V(0, back);
        const ang = (this.rng.next() - 0.5) * Math.PI * (1 - dom) * 1.4;
        const c = Math.cos(ang), s2 = Math.sin(ang);
        const dir = V(aim.x * c - aim.z * s2, aim.x * s2 + aim.z * c);
        b.v = mul(dir, 1.6 + 2.2 * dom);
        b.vy = 0.6;
        b.lastTouch = j.team;
        b.noGrab = j.id;
        b.noGrabT = b.t + 0.4;
        this.jb.tapped = true;
        this.phase = "live";
        this.phaseT = 0;
        this.shotClock = 24;
        j.say(dom > 0.6 ? "競り勝った！" : "弾いた", 1.0);
        this.log(`${this.tag(j)} がジャンプボールを${dom > 0.6 ? "競り勝って" : "辛うじて"}${to ? ` ${this.tag(to)} の方へ` : ""}弾いた`, "info", j.team);
        return;
      }
      // 誰も触れずに落ちてきたら、そのまま取り合い
      if (b.h < 1.6 && b.vy < 0) { this.jb.tapped = true; this.phase = "live"; this.shotClock = 24; }
      return;
    }
    if (b.t < 0.15) return;
    // 手がボールに触れた人が取る（触れている手の数・近さ・リバウンド能力）
    const B: V3 = { x: b.p.x, y: b.h, z: b.p.z };
    let best: Player | null = null;
    let bestS = -1e9;
    let bestTouch = 0;
    for (const p of this.players) {
      if (p.bal.off) continue;
      if (b.noGrab === p.id && b.t < (b.noGrabT ?? 0)) continue;
      if (p.fallen) continue;
      let touch = 0, dd = 9;
      for (let i = 0; i < 2; i++) {
        const di = dist3(p.handW(i), B);
        dd = Math.min(dd, di);
        if (di < 0.24) touch++;
      }
      if (touch === 0) continue;
      const sc = -dd + 0.25 * touch + 0.4 * n(p.a.rebound) + this.rng.next() * 0.3;
      if (sc > bestS) { bestS = sc; best = p; bestTouch = touch; }
    }
    if (!best) return;
    // 確保できるか: 相手の手もすぐ近くにある競り合い／跳んで片手で触れた → 弾くことがある
    let rival: Player | null = null;
    for (const q of this.players) {
      if (q.team === best.team || q.fallen) continue;
      if (Math.min(dist3(q.handW(0), B), dist3(q.handW(1), B)) < 0.35) { rival = q; break; }
    }
    let pCatch = 1;
    if (rival) pCatch = clamp(0.45 + 0.6 * (n(best.a.rebound) - n(rival.a.rebound)) + (bestTouch === 2 ? 0.15 : -0.1), 0.15, 0.85);
    else if (bestTouch === 1 && best.airborne && b.h > best.shoulderY + best.airY()) pCatch = 0.6;
    if (!this.rng.chance(pCatch)) {
      // 弾く: 体の向きへ少し上向きに。弾いた本人は少しの間取れない
      const dir = norm(add(best.f, V((this.rng.next() - 0.5) * 1.2, (this.rng.next() - 0.5) * 1.2)));
      b.v = mul(dir, 1.2 + this.rng.next() * 1.2);
      b.vy = 1.2 + this.rng.next() * 0.8;
      b.lastTouch = best.team;
      b.noGrab = best.id;
      b.noGrabT = b.t + 0.25;
      best.say(rival ? "競り合いで弾いた" : "ティップ", 0.9);
      if (rival) this.log(`${this.tag(best)} と ${this.tag(rival)} の競り合い → ボールが弾かれた`, "info", best.team);
      return;
    }
    const team = best.team;
    this.ball = { k: "held", owner: best };
    if (this.phase !== "live" && this.phase !== "throwin") return;
    if (team === this.offTeam) {
      if (b.h > 1.5 || b.t > 0.3) this.stats[team].oreb++;
      this.log(`${this.tag(best)} がボール確保（攻撃継続）`, "info", team);
      this.shotClock = Math.max(this.shotClock, 14);
      this.lastWasShot = false;
      this.off.onRegain(best);
      this.def.onRegain();
    } else {
      this.log(`${this.tag(best)} がボール確保`, "info", team);
      this.changeLive(team, this.lastWasShot ? "守備リバウンド" : "ルーズボール");
    }
  }

  /** オンボールのスティール */
  tryStrip(d: Player, h: Player, exposure: number): boolean {
    const p = clamp(0.1 + 0.35 * n(d.a.steal) * exposure - 0.15 * n(h.a.handle), 0.02, 0.5);
    if (this.rng.chance(p)) {
      const dir = norm(add(dirTo(h.p, d.p), V((this.rng.next() - 0.5), (this.rng.next() - 0.5))));
      this.ball = { k: "loose", p: copy(h.handPos()), v: mul(dir, 2.5), h: 0.6, vy: 0.5, t: 0, lastTouch: d.team };
      d.say("スティール！", 1.2);
      this.lastWasShot = false;
      this.log(`${this.tag(d)} が ${this.tag(h)} からボールをはたいた`, "to", d.team);
      this.stats[d.team].stl++;
      this.stats[h.team].to++;
      this.off.onLoose();
      this.def.onLoose();
      return true;
    }
    // 空振り: 手を伸ばしたぶん前へ体重が流れる
    d.bal.kick(mul(dirTo(d.p, h.p), 1.4));
    d.say("リーチ空振り", 0.8);
    return false;
  }

  fumble(h: Player): void {
    const dir = norm(V(this.rng.next() - 0.5, this.rng.next() - 0.5));
    this.ball = { k: "loose", p: copy(h.handPos()), v: mul(dir, 2.0), h: 0.4, vy: 0.8, t: 0, lastTouch: h.team };
    h.say("ファンブル", 1.0);
    this.lastWasShot = false;
    this.log(`${this.tag(h)} がファンブル`, "to", h.team);
    this.off.onLoose();
    this.def.onLoose();
  }

  speedOf(p: Player): number { return len(p.v); }
}
