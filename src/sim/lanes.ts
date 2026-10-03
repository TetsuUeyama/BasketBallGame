// 導線(lane)。すべて「攻撃側が着く時刻」と「守備者が届かせる時刻」の差（余裕 margin）で開閉が決まる。
//   margin > 0 … 攻撃が先に着く（導線が通っている）
//   margin < 0 … 守備が先に届く（導線が消されている）
import { n } from "./attrs";
import { RIM, distRim } from "./court";
import { passRelease, passSpeed } from "./eval";
import { V2, alongPoly, clamp, dirTo, dist, dot, len, lerp, lerpV, madd, polyLen, sat } from "./math";
import { Player } from "./player";
import { Obstacle, runTime, timeToReach } from "./reach";

export type LaneKind = "pass" | "lead" | "lob" | "drive" | "shot";

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
}

function defAt(c: LaneCtx, d: Player): { at?: V2; still?: boolean } {
  const at = c.virt?.get(d);
  return at ? { at, still: true } : {};
}

/** ロブの高さの形 */
export function lobHeight(h0: number, h1: number, s: number, L: number): number {
  const apex = 0.6 + 0.12 * L;
  return lerp(h0, h1, s) + 4 * apex * s * (1 - s);
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

/** バウンズパスが床に着く位置（飛行の割合） */
export const BOUNCE_AT = 0.62;

/** 飛行の割合 s でのボールの高さ */
export function passHeight(style: PassStyle, h0: number, h1: number, s: number, L: number): number {
  if (style === "lob") return lobHeight(h0, h1, s, L);
  if (style === "bounce") return s < BOUNCE_AT ? lerp(h0, 0.12, s / BOUNCE_AT) : lerp(0.12, h1, (s - BOUNCE_AT) / (1 - BOUNCE_AT));
  return lerp(h0, h1, s);
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

/** 種類と左右の手を試して、いちばん開くパス */
export function bestPassLane(c: LaneCtx, passer: Player, recv: Player, target: V2, coarse = false): Lane {
  const tries: [PassStyle, number][] = coarse
    ? [["chest", 0], ["bounce", 0], ["overhead", 0], ["lob", 0]]
    : [["chest", 0], ["chest", 1], ["chest", -1], ["bounce", 0], ["bounce", 1], ["bounce", -1], ["overhead", 0], ["jump", 0], ["lob", 0]];
  let best: Lane | null = null;
  let fastest: Lane | null = null;
  for (const [st, sd] of tries) {
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
  const obst: Obstacle[] = [{ p: recv.p, r: recv.radius, hold: 0.15 }, ...c.screens];
  let margin = 9;
  let closer: Player | null = null;
  for (const d of c.defs) {
    const antic = clamp(0.55 * n(d.a.defIQ) - 0.35 * n(passer.a.vision), 0, 0.55);
    const lag = d.reactT * (1 - antic);
    const va = defAt(c, d);
    for (let i = 0; i <= 7; i++) {
      const s = s0 + ((1 - s0) * i) / 7;
      if (style === "lob" && s < 0.55) continue;
      // その点のボールの高さに、腕（跳べば跳躍ぶん／低ければかがんで）が届く水平距離
      const ballH = passHeight(style, sp.h0, sp.h1, s, L);
      let handR = d.handReachAt(ballH, true);
      let extra = 0;
      if (handR < 0 && ballH < d.shoulderY) { handR = d.handReachLow(ballH); extra = 0.15; }
      if (handR < 0) continue;
      const X = lerpV(p0, target, s);
      // 受け手の手前ではレシーバーの体が手を遮る
      const reachR = s > 0.9 ? Math.min(handR, 0.6) : handR + LUNGE_REACH * 0.8;
      const td = timeToReach(d, X, reachR, { lag, obstacles: obst, ...va }) + extra;
      const m = td - (sp.rel + (s * L) / sp.speed);
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
  const styles: PassStyle[] = lob ? ["lob"] : ["chest", "bounce"];
  let best: Lane | null = null;
  for (const tau of [0.55, 0.8, 1.05, 1.35, 1.7]) {
    const dRun = Math.min(total, runDist(tau, v0, vr, recv.accelMax));
    const R = alongPoly(path, dRun);
    for (const style of styles) {
      const sp = styleParams(passer, style, endH);
      if (tau - sp.rel < 0.15) continue;
      const p0 = releasePoint(passer, R, 0);
      const L = Math.max(0.1, dist(p0, R));
      let vb = L / (tau - sp.rel);
      if (vb > sp.speed) continue;
      const vmin = lob ? 4.5 : sp.speed * 0.55;
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
