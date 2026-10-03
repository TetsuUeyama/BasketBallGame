// 到達時間。導線の開閉はすべて「守備者がその点に手(体)を届かせる時刻」と
// 「攻撃側(ボール/ハンドラー)がそこへ着く時刻」の比較で決まる。
import { n } from "./attrs";
import { V2, angleBetween, closestT, dist, dot, len, lerpV, norm, sub } from "./math";
import { Player } from "./player";

/** 初速 v0（目標方向の成分、負もあり）から距離 d を走る時間（加速 a・上限 vm） */
export function runTime(d: number, v0: number, vm: number, a: number): number {
  if (d <= 0) return 0;
  const v = Math.min(v0, vm);
  const dAcc = (vm * vm - v * v) / (2 * a);
  if (d <= dAcc) return (-v + Math.sqrt(Math.max(0, v * v + 2 * a * d))) / a;
  return (vm - v) / a + (d - dAcc) / vm;
}

/** 体が経路の障害になる相手（スクリーナー・レシーバー・抜いたハンドラー） */
export interface Obstacle {
  p: V2;
  r: number;
  /** 回り込みに加える固定時間（セットしたスクリーンは「当たって抜ける」ぶん重い） */
  hold: number;
}

export interface ReachOpt {
  /** 反応の遅れを足すか（動き出しを見てから） */
  lag?: number;
  obstacles?: Obstacle[];
  /** 到着して止まる（クローズアウト）。全速のまま着いても手は出せないので減速の時間を足す */
  stop?: boolean;
  /** 仮想位置（守備の最適化で「ここに居たら」を評価する） */
  at?: V2;
  /** 仮想位置での評価では速度0・構え0.6とみなす */
  still?: boolean;
  /**
   * 体で進路をふさぐ評価（ドライブ）。その場に居ても、跳んでいる／崩れているなら着地・立て直しまでふさげない。
   * （手で届けばよいシュートのコンテストやパスカットは、空中でも手は出せるので付けない）
   */
  body?: boolean;
}

/**
 * 選手 pl が点 q から reachR 以内に入るまでの時間。
 * 既に入っていれば 0（遅れも足さない＝そこに立っているだけで消せる）。
 */
export function timeToReach(pl: Player, q: V2, reachR: number, o: ReachOpt = {}): number {
  if (pl.fallen && !o.still) return pl.fallT + 0.5 + timeToReachPlain(pl, q, reachR);
  const from = o.at ?? pl.p;
  const d0 = dist(from, q);
  let d = d0 - reachR;
  if (d <= 0) {
    if (o.body && !o.still) {
      let pen = 0;
      if (pl.bal.off) pen += recoverTime(pl);
      if (pl.airborne) pen += pl.airT + 0.1 + 0.3;
      else if (pl.landT > 0) pen += pl.landT * 0.8;
      return pen;
    }
    return 0;
  }
  const dir = norm(sub(q, from));
  const v0 = o.still ? 0 : dot(pl.v, dir);
  const stance = o.still ? 0.6 : pl.stance;
  let vm = pl.maxSpeed * (1 - 0.3 * stance);
  let t = 0;
  if (d < 1.6) {
    // 近ければ向きを変えずに滑る
    vm *= 0.72 + 0.12 * stance;
  } else {
    // 遠ければ向き直って走る（向き直りの時間）
    const f = o.still ? dir : pl.f;
    const ang = Math.abs(angleBetween(f, dir));
    t += (ang / (6 + 7 * n(pl.a.agility))) * 0.6;
  }
  const a = pl.accelMax * (1 + 0.15 * stance);
  t += runTime(d, v0, vm, a);
  // 加速して減速する三角形の速度で走ると、加速しっぱなしより約 0.59√(d/a) 余計にかかる
  if (o.stop) t += 0.59 * Math.sqrt(d / a);

  if (o.obstacles) {
    for (const ob of o.obstacles) {
      const k = closestT(ob.p, from, q);
      if (k <= 0.02 || k >= 0.98) continue;
      const pt = lerpV(from, q, k);
      const clear = ob.r + pl.radius + 0.08;
      const gap = dist(pt, ob.p);
      if (gap < clear) {
        // 回り込む距離のぶん遠回り＋当たって抜ける時間
        const extra = (clear - gap) * 1.7;
        t += extra / Math.max(1, vm) + ob.hold;
      }
    }
  }

  if (!o.still) {
    if (pl.bal.off) t += recoverTime(pl);
    if (pl.airborne) t += pl.airT + 0.1 + 0.3;
    else if (pl.landT > 0) t += pl.landT * 0.8;
  }
  if (o.lag) t += o.lag;
  return t;
}

/** バランスを取り直すまでの見込み時間（ずれが大きいほど長い） */
function recoverTime(pl: Player): number {
  return Math.max(0.15, 0.25 + 0.25 * Math.min(3, pl.bal.ratio) - 0.3 * pl.bal.offT);
}

/** 倒れた人が起き上がってから向かう時間（静止から） */
function timeToReachPlain(pl: Player, q: V2, reachR: number): number {
  const d = dist(pl.p, q) - reachR;
  return d <= 0 ? 0 : runTime(d, 0, pl.maxSpeed, pl.accelMax);
}

/** 速度ベクトルを考慮した予測位置（τ秒後、等速） */
export function predict(pl: Player, tau: number): V2 {
  return { x: pl.p.x + pl.v.x * tau, z: pl.p.z + pl.v.z * tau };
}

export const speedOf = (pl: Player): number => len(pl.v);
