// 守備AI。基本は「攻撃側の導線を消す」最適化:
//   各守備者が候補地点を試し、攻撃側の脅威（options.ts の選択肢の滑らかな最大値）が最小になる位置へ動く。
//   ヘルプ・ローテーション・ディナイ・クローズアウトは個別ルールではなくここから出る。
// カバレッジ（コールへの対抗）は「スクリーンに関わる守備者の台本」と「最適化の重み」を変える。
import { n } from "./attrs";
import { RIM, distRim, inCourt } from "./court";
import { STEALS, StealDef, exposure, onBallDefend, stealSuccessEstimate } from "./duel";
import { contValue } from "./eval";
import type { Game, BallState } from "./game";
import { LaneCtx } from "./lanes";
import { V, V2, alongPoly, clamp, closestT, copy, dirTo, dist, distToSeg, dot, len, lerpV, madd, mul, norm, right, sub } from "./math";
import { evalOptions, threatOf } from "./options";
import { Player, Team, dist3 } from "./player";
import { COVER_LABEL, CoverageId, chooseCoverage } from "./plays";
import { timeToReach } from "./reach";
import { offRole } from "./roles";
import { BallPath, LUNGE_REACH, planIntercept, willGamble } from "./steal";
import type { Lane } from "./lanes";
import type { V3 } from "./player";

/** 跳んでから最高点までの時間（コンテストは最高点がリリースに重なるように跳ぶ） */
/** 全力で跳んだときの最高点までの時間 */
const jumpApexT = (d: Player): number => Math.sqrt((2 * d.jumpH) / 9.8);
/**
 * シュートのコンテストで跳ぶか: 最高点が「ボールが手を離れた少し後（0.1秒）」に来るように跳ぶ（ブロックできるのはボールが上がっていく間）。
 * ただしシュートの動きが見えてから（反応の遅れの7割）でないと跳べない。
 */
const contestJumpNow = (d: Player, t: number, rel: number): boolean => t >= Math.max(d.reactT * 0.7, rel + 0.1 - jumpApexT(d));

/** ビッグ（C/PF/身長2.03m以上）: トランジションではボールを止めに行かず、リムを守りに戻る */
const isBig = (p: Player): boolean => p.d.pos === "C" || p.d.pos === "PF" || p.a.height >= 2.03;

export class Defense {
  g: Game;
  team: Team = 1;
  pl: Player[] = [];
  /** 守備者 → マークする攻撃選手 */
  mark = new Map<Player, Player>();
  coverage: CoverageId = "MAN";
  private readAt = 1e9;
  private optT = 0;
  private tgt = new Map<Player, V2>();
  private stealCd = new Map<Player, number>();
  /** リーチインで手を出している期限 */
  private reaching = new Map<Player, { sd: StealDef; until: number; tgt: V2 }>();
  /** オンボールのスティールを考える次の時刻 */
  private stealDecideT = new Map<Player, number>();
  private passRef: BallState | null = null;
  private icpt = new Map<Player, V2>();
  /** パスを取りに行っている守備者（読んだ点・高さ・飛び込んだか・期限） */
  private steals = new Map<Player, { X: V2; h: number; lunged: boolean; endT: number }>();
  /** 空振りして立て直している守備者 */
  private recoverUntil = new Map<Player, number>();
  /** 今の構え（パスの予備動作）を既に読んだ守備者 */
  private readDone = new Set<Player>();
  private windupRef: Lane | null = null;
  private switched = new Set<Player>();
  private trapper: Player | null = null;
  private under = new Set<Player>();
  private shotT = 0;
  /** トランジション守備中（セーフティーファースト: 1人がボールを遅らせ、残りは自陣へ全力で戻る） */
  private transActive = false;
  private transT = 0;
  private stopper: Player | null = null;
  private backSpot = new Map<Player, V2>();
  /** オンボールの警戒の表示（-1/0/+1） */
  private focusShown = new Map<Player, number>();
  /** 「守備者id-スクリーナーid」: そのスクリーンに気づいている（見えた／声をかけられた／ぶつかった） */
  private noticed = new Set<string>();

  constructor(g: Game) {
    this.g = g;
  }

  reset(team: Team): void {
    this.team = team;
    this.pl = this.g.teams[team];
    this.mark.clear();
    const off = this.g.teams[1 - team];
    this.pl.forEach((d, i) => this.mark.set(d, off[i]));
    this.coverage = "MAN";
    this.readAt = 1e9;
    this.tgt.clear();
    this.switched.clear();
    this.trapper = null;
    this.icpt.clear();
    this.noticed.clear();
    this.steals.clear();
    this.transActive = false;
    this.backSpot.clear();
    this.readDone.clear();
    for (const d of this.pl) { d.vCmd = null; d.leanCmd = V(); d.pushBoost = 1; }
  }

  /** ぶつかったスクリーンには以後気づいている */
  noticeScreen(d: Player, screener: Player): void {
    this.noticed.add(`${d.id}-${screener.id}`);
  }

  /**
   * スクリーンへの気づき。前（視界）に見えるか、スクリーナーのマークが声をかけたら気づく。
   * 死角のスクリーンには気づくまで回り込めない＝ぶつかって引っかかる。
   */
  private updateNotice(): void {
    const off = this.g.off;
    for (const S of off.pl) {
      const st = off.stOf(S);
      if (st.mode !== "screen") {
        for (const d of this.pl) this.noticed.delete(`${d.id}-${S.id}`);
        continue;
      }
      if (st.setT <= 0) continue;
      const SD = this.markerOf(S);
      const called = SD ? st.setT > 0.25 + 0.6 * (1 - n(SD.a.defIQ)) : false;
      for (const d of this.pl) {
        if (dist(d.p, S.p) > 3.5) continue;
        const seen = dot(d.f, dirTo(d.p, S.p)) > 0.35;
        if (seen || called || d === SD) this.noticed.add(`${d.id}-${S.id}`);
      }
    }
  }

