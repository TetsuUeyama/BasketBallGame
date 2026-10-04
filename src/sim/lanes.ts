// 導線(lane)。すべて「攻撃側が着く時刻」と「守備者が届かせる時刻」の差（余裕 margin）で開閉が決まる。
//   margin > 0 … 攻撃が先に着く（導線が通っている）
//   margin < 0 … 守備が先に届く（導線が消されている）
import { n } from "./attrs";
import { RIM, distRim } from "./court";
import { passRelease, passSpeed } from "./eval";
import { V2, alongPoly, clamp, dirTo, dist, dot, len, lerp, lerpV, madd, polyLen, sat } from "./math";
import { Player } from "./player";
import { Obstacle, runTime, timeToReach } from "./reach";
import { POST_PUSH_SPEED, pushPower } from "./contact";

export type LaneKind = "pass" | "lead" | "lob" | "drive" | "shot" | "step" | "post";

export interface Lane {
  kind: LaneKind;
  from: Player;
  to: Player | null;
  /** 表示用の折れ線（x,z） */
  pts: V2[];
  target: V2;
  margin: number;
  open: number;
  /** いちばん導線を消している守備者 */
  closer: Player | null;
  /** ボール/ハンドラーが終点へ着く時刻 */
  T: number;
  /** パスの水平速度 */
  speed: number;
  /** ロブの終点の高さ */
  endH: number;
  /** ドライブで「消される前に進める距離」 */
  freeD: number;
  /** パスの種類・どちらの手から(-1/0/+1)・リリースの高さ */
  style: PassStyle;
  side: number;
  h0: number;
}

export const openOf = (m: number): number => sat((m + 0.12) / 0.5);

export interface LaneCtx {
  defs: Player[];
  /** スクリーンなど、守備者の経路をふさぐ体 */
  screens: Obstacle[];
  /** 守備の最適化用: 仮想位置 */
  virt?: Map<Player, V2>;
  /** 評価用: 守備者ごとの追加の遅れ（スティールに失敗したら導線がどれだけ開くか、の見積もり） */
  delay?: Map<Player, number>;
}

function defAt(c: LaneCtx, d: Player): { at?: V2; still?: boolean; delay?: number } {
  const at = c.virt?.get(d);
  const delay = c.delay?.get(d);
  return at ? { at, still: true, delay } : { delay };
}

// ---------------------------------------------------------------- ボールの飛び方（重力＋空気抵抗）
// パス・シュートは「飛行時間 T で水平に L 進み、高さ h0 → h1」を、重力と空気抵抗に従って飛ぶ。
// u = 飛行時間の割合（t/T）。水平に進んだ割合は passFrac(u, L)（手元ほど速く、先ほど空気抵抗で遅い）、
// 高さは重力の放物線（ballistic）。導線の評価・ボールの位置・表示・手の狙いがすべてこの関数を使う。

export const G = 9.8;
/** 空気抵抗（速さの2乗に比例する減速）の係数 [1/m] ≈ 0.5·空気密度1.2·Cd0.5·断面積0.045m²/質量0.62kg */
export const BALL_DRAG = 0.022;

/** 飛行時間の割合 u で水平に進んだ割合（x(t) = ln(1 + k·v0·t)/k、L 進むのに T 秒になる v0） */
export function passFrac(u: number, L: number): number {
  const kL = BALL_DRAG * L;
  const uu = clamp(u, 0, 1);
  if (kL < 1e-4) return uu;
  return Math.log(1 + (Math.exp(kL) - 1) * uu) / kL;
}

/** 水平に割合 s 進んだときの飛行時間の割合（passFrac の逆） */
export function fracToU(s: number, L: number): number {
  const kL = BALL_DRAG * L;
  if (kL < 1e-4) return s;
  return (Math.exp(kL * s) - 1) / (Math.exp(kL) - 1);
}

/** 水平の速さ [m/s]（飛行時間の割合 u のとき） */
export function passHSpeed(u: number, L: number, T: number): number {
  const kL = BALL_DRAG * L;
  if (kL < 1e-4) return L / T;
  const e = Math.exp(kL) - 1;
  return ((L / T) * e) / (kL * (1 + e * clamp(u, 0, 1)));
}

