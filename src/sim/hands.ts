// 手の狙い。毎フレーム、状況から各選手の左右の手の目標(ワールド3D)を決める。
// 実際に手が届くかは Player.updateHands（腕の長さ・手の速さ）が決め、
// パスカット・ブロック・リバウンド・スティール・キャッチは game.ts が「手がボールに触れたか」で判定する。
import { RIM } from "./court";
import type { Game } from "./game";
import { V2, clamp, closestT, dirTo, dist, lerpV, madd } from "./math";
import { Player, V3 } from "./player";
import { passHeight } from "./lanes";

const v3 = (p: V2, y: number): V3 => ({ x: p.x, y, z: p.z });

/** 平面上で p に近い方の手 */
function nearHand(pl: Player, q: V2): number {
  const a = pl.shoulder(0), b = pl.shoulder(1);
  return dist({ x: a.x, z: a.z }, q) <= dist({ x: b.x, z: b.z }, q) ? 0 : 1;
}

function both(pl: Player, t: V3): void {
  pl.hands[0].cmd = t;
  pl.hands[1].cmd = t;
  // 腕を下ろしても届かない低さなら構えを落とし、さらに低ければ腰をかがめる
  const low = pl.shoulderY - pl.armLen * 0.9;
  if (t.y < low) {
    pl.stanceCmd = Math.max(pl.stanceCmd, 1);
    pl.bendCmd = Math.max(pl.bendCmd, clamp((low - t.y) / 0.85, 0, 1));
  }
}

/** 腕の届く範囲（＋余裕）にボールがあるか。低いボールはかがめば届く範囲 */
function inReach(pl: Player, b: V3, extra: number): boolean {
  let r = pl.handReachAt(b.y, pl.airborne);
  if (r < 0 && b.y < pl.shoulderY) r = pl.handReachLow(b.y);
  return r > 0 && dist(pl.p, { x: b.x, z: b.z }) < r + extra;
}