  /** コールを読んでいる最中か */
  get reading(): boolean {
    return this.readAt < 1e9;
  }

  /** スティールに行っている守備者の手の狙い */
  stealAim(d: Player): V3 | null {
    const s = this.steals.get(d);
    return s ? { x: s.X.x, y: s.h, z: s.X.z } : null;
  }

  /** パスを弾いた／取った（空振りの代償なし） */
  stealDone(d: Player): void {
    this.steals.delete(d);
  }

  private commitSteal(d: Player, X: V2, h: number, tb: number): void {
    this.steals.set(d, { X, h, lunged: false, endT: this.g.t + tb + 0.45 });
  }

  /** スティールの実行: ダッシュ → 届く距離で飛び込む → 期限までに取れなければ空振り（重心が前へ流れる） */
  private runSteals(scripted: Set<Player> | null): void {
    const g = this.g;
    for (const [d, s] of this.steals) {
      if (g.t > s.endT) {
        this.steals.delete(d);
        const dir = dirTo(d.p, s.X);
        d.bal.kick(mul(dir, 1.3 * (1 - 0.4 * n(d.a.balance))));
        d.fallWhy = "スティールの空振り";
        d.fallWhyT = 0.8;
        this.recoverUntil.set(d, g.t + 0.5);
        d.say("空振り", 0.9);
        continue;
      }
      scripted?.add(d);
      d.urgency = 1;
      d.tgt = s.X;
      d.face = null;
      d.stanceCmd = 0;
      d.spd = 1;
      d.leanCmd = V();
      const reach = Math.max(0.5, d.handReachAt(s.h, true));
      if (!s.lunged && dist(d.p, s.X) < reach + LUNGE_REACH + 0.35) {
        s.lunged = true;
        d.lungeT = 0.32;
        d.say("手を伸ばす", 0.7);
      }
      if (d.lungeT > 0) d.vCmd = mul(dirTo(d.p, s.X), d.maxSpeed);
    }
  }

  /** パサーの構えを読んで先に動き出す（守備IQが高いほど早く、パサーの視野が広いほど遅れる） */
  private readWindup(h: Player, hd: Player | null, scripted: Set<Player>): void {
    const g = this.g;
    const pa = g.off.hs.passing;
    if (!pa) { this.windupRef = null; return; }
    if (this.windupRef !== pa.lane) { this.windupRef = pa.lane; this.readDone.clear(); }
    const ln = pa.lane;
    const L = dist(ln.pts[0], ln.target);
    const path: BallPath = {
      p0: ln.pts[0], p1: ln.target, h0: ln.h0, h1: ln.endH, style: ln.style, L,
      T: L / Math.max(1, ln.speed), t: 0, wait: Math.max(0, pa.rel - pa.t),
    };
    for (const d of this.pl) {
      if (d === hd || scripted.has(d) || this.steals.has(d) || this.readDone.has(d)) continue;
      if ((this.recoverUntil.get(d) ?? 0) > g.t || d.bal.off || d.airborne) continue;
      const read = d.reactT * (1.4 - 0.7 * n(d.a.defIQ)) * (0.6 + 0.7 * n(h.a.vision));
      if (pa.t < read) continue;
      this.readDone.add(d);
      const ic = planIntercept(d, path, 0);
      if (ic && willGamble(d, ic, g.rng.next())) {
        this.commitSteal(d, ic.X, ic.h, ic.tb);
        d.say("パスを読んだ", 0.9);
        g.log(`${g.tag(d)} が ${g.tag(h)} のパスを読んで飛び出した`, "def", this.team);
      }
    }
  }

  markerOf(o: Player): Player | null {
    for (const [d, m] of this.mark) if (m === o) return d;
    return null;
  }

  /**
   * 生きたボールのまま攻守交代: 近い相手からマークを付け直す（ハンドラーに最も近い守備者がボールへ）。
   * クロスマッチ（ミスマッチ）が起きる。
   */
  resetTransition(team: Team): void {
    this.reset(team);
    const off = this.g.teams[1 - team];
    const h = this.g.holder();
    this.mark.clear();
    const freeD = [...this.pl];
    const freeO = [...off];
    if (h && freeO.includes(h)) {
      const d = freeD.sort((a, b) => dist(a.p, h.p) - dist(b.p, h.p))[0];
      this.mark.set(d, h);
      freeD.splice(freeD.indexOf(d), 1);
      freeO.splice(freeO.indexOf(h), 1);
    }
    while (freeD.length) {
      let bd = 1e9, bi = 0, bj = 0;
      freeD.forEach((d, i) => freeO.forEach((o, j) => { const x = dist(d.p, o.p); if (x < bd) { bd = x; bi = i; bj = j; } }));
      this.mark.set(freeD[bi], freeO[bj]);
      freeD.splice(bi, 1);
      freeO.splice(bj, 1);
    }
    this.readAt = 1e9;
    // セーフティーファースト: ハンドラーのすぐ近く（3m以内）の1人だけがボールを遅らせ、残りは全員自陣へ
    this.transActive = true;
    this.transT = this.g.t;
    this.stopper = null;
    if (h) {
      // ボールを止めるのはビッグ以外（足の遅いビッグにスピード勝負をさせない）。居なければ全員戻る
      const near = this.pl.filter((d) => !isBig(d)).sort((a, b) => dist(a.p, h.p) - dist(b.p, h.p))[0];
      if (near && dist(near.p, h.p) < 3.0) {
        this.stopper = near;
        // ボールを止める人がハンドラーのマークになる
        const prev = this.mark.get(near)!;
        const other = this.markerOf(h);
        if (other && other !== near) { this.mark.set(other, prev); this.mark.set(near, h); }
      }
    }
    this.assignBackSpots(h);
  }

  /** 得点後など自陣エンドラインからのスローイン: 全員が自陣へ戻る（ボールを止める人は置かない） */
  beginGetBack(): void {
    this.transActive = true;
    this.transT = this.g.t;
    this.stopper = null;
    this.assignBackSpots(null);
  }

