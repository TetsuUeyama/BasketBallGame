// 1on1。ハンドラーのムーブと、オンボール守備の読み（反応の遅れ・体重の寄せ・構え）。
// 崩れは抽選ではなく重心の物理で起きる: 守備者は遅れて見た「横の動き」と「見せ(フェイク)」で
// 体重を寄せる → 寄せた逆へ急加速を強いられると支持円を出る → 崩れている間は導線を消せない。
import { n } from "./attrs";
import { RIM, distRim, isThree } from "./court";
import { shotBase } from "./eval";
import { V2, clamp, dirTo, dist, dot, len, madd, mul, right, sub, Rng } from "./math";
import { LEAN_MAX, Player } from "./player";

export type MoveId =
  | "cross" | "inout" | "btl" | "btb" | "hesi" | "jab" | "pump"
  | "stepback" | "sidestep" | "spin" | "power" | "euro" | "retreat";

export interface MoveDef {
  id: MoveId;
  label: string;
  dur: number;
  /** u=0..1, s=最終的に攻める横の向き(+1=右/-1=左) → [前, 横]（最高速に対する割合） */
  vel: (u: number, s: number) => [number, number];
  /** 横への見せ（lat単位の符号つき） */
  sellLat?: (u: number, s: number) => number;
  sellStop?: (u: number) => number;
  sellShot?: (u: number) => number;
  /** 持ち替えのタイミング（u） */
  switchAt?: number;
  /** ボールが体の前に出て取られやすい区間 */
  exposed?: [number, number];
  push?: number;
  stance?: number;
  /** 終わりにプルアップ／フィニッシュへつなぐ */
  shot?: boolean;
  /** 難しさ（ハンドリングが足りないとファンブル） */
  diff: number;
}

const ph = (u: number, cut: number) => u < cut;

export const MOVES: Record<MoveId, MoveDef> = {
  cross: {
    id: "cross", label: "クロスオーバー", dur: 0.5, diff: 0.45, switchAt: 0.42, exposed: [0.34, 0.5],
    vel: (u, s) => (ph(u, 0.42) ? [0.25, -s * 0.55] : [0.75, s * 0.75]),
    sellLat: (u, s) => (ph(u, 0.42) ? -s : 0),
  },
  inout: {
    id: "inout", label: "インアウト", dur: 0.5, diff: 0.5,
    vel: (u, s) => (ph(u, 0.45) ? [0.3, -s * 0.15] : [0.78, s * 0.7]),
    sellLat: (u, s) => (ph(u, 0.45) ? -s * 0.9 : 0),
  },
  btl: {
    id: "btl", label: "レッグスルー", dur: 0.6, diff: 0.4, switchAt: 0.5,
    vel: (u, s) => (ph(u, 0.5) ? [0.1, -s * 0.4] : [0.7, s * 0.75]),
    sellLat: (u, s) => (ph(u, 0.5) ? -s * 0.8 : 0),
  },
  btb: {
    id: "btb", label: "ビハインドバック", dur: 0.5, diff: 0.55, switchAt: 0.4,
    vel: (u, s) => (ph(u, 0.4) ? [0.55, -s * 0.35] : [0.75, s * 0.65]),
    sellLat: (u, s) => (ph(u, 0.4) ? -s * 0.7 : 0),
  },
  hesi: {
    id: "hesi", label: "ヘジテーション", dur: 0.7, diff: 0.35,
    vel: (u, s) => (ph(u, 0.45) ? [0.05, 0] : [1.0, s * 0.2]),
    sellStop: (u) => (ph(u, 0.45) ? 1 : 0),
    stance: 0,
  },
  jab: {
    id: "jab", label: "ジャブステップ", dur: 0.45, diff: 0.1,
    vel: (u, s) => (ph(u, 0.35) ? [0.15, s * 0.5] : [0, -s * 0.45]),
    sellLat: (u, s) => (ph(u, 0.4) ? s : 0),
  },
  pump: {
    id: "pump", label: "ポンプフェイク", dur: 0.45, diff: 0.1,
    vel: () => [0, 0],
    sellShot: (u) => (ph(u, 0.7) ? 1 : 0),
    stance: 0,
  },
  stepback: {
    id: "stepback", label: "ステップバック", dur: 0.5, diff: 0.55, shot: true,
    vel: (u, s) => (ph(u, 0.3) ? [0.5, 0] : [-0.85, s * 0.15]),
    sellLat: () => 0,
  },
  sidestep: {
    id: "sidestep", label: "サイドステップ", dur: 0.45, diff: 0.5, shot: true,
    vel: (u, s) => (ph(u, 0.25) ? [0.2, -s * 0.2] : [0, s * 0.9]),
    sellLat: (u, s) => (ph(u, 0.25) ? -s * 0.6 : 0),
  },
  spin: {
    id: "spin", label: "スピンムーブ", dur: 0.6, diff: 0.6, switchAt: 0.45, push: 1.2,
    vel: (u, s) => (ph(u, 0.45) ? [0.4, -s * 0.25] : [0.75, s * 0.55]),
    sellLat: (u, s) => (ph(u, 0.45) ? -s * 0.8 : 0),
  },
  power: {
    id: "power", label: "パワードライブ", dur: 0.6, diff: 0.25, push: 1.7, stance: 0.6,
    vel: (_u, s) => [0.9, s * 0.2],
  },
  euro: {
    id: "euro", label: "ユーロステップ", dur: 0.55, diff: 0.5, shot: true,
    vel: (u, s) => (ph(u, 0.45) ? [0.6, -s * 0.6] : [0.55, s * 0.7]),
    sellLat: (u, s) => (ph(u, 0.45) ? -s : 0),
  },
  retreat: {
    id: "retreat", label: "リトリート", dur: 0.5, diff: 0.1,
    vel: () => [-0.75, 0],
  },
};