/** 重力で h0 から T 秒後に h1 に着く放物線の、t 秒後の高さ */
export function ballistic(h0: number, h1: number, t: number, T: number): number {
  const vy0 = (h1 - h0 + 0.5 * G * T * T) / T;
  return h0 + vy0 * t - 0.5 * G * t * t;
}

/** 同じ放物線の t 秒後の上向きの速さ */
export function ballisticVy(h0: number, h1: number, t: number, T: number): number {
  return (h1 - h0 + 0.5 * G * T * T) / T - G * t;
}

/** ロブの水平の速さの上限: 頂点がリリース点と受け手を結ぶ線より 0.6+0.12·L 上になる（重力でその高さまで上がる）飛行時間から */
export function lobSpeed(L: number): number {
  const apex = 0.6 + 0.12 * L;
  return L / Math.sqrt((8 * apex) / G);
}

function newLane(kind: LaneKind, from: Player, to: Player | null, pts: V2[], target: V2): Lane {
  return { kind, from, to, pts, target, margin: 9, open: 1, closer: null, T: 0, speed: 0, endH: 1.5, freeD: 0, style: "chest", side: 0, h0: 1.3 };
}

/** スティールで飛び込んだときに伸びる届く距離 [m] */
export const LUNGE_REACH = 0.4;

/** そのパスを出してよい最低の開き。ロブは遅くて読まれやすいので、ほぼ確実に通るときだけ */
export const passMinOpen = (l: { style: PassStyle; kind: LaneKind }): number => (l.style === "lob" || l.kind === "lob" ? 0.8 : 0.45);

export type PassStyle = "chest" | "bounce" | "overhead" | "lob" | "jump";
export const PASS_LABEL: Record<PassStyle, string> = {
  chest: "チェストパス", bounce: "バウンズパス", overhead: "オーバーヘッドパス", lob: "ロブパス", jump: "ジャンプパス",
};

export interface StyleP {
  /** リリースの高さ */
  h0: number;
  /** 受け手の手元の高さ */
  h1: number;
  /** 水平速度 */
  speed: number;
  /** 構えてから離すまで */
  rel: number;
}

/** パスの種類ごとの高さ・速さ・構えの時間 */
export function styleParams(passer: Player, style: PassStyle, endH = 1.5): StyleP {
  const vb = passSpeed(passer, false);
  const r = passRelease(passer);
  switch (style) {
    case "chest": return { h0: passer.a.height * 0.7, h1: 1.2, speed: vb, rel: r };
    case "overhead": return { h0: passer.a.height + 0.3, h1: 1.75, speed: vb * 0.95, rel: r + 0.06 };
    case "bounce": return { h0: 0.95, h1: 0.85, speed: vb * 0.8, rel: r + 0.02 };
    case "lob": return { h0: passer.a.height * 1.05, h1: endH, speed: passSpeed(passer, true), rel: r + 0.04 };
    // 跳んで最高点付近から投げ下ろす（守備の手の上を越える）。跳ぶぶん構えが長い
    case "jump": return { h0: passer.standReach - 0.15 + passer.jumpH * 0.85, h1: 1.35, speed: vb * 0.9, rel: r + 0.28 };
  }
}

/** バウンズパスが床に着く時刻（飛行時間の割合） */
export const BOUNCE_AT = 0.62;

/** 飛行時間の割合 u でのボールの高さ（T = 飛行時間）。バウンズは床までと床からの2つの放物線 */
export function passHeight(style: PassStyle, h0: number, h1: number, u: number, T: number): number {
  const t = clamp(u, 0, 1) * T;
  if (style === "bounce") {
    const tb = BOUNCE_AT * T;
    return t < tb ? ballistic(h0, 0.12, t, tb) : ballistic(0.12, h1, t - tb, T - tb);
  }
  return ballistic(h0, h1, t, T);
}

