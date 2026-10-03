// チームの見た目（色・エンブレム）と、会場のロゴの置き場（スロット）に何を出すか。
// エンブレム画像は public/ 以下に置いて URL で指定する（例: public/emblems/red.png → "emblems/red.png"）。
// 画像を指定しなければ、チーム色と名前からエンブレムを描く。
import { Color3 } from "@babylonjs/core";

export interface TeamBrand {
  /** 表示名（未指定なら Game.names） */
  name?: string;
  /** チーム色（選手の円柱・ベンチの椅子・エンブレムの地） */
  color: Color3;
  /** 2色目（エンブレムの縁と文字） */
  accent: Color3;
  /** エンブレム画像の URL（public/ からの相対）。未指定なら色と名前から描く */
  emblem?: string;
}

export const TEAMS: [TeamBrand, TeamBrand] = [
  { color: new Color3(0.86, 0.26, 0.22), accent: new Color3(1, 0.93, 0.8) },
  { color: new Color3(0.2, 0.45, 0.92), accent: new Color3(0.9, 0.95, 1) },
];

/**
 * ロゴの置き場。
 *  WALL      : エンド側の壁の大型エンブレム（モデルの元ロゴ）
 *  AD1..AD4  : 記録席側の広告板（−Z 側から順に。モデルの元ロゴ）
 *  BOARD_NEGZ / BOARD_POSZ : バックボード上端の帯（表示の −Z / +Z のゴール）
 *  CENTER    : センターサークルの床
 */
export type LogoSlot = "WALL" | "AD1" | "AD2" | "AD3" | "AD4" | "BOARD_NEGZ" | "BOARD_POSZ" | "CENTER";

/**
 * スロットに出すもの。
 *  { team: 0|1 }      : そのチームのエンブレム
 *  { side: -1|1 }     : 表示の −Z / +Z 側にベンチがあるチームのエンブレム（攻める向きから決まる）
 *  { image: url }     : 任意の画像（スポンサー等）
 *  { text: "..." }    : 文字だけ
 */
export type LogoContent =
  | { team: 0 | 1 }
  | { side: -1 | 1 }
  | { image: string; bg?: string }
  | { text: string; color?: string; bg?: string };

export const LOGO_SLOTS: Record<LogoSlot, LogoContent> = {
  WALL: { team: 0 },
  AD1: { side: -1 },
  AD2: { side: -1 },
  AD3: { side: 1 },
  AD4: { side: 1 },
  BOARD_NEGZ: { side: -1 },
  BOARD_POSZ: { side: 1 },
  CENTER: { team: 0 },
};