export interface ActiveMove {
  def: MoveDef;
  s: number;
  t: number;
  axis: V2;
  lat: V2;
}

export function startMove(h: Player, id: MoveId, s: number, toward: V2): ActiveMove {
  const axis = dirTo(h.p, toward);
  const m: ActiveMove = { def: MOVES[id], s, t: 0, axis, lat: right(axis) };
  h.say(m.def.label, m.def.dur + 0.5);
  return m;
}

/** ムーブ1ステップ。終わったら true */
export function stepMove(h: Player, m: ActiveMove, dt: number): boolean {
  m.t += dt;
  const u = Math.min(1, m.t / m.def.dur);
  const q = 0.65 + 0.35 * n(h.a.handle);
  const [fw, lt] = m.def.vel(u, m.s);
  const sp = h.speedNow() * q;
  h.vCmd = madd(mul(m.axis, fw * sp), m.lat, lt * sp);
  h.face = m.axis;
  if (m.def.sellLat) h.sell = mul(m.lat, m.def.sellLat(u, m.s) * q);
  if (m.def.sellStop) h.sellStop = Math.max(h.sellStop, m.def.sellStop(u) * q);
  if (m.def.sellShot) h.sellShot = Math.max(h.sellShot, m.def.sellShot(u) * q);
  if (m.def.switchAt !== undefined && u >= m.def.switchAt) h.hand = m.s >= 0 ? 1 : -1;
  h.pushBoost = m.def.push ?? 1;
  if (m.def.push) h.effort = 1;
  h.urgency = 1;
  h.stanceCmd = m.def.stance ?? 0.35;
  if (u >= 1) {
    h.pushBoost = 1;
    h.vCmd = null;
    return true;
  }
  return false;
}

/** 今ボールが守備者 d 側に出ているか（0..1） */
export function exposure(h: Player, m: ActiveMove | null, d: Player): number {
  const toD = dirTo(h.p, d.p);
  const handSide = dot(right(h.f), toD) * h.hand; // 正 = ボールの手が守備者側
  let e = clamp(0.25 + 0.5 * handSide, 0, 1);
  if (m && m.def.exposed) {
    const u = m.t / m.def.dur;
    if (u >= m.def.exposed[0] && u <= m.def.exposed[1]) e = Math.max(e, 0.9);
  }
  return e * (1 - 0.5 * n(h.a.handle));
}

// ---------------------------------------------------------------------------
// オンボール守備