  /** 自陣の戻る地点（リム前・両エルボー・FTライン付近の左右・トップ）を近い順に重ならないよう割り当てる */
  private assignBackSpots(h: Player | null): void {
    this.backSpot.clear();
    const ballX = h ? h.p.x : 0;
    const s = ballX >= 0 ? 1 : -1;
    const spots: V2[] = [
      madd(RIM, { x: 0, z: -1 }, 1.6),
      V(2.6 * s, 8.6), V(-2.6 * s, 8.6),
      V(4.6 * s, 6.6), V(-4.6 * s, 6.6),
    ];
    const ds = this.pl.filter((d) => d !== this.stopper);
    // リム前はビッグの中で最も早く着ける人（ビッグが居なければ全員から）、以降は着くのが早い順
    spots.forEach((sp, k) => {
      let best: Player | null = null, bd = 1e9;
      const pool = k === 0 && ds.some(isBig) ? ds.filter(isBig) : ds;
      for (const d of pool) {
        if (this.backSpot.has(d)) continue;
        const x = dist(d.p, sp) / Math.max(1, d.maxSpeed);
        if (x < bd) { bd = x; best = d; }
      }
      if (best) this.backSpot.set(best, sp);
    });
  }

  /** トランジション守備。続いているなら true */
  private transitionDefense(h: Player, scripted: Set<Player>): boolean {
    const g = this.g;
    const elapsed = g.t - this.transT;
    let allBack = true;
    for (const [d, sp] of this.backSpot) if (dist(d.p, sp) > 2.0 && !d.fallen) allBack = false;
    if ((h.p.z > 0.5 && (allBack || elapsed > 3.5)) || elapsed > 6) {
      // 普段の守備へ: 近い相手からマークを付け直す（ハンドラーにはボールを止めていた人か最も近い人）
      this.transActive = false;
      const off = g.teams[1 - this.team];
      this.mark.clear();
      const freeD = [...this.pl];
      const freeO = [...off];
      // 付け直し: 距離＋ポジションの違い（ミスマッチをできるだけ戻す）
      const cost = (d: Player, o: Player) => dist(d.p, o.p) + 2.5 * Math.abs(d.slot - o.slot);
      const hd = [...freeD].sort((a, b) => cost(a, h) - cost(b, h))[0];
      this.mark.set(hd, h);
      freeD.splice(freeD.indexOf(hd), 1);
      freeO.splice(freeO.indexOf(h), 1);
      while (freeD.length) {
        let bd = 1e9, bi = 0, bj = 0;
        freeD.forEach((d, i) => freeO.forEach((o, j) => { const x = cost(d, o); if (x < bd) { bd = x; bi = i; bj = j; } }));
        this.mark.set(freeD[bi], freeO[bj]);
        freeD.splice(bi, 1);
        freeO.splice(bj, 1);
      }
      this.tgt.clear();
      g.log(`${g.names[this.team]} 守備が戻ってマークを付け直した`, "def", this.team);
      return false;
    }
    for (const d of this.pl) {
      d.leanCmd = V();
      if (d === this.stopper) {
        // ボールを遅らせる: 下がりながら間合いを広く（ギャンブルしない）
        onBallDefend(d, h, { shade: 0, cushionAdd: 0.8, rng: g.rng, triple: false });
        scripted.add(d);
        continue;
      }
      const sp = this.backSpot.get(d) ?? madd(RIM, dirTo(RIM, h.p), 4);
      d.tgt = sp;
      d.spd = 1;
      const there = dist(d.p, sp) < 1.5;
      d.face = there ? dirTo(d.p, h.p) : null;
      d.stanceCmd = there ? 0.5 : 0;
      d.urgency = 1;
      scripted.add(d);
    }
    // 速攻のシュートには近い人が跳んでコンテスト
    const sh = g.off.hs.shooting;
    if (sh) {
      for (const d of this.pl) {
        if (d.airborne || d.bal.off || dist(d.p, h.p) > 1.9) continue;
        d.tgt = madd(h.p, dirTo(h.p, d.p), 0.55);
        d.face = dirTo(d.p, h.p);
        if (contestJumpNow(d, sh.t, sh.rel)) d.jump(0.66, 0.2);
      }
    }
    return true;
  }

  updateSetup(_dt: number): void {
    if (this.transActive) {
      for (const d of this.pl) {
        const sp = this.backSpot.get(d) ?? madd(RIM, { x: 0, z: -1 }, 4);
        d.tgt = sp;
        d.spd = 1;
        d.urgency = 1;
        d.vCmd = null;
        d.face = dist(d.p, sp) < 1.5 ? { x: 0, z: -1 } : null;
        d.stanceCmd = 0.3;
      }
      return;
    }
    for (const d of this.pl) {
      const m = this.mark.get(d)!;
      const spot = this.g.off.stOf(m).spot;
      const base = dist(m.p, spot) < 2 ? m.p : spot;
      d.tgt = inCourt(madd(base, dirTo(base, RIM), 1.4));
      d.spd = 0.8;
      d.face = dist(d.p, d.tgt) < 1 ? dirTo(d.p, m.p) : null;
      d.stanceCmd = 0.2;
      d.vCmd = null;
    }
  }

  goLive(): void {
    const iq = this.pl.reduce((s, p) => s + n(p.a.defIQ), 0) / this.pl.length;
    this.readAt = this.g.t + 0.5 + 1.4 * (1 - iq);
  }

  onShot(_s: Player): void {
    this.shotT = this.g.t;
  }
  onRebound(): void {}
  onLoose(): void {}
  onRegain(): void {
    this.readAt = this.g.t + 1.0;
    this.trapper = null;
  }