/** 飛行時間の割合 u でのボールの上向きの速さ */
export function passVy(style: PassStyle, h0: number, h1: number, u: number, T: number): number {
  const t = clamp(u, 0, 1) * T;
  if (style === "bounce") {
    const tb = BOUNCE_AT * T;
    return t < tb ? ballisticVy(h0, 0.12, t, tb) : ballisticVy(0.12, h1, t - tb, T - tb);
  }
  return ballisticVy(h0, h1, t, T);
}

/** リリース点。side=±1 で左右どちらかの手から（目の前の守備者の手をよけて出す） */
export function releasePoint(passer: Player, target: V2, side: number): V2 {
  const dir = dirTo(passer.p, target);
  const perp = { x: -dir.z, z: dir.x };
  return madd(madd(passer.p, dir, 0.25), perp, side * 0.45);
}

/**
 * パス導線。ボールの通り道の各点で、守備者の手がその高さのボールに届く前にボールが通過するか。
 * 低いボール（バウンズ）はかがまないと届かず、高いボール（オーバーヘッド・ロブ）は背が高い/跳べる人しか届かない。
 * レシーバーの体は回り込みの障害物（後ろに居る守備者はパスを消せない）。
 */
export function passLane(c: LaneCtx, passer: Player, recv: Player, target: V2, style: PassStyle = "chest", side = 0, endH = 1.5): Lane {
  const sp = styleParams(passer, style, endH);
  const p0 = releasePoint(passer, target, side);
  const L = Math.max(0.1, dist(p0, target));
  // ロブは重力で山なりになる速さまで（速く投げると低く飛ぶ）
  if (style === "lob") sp.speed = Math.min(sp.speed, lobSpeed(L));
  // パスは上半身の前から真横までしか出せない: 上半身をひねる（足りなければ足も回す）時間ぶん構えが長い
  sp.rel += passer.passTurnTime(dirTo(passer.p, target));
  const lane = newLane(style === "lob" ? "lob" : "pass", passer, recv, [p0, target], target);
  lane.style = style;
  lane.side = side;
  lane.h0 = sp.h0;
  lane.T = sp.rel + L / sp.speed;
  lane.speed = sp.speed;
  lane.endH = sp.h1;
  scorePass(c, lane, passer, recv, target, p0, L, sp, style, timeToReach(recv, target, 0.35));
  return lane;
}

/**
 * 速いパス（チェスト・バウンズ・オーバーヘッド・ジャンプ）を出せる最低の距離 [m]。
 * これより近い相手には山なりのロブ（ゆっくりした柔らかいパス）しか出せない。
 * バウンズは床で弾ませる距離が要るので少し長い。手渡し（forcePass）はこの制限を受けない。
 */
export const PASS_MIN_DIST: Record<PassStyle, number> = { chest: 3.0, overhead: 3.0, jump: 3.0, bounce: 3.5, lob: 0 };

/** 種類と左右の手を試して、いちばん開くパス（近すぎる相手には速いパスを出せない＝ロブだけ） */
export function bestPassLane(c: LaneCtx, passer: Player, recv: Player, target: V2, coarse = false): Lane {
  const D = dist(passer.p, target);
  const tries: [PassStyle, number][] = coarse
    ? [["chest", 0], ["bounce", 0], ["overhead", 0], ["lob", 0]]
    : [["chest", 0], ["chest", 1], ["chest", -1], ["bounce", 0], ["bounce", 1], ["bounce", -1], ["overhead", 0], ["jump", 0], ["lob", 0]];
  let best: Lane | null = null;
  let fastest: Lane | null = null;
  for (const [st, sd] of tries) {
    if (D < PASS_MIN_DIST[st]) continue;
    // 立っている相手へのロブは頭の上（1.9m）で受けさせる
    const l = passLane(c, passer, recv, target, st, sd, st === "lob" ? 1.9 : 1.5);
    // 十分空いている（0.85以上）なら、いちばん早く届くパス（チェスト/オーバーハンド）で早く通す
    if (l.open >= 0.85 && st !== "lob" && (!fastest || l.T < fastest.T - 1e-3 || (Math.abs(l.T - fastest.T) <= 1e-3 && st === "chest"))) fastest = l;
    // そうでなければ守備の手をかわせる種類（余裕が大きいもの）。同じくらいならチェストを好む
    const pen = (x: PassStyle, side: number) => (x === "chest" ? 0 : x === "lob" ? 0.15 : 0.04) + (side === 0 ? 0 : 0.02);
    const sc = l.margin - pen(st, sd);
    const bs = best ? best.margin - pen(best.style, best.side) : -1e9;
    if (sc > bs) best = l;
  }
  return fastest ?? best!;
}

