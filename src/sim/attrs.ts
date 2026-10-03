// 能力値（0..100、身長[m]と体重[kg]を除く）とロスター生成
import { Rng, clamp } from "./math";

export type Pos = "PG" | "SG" | "SF" | "PF" | "C";
export const POSITIONS: Pos[] = ["PG", "SG", "SF", "PF", "C"];

export interface Attrs {
  height: number;
  weight: number;
  // 身体
  speed: number;     // 最高速
  accel: number;     // 加速
  agility: number;   // 切り返し・旋回
  strength: number;  // 押し合い
  balance: number;   // 重心の強さ（支持円・戻り）
  vertical: number;  // 跳躍
  // 攻撃
  handle: number;    // ドリブル（ムーブの切れ・ボール保護）
  passing: number;   // パスの速さと正確さ
  vision: number;    // 視野（ノールック＝守備の先読みを外す）
  finish: number;    // リム周り
  mid: number;       // ミドル
  three: number;     // 3P
  release: number;   // リリースの速さ
  offIQ: number;     // 判断・オフボールの動き
  screen: number;    // スクリーンの硬さ
  // 守備
  perD: number;      // 外の1on1守備（横の動き・構え）
  intD: number;      // リム守備
  reaction: number;  // 反応の速さ（＝相手を見る遅れ）
  defIQ: number;     // 読み（フェイクに掛からない・コール読み）
  steal: number;
  block: number;
  rebound: number;
}

export interface PlayerDef {
  name: string;
  num: number;
  pos: Pos;
  a: Attrs;
}

type Tmpl = Omit<Attrs, "height" | "weight"> & { h: number; w: number };

// ポジションごとの平均像。ばらつきは makeTeam で足す。
const TEMPLATE: Record<Pos, Tmpl> = {
  PG: { h: 1.88, w: 84, speed: 82, accel: 84, agility: 84, strength: 52, balance: 70, vertical: 62,
    handle: 86, passing: 84, vision: 80, finish: 62, mid: 68, three: 72, release: 72, offIQ: 78, screen: 35,
    perD: 70, intD: 35, reaction: 74, defIQ: 68, steal: 70, block: 25, rebound: 38 },
  SG: { h: 1.95, w: 90, speed: 78, accel: 78, agility: 78, strength: 58, balance: 66, vertical: 68,
    handle: 74, passing: 66, vision: 64, finish: 66, mid: 72, three: 80, release: 78, offIQ: 70, screen: 40,
    perD: 70, intD: 40, reaction: 70, defIQ: 64, steal: 62, block: 32, rebound: 44 },
  SF: { h: 2.01, w: 98, speed: 72, accel: 72, agility: 70, strength: 66, balance: 68, vertical: 70,
    handle: 64, passing: 60, vision: 60, finish: 70, mid: 66, three: 68, release: 66, offIQ: 66, screen: 52,
    perD: 70, intD: 55, reaction: 66, defIQ: 66, steal: 56, block: 48, rebound: 56 },
  PF: { h: 2.06, w: 106, speed: 64, accel: 62, agility: 60, strength: 76, balance: 72, vertical: 66,
    handle: 48, passing: 54, vision: 54, finish: 74, mid: 58, three: 56, release: 56, offIQ: 62, screen: 72,
    perD: 56, intD: 70, reaction: 60, defIQ: 64, steal: 44, block: 62, rebound: 72 },
  C: { h: 2.12, w: 114, speed: 56, accel: 54, agility: 50, strength: 84, balance: 76, vertical: 64,
    handle: 36, passing: 50, vision: 50, finish: 80, mid: 44, three: 30, release: 44, offIQ: 58, screen: 84,
    perD: 42, intD: 82, reaction: 56, defIQ: 66, steal: 36, block: 78, rebound: 82 },
};

const FIRST = ["カイ", "リク", "ソラ", "ハル", "ユウ", "レン", "ジン", "タク", "ケン", "ショウ", "ダイ", "ミナト", "ナギ", "トウマ", "アキ", "ルイ"];
const LAST = ["サトウ", "タナカ", "ワタナベ", "ナカムラ", "コバヤシ", "カトウ", "ヨシダ", "ヤマダ", "イノウエ", "キムラ", "ハヤシ", "シミズ", "モリ", "イケダ", "ハシモト", "アベ"];

export function makeTeam(rng: Rng): PlayerDef[] {
  const nums = new Set<number>();
  return POSITIONS.map((pos) => {
    const t = TEMPLATE[pos];
    const jit = (v: number, s = 9) => clamp(Math.round(v + (rng.next() + rng.next() + rng.next() - 1.5) * s * 1.2), 15, 99);
    const a: Attrs = {
      height: Math.round((t.h + (rng.next() - 0.5) * 0.1) * 100) / 100,
      weight: Math.round(t.w + (rng.next() - 0.5) * 12),
      speed: jit(t.speed), accel: jit(t.accel), agility: jit(t.agility), strength: jit(t.strength),
      balance: jit(t.balance), vertical: jit(t.vertical), handle: jit(t.handle), passing: jit(t.passing),
      vision: jit(t.vision), finish: jit(t.finish), mid: jit(t.mid), three: jit(t.three), release: jit(t.release),
      offIQ: jit(t.offIQ), screen: jit(t.screen), perD: jit(t.perD), intD: jit(t.intD), reaction: jit(t.reaction),
      defIQ: jit(t.defIQ), steal: jit(t.steal), block: jit(t.block), rebound: jit(t.rebound),
    };
    let num = rng.int(0, 35);
    while (nums.has(num)) num = (num + 7) % 55;
    nums.add(num);
    return { name: `${rng.pick(LAST)} ${rng.pick(FIRST)}`, num, pos, a };
  });
}

/** 0..100 → 0..1 */
export const n = (v: number): number => v / 100;