export interface OnBallOpt {
  /** 横への寄せ（lat単位、+は右）。ICE や「ベースラインへ追い込む」に使う */
  shade: number;
  /** 間合いの追加 */
  cushionAdd: number;
  rng: Rng;
  /** 相手がまだドリブルしていない（トリプルスレット） */
  triple: boolean;
}

export interface OnBallResult {
  jumped: boolean;
}

export function onBallDefend(d: Player, h: Player, o: OnBallOpt): OnBallResult {
  const res: OnBallResult = { jumped: false };
  d.urgency = 1;
  const ps = h.perceived(d.reactT);
  const axis = dirTo(ps.p, RIM);
  const lat = right(axis);
  const dRim = distRim(ps.p);
  const gull = 1 - 0.6 * n(d.a.defIQ);

  const shootThreat = isThree(ps.p) ? n(h.a.three) : n(h.a.mid);
  // 何を警戒するか: その位置からフリーで撃たれたときの期待値 と ドリブラーとしての優位
  const sb = shotBase(h, ps.p);
  const shotEVfree = sb.p * sb.pts;
  const driveAdv = (n(h.a.speed) + n(h.a.agility) + n(h.a.handle)) / 3 - (n(d.a.perD) + n(d.a.agility) + n(d.a.speed)) / 3;
  // +1 = シュート警戒（密着） / -1 = ドライブ警戒（離れてドリブルの線を広く）
  const focus = clamp((shotEVfree - 0.85) * 2.4 - driveAdv * 3.0, -1, 1);
  d.guardFocus = focus;
  let cushion = 1.25 - 0.55 * focus + o.cushionAdd;
  if (o.triple) cushion -= 0.12;
  cushion -= 0.35 * ps.sellStop * gull; // 止まる見せ → 詰める
  cushion = clamp(cushion, 0.6, 2.0);
  if (dRim < 4) cushion = Math.min(cushion, dRim * 0.35 + 0.3);

  // ドライブ警戒なら利き手（ボールの手）側をふさいで逆の手へ追い込む
  const handShade = h.hand * 0.3 * Math.max(0, -focus);
  const pred = madd(ps.p, ps.v, 0.18);
  const tgt = madd(madd(pred, axis, cushion), lat, o.shade + handShade);

  // 体重の寄せ: 遅れて見た横の動き＋見せ
  const vlat = dot(ps.v, lat);
  const sl = dot(ps.sell, lat);
  const leanS = clamp(vlat / 3.5 + sl * 0.9 * gull, -1, 1);
  d.leanCmd = mul(lat, leanS * (0.45 + 0.55 * gull));

  // 抜かれた（相手より前に居ない）なら構えを解いて体を向けて走る
  const ahead = dot(sub(d.p, h.p), axis);
  const beaten = ahead < 0.15 || dist(d.p, tgt) > 1.5;
  if (beaten) {
    d.face = null;
    d.stanceCmd = 0;
    d.tgt = madd(h.p, axis, Math.min(1.2, dRim * 0.5));
    d.leanCmd = mul(d.leanCmd, 0);
  } else {
    d.face = dirTo(d.p, ps.p);
    // ドライブ警戒は低く広く（支持円が広い＝切り返しに崩れにくい）、シュート警戒は高め（手を伸ばせる）
    d.stanceCmd = clamp(0.85 - 0.25 * focus - 0.6 * ps.sellStop * gull, 0.2, 1);
    d.tgt = tgt;
  }
  d.spd = 1;

  // ポンプフェイクに跳ぶ
  if (ps.sellShot > 0.55 && !d.airborne && dist(d.p, h.p) < 2.3) {
    const bite = 0.04 * gull * (0.5 + shootThreat);
    if (o.rng.chance(bite)) {
      d.jump(0.7, 0.3);
      d.say("跳ばされた", 1.0);
      res.jumped = true;
    }
  }
  return res;
}

// ---------------------------------------------------------------------------
// ムーブの選択

export interface MoveChoice { id: MoveId; s: number }