  /** ルーズボールが手の届く高さまで落ちてくる地点 */
  landing(): V2 {
    const b = this.g.ball;
    if (b.k === "shot") return madd(RIM, dirTo(RIM, b.p0), 1.2);
    if (b.k !== "loose") return this.g.ballPos().p;
    let p = copy(b.p), v = copy(b.v), h = b.h, vy = b.vy;
    const dt = 1 / 30;
    for (let i = 0; i < 45; i++) {
      vy -= 9.8 * dt;
      h += vy * dt;
      p = madd(p, v, dt);
      if (h < 2.9 && vy < 0) return inCourt(p, 0.2);
      if (h < 0.12) { h = 0.12; vy = -vy * 0.55; v = mul(v, 0.8); }
    }
    return inCourt(p, 0.2);
  }

  // ------------------------------------------------------------------ 毎フレーム

  update(dt: number): void {
    const g = this.g;
    if (g.t >= this.readAt) {
      this.readAt = 1e9;
      this.coverage = chooseCoverage(g.off.call, g.off, this.pl, g.rng);
      g.log(`${g.names[this.team]} 守備: ${g.off.call === "MOTION" ? "" : `${g.callLabel()} を読んで `}${COVER_LABEL[this.coverage]}`, "def", this.team);
    }
    for (const d of this.pl) { d.vCmd = null; d.pushBoost = 1; }
    const b = g.ball;
    if (b.k === "loose") { this.chaseLoose(); return; }
    if (b.k === "shot") { this.boxOut(); return; }
    if (b.k === "pass") { this.passDefense(b, dt); return; }
    this.passRef = null;
    this.icpt.clear();
    const h = g.off.handler();
    if (!h) return;
    this.live(h, dt);
  }

  /**
   * ルーズボール: まずマークをボックスアウト。ボールを取りに行くのはビッグと落下点に近い2人（と落下点のすぐ近くの人）だけ。
   * それ以外はマークに付いたまま（外で受けて打たれないように）。
   */
  private chaseLoose(): void {
    const g = this.g;
    const b = g.ball;
    const land = this.landing();
    const early = b.k === "loose" && b.t < 0.35;
    const near2 = [...this.pl].sort((a, c) => dist(a.p, land) - dist(c.p, land)).slice(0, 2);
    const isBig = (p: Player) => p.d.pos === "C" || p.d.pos === "PF" || p.a.height >= 2.03;
    for (const d of this.pl) {
      const m = this.mark.get(d)!;
      d.leanCmd = V();
      d.spd = 1;
      const chase = isBig(d) || near2.includes(d) || dist(d.p, land) < 2.0;
      if (early && distRim(m.p) < 6) {
        // まずボックスアウト
        d.effort = 1;
        d.urgency = 1;
        d.tgt = madd(m.p, dirTo(m.p, RIM), 0.6);
        d.face = dirTo(m.p, RIM);
        d.stanceCmd = 0.8;
        d.pushBoost = 1.2;
      } else if (chase) {
        d.effort = 1;
        d.urgency = 1;
        d.tgt = land;
        d.face = null;
        d.stanceCmd = 0.2;
      } else {
        // マークに付いたまま（飛び込んでくる相手なら体を入れ続ける）
        const crashing = distRim(m.p) < 4;
        d.effort = crashing ? 0.9 : 0.4;
        d.urgency = 0.5;
        d.tgt = madd(m.p, dirTo(m.p, RIM), crashing ? 0.6 : 1.1);
        d.face = crashing ? dirTo(m.p, RIM) : dirTo(d.p, m.p);
        d.stanceCmd = 0.5;
      }
      if (b.k === "loose" && chase && d.shouldJumpFor(b.p, b.v, b.h, b.vy)) d.jump(0.6, 0.15);
    }
  }

  private boxOut(): void {
    for (const d of this.pl) {
      const m = this.mark.get(d)!;
      d.leanCmd = V();
      if (distRim(m.p) < 7) {
        // ボックスアウト: 相手をリムから遠ざける（押されたら押し返す）
        d.effort = 1;
        d.urgency = 1;
        d.tgt = madd(m.p, dirTo(m.p, RIM), 0.65);
        d.face = dirTo(m.p, RIM);
        d.stanceCmd = 0.8;
        d.pushBoost = 1.2;
        d.spd = 1;
      } else {
        d.tgt = madd(m.p, dirTo(m.p, RIM), 1.2);
        d.face = null;
      }
    }
  }

  /** パスが飛んでいる間: 届くなら取りに行く（ギャンブル）／受け手のマークはクローズアウト */
  private passDefense(b: Extract<BallState, { k: "pass" }>, _dt: number): void {
    const g = this.g;
    const path: BallPath = { p0: b.p0, p1: b.p1, h0: b.h0, h1: b.h1, style: b.style, L: b.L, T: b.T, t: b.t, wait: 0 };
    if (this.passRef !== b) {
      this.passRef = b;
      for (const d of this.pl) {
        if (d.bal.off || d.airborne || (this.recoverUntil.get(d) ?? 0) > g.t) continue;
        const cur = this.steals.get(d);
        if (cur) {
          // 読んで出ていた人は、実際のボールに合わせて狙いを直す
          const ic = planIntercept(d, path, 0);
          if (ic) { cur.X = ic.X; cur.h = ic.h; cur.endT = g.t + ic.tb + 0.4; }
          continue;
        }
        const ic = planIntercept(d, path, d.reactT * 0.6);
        if (ic && willGamble(d, ic, g.rng.next())) this.commitSteal(d, ic.X, ic.h, ic.tb);
      }
    }
    const busy = new Set<Player>();
    this.runSteals(busy);
    const recvD = this.markerOf(b.to);
    for (const d of this.pl) {
      if (busy.has(d)) continue;
      d.leanCmd = V();
      if (d === recvD) {
        // クローズアウト: 受け手のリム側へ。近づいたら構えて小刻みに
        const pt = madd(b.p1, dirTo(b.p1, RIM), 0.85);
        d.tgt = pt;
        d.urgency = 1;
        const near = dist(d.p, pt) < 2.5;
        d.face = near ? dirTo(d.p, b.p1) : null;
        d.stanceCmd = near ? 0.8 : 0;
        d.spd = 1;
        continue;
      }
      d.tgt = this.tgt.get(d) ?? d.tgt;
      d.face = dist(d.p, d.tgt) > 2.2 ? null : dirTo(d.p, b.p1);
      d.stanceCmd = 0.4;
    }
    this.detourAll(null);
  }

