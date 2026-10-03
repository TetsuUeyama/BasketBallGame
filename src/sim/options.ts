// ハンドラーの選択肢を導線で評価する。攻撃の判断と守備の最適化（脅威の評価）が同じ関数を使う。
import { RIM, distRim, inCourt } from "./court";
import { creatorK, finishPoint, holdValue, releaseTime, shotEV, pMake, shotBase } from "./eval";
import { Lane, LaneCtx, bestPassLane, driveLane, leadLane, shotLane } from "./lanes";
import { V2, dirTo, dist, dot, lerpV, madd, right, rot, sub } from "./math";
import { Player } from "./player";

export type OptKind = "shoot" | "pass" | "lead" | "lob" | "drive" | "hold";

export interface Option {
  kind: OptKind;
  value: number;
  lane: Lane | null;
  to: Player | null;
  /** パス後にキャッチしてからのシュート導線（表示用） */
  after: Lane | null;
  /** ドライブの経路 */
  path: V2[] | null;
}

export interface CutInfo {
  path: V2[];
  lob: boolean;
  endH: number;
}

export interface OptCtx {
  lc: LaneCtx;
  h: Player;
  mates: Player[];
  cuts: Map<Player, CutInfo>;
  /** キャッチ直後（ドリブル前）ならキャッチ&シュートのリリース */
  catchShoot: boolean;
  /** 継続価値 */
  C: number;
  /** オンボールの守備者（ドライブの隙間の基準） */
  onBall: Player | null;
  /** 守備の評価用に精度を落とす */
  coarse?: boolean;
  /** ハンドラーがボールを持ち続けている時間 */
  holdT?: number;
}

/**
 * ドライブの経路候補（その場の状況から作る）:
 *   まっすぐ／扇状の方向（リムへの向きから±75°まで、近い・遠い経由点。真横に近い方向も含む）／
 *   近くの守備者それぞれの脇／守備者2人の間の空いたスペース。
 * どれが通るかは導線（driveLane）が決める。coarse は守備の評価用に数を絞る。
 */
export function drivePaths(h: Player, onBall: Player | null, defs: Player[], coarse = false): V2[][] {
  const fin = finishPoint(h.p);
  const paths: V2[][] = [[h.p, fin]];
  if (distRim(h.p) <= 2.5) return paths;
  const axis = dirTo(h.p, RIM);
  const deg = Math.PI / 180;
  const add = (wp: V2) => {
    const q = inCourt(wp, 0.5);
    if (dist(q, h.p) < 1.2 || dist(q, fin) < 1.0) return;
    for (const p of paths) if (p.length === 3 && dist(p[1], q) < 0.8) return; // 近すぎる候補は1つに
    paths.push([h.p, q, fin]);
  };
  const angles = coarse ? [-50, 50, -80, 80] : [-75, -50, -25, 25, 50, 75];
  const dists = coarse ? [2.5] : [2.0, 3.5];
  for (const a of angles) for (const d of dists) add(madd(h.p, rot(axis, a * deg), d));
  if (coarse) return paths;
  // 近くの守備者の脇を抜ける・2人の間の空きを通る
  const near = defs.filter((d) => dist(d.p, h.p) < 6 && dot(sub(d.p, h.p), axis) > -0.5);
  for (const d of near) {
    const side = right(dirTo(h.p, d.p));
    for (const s of [1, -1]) add(madd(d.p, side, s * (d.radius + h.radius + 0.75)));
  }
  for (let i = 0; i < near.length; i++) {
    for (let j = i + 1; j < near.length; j++) {
      if (dist(near[i].p, near[j].p) > 1.6) add(lerpV(near[i].p, near[j].p, 0.5));
    }
  }
  return paths;
}