function scorePass(
  c: LaneCtx, lane: Lane, passer: Player, recv: Player, target: V2, p0: V2,
  L: number, sp: StyleP, style: PassStyle, recvArrive: number,
): void {
  const s0 = Math.min(0.5, 0.6 / L);
  const Tf = L / sp.speed;
  const obst: Obstacle[] = [{ p: recv.p, r: recv.radius, hold: 0.15 }, ...c.screens];
  let margin = 9;
  let closer: Player | null = null;
  for (const d of c.defs) {
    const antic = clamp(0.55 * n(d.a.defIQ) - 0.35 * n(passer.a.vision), 0, 0.55);
    const lag = d.reactT * (1 - antic);
    const va = defAt(c, d);
    for (let i = 0; i <= 7; i++) {
      const s = s0 + ((1 - s0) * i) / 7; // 水平に進んだ割合
      if (style === "lob" && s < 0.55) continue;
      const u = fracToU(s, L); // そこへ来る飛行時間の割合（空気抵抗で先ほど遅れる）
      // その点のボールの高さに、腕（跳べば跳躍ぶん／低ければかがんで）が届く水平距離
      const ballH = passHeight(style, sp.h0, sp.h1, u, Tf);
      let handR = d.handReachAt(ballH, true);
      let extra = 0;
      if (handR < 0 && ballH < d.shoulderY) { handR = d.handReachLow(ballH); extra = 0.15; }
      if (handR < 0) continue;
      const X = lerpV(p0, target, s);
      // 受け手の手前ではレシーバーの体が手を遮る
      const reachR = s > 0.9 ? Math.min(handR, 0.6) : handR + LUNGE_REACH * 0.8;
      const td = timeToReach(d, X, reachR, { lag, obstacles: obst, ...va }) + extra;
      const m = td - (sp.rel + u * Tf);
      if (m < margin) { margin = m; closer = d; }
    }
  }
  // レシーバーがボールより遅れて着くならボールが流れる
  const late = recvArrive - lane.T;
  if (late > 0) margin = Math.min(margin, 0.25 - late * 1.5);
  lane.margin = margin;
  lane.open = openOf(margin);
  lane.closer = closer;
}

/** τ秒で走れる距離 */
function runDist(tau: number, v0: number, vm: number, a: number): number {
  const v = Math.min(Math.max(0, v0), vm);
  const tAcc = (vm - v) / a;
  if (tau <= tAcc) return v * tau + 0.5 * a * tau * tau;
  return v * tAcc + 0.5 * a * tAcc * tAcc + vm * (tau - tAcc);
}

/**
 * 待ち合わせパス（リード／アリウープ）。レシーバーの予定経路 path 上の
 * 「τ秒後にいる点」へ、ボールが同じ時刻に着くように投げる。τ と種類（チェスト/バウンズ、またはロブ）を試して最も開くもの。
 */