  // ------------------------------------------------------------------ ハンドラーが持っている

  private live(h: Player, dt: number): void {
    const g = this.g;
    const off = g.off;
    const scripted = new Set<Player>();
    this.under.clear();
    this.updateNotice();
    if (this.transActive && this.transitionDefense(h, scripted)) {
      this.detourAll(h);
      return;
    }

    // スクリーンへの対抗（台本）
    for (const S of off.pl) {
      const st = off.stOf(S);
      if (st.mode !== "screen" || !st.screenFor) continue;
      const U = st.screenFor;
      const UD = this.markerOf(U);
      const SD = this.markerOf(S);
      if (!UD || !SD) continue;
      if (U === h) this.onBallScreen(h, S, st.setT, st.used, UD, SD, scripted);
      else this.offBallScreen(U, S, st.setT, st.used, UD, SD, scripted);
    }

    // アイソへのダブルチーム
    if (this.coverage === "DOUBLE" && off.hs.dribbled && distRim(h.p) < 8.5) {
      const hd0 = this.markerOf(h);
      if (!this.trapper) {
        let best: Player | null = null, bs = 1e9;
        for (const d of this.pl) {
          if (d === hd0) continue;
          const m = this.mark.get(d)!;
          const sc = dist(d.p, h.p) + n(m.a.three) * 3;
          if (sc < bs) { bs = sc; best = d; }
        }
        this.trapper = best;
        if (best) g.log(`${g.tag(best)} がダブルチームへ`, "def", this.team);
      }
      if (this.trapper) {
        const t = this.trapper;
        const axis = dirTo(h.p, RIM);
        const lat = right(axis);
        const side = Math.sign(dot(sub(t.p, h.p), lat)) || 1;
        t.tgt = inCourt(madd(madd(h.p, axis, 0.6), lat, side * 0.8));
        t.face = dirTo(t.p, h.p);
        t.stanceCmd = 0.9;
        t.spd = 1;
        t.urgency = 1;
        scripted.add(t);
      }
    }

    // オンボール
    const hd = this.markerOf(h);
    if (hd && !scripted.has(hd)) {
      const blitz = this.coverage === "BLITZ" && off.screenerOf(off.play?.screener ?? h);
      onBallDefend(hd, h, {
        shade: this.shadeFor(h),
        cushionAdd: this.coverage === "PACK" ? 0.25 : this.coverage === "DENY" ? -0.1 : blitz ? -0.4 : 0,
        rng: g.rng,
        triple: !off.hs.dribbled,
      });
      scripted.add(hd);
      // ドライブに体を当てて止める
      hd.effort = 0.7;
      // 押し込みドリブルには体を密着させて押し返す（ハンドラーとリングの間、少しハンドラーへ食い込む所を目指す＝押す意思）
      if (off.hs.post && !hd.bal.off) {
        const toRim = dirTo(h.p, RIM);
        hd.tgt = madd(h.p, toRim, h.radius + hd.radius - 0.15);
        hd.face = dirTo(hd.p, h.p);
        hd.effort = 1;
        hd.urgency = 1;
        hd.stanceCmd = 0.8;
        hd.leanCmd = V();
      }
      const cat = hd.guardFocus > 0.35 ? 1 : hd.guardFocus < -0.35 ? -1 : 0;
      if (this.focusShown.get(hd) !== cat) {
        this.focusShown.set(hd, cat);
        if (cat !== 0) hd.say(cat > 0 ? "シュート警戒" : "ドライブ警戒", 1.2);
      }
      this.reachIn(hd, h, dt);
      this.tryStrip(hd, h, dt);
      // 苦手なシューターにはスクリーンの下をくぐる
      if (n(Math.max(h.a.three, h.a.mid)) < 0.55) this.under.add(hd);
    }

    // パスの構えを読んで飛び出す／飛び出している人の実行
    this.readWindup(h, hd, scripted);
    this.runSteals(scripted);

    // シュートのコンテスト
    if (off.hs.shooting) {
      const sh = off.hs.shooting;
      for (const d of this.pl) {
        if (d.airborne || d.bal.off) continue;
        const dd = dist(d.p, h.p);
        const nearRim = distRim(h.p) < 2.5 && distRim(d.p) < 2.6;
        if (dd > 1.9 && !nearRim) continue;
        d.tgt = madd(h.p, dirTo(h.p, d.p), 0.55);
        d.face = dirTo(d.p, h.p);
        d.urgency = 1;
        if (contestJumpNow(d, sh.t, sh.rel)) {
          d.jump(0.66, 0.2);
          d.say("コンテスト", 0.7);
        }
        scripted.add(d);
      }
    }

    // ボールより後ろに取り残された守備者は、ボールとリムの間へ全力で戻る（近い順に深く。普段の守備でも抜かれたとき用）
    let back = 0;
    for (const d of [...this.pl].sort((a, b) => distRim(a.p) - distRim(b.p))) {
      if (scripted.has(d) || d === hd) continue;
      if (d.p.z > h.p.z - 1.0 || distRim(d.p) < 6) continue;
      d.tgt = madd(RIM, dirTo(RIM, h.p), 2.5 + 1.5 * back++);
      d.face = null;
      d.stanceCmd = 0;
      d.spd = 1;
      d.urgency = 1;
      d.leanCmd = V();
      scripted.add(d);
    }

    // 残りは導線を消す最適化
    this.optT -= dt;
    if (this.optT <= 0) {
      this.optT = 0.15;
      this.optimize(h, scripted, hd);
    }
    for (const d of this.pl) {
      if (scripted.has(d)) continue;
      const t = this.tgt.get(d) ?? d.p;
      d.tgt = t;
      const far = dist(d.p, t) > 2.2;
      const m = this.mark.get(d)!;
      d.face = far ? null : norm({ x: dirTo(d.p, h.p).x + dirTo(d.p, m.p).x, z: dirTo(d.p, h.p).z + dirTo(d.p, m.p).z });
      d.stanceCmd = far ? 0 : 0.45;
      d.spd = 1;
      d.leanCmd = V();
      d.urgency = dist(m.p, h.p) < 7 || this.beaten(h, hd) ? 0.7 : 0.4;
      if (!far) {
        // 棒立ちにしない: 構えたまま小刻みに合わせる（ボールの動きへ先回りして少しずつずれる）
        // 選手ごとのリズム（反応が速いほど細かく揺れる）
        const freq = 1.5 + 1.4 * d.quirk(3) + 0.8 * n(d.a.reaction);
        const sway = Math.sin(g.t * freq + d.quirk(4) * Math.PI * 2) * (0.1 + 0.1 * d.quirk(5));
        const perp = right(dirTo(t, h.p));
        d.tgt = madd(madd(t, perp, sway), h.v, 0.12);
        d.stanceCmd = 0.5 + 0.1 * Math.sin(g.t * (2.2 + 1.6 * d.quirk(6)) + d.quirk(7) * Math.PI * 2);
      }
      // ゴール下ではポジションを譲らない
      if (distRim(d.p) < 3.6) d.effort = 0.85;
    }
    this.detourAll(h);
  }

