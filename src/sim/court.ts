// コート寸法（FIBA）。フルコート: Z=−14〜+14（センターライン0）。
// sim は「攻撃側の座標」で持つ: 今の攻撃は常に +Z のゴール（RIM）へ攻め、−Z のゴールは自陣。
// 攻守が替わったら全員とボールをコート中心で180°回した座標に置き換え（Game.flipFrame）、描画は逆に回して表示する。
// X=幅(±7.5) / Y=上
import { V, V2, dist, clamp } from "./math";

export const COURT = {
  halfW: 7.5,
  midZ: 0,
  baseZ: 14,
  rimH: 3.05,
  rimR: 0.225,
  threeR: 6.75,
  cornerX: 6.6,
  paintHalfW: 2.45,
  ftZ: 14 - 5.8,
  raR: 1.25,
  boardZ: 14 - 1.2,
};
export const RIM: V2 = V(0, 14 - 1.575);
/** 3Pのコーナー直線部とアークの継ぎ目のZ */
export const CORNER_Z = RIM.z - Math.sqrt(COURT.threeR ** 2 - COURT.cornerX ** 2);

export const distRim = (p: V2): number => dist(p, RIM);

export function isThree(p: V2): boolean {
  if (p.z > CORNER_Z) return Math.abs(p.x) > COURT.cornerX;
  return distRim(p) > COURT.threeR;
}

/** 目標地点をコート内へ収める（位置ではなく「行き先」だけに使う） */
export function inCourt(p: V2, margin = 0.35): V2 {
  return V(
    clamp(p.x, -COURT.halfW + margin, COURT.halfW - margin),
    clamp(p.z, -COURT.baseZ + margin, COURT.baseZ - margin),
  );
}

/** ラインの外（ライン上も外。半径 r ぶん外へ出たら） */
export const outOfBounds = (p: V2, r = 0): boolean =>
  Math.abs(p.x) > COURT.halfW + r || Math.abs(p.z) > COURT.baseZ + r;

/** ネット: リムから下へ長さ len、下の口の半径 rBottom（ボールの半径0.12よりやや小さい） */
export const NET = { len: 0.45, rBottom: 0.06 };
/** 網の細まり方の指数（1=まっすぐな円すい。小さいほど上の方から早く細くなる） */
export const NET_TAPER = 0.6;

/** 網の半径（伸びを含まない）。u = リムからの深さの割合 0（リム）..1（下の口） */
export function netProfile(u: number): number {
  const k = Math.pow(Math.min(1, Math.max(0, u)), NET_TAPER);
  return COURT.rimR + (NET.rBottom - COURT.rimR) * k;
}
/** 網がボールに押されて広がれる量 [m]（下の口 0.06 + 0.05 はボール 0.12 より細い＝擦れて絞られながら真ん中を抜ける） */
export const NET_STRETCH = 0.05;

/** リムの面から depth [m] 下での網の半径（伸びを含む）。0..NET.len の外は -1 */
export function netRadiusAt(depth: number): number {
  if (depth < 0 || depth > NET.len) return -1;
  return netProfile(depth / NET.len) + NET_STRETCH;
}
export const BALL_R = 0.12;
/** ボールの質量 [kg] */
export const BALL_MASS = 0.62;

/** バックボード（前面 z=BOARD.z、厚さ depth、下端 y0 〜 上端 y1、幅 ±halfW） */
export const BOARD = { z: 14 - 1.2, depth: 0.05, y0: 2.9, y1: 3.95, halfW: 0.9 };

/** 外に出た地点から、スローインする地点（ラインのすぐ外） */
export function throwInSpot(p: V2): V2 {
  const W = COURT.halfW;
  if (Math.abs(p.z) > COURT.baseZ) {
    const sz = p.z >= 0 ? 1 : -1;
    let x = clamp(p.x, -W + 0.6, W - 0.6);
    if (Math.abs(x) < 1.3) x = (x >= 0 ? 1 : -1) * 1.3; // ゴールの真後ろは避ける
    return V(x, sz * (COURT.baseZ + 0.45));
  }
  const sx = p.x >= 0 ? 1 : -1;
  return V(sx * (W + 0.45), clamp(p.z, -COURT.baseZ + 0.6, COURT.baseZ - 0.6));
}

/** 得点のあと: 決められた側がスローインする自陣エンドライン（今の攻撃の座標では +Z 側の外） */
export function baselineInbound(side: number): V2 {
  return V(1.5 * side, COURT.baseZ + 0.45);
}

/**
 * 定位置。side=+1 は x>0 側、-1 は x<0 側。
 * 3Pのスポットはラインの0.4〜0.8m外。
 */
export const SPOT = {
  top: (): V2 => V(0, RIM.z - 7.45),
  slot: (s: number): V2 => V(3.1 * s, RIM.z - 6.85),
  wing: (s: number): V2 => V(5.35 * s, RIM.z - 5.15),
  corner: (s: number): V2 => V(6.95 * s, 13.25),
  elbow: (s: number): V2 => V(2.45 * s, COURT.ftZ + 0.1),
  block: (s: number): V2 => V(2.15 * s, RIM.z - 0.1),
  dunker: (s: number): V2 => V(3.25 * s, 13.35),
  shortCorner: (s: number): V2 => V(4.6 * s, 12.9),
  rimFront: (): V2 => V(0, RIM.z - 1.1),
  check: (): V2 => V(0, 2.2),
};

/** 外周（3Pの外）のスポット一覧。リロケート候補 */
export function perimeterSpots(): V2[] {
  return [SPOT.top(), SPOT.slot(1), SPOT.slot(-1), SPOT.wing(1), SPOT.wing(-1), SPOT.corner(1), SPOT.corner(-1)];
}
