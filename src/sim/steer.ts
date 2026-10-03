// 移動の経路の最終調整。AI が決めた行き先(tgt)へ一直線に向かうと
// ハンドラーとそのマークの間（1on1の空間）を平気で横切ってしまうので、そこを避ける経由点に差し替える。
// 意図して入る人（スクリーナー・オンボール守備・ヘルプ/ダブル/コンテスト）は対象外。
import type { Game } from "./game";
import { V2, closestT, dirTo, dist, dot, lerpV, madd, sub } from "./math";
import { Player } from "./player";

/** 線分 ab と線分 cd の最短距離 */
function segSegDist(a: V2, b: V2, c: V2, d: V2): number {
  const cand = [
    dist(a, lerpV(c, d, closestT(a, c, d))),
    dist(b, lerpV(c, d, closestT(b, c, d))),
    dist(c, lerpV(a, b, closestT(c, a, b))),
    dist(d, lerpV(a, b, closestT(d, a, b))),
  ];
  // 交差していれば0
  const cr = (p: V2, q: V2, r: V2) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  const d1 = cr(c, d, a), d2 = cr(c, d, b), d3 = cr(a, b, c), d4 = cr(a, b, d);
  if (d1 * d2 < 0 && d3 * d4 < 0) return 0;
  return Math.min(...cand);
}

/** ハンドラーの前（リム側）2.6m 以内でいちばん近い守備者 */
function onBallOf(g: Game, h: Player): Player | null {
  let best: Player | null = null, bd = 2.6;
  for (const d of g.players) {
    if (d.team === h.team) continue;
    const dd = dist(d.p, h.p);
    if (dd < bd) { bd = dd; best = d; }
  }
  return best;
}

export function steerAll(g: Game): void {
  if (g.phase !== "live") return;
  const h = g.holder();
  if (!h || h.team !== g.offTeam) return;
  const hd = onBallOf(g, h);
  if (!hd) return;
  const A = h.p, B = hd.p;
  const off = g.off;
  for (const p of g.players) {
    if (p === h || p === hd || p.airborne) continue;
    if (p.team === g.offTeam) {
      const m = off.stOf(p).mode;
      if (m === "screen" || m === "handoff") continue;
    } else {
      // ハンドラーへ意図して寄る守備者（ヘルプ・ダブル・コンテスト）は通す
      if (dist(p.tgt, h.p) < 1.8) continue;
    }
    const t = p.tgt;
    const w = 0.5 + p.radius;
    if (segSegDist(p.p, t, A, B) >= w) continue;
    // ハンドラーの後ろを回るか、マークの背中側を回るか（近い方）
    const wpA = madd(A, dirTo(B, A), 0.9 + p.radius);
    const wpB = madd(B, dirTo(A, B), 0.9 + p.radius);
    const cA = dist(p.p, wpA) + dist(wpA, t);
    const cB = dist(p.p, wpB) + dist(wpB, t);
    const wp = cA <= cB ? wpA : wpB;
    // 既に経由点を越えて行き先側に出ているなら差し替えない
    if (dot(sub(t, p.p), sub(wp, p.p)) <= 0) continue;
    p.tgt = wp;
  }
}