export function evalOptions(o: OptCtx): Option[] {
  const { lc, h, C } = o;
  const out: Option[] = [];

  // シュート
  const rel = releaseTime(h, h.p, o.catchShoot);
  const sl = shotLane(lc, h, h.p, 0, rel);
  out.push({ kind: "shoot", value: shotEV(h, h.p, sl.open), lane: sl, to: null, after: null, path: null });

  // ドライブ
  const layEV = (open: number) => pMake(h, finishPoint(h.p), 0.35 + 0.65 * open) * 2;
  for (const path of drivePaths(h, o.onBall, lc.defs, o.coarse)) {
    const dl = driveLane(lc, h, path);
    const total = Math.max(0.1, dist(path[0], path[path.length - 1]));
    // 最後まで開いていればリムへ。途中で消されるなら「ヘルプを引き寄せる」価値だけ
    const collapse = 0.18 * Math.min(1, dl.freeD / Math.min(total, 4.5));
    const v = C + (layEV(dl.open) - C) * dl.open + collapse * (1 - dl.open);
    out.push({ kind: "drive", value: v, lane: dl, to: null, after: null, path });
  }

  // パス（キャッチ後のシュート導線＝クローズアウトの競争まで含める）
  for (const m of o.mates) {
    const cut = o.cuts.get(m);
    if (cut) {
      const ll = leadLane(lc, h, m, cut.path, cut.lob, cut.endH);
      if (ll) {
        const ev = pMake(m, ll.target, 0.7) * shotBase(m, ll.target).pts;
        out.push({ kind: cut.lob ? "lob" : "lead", value: ll.open * Math.max(ev, C) + (1 - ll.open) * 0.2 * C, lane: ll, to: m, after: null, path: null });
      }
      if (o.coarse) continue;
    }
    const tgt = inCourt(madd(m.p, m.v, 0.3));
    const pl = bestPassLane(lc, h, m, tgt, o.coarse);
    const after = shotLane(lc, m, tgt, pl.T, releaseTime(m, tgt, true));
    const ev = shotEV(m, tgt, after.open);
    const fresh = C * creatorK(m) * 1.04;
    const v = pl.open * Math.max(ev, catchDriveValue(lc, m, tgt, pl.T, C), fresh) + (1 - pl.open) * 0.25 * C;
    out.push({ kind: "pass", value: v, lane: pl, to: m, after, path: null });
  }

  out.push({ kind: "hold", value: holdValue(h, C, o.holdT ?? 0), lane: null, to: null, after: null, path: null });
  return out;
}

/**
 * 受けてすぐリムへ攻めたときの価値。マークが離れていれば（クローズアウトが間に合わなければ）
 * ドライブの導線が開いている＝マークを空けた代償。パスの飛行＋キャッチ(0.15s)のあいだ守備は詰められる。
 */
export function catchDriveValue(lc: LaneCtx, m: Player, at: V2, passT: number, C: number): number {
  const fin = finishPoint(at);
  if (dist(at, fin) < 0.8) return C;
  const dl = driveLane(lc, m, [at, fin], passT + 0.15, 0);
  const lay = pMake(m, fin, 0.35 + 0.65 * dl.open) * 2;
  return C + (lay - C) * dl.open;
}

/** 攻撃側の脅威（選択肢の滑らかな最大値）。守備はこれを最小にする位置へ動く */
export function threatOf(opts: Option[], k = 7): number {
  let mx = -1e9;
  for (const x of opts) mx = Math.max(mx, x.value);
  let s = 0;
  for (const x of opts) s += Math.exp(k * (x.value - mx));
  return mx + Math.log(s) / k;
}

export function bestOf(opts: Option[], kind?: OptKind): Option | null {
  let b: Option | null = null;
  for (const x of opts) {
    if (kind && x.kind !== kind) continue;
    if (!b || x.value > b.value) b = x;
  }
  return b;
}

/** 受け手が c に居たら、どれだけ脅威になるか（オフボールの位置取り用） */
export function receiveValue(lc: LaneCtx, h: Player, m: Player, c: V2): number {
  const sp = m.p, sv = m.v;
  m.p = c;
  m.v = { x: 0, z: 0 };
  const pl = bestPassLane(lc, h, m, c, true);
  const after = shotLane(lc, m, c, pl.T, releaseTime(m, c, true));
  const v = pl.open * Math.max(shotEV(m, c, after.open), catchDriveValue(lc, m, c, pl.T, 0.9)) + pl.open * 0.3;
  m.p = sp;
  m.v = sv;
  return v;
}