  /** ICE: スクリーン側に立って使わせない */
  private shadeFor(_h: Player): number {
    const off = this.g.off;
    if (this.coverage !== "ICE" || !off.play || off.play.done) return 0;
    return 0.7 * off.playSide();
  }

  private swap(a: Player, b: Player): void {
    const ma = this.mark.get(a)!, mb = this.mark.get(b)!;
    this.mark.set(a, mb);
    this.mark.set(b, ma);
    this.switched.add(a);
    this.switched.add(b);
    a.say("スイッチ", 0.9);
    b.say("スイッチ", 0.9);
    this.g.log(`${this.g.tag(a)} と ${this.g.tag(b)} がスイッチ`, "def", this.team);
  }

  private onBallScreen(h: Player, S: Player, setT: number, used: boolean, UD: Player, SD: Player, scripted: Set<Player>): void {
    if (setT <= 0) return;
    const axis = dirTo(h.p, RIM);
    const lat = right(axis);
    const s = this.g.off.playSide();
    const put = (d: Player, p: V2, face: V2 | null, stance: number) => {
      d.tgt = inCourt(p);
      d.face = face;
      d.stanceCmd = stance;
      d.spd = 1;
      d.leanCmd = V();
      d.urgency = 0.8;
      scripted.add(d);
    };
    switch (this.coverage) {
      case "SWITCH":
        if (used && !this.switched.has(UD)) { this.swap(UD, SD); return; }
        if (!used) put(SD, madd(S.p, dirTo(S.p, h.p), 0.7), dirTo(SD.p, h.p), 0.7);
        return;
      case "DROP": {
        const dd = clamp(distRim(h.p) * 0.45, 2.0, 3.8);
        put(SD, madd(RIM, dirTo(RIM, h.p), dd), dirTo(SD.p, h.p), 0.8);
        return;
      }
      case "HEDGE":
        if (setT < 1.1) put(SD, madd(madd(S.p, dirTo(S.p, h.p), 1.0), lat, s * 0.6), dirTo(SD.p, h.p), 0.9);
        else put(SD, madd(S.p, dirTo(S.p, RIM), 0.8), null, 0.3);
        return;
      case "ICE": {
        const forced = madd(h.p, lat, -s * 2);
        put(SD, madd(RIM, dirTo(RIM, forced), 2.8), dirTo(SD.p, h.p), 0.8);
        return;
      }
      case "BLITZ":
        put(SD, madd(madd(h.p, axis, 0.7), lat, s * 0.75), dirTo(SD.p, h.p), 1.0);
        return;
      default:
        // 読む前／それ以外のカバレッジ: スクリーナーが撃てるなら横で見せる、撃てないならドロップでリムを守る
        if (n(S.a.three) >= 0.7) { if (!used) put(SD, madd(S.p, dirTo(S.p, h.p), 0.5), dirTo(SD.p, h.p), 0.6); }
        else put(SD, madd(RIM, dirTo(RIM, h.p), clamp(distRim(h.p) * 0.45, 2.0, 3.8)), dirTo(SD.p, h.p), 0.8);
    }
  }

  private offBallScreen(U: Player, S: Player, setT: number, used: boolean, UD: Player, SD: Player, scripted: Set<Player>): void {
    if (setT <= 0) return;
    if (this.coverage === "SWITCH") {
      if (used && !this.switched.has(UD)) this.swap(UD, SD);
      return;
    }
    if (this.coverage === "UNDER") {
      this.under.add(UD);
      return;
    }
    // チェイス: 背中に付いていく
    const sp = len(U.v);
    UD.tgt = sp > 0.8 ? madd(U.p, norm(U.v), -0.55) : madd(U.p, dirTo(U.p, RIM), 0.8);
    UD.face = sp > 0.8 ? null : dirTo(UD.p, U.p);
    UD.stanceCmd = 0.1;
    UD.spd = 1;
    UD.urgency = 0.9;
    UD.leanCmd = V();
    scripted.add(UD);
  }