/** マークの状態（1on1の選択肢の重みを変える） */
export interface DefRead {
  /** 跳んでいる（フェイクに掛かった） */
  air: boolean;
  /** 重心が崩れている */
  off: boolean;
  /** 全速で詰めてくる（クローズアウト） */
  closing: boolean;
  /** 離れて構えている（ドライブ警戒） */
  sag: boolean;
  /** 密着している（シュート警戒） */
  tight: boolean;
}

export function readDefender(h: Player, d: Player): DefRead {
  const dd = dist(h.p, d.p);
  const approach = dot(d.v, dirTo(d.p, h.p));
  return {
    air: d.airborne,
    off: d.bal.off,
    closing: approach > 2.2 && dd < 3.5,
    sag: dd > 1.55 || d.guardFocus < -0.35,
    tight: dd < 0.95 || d.guardFocus > 0.35,
  };
}

const strengthOf = (p: Player): number => p.mass * (0.6 + 0.8 * n(p.a.strength));

export function chooseMove(h: Player, d: Player, triple: boolean, others: Player[], rng: Rng): MoveChoice | null {
  const dd = dist(h.p, d.p);
  if (dd > 2.7) return null;
  const st = readDefender(h, d);
  // 跳んでいる／崩れている相手にムーブは要らない（そのまま抜く）
  if (st.air || st.off) return null;
  const axis = dirTo(h.p, RIM);
  const lat = right(axis);
  const dl = dot(sub(d.p, h.p), lat);
  const leanS = dot(d.bal.lean, lat) / LEAN_MAX;
  let openSide = -Math.sign(dl + leanS * 0.4);
  if (openSide === 0) openSide = rng.sign();
  const hand = h.hand;
  const hd = n(h.a.handle);
  const shooter = isThree(h.p) ? n(h.a.three) : n(h.a.mid);
  const ids: MoveChoice[] = [];
  const w: number[] = [];
  const add = (id: MoveId, s: number, wt: number) => { ids.push({ id, s }); w.push(Math.max(0, wt)); };

  // 囲まれたら下がる
  const near = others.filter((o) => dist(o.p, h.p) < 2.0).length;
  if (near >= 2) add("retreat", 1, 1.2);

  if (triple) {
    add("jab", openSide, 0.7);
    add("jab", -openSide, 0.4);
    const closing = dot(d.v, dirTo(d.p, h.p));
    add("pump", 1, (closing > 1.2 ? 0.9 : 0.15) * (0.4 + shooter) * (st.closing ? 2.0 : 1));
    if (st.sag) add("jab", openSide, 0.2);
  } else {
    const sp = len(h.v);
    add("cross", -hand, (0.45 + (-hand === openSide ? 0.6 : -0.2) + (leanS * hand > 0.3 ? 0.5 : 0)) * (0.5 + hd));
    add("inout", hand, (0.4 + (hand === openSide ? 0.4 : 0) + (Math.abs(leanS) < 0.2 ? 0.3 : 0)) * (0.5 + hd));
    add("btl", -hand, (0.3 + (dd < 1.3 ? 0.3 : 0)) * (0.5 + hd));
    add("btb", -hand, (sp > 2.5 ? 0.55 : 0.08) * (0.5 + hd));
    add("hesi", openSide, (sp > 2 ? 0.55 : 0.12) + (d.stance > 0.7 ? 0.15 : 0));
    add("stepback", hand, dd < 1.7 ? 0.6 * shooter * shooter : 0.03);
    add("sidestep", openSide, 0.3 * shooter * shooter);
    const ratio = strengthOf(h) / strengthOf(d);
    add("power", openSide, ratio > 1.08 && dd < 1.9 ? 0.35 + (ratio - 1) * 2.5 : 0.04);
    add("spin", openSide, dd < 1.25 ? 0.45 * (0.5 + hd) : 0.04);
    // マークの状態で重みを変える
    const boost = (ids2: MoveId[], k: number) => ids.forEach((m, i) => { if (ids2.includes(m.id)) w[i] *= k; });
    if (st.tight) boost(["cross", "inout", "btl", "power", "spin"], 1.6);
    if (st.sag) { boost(["hesi", "sidestep"], 1.8); boost(["power", "spin"], 0.3); }
    if (st.closing) boost(["hesi", "inout"], 1.5);
  }
  if (ids.length === 0) return null;
  return rng.weighted(ids, w);
}