export function aimHands(g: Game): void {
  const b = g.ball;
  const bp = g.ballPos();
  const B = v3(bp.p, bp.h);
  const off = g.off;
  const h = g.holder();

  for (const p of g.players) { p.hands[0].cmd = null; p.hands[1].cmd = null; }

  // 少し先のボール（動いているボールへ手を出すとき）
  let ahead = B;
  if (b.k === "pass") {
    const s = Math.min(1, (b.t + 0.08) / b.T);
    const q = lerpV(b.p0, b.p1, s);
    ahead = v3(q, passHeight(b.style, b.h0, b.h1, s, b.L));
  } else if (b.k === "loose") {
    ahead = { x: b.p.x + b.v.x * 0.08, y: b.h + b.vy * 0.08, z: b.p.z + b.v.z * 0.08 };
  }

  // ---- ボールを持っている人
  if (h) {
    const hs = h.team === g.offTeam ? off.hs : null;
    if (hs?.shooting) {
      const ty = hs.shooting.type;
      if (ty === "dunk") {
        // リムへ叩き込む
        const tr = dirTo(RIM, h.p);
        both(h, { x: RIM.x + tr.x * 0.25, y: 3.2, z: RIM.z + tr.z * 0.25 });
      } else if (ty === "layup") {
        // リムへ向けて腕を伸ばす
        const tr = dirTo(h.p, RIM);
        both(h, { x: h.p.x + tr.x * 0.4, y: h.shoulderY + h.armLen * 0.95 + h.airY(), z: h.p.z + tr.z * 0.4 });
      } else {
        // 頭の上やや前（セットシュートは跳ばないぶん低い）
        both(h, { x: h.p.x + h.f.x * 0.25, y: h.shoulderY + h.armLen * 0.92 + h.airY(), z: h.p.z + h.f.z * 0.25 });
      }
    } else if (hs?.passing) {
      // パスの種類のリリース点（左右どちらかの手・高さ）へ
      const ln = hs.passing.lane;
      both(h, v3(ln.pts[0], ln.h0));
    } else if (h.dribbling) {
      const di = h.hand > 0 ? 0 : 1;
      const s = h.shoulder(di);
      h.hands[di].cmd = { x: s.x + h.f.x * 0.25, y: 0.85, z: s.z + h.f.z * 0.25 };
      // 逆の手は近い守備者へ向けて腕でボールを守る
      let near: Player | null = null, nd = 1.6;
      for (const d of g.players) {
        if (d.team === h.team) continue;
        const dd = dist(d.p, h.p);
        if (dd < nd) { nd = dd; near = d; }
      }
      if (near) h.hands[1 - di].cmd = v3(madd(h.p, dirTo(h.p, near.p), h.armLen * 0.7), 1.1);
    } else {
      both(h, v3(madd(h.p, h.f, 0.3), 1.15));
    }
  }

  for (const p of g.players) {
    if (p === h || p.fallen) continue;
    if (p.bal.off) {
      const s0 = p.shoulder(0), s1 = p.shoulder(1);
      p.hands[0].cmd = { x: s0.x + (s0.x - p.p.x) * 3, y: s0.y - 0.05, z: s0.z + (s0.z - p.p.z) * 3 };
      p.hands[1].cmd = { x: s1.x + (s1.x - p.p.x) * 3, y: s1.y - 0.05, z: s1.z + (s1.z - p.p.z) * 3 };
      if (p.bal.ratio > 1.4 && p.labelT <= 0) p.say("踏ん張る", 0.6);
      continue;
    }
    const isDef = p.team !== g.offTeam;

    // パスが飛んでいる: 受け手は手を出す／届く守備者は手を伸ばす
    if (b.k === "pass") {
      if (p === b.to) {
        if (dist(p.p, b.p1) < 4) both(p, ahead);
        continue;
      }
      if (isDef && inReach(p, ahead, 0.5 + p.lunge * 0.4)) { both(p, ahead); continue; }
    }

    // シュート: 打ち上がったボールへ届く守備者は手を伸ばす（ブロック）
    if (b.k === "shot") {
      // ボールが0.1秒後に来る位置へ先回り
      const sa = g.shotPosAt(0.1);
      if (isDef && inReach(p, sa, 0.4)) { both(p, sa); continue; }
      if (isDef) {
        // ボックスアウト: 腕を横に広げる
        const s0 = p.shoulder(0), s1 = p.shoulder(1);
        p.hands[0].cmd = { x: s0.x + (s0.x - p.p.x) * 3, y: 1.2, z: s0.z + (s0.z - p.p.z) * 3 };
        p.hands[1].cmd = { x: s1.x + (s1.x - p.p.x) * 3, y: 1.2, z: s1.z + (s1.z - p.p.z) * 3 };
      }
      continue;
    }

    // ルーズ・リバウンド: 予測した軌道上で「手が間に合い、届く」最も早い点へ手を伸ばす
    if (b.k === "loose") {
      const tp = g.loosePath;
      let aim: V3 | null = null;
      for (let i = 1; i < tp.length; i++) {
        const q = tp[i];
        const px = p.p.x + p.v.x * q.t * 0.6, pz = p.p.z + p.v.z * q.t * 0.6;
        let r = p.handReachAt(q.h, true);
        if (r < 0 && q.h < p.shoulderY) r = p.handReachLow(q.h);
        if (r < 0) continue;
        if (Math.hypot(q.x - px, q.z - pz) > r + 0.1) continue;
        // 手がそこまで動く時間
        const hw = p.handW(0);
        if (Math.hypot(hw.x - q.x, hw.y - q.h, hw.z - q.z) / p.handSpeed > q.t + 0.08) continue;
        aim = { x: q.x, y: q.h, z: q.z };
        break;
      }
      if (aim) { both(p, aim); continue; }
      if (inReach(p, ahead, 1.0)) {
        if (ahead.y > p.shoulderY + p.airY()) {
          const dx = ahead.x - p.p.x, dz = ahead.z - p.p.z;
          const l = Math.hypot(dx, dz);
          const k = l > 0.45 ? 0.45 / l : 1;
          both(p, { x: p.p.x + dx * k, y: ahead.y, z: p.p.z + dz * k });
        } else both(p, ahead);
      }
      continue;
    }

    if (!h) continue;

    if (isDef) {
      const sa = g.def.stealAim(p);
      if (sa) { both(p, sa); continue; }
      // シュートモーションへのコンテスト: リリース点へ手を
      const hs = off.hs;
      if (hs.shooting && dist(p.p, h.p) < 2.2) {
        const R: V3 = { x: h.p.x + h.f.x * 0.25, y: h.shoulderY + h.armLen * 0.92 + h.airY() + 0.15, z: h.p.z + h.f.z * 0.25 };
        both(p, R);
        continue;
      }
      const m = g.def.mark.get(p);
      if (m === h) {
        // オンボール: ボールに近い手はボールへ（スティールの手）、もう一方は上げてシュート/パスの壁
        const bi = nearHand(p, bp.p);
        const toH = dirTo(p.p, h.p);
        if (p.lungeT > 0) {
          // リーチイン: 近い方の手をボールへ伸ばす
          p.hands[bi].cmd = { x: B.x, y: Math.max(0.4, B.y), z: B.z };
          p.hands[1 - bi].cmd = v3(madd(p.p, toH, 0.3), p.shoulderY);
        } else if (p.guardFocus > 0.2) {
          // シュート警戒: ボール側の手はボールへ、もう一方は顔の前に高く
          p.hands[bi].cmd = { x: B.x, y: Math.max(0.5, B.y), z: B.z };
          p.hands[1 - bi].cmd = v3(madd(p.p, toH, 0.45), p.shoulderY + p.armLen * 0.85);
        } else if (p.guardFocus < -0.2) {
          // ドライブ警戒: 両手を低く横に広げてドリブルの線をふさぐ
          const s0 = p.shoulder(0), s1 = p.shoulder(1);
          p.hands[0].cmd = { x: s0.x + (s0.x - p.p.x) * 2.5 + toH.x * 0.3, y: 0.9, z: s0.z + (s0.z - p.p.z) * 2.5 + toH.z * 0.3 };
          p.hands[1].cmd = { x: s1.x + (s1.x - p.p.x) * 2.5 + toH.x * 0.3, y: 0.9, z: s1.z + (s1.z - p.p.z) * 2.5 + toH.z * 0.3 };
        } else {
          p.hands[bi].cmd = { x: B.x, y: Math.max(0.5, B.y), z: B.z };
          p.hands[1 - bi].cmd = v3(madd(p.p, toH, 0.35), p.shoulderY + p.armLen * 0.75);
        }
      } else if (m) {
        // オフボール: ボール側の手をパスの線へ（導線を手で切る）、もう一方はマークへ
        const k = closestT(p.p, h.p, m.p);
        const onLine = lerpV(h.p, m.p, k);
        const li = nearHand(p, onLine);
        p.hands[li].cmd = v3(onLine, 1.25);
        p.hands[1 - li].cmd = v3(madd(p.p, dirTo(p.p, m.p), 0.5), 1.0);
      }
    } else {
      // オフボールの攻撃: ボール側の手を上げてターゲットを見せる
      const st = off.stOf(p);
      if (st.mode === "spot" || st.mode === "cut" || st.mode === "roll") {
        const li = nearHand(p, h.p);
        p.hands[li].cmd = v3(madd(p.p, dirTo(p.p, h.p), 0.3), p.shoulderY + 0.25);
        if (st.mode === "roll" && st.lob) both(p, v3(madd(p.p, dirTo(p.p, RIM), 0.2), p.shoulderY + p.armLen));
      }
    }
  }
}