  /**
   * オンボールのスティールを選択肢として選ぶ（弱=チェック／中=リーチイン／強=ギャンブル、duel.ts の STEALS）。
   * 0.17〜0.25秒ごとに、それぞれ
   *   得 = 成功の見込み ×（今の攻撃の脅威 + 速攻0.3）
   *   損 = 失敗の見込み ×（失敗して「構え直し＋崩れの立て直し」の時間だけ自分が遅れたときに増える攻撃の脅威）
   * を導線で計算し（遅れは導線の到達時間に足す＝抑えていたドリブル・パスの導線が開く）、得−損が最大の強さで手を出す。
   * 守備IQが低いほど成功の見込みを高く見積もる（ギャンブルしがち）。
   */
  private reachIn(d: Player, h: Player, _dt: number): void {
    const g = this.g;
    const r = this.reaching.get(d);
    if (r) {
      if (g.t > r.until) {
        // 手を出して届かずに終わった
        this.reaching.delete(d);
        this.stealFailed(d, h, r.sd, "空振り");
      } else {
        // 手を出している最中: 踏み込み・飛び込みを続ける
        d.tgt = r.tgt;
        d.urgency = 1;
        if (r.sd.lv === "strong") d.vCmd = mul(dirTo(d.p, r.tgt), d.maxSpeed * 0.8);
      }
      return;
    }
    if (d.bal.off || d.airborne || d.lungeT > 0 || d.commitT > 0 || g.phase !== "live" || g.off.hs.shooting || g.off.hs.passing) return;
    if (dist(d.p, h.p) > 2.2 || g.t < (this.stealCd.get(d) ?? 0) || g.t < (this.stealDecideT.get(d) ?? 0)) return;
    this.stealDecideT.set(d, g.t + 0.25 - 0.08 * n(d.a.defIQ));
    const e = exposure(h, g.off.hs.move, d);
    const bp = g.ballPos().p;
    const lc: LaneCtx = { defs: this.pl, screens: g.off.screens() };
    const base = {
      lc, h, mates: g.off.receivers(h), cuts: g.off.cuts(), catchShoot: false,
      C: contValue(g.shotClock), onBall: d, coarse: true, holdT: g.off.holdTime(),
    };
    const opts0 = evalOptions(base);
    const now = threatOf(opts0);
    const gain = now + 0.3;
    const over = 1 + 0.6 * (1 - n(d.a.defIQ));
    let best: StealDef | null = null;
    let bestEV = 0.02, bestP = 0, bestCost = 0;
    for (const sd of Object.values(STEALS)) {
      const p = Math.min(0.95, stealSuccessEstimate(sd, d, h, bp, e) * over);
      if (p < 0.01) continue;
      const lag = sd.commit + 0.18 * sd.kick;
      const opts1 = evalOptions({ ...base, lc: { ...lc, delay: new Map([[d, lag]]) } });
      // 損: 攻撃の脅威（全選択肢のなめらかな最大）の増加 ＋ 失敗で一番良くなる選択肢の伸びの半分。
      // 脅威は「攻め続ける価値」に近い選択肢が多いと薄まり、空振りでフリーのシュートが生まれても小さく見える（2026-10-04 計測で中央値+0.05）ため
      let jump = 0;
      for (let i = 0; i < Math.min(opts0.length, opts1.length); i++) jump = Math.max(jump, opts1[i].value - opts0[i].value);
      const cost = Math.max(0, threatOf(opts1) - now) + 0.5 * jump;
      const ev = p * gain - (1 - p) * cost;
      if (ev > bestEV) { bestEV = ev; best = sd; bestP = p; bestCost = cost; }
    }
    if (!best) return;
    d.lungeT = best.lungeT;
    const tgt = best.step > 0 ? madd(d.p, dirTo(d.p, bp), best.step) : d.p;
    this.reaching.set(d, { sd: best, until: g.t + best.lungeT + 0.07, tgt });
    this.stealCd.set(d, g.t + 0.9);
    d.say(best.label, 0.7);
    const lvTxt = best.lv === "weak" ? "弱" : best.lv === "mid" ? "中" : "強";
    // 弱（チェック）は頻繁なのでログに出さない（頭の上の表示だけ）
    if (best.lv !== "weak") g.log(`${g.tag(d)} ${best.label}（${lvTxt}: 成功見込み ${(bestP * 100).toFixed(0)}% / 失敗で脅威 +${bestCost.toFixed(2)}）`, "def", this.team);
  }

  /** スティールの失敗: 重心が前へ流れ（強さは種類ごと）、構え直すまで遅い＝抑えていた導線が開く */
  private stealFailed(d: Player, h: Player, sd: StealDef, why: string): void {
    d.bal.kick(mul(dirTo(d.p, h.p), sd.kick * (1 - 0.4 * n(d.a.balance))));
    d.commitT = Math.max(d.commitT, sd.commit);
    d.say(`${sd.label}${why}`, 0.8);
  }

  private tryStrip(d: Player, h: Player, dt: number): void {
    const g = this.g;
    if (d.bal.off || d.airborne || g.off.hs.shooting || g.off.hs.passing || g.phase !== "live") return;
    // 手がボールに触れていなければ取れない
    const bp = g.ballPos();
    const B = { x: bp.p.x, y: bp.h, z: bp.p.z };
    if (Math.min(dist3(d.handW(0), B), dist3(d.handW(1), B)) > 0.24) return;
    const e = exposure(h, g.off.hs.move, d);
    // スティールで手を出している最中に触れたら必ず判定（1回）、そうでなければ低い頻度で
    const r = this.reaching.get(d);
    if (r) {
      this.reaching.delete(d);
      this.stealCd.set(d, g.t + 1.2);
      // 手を出して触れたら出方は最低0.5とみなす（ただしキープして守っているボールにはこの下限をかけない）
      if (!g.tryStrip(d, h, h.protecting ? e : Math.max(e, 0.5), r.sd)) this.stealFailed(d, h, r.sd, "取りきれず");
      return;
    }
    if (g.t < (this.stealCd.get(d) ?? 0)) return;
    const rate = (0.15 + 0.6 * n(d.a.steal)) * e * (1.2 - 0.5 * n(d.a.defIQ));
    if (g.rng.chance(rate * dt)) {
      this.stealCd.set(d, g.t + 1.5);
      g.tryStrip(d, h, e);
    }
  }

  // ------------------------------------------------------------------ 導線を消す最適化