export function leadLane(c: LaneCtx, passer: Player, recv: Player, path: V2[], lob: boolean, endH: number): Lane | null {
  const total = polyLen(path);
  if (total < 0.5) return null;
  const vr = recv.speedNow() * 0.95;
  const v0 = len(recv.v);
  // 走り込む先が近すぎれば速いパスは出せない → ロブ（ゆっくり）だけ
  const styles: PassStyle[] = lob ? ["lob"] : ["chest", "bounce", "lob"];
  let best: Lane | null = null;
  for (const tau of [0.55, 0.8, 1.05, 1.35, 1.7]) {
    const dRun = Math.min(total, runDist(tau, v0, vr, recv.accelMax));
    const R = alongPoly(path, dRun);
    const turn = passer.passTurnTime(dirTo(passer.p, R));
    for (const style of styles) {
      const Dr = dist(passer.p, R);
      if (Dr < PASS_MIN_DIST[style]) continue;
      // アリウープでないリードのロブは、速いパスが出せない近さのときだけ
      if (!lob && style === "lob" && Dr >= PASS_MIN_DIST.chest) continue;
      const sp = styleParams(passer, style, endH);
      sp.rel += turn;
      if (tau - sp.rel < 0.15) continue;
      const p0 = releasePoint(passer, R, 0);
      const L = Math.max(0.1, dist(p0, R));
      let vb = L / (tau - sp.rel);
      if (vb > sp.speed || (style === "lob" && vb > lobSpeed(L))) continue;
      const vmin = style === "lob" ? Math.min(4.5, lobSpeed(L)) : sp.speed * 0.55;
      if (vb < vmin) vb = vmin;
      const spv: StyleP = { ...sp, speed: vb };
      const lane = newLane(lob ? "lob" : "lead", passer, recv, [p0, R], R);
      lane.style = style;
      lane.h0 = sp.h0;
      lane.T = sp.rel + L / vb;
      lane.speed = vb;
      lane.endH = sp.h1;
      // レシーバーは経路どおり走って τ に着く（早く着きすぎる分は待てる）
      const recvArrive = dRun < total - 1e-6 ? tau : runTime(total, v0, vr, recv.accelMax);
      scorePass(c, lane, passer, recv, R, p0, L, spv, style, recvArrive);
      if (!best || lane.margin > best.margin + 0.02) best = lane;
    }
  }
  return best;
}

/**
 * ドリブル導線。ハンドラーが path を進むとき、各点に守備者が体を入れられるか。
 * 抜かれた守備者はハンドラーの体を回り込む必要がある。
 * t0 =走り出すまでの時間（パスを受けてから攻める場合はパスの飛行＋キャッチ）。
 * v0 を渡せば今の速度の代わりに使う（受けてから走り出すなら0）。
 */
export function driveLane(c: LaneCtx, h: Player, path: V2[], t0 = 0, v0in?: number): Lane {
  const lane = newLane("drive", h, null, path, path[path.length - 1]);
  const L = polyLen(path);
  const vh = h.speedNow();
  const dir0 = dirTo(path[0], path[Math.min(1, path.length - 1)]);
  const v0 = v0in ?? dot(h.v, dir0);
  const obst: Obstacle[] = [{ p: path[0], r: h.radius, hold: 0.05 }, ...c.screens];
  let margin = 9;
  let closer: Player | null = null;
  let freeD = L;
  const N = 8;
  for (let i = 0; i <= N; i++) {
    const dd = L * (0.08 + (0.92 * i) / N);
    const X = alongPoly(path, dd);
    const th = t0 + runTime(dd, v0, vh, h.accelMax);
    let mi = 9;
    for (const d of c.defs) {
      const reachR = d.radius + h.radius + 0.15;
      const td = timeToReach(d, X, reachR, { lag: d.reactT * 0.8, obstacles: obst, body: true, ...defAt(c, d) });
      const m = td - th;
      if (m < mi) mi = m;
      if (m < margin) { margin = m; closer = d; }
    }
    if (mi < -0.05 && freeD === L) freeD = Math.max(0, dd - L / N);
  }
  lane.T = t0 + runTime(L, v0, vh, h.accelMax);
  lane.margin = margin;
  lane.open = openOf(margin);
  lane.closer = closer;
  lane.freeD = freeD;
  return lane;
}

/**
 * ステップ導線（サイドステップ／ステップバック）の表示と開き。from→to へ T 秒でステップし、
 * 開き・消している守備者は着地してからの狙い（follow = シュート導線 or 突破の導線）のものを使う。
 */
export function stepLane(h: Player, from: V2, to: V2, T: number, follow: Lane): Lane {
  const lane = newLane("step", h, null, [from, to], to);
  lane.T = T;
  lane.margin = follow.margin;
  lane.open = follow.open;
  lane.closer = follow.closer;
  return lane;
}

