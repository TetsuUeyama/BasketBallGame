// ハンドラーの選択肢を導線で評価する。攻撃の判断と守備の最適化（脅威の評価）が同じ関数を使う。
import { n } from "./attrs";
import { COURT, RIM, distRim, inCourt, isThree } from "./court";
import { MOVES, MoveId, moveDisp } from "./duel";
import { creatorK, finishPoint, holdValue, releaseTime, shotEV, pMake, shotBase } from "./eval";
import { Lane, LaneCtx, bestPassLane, driveLane, leadLane, openOf, postLane, shotLane, stepLane } from "./lanes";
import { POST_PUSH_SPEED } from "./contact";
import { V2, dirTo, dist, dot, lerpV, madd, right, rot, sub } from "./math";
import { Player } from "./player";

export type OptKind = "shoot" | "pass" | "lead" | "lob" | "drive" | "step" | "post" | "hold";

/** ステップ導線: どのムーブで、どこへ出て、そのあと何をする見込みか */
export interface StepPlan {
  id: MoveId;
  s: number;
  /** 着地点 */
  at: V2;
  /** 着地してからの狙い（シュート／そこから突破） */
  follow: "shoot" | "drive";
  /** 突破のときの経路 */
  drivePath: V2[] | null;
}

export interface Option {
  kind: OptKind;
  value: number;
  lane: Lane | null;
  to: Player | null;
  /** パス後にキャッチしてからのシュート導線（表示用） */
  after: Lane | null;
  /** ドライブの経路 */
  path: V2[] | null;
  /** ステップ導線の中身（kind="step" のときだけ） */
  step?: StepPlan;
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
  /** ショットクロックの残り（押し込みなど時間のかかる選択肢の可否） */
  shotClock?: number;
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

  // 押し込みドリブル（ペイント付近でマークを背中で押してゴール下へ）
  if (o.onBall && distRim(h.p) < 6.0 && distRim(h.p) > 1.8 && dist(o.onBall.p, h.p) < 1.6) {
    const pl = postLane(lc, h, o.onBall);
    // マークがリングとの間に居るとき（力で負けていても試せる。進めなければ実行中に見切る）
    if (pl.T >= 0) {
      const fin = pl.target;
      // ゴール下での決め: マークは背中に居るが押し勝っているほど体勢が良い。ヘルプが寄れるほど難しい
      const net = pl.speed / POST_PUSH_SPEED;
      const help = openOf(pl.margin);
      const finOpen = Math.min(0.85, Math.max(0.1, 0.3 + 3 * net)) * (0.4 + 0.6 * help);
      const ev = pMake(h, fin, finOpen) * 2;
      out.push({ kind: "post", value: C + (ev - C) * (0.5 + 0.5 * pl.open), lane: pl, to: null, after: null, path: [h.p, fin] });
    }
  }

  // ステップ（左右のサイドステップ・ステップバック）→ シュート、またはそれを見せて突破
  if (!o.coarse && o.onBall) out.push(...stepOptions(o, layEV));

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


/**
 * ステップ導線（左右のサイドステップ・ステップバック）。マークとの間合いを横・後ろへずらして、
 *   ① 着地してシュート: 着地点からのシュート導線（ステップの時間 tStep のあいだに守備者が手を届かせられるか）
 *   ② 着地してから突破: 撃つ構えを見せるので、信じた守備者は詰めて出遅れる（フェイクの効きぶん走り出しが早い）
 * の良い方を価値にする。シュートが届かない距離でも、ずらした位置からの突破の導線が開けば選ばれる。
 */
function stepOptions(o: OptCtx, layEV: (open: number) => number): Option[] {
  const { lc, h, C } = o;
  const od = o.onBall!;
  const out: Option[] = [];
  const axis = dirTo(h.p, RIM);
  const lat = right(axis);
  // フェイクの効き: その位置で撃てると思わせる力 × 守備者の掛かりやすさ
  const gull = 1 - 0.6 * n(od.a.defIQ);
  const tries: [MoveId, number][] = [["sidestep", 1], ["sidestep", -1], ["stepback", h.hand >= 0 ? 1 : -1]];
  for (const [id, sd] of tries) {
    const [fw, lt] = moveDisp(h, id, sd);
    const at = madd(madd(h.p, axis, fw), lat, lt);
    // ライン際・バックコート・ゴール下へは出ない
    if (Math.abs(at.x) > COURT.halfW - 0.6 || at.z > COURT.baseZ - 0.6 || at.z < 0.8 || distRim(at) < 2.0) continue;
    const def = MOVES[id];
    const tStep = def.dur;
    // ① 着地してシュート（ステップからのシュートは体勢が少し難しい）
    const sl = shotLane(lc, h, at, tStep, releaseTime(h, at, false));
    const evShot = shotEV(h, at, sl.open) * 0.93;
    // ② 着地してから突破
    const believe = isThree(at) ? n(h.a.three) : n(h.a.mid);
    const fakeGain = 0.18 * believe * gull;
    const dpath = [at, finishPoint(at)];
    const dl = driveLane(lc, h, dpath, Math.max(0, tStep - fakeGain), 0);
    const evDrive = C + (layEV(dl.open) - C) * dl.open;
    const follow = evShot >= evDrive ? "shoot" : "drive";
    const fl = follow === "shoot" ? sl : dl;
    // ムーブのしくじり（ハンドリングが足りない）と、ステップに使う時間のぶん
    const risk = Math.max(0, def.diff - n(h.a.handle)) * 0.25;
    const v = Math.max(evShot, evDrive) * (1 - risk) - 0.02;
    out.push({
      kind: "step", value: v, lane: stepLane(h, h.p, at, tStep, fl), to: null, after: fl, path: null,
      step: { id, s: sd, at, follow, drivePath: follow === "drive" ? dpath : null },
    });
  }
  return out;
}