  /** ゴール下を守る役: 撃てないビッグをマークしている守備者（いなければ居ない） */
  private rimProtector(): Player | null {
    let best: Player | null = null, bh = 0;
    for (const [d, m] of this.mark) {
      if (offRole(m) !== "big") continue;
      if (m.a.height > bh) { bh = m.a.height; best = d; }
    }
    return best;
  }

  private candidates(d: Player, m: Player, h: Player, rimP: Player | null): V2[] {
    const toR = dirTo(m.p, RIM);
    const dm = distRim(m.p);
    const helpPt = madd(RIM, dirTo(RIM, h.p), clamp(distRim(h.p) * 0.45, 1.5, 4.0));
    const cs: V2[] = [
      madd(m.p, toR, 0.9),
      madd(m.p, toR, Math.min(2.0, dm * 0.4)),
      this.tgt.get(d) ?? d.p,
    ];
    const onePass = dist(m.p, h.p) < 7.0;
    if (onePass) {
      // ボールに近いマーク: ディナイ／ハーフディナイ
      cs.push(madd(madd(m.p, dirTo(m.p, h.p), 0.9), toR, 0.3));
      cs.push(madd(madd(m.p, dirTo(m.p, h.p), 0.5), toR, 0.7));
    } else {
      // 逆サイド（2パス先）: マークとリムの間のヘルプライン
      const line = madd(m.p, toR, dm * 0.5);
      cs.push(line, lerpV(line, helpPt, 0.35));
    }
    if (d === rimP) cs.push(madd(RIM, dirTo(RIM, h.p), 1.8), helpPt);
    const st = this.g.off.stOf(m);
    if (st.path && (st.mode === "cut" || st.mode === "roll")) {
      cs.push(alongPoly([m.p, ...st.path.slice(st.pathI)], 1.6));
    }
    return cs.map((c) => inCourt(c, 0.3));
  }

  /** オンボールの守備者が抜かれているか（ヘルプが要るか） */
  private beaten(h: Player, hd: Player | null): boolean {
    if (!hd) return true;
    if (hd.bal.off || hd.airborne) return true;
    if (dist(hd.p, h.p) > 2.0) return true;
    return dot(sub(hd.p, h.p), dirTo(h.p, RIM)) < 0.1;
  }

  private structureCost(d: Player, m: Player, c: V2, h: Player, beaten: boolean, crowdH: number): number {
    let k = 0.01 * dist(d.p, c);
    switch (this.coverage) {
      case "PACK": k += 0.04 * Math.max(0, distRim(c) - 5.0); break;
      case "DENY": if (dist(m.p, h.p) < 8) k += 0.03 * distToSeg(c, h.p, m.p); break;
      case "NOHELP": k += 0.06 * Math.max(0, dist(c, m.p) - 1.5); break;
      default: k += 0.015 * Math.max(0, dist(c, m.p) - 3.0);
    }
    // ハンドラーに寄る（2人目・3人目になる）のは、抜かれた時とダブルの時だけ
    if (dist(c, h.p) < 2.3 && m !== h) {
      if (!beaten && this.coverage !== "DOUBLE") k += 0.3 + 0.3 * crowdH;
      else k += 0.15 * crowdH;
    }
    return k;
  }

  private optimize(h: Player, scripted: Set<Player>, hd: Player | null): void {
    const g = this.g;
    const off = g.off;
    const free = this.pl.filter((d) => !scripted.has(d));
    if (free.length === 0) return;
    const virt = new Map<Player, V2>();
    for (const d of free) virt.set(d, this.tgt.get(d) ?? copy(d.p));
    const lc: LaneCtx = { defs: this.pl, screens: off.screens(), virt };
    const base = {
      lc, h, mates: off.receivers(h), cuts: off.cuts(), catchShoot: false,
      C: contValue(g.shotClock), onBall: hd, coarse: true, holdT: off.holdTime(),
    };
    const beaten = this.beaten(h, hd);
    const rimP = this.rimProtector();
    // ボールから遠い順に（遠い守備者の判断は近い守備者の位置に依存する）
    free.sort((a, b) => dist(b.p, h.p) - dist(a.p, h.p));
    for (const d of free) {
      const m = this.mark.get(d)!;
      let bestC = virt.get(d)!;
      let bestV = 1e9;
      let crowdH = 0;
      for (const o of this.pl) {
        if (o === d) continue;
        const at = virt.get(o) ?? o.p;
        if (o !== hd && dist(at, h.p) < 2.3) crowdH++;
      }
      for (const c of this.candidates(d, m, h, rimP)) {
        virt.set(d, c);
        const v = threatOf(evalOptions(base)) + this.structureCost(d, m, c, h, beaten, crowdH);
        if (v < bestV) { bestV = v; bestC = c; }
      }
      virt.set(d, bestC);
      this.tgt.set(d, bestC);
    }
  }

  /** 経路をふさぐ体（特にセットしたスクリーン）を回り込む。アンダーはリム側、それ以外は上側 */
  private detourAll(h: Player | null): void {
    const off = this.g.off;
    for (const d of this.pl) {
      if (d.airborne) continue;
      const t = d.tgt;
      for (const o of off.pl) {
        if (o === h && this.markerOf(h) === d) continue;
        const k = closestT(o.p, d.p, t);
        if (k <= 0.05 || k >= 0.95) continue;
        const pt = lerpV(d.p, t, k);
        const clear = o.radius + d.radius + 0.12;
        if (dist(pt, o.p) >= clear) continue;
        const perp = right(dirTo(d.p, t));
        let side = Math.sign(dot(sub(pt, o.p), perp)) || 1;
        if (off.screenerOf(o) && !this.noticed.has(`${d.id}-${o.id}`)) continue;
        if (off.screenerOf(o)) {
          const rimSide = Math.sign(dot(dirTo(o.p, RIM), perp)) || 1;
          side = this.under.has(d) ? rimSide : -rimSide;
        }
        d.tgt = inCourt(madd(o.p, perp, side * (clear + 0.25)), 0.2);
        break;
      }
    }
  }
}