/**
 * 押し込みドリブルの導線（ポストアップ）。ゴールに背を向け、マーク d を背中で押してゴール下（リムの手前1.3m）まで進む。
 * 進む速さは押し合いの物理（contact.ts）と同じ式: 押し勝ちの度合い net = (押す力h − 押す力d)/(和)、速さ = net × POST_PUSH_SPEED。
 * 構えは押し込む側0.9（仕掛ける有利つき）・守る側0.8で見積もる。ドリブルの上手さは使わない（体でボールを守るので取られにくい）。
 *   lane.open   = 押し進める度合い（速さ 0.6m/s で 1）。押し負けていれば 0（進めない・押し戻される）
 *   lane.margin = ゴール下に着く時刻までに、マーク以外の守備者（ヘルプ）がゴール下へ寄れる余裕（決めの難しさに使う）
 *   lane.speed  = 進む速さ（負なら押し戻される）、lane.T = 着いて振り向くまでの時間
 */
export function postLane(c: LaneCtx, h: Player, d: Player): Lane {
  const toRim = dirTo(h.p, RIM);
  const fin = madd(RIM, dirTo(RIM, h.p), 1.3);
  const lane = newLane("post", h, null, [h.p, fin], fin);
  const Fa = pushPower(h, 0.9, true), Fb = pushPower(d, 0.8, false);
  const net = (Fa - Fb) / (Fa + Fb);
  const v = net * POST_PUSH_SPEED;
  lane.speed = v;
  lane.closer = d;
  const D = Math.max(0, dist(h.p, fin));
  // マークがリングとの間に居なければ押し込みにならない（T<0 = 使えない）
  if (dot(toRim, dirTo(h.p, d.p)) < 0.2) {
    lane.margin = -1;
    lane.open = 0;
    lane.T = -1;
    return lane;
  }
  // 押し進められない（互角以下）ときも試すことはできる（open 0、着くまでの時間は長い見込み）
  lane.T = D / Math.max(0.15, v) + 0.3; // 押し込む時間＋振り向いて打つまで
  let margin = 9;
  for (const x of c.defs) {
    if (x === d) continue;
    const m = timeToReach(x, fin, 0.9, { lag: x.reactT, ...defAt(c, x) }) - lane.T;
    if (m < margin) { margin = m; lane.closer = x; }
  }
  lane.margin = margin;
  lane.open = sat(v / 0.6);
  lane.freeD = D;
  return lane;
}

/**
 * シュート導線。シューターがリリースするまで（preT=パスの飛行時間＋rel）に
 * 守備者が手を届かせられるか。リム付近はリムプロテクターの高さも効く。
 */
export function shotLane(c: LaneCtx, s: Player, from: V2, preT: number, rel: number, relH?: number): Lane {
  // リリースの高さ（跳ばないセットシュートは低い＝届かれやすい）
  const sh = relH ?? s.reachMax;
  const lane = newLane("shot", s, null, [from, RIM], RIM);
  const tShot = preT + rel;
  const near = distRim(from) < 2.8;
  const rimPt = madd(RIM, dirTo(RIM, from), 0.7);
  let margin = 9;
  let closer: Player | null = null;
  for (const d of c.defs) {
    const va = defAt(c, d);
    const lag = preT > 0 ? d.reactT * 0.6 : d.reactT;
    const contestR = clamp(1.0 + (d.reachMax - sh) * 0.6, 0.6, 1.5);
    let m = timeToReach(d, from, contestR, { lag, obstacles: c.screens, stop: preT > 0, ...va }) - tShot;
    if (near) {
      // リムの前で待つブロッカー。背が低ければ遅れたのと同じ
      const short = Math.max(0, sh - d.reachMax - 0.1) * 0.8;
      const mr = timeToReach(d, rimPt, 0.9, { lag, obstacles: c.screens, ...va }) + short - (tShot + 0.12);
      m = Math.min(m, mr);
    }
    if (m < margin) { margin = m; closer = d; }
  }
  lane.T = tShot;
  lane.margin = margin;
  lane.open = openOf(margin);
  lane.closer = closer;
  return lane;
}
