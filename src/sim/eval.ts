// シュートの成功率・リリース時間・ポゼッションの継続価値
import { n } from "./attrs";
import { COURT, RIM, distRim, isThree } from "./court";
import { V2, dirTo, madd, sat } from "./math";
import { Player } from "./player";

export type ShotKind = "rim" | "close" | "mid" | "three";

export interface ShotBase {
  p: number;
  pts: number;
  kind: ShotKind;
  dunk: boolean;
}

export function shotBase(s: Player, from: V2): ShotBase {
  const d = distRim(from);
  if (isThree(from)) {
    // 射程 = 7.5m + 3P能力×1.3m（平均的な選手で約8.4m）。超えると1mごとに約1/3ずつ急に下がる
    const range = 7.5 + 1.3 * n(s.a.three);
    let p = 0.2 + 0.2 * n(s.a.three) - 0.03 * Math.max(0, d - 7.3);
    if (d > range) p *= Math.exp(-1.1 * (d - range));
    return { p: Math.max(0, p), pts: 3, kind: "three", dunk: false };
  }
  if (d < 1.6) {
    const dunk = s.reachMax >= 3.32 && d < 1.3;
    return { p: 0.48 + 0.28 * n(s.a.finish) + (dunk ? 0.12 : 0), pts: 2, kind: "rim", dunk };
  }
  if (d < 3.2) {
    return { p: 0.36 + 0.24 * n((s.a.finish + s.a.mid) / 2) - 0.03 * (d - 1.6), pts: 2, kind: "close", dunk: false };
  }
  return { p: 0.3 + 0.22 * n(s.a.mid) - 0.015 * (d - 3.2), pts: 2, kind: "mid", dunk: false };
}

/** 導線の開き(0..1) → 成功率に掛ける係数 */
export function contestFactor(kind: ShotKind, open: number): number {
  // リム周りは体を当てられても決め切れる（ブロックは手が触れたときの判定で別に起きる）
  return kind === "rim" ? 0.62 + 0.38 * open : 0.42 + 0.58 * open;
}

export function pMake(s: Player, from: V2, open: number): number {
  const b = shotBase(s, from);
  return sat(b.p * contestFactor(b.kind, open));
}

export function shotEV(s: Player, from: V2, open: number): number {
  return pMake(s, from, open) * shotBase(s, from).pts;
}

export type ShotType = "dunk" | "layup" | "floater" | "jumper" | "set";
export const SHOT_LABEL: Record<ShotType, string> = {
  dunk: "ダンク", layup: "レイアップ", floater: "フローター", jumper: "ジャンプシュート", set: "セットシュート（跳ばない）",
};

/**
 * 打ち方を選ぶ。リム下: 届けばダンク・届かなければレイアップ／近距離: 守備が近ければフローター／
 * ミドル・3P: 空いていれば跳ばないセットシュート（安定）、詰められていればジャンプシュート（高いリリース）。
 */
export function chooseShotType(s: Player, from: V2, open: number): ShotType {
  const d = distRim(from);
  if (d < 1.7) return s.reachMax >= 3.28 && open > 0.3 ? "dunk" : "layup";
  if (d < 3.4) return open < 0.6 ? "floater" : "jumper";
  return open >= 0.7 || n(s.a.vertical) < 0.35 ? "set" : "jumper";
}

/** 打ち方ごとのリリースの高さ（守備の手が届くかに効く） */
export function releaseHeight(s: Player, t: ShotType): number {
  switch (t) {
    case "dunk": return COURT.rimH + 0.15;
    case "layup": return s.standReach + s.jumpH * 0.85;
    case "floater": return s.standReach + s.jumpH * 0.5;
    case "jumper": return s.standReach + s.jumpH * 0.9 - 0.1;
    case "set": return s.standReach - 0.05;
  }
}

/** 打ち方ごとの構えてから離すまで */
export function shotTypeRel(s: Player, from: V2, catchShoot: boolean, t: ShotType): number {
  switch (t) {
    case "dunk": return 0.38;
    case "layup": return 0.34;
    case "floater": return 0.36;
    case "jumper": return releaseTime(s, from, catchShoot);
    case "set": return releaseTime(s, from, catchShoot) - 0.04;
  }
}

/** 打ち方ごとの成功率 */
export function pMakeType(s: Player, from: V2, open: number, t: ShotType): number {
  const b = shotBase(s, from);
  const d = distRim(from);
  switch (t) {
    case "dunk": return sat((0.86 + 0.1 * n(s.a.finish)) * (0.75 + 0.25 * open));
    case "layup": return sat((0.48 + 0.28 * n(s.a.finish)) * (0.62 + 0.38 * open));
    case "floater": return sat((0.36 + 0.26 * n((s.a.finish + s.a.mid) / 2) - 0.03 * Math.max(0, d - 1.6)) * (0.55 + 0.45 * open));
    case "jumper": return sat(b.p * contestFactor(b.kind, open));
    case "set": return sat(b.p * 1.04 * contestFactor(b.kind, open));
  }
}

/** 構えてから離すまで [s] */
export function releaseTime(s: Player, from: V2, catchShoot: boolean): number {
  if (distRim(from) < 1.8) return 0.3;
  return (catchShoot ? 0.5 : 0.62) - 0.18 * n(s.a.release);
}

/** ショットクロックに応じた「今撃たずに続けた場合」の期待値 */
export function contValue(shotClock: number): number {
  return 0.95 * Math.sqrt(sat((shotClock - 1.5) / 14));
}

/**
 * その選手が持っているときの攻撃の作りやすさ（0.62〜1.0）。
 * ドリブルが苦手なビッグが持ち続けても攻撃は進まない＝持ち続ける価値が低い。
 */
export function creatorK(p: Player): number {
  return 0.62 + 0.38 * (0.5 * n(p.a.handle) + 0.25 * n(p.a.passing) + 0.25 * n(p.a.speed));
}

/** 持ち続ける価値: 継続価値 × 持っている人の作りやすさ × 持ちすぎの減衰（1.5秒を超えると守備が整っていく） */
export function holdValue(p: Player, C: number, holdT: number): number {
  return C * creatorK(p) * (1 - Math.min(0.3, Math.max(0, holdT - 1.5) * 0.12));
}

/** レイアップを打つ地点（リムの手前） */
export function finishPoint(from: V2): V2 {
  return madd(RIM, dirTo(RIM, from), 0.9);
}

export const passRelease = (p: Player): number => 0.24 - 0.1 * n(p.a.passing);
export const passSpeed = (p: Player, lob: boolean): number => (lob ? 6.5 + 2 * n(p.a.passing) : 9 + 5 * n(p.a.passing));
