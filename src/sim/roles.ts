// ポジションごとのオフボールの役割。持ち場の候補・カットの頻度・ドライブへの反応を決める。
//   guard   … PG/SG。外周（トップ/スロット/ウイング）。ドライブにはリフト/ドリフト。カットは控えめ
//   wing    … SF。ウイング/コーナー。カッター（バックドア・ベースカット）
//   stretch … 撃てるPF/C。スロット/ウイング/コーナー/エルボー。スクリーンからポップ
//   big     … 撃てないPF/C。ダンカー/ショートコーナー/ハイポスト。ペイントの真ん中には居座らない
import { RIM, SPOT, distRim } from "./court";
import { V2, dist } from "./math";
import { Player } from "./player";

export type OffRole = "guard" | "wing" | "stretch" | "big";

export function offRole(p: Player): OffRole {
  switch (p.d.pos) {
    case "PG":
    case "SG": return "guard";
    case "SF": return "wing";
    case "PF": return p.a.three >= 60 ? "stretch" : "big";
    default: return p.a.three >= 65 ? "stretch" : "big";
  }
}

export const ROLE_LABEL: Record<OffRole, string> = { guard: "ガード", wing: "ウイング", stretch: "ストレッチ", big: "ビッグ" };

/** カットの起こしやすさ */
export const CUT_RATE: Record<OffRole, number> = { guard: 0.45, wing: 1.0, stretch: 0.35, big: 0 };

/** 役割ごとの持ち場の候補（ハンドラーの近くは除く＝ハンドラーの周りを空ける） */
export function roleSpots(role: OffRole, h: V2 | null): V2[] {
  let c: V2[];
  switch (role) {
    case "guard":
      c = [SPOT.top(), SPOT.slot(1), SPOT.slot(-1), SPOT.wing(1), SPOT.wing(-1), SPOT.corner(1), SPOT.corner(-1)];
      break;
    case "wing":
      c = [SPOT.wing(1), SPOT.wing(-1), SPOT.corner(1), SPOT.corner(-1), SPOT.slot(1), SPOT.slot(-1)];
      break;
    case "stretch":
      c = [SPOT.slot(1), SPOT.slot(-1), SPOT.wing(1), SPOT.wing(-1), SPOT.corner(1), SPOT.corner(-1), SPOT.elbow(1), SPOT.elbow(-1)];
      break;
    case "big":
      c = [SPOT.dunker(1), SPOT.dunker(-1), SPOT.shortCorner(1), SPOT.shortCorner(-1)];
      // ボールが外にあればハイポストも
      if (!h || distRim(h) > 6.5) c.push(SPOT.elbow(1), SPOT.elbow(-1));
      break;
  }
  return h ? c.filter((q) => dist(q, h) > 3.2) : c;
}

/** ゴール下の混雑（リムの前 2.6m 以内にいる人数） */
export function rimCrowd(ps: Player[], ex: Player | null): number {
  let k = 0;
  for (const p of ps) if (p !== ex && dist(p.p, RIM) < 2.6) k++;
  return k;
}
