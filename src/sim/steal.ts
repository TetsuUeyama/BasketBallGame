// パスへのスティール。パスの導線に対して「ダッシュ → 腕を伸ばして飛び込む(ランジ) → 弾く/確保」。
// 空振りすれば重心が前へ流れて立て直しが要る（ギャンブルの代償）。
import { n } from "./attrs";
import { LUNGE_REACH, PassStyle, passHeight } from "./lanes";
import { V2, clamp, lerpV } from "./math";
import { Player } from "./player";
import { timeToReach } from "./reach";

export { LUNGE_REACH };

export interface BallPath {
  p0: V2;
  p1: V2;
  h0: number;
  h1: number;
  style: PassStyle;
  L: number;
  /** 飛行時間 */
  T: number;
  /** 飛行の経過（投げる前なら0） */
  t: number;
  /** 投げるまでの残り時間（構え中） */
  wait: number;
}

export interface Intercept {
  X: V2;
  h: number;
  /** 余裕（守備が先に着く秒数） */
  margin: number;
  /** ボールがその点に来るまでの時間 */
  tb: number;
}

/** ボールの通り道で、ボールより先に手を届かせられる最も早い点 */
export function planIntercept(d: Player, b: BallPath, lag: number): Intercept | null {
  const s0 = b.t / b.T;
  for (let i = 1; i <= 12; i++) {
    const s = s0 + (1 - s0) * (i / 12);
    if (s < 0.12) continue;
    const h = passHeight(b.style, b.h0, b.h1, s, b.L);
    let r = d.handReachAt(h, true);
    let extra = 0;
    if (r < 0 && h < d.shoulderY) { r = d.handReachLow(h); extra = 0.15; }
    if (r < 0) continue;
    const X = lerpV(b.p0, b.p1, s);
    const tb = b.wait + s * b.T - b.t;
    const td = timeToReach(d, X, r + LUNGE_REACH * 0.8) + lag + extra;
    if (td < tb - 0.02) return { X, h, margin: tb - td, tb };
  }
  return null;
}

/** 取りに行くか（ギャンブル）。余裕が大きいほど・スティール能力が高いほど行く */
export function willGamble(d: Player, ic: Intercept, rnd: number): boolean {
  const p = clamp(0.15 + 0.55 * n(d.a.steal) + ic.margin * 1.6, 0, 0.95);
  return rnd < p;
}

