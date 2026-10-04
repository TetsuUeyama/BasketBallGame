// 体の接触。円同士の押し離し＋近づく速さで重心へ撃力。
// 押し合いの強さ = 質量 × 筋力 × 構え × 押しの倍率（パワードライブ・セットしたスクリーン）。
// 撃力は触れた最初の1ステップだけ（押し合いが続くあいだ毎フレーム入れると誰でも崩れる）。
import { n } from "./attrs";
import { dot, madd, mul } from "./math";
import { Player } from "./player";

const anchorOf = (p: Player): number =>
  p.mass * (0.6 + 0.8 * n(p.a.strength)) * (1 + 0.6 * p.stance) * p.pushBoost * (p.airborne ? 0.3 : 1) * (p.bal.off ? 0.5 : 1);

/** 押し込みドリブルの仕掛ける側の有利（自分から当たるタイミングを選べる）: 押す力 ×1.1 */
export const POST_INITIATIVE = 1.1;

/**
 * 押す力: 筋力×体重×構え×本気度。崩れていたり跳んでいたりすると押せない。stance を渡せばその構えで見積もる。
 * post = 押し込みドリブルで仕掛けている側（POST_INITIATIVE 倍）
 */
export const pushPower = (p: Player, stance = p.stance, post = p.postUp): number =>
  p.mass * (0.6 + 0.8 * n(p.a.strength)) * (1 + 0.4 * stance) * (p.bal.off ? 0.4 : 1) * (p.airborne ? 0.3 : 1) * (post ? POST_INITIATIVE : 1);

/**
 * 押し合いで動く速さ [m/s]（押し勝ちの度合い net=1 のとき）。
 * 押し込みドリブル中は 6.0: net は力の差が小さく出る（力が25%強くて net≈0.11）ので、互角＋仕掛けの有利で約0.4m/s、
 * 力で勝てば1m/s前後になるように
 */
export const PUSH_SPEED = 1.1;
export const POST_PUSH_SPEED = 6.0;

/** p が向き n の方へ（相手の居る方へ）進みたい度合い（0..1） */
function intentToward(p: Player, nx: number, nz: number): number {
  let dx: number, dz: number;
  if (p.vCmd) { dx = p.vCmd.x; dz = p.vCmd.z; }
  else { dx = p.tgt.x - p.p.x; dz = p.tgt.z - p.p.z; }
  const l = Math.hypot(dx, dz);
  if (l < 0.12) return p.effort > 0.7 ? 0.5 : 0; // その場を守る（ボックスアウト・ポスト）
  return Math.max(0, (dx * nx + dz * nz) / l);
}

/** 接触が続いている時間（押しのけの判断） */
const contactT = new Map<string, number>();

export function resolveContacts(
  ps: Player[],
  prev: Set<string>,
  onHit: (a: Player, b: Player, vrel: number) => void,
  onShove?: (winner: Player, loser: Player) => void,
  dt = 1 / 60,
): Set<string> {
  const now = new Set<string>();
  for (let i = 0; i < ps.length; i++) {
    for (let j = i + 1; j < ps.length; j++) {
      const a = ps[i], b = ps[j];
      if (a.fallen || b.fallen) continue;
      const dx = b.p.x - a.p.x, dz = b.p.z - a.p.z;
      const rr = a.radius + b.radius;
      const d2 = dx * dx + dz * dz;
      if (d2 >= rr * rr) continue;
      const d = Math.sqrt(d2);
      const nrm = d > 1e-6 ? { x: dx / d, z: dz / d } : { x: 1, z: 0 };
      const overlap = rr - d;
      const key0 = a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`;

      // セットしたスクリーン: スクリーナーは動かない。当たった相手は止められ、表面を滑って抜けられない
      if (a.screenSet || b.screenSet) {
        const scr = a.screenSet ? a : b;
        const oth = scr === a ? b : a;
        const out = scr === a ? nrm : { x: -nrm.x, z: -nrm.z }; // スクリーナー → 相手
        oth.p = madd(oth.p, out, overlap);
        const vn = dot(oth.v, out);
        // めり込む向きの速度は消し、横へ滑る速度も大きく削る（体で受け止める摩擦）
        const tan = madd(oth.v, out, -vn);
        oth.v = madd(mul(tan, 0.35), out, Math.max(0, vn));
        now.add(key0);
        if (oth.team !== scr.team && !prev.has(key0)) {
          // 止める時間: スクリーナーの硬さ・筋力 対 相手の筋力、当たった速さ
          const hold = 0.2 + 0.45 * (0.6 * n(scr.a.screen) + 0.4 * n(scr.a.strength)) - 0.25 * n(oth.a.strength) + 0.06 * Math.max(0, -vn);
          oth.screenHeld = Math.max(oth.screenHeld, Math.min(0.75, Math.max(0.12, hold)));
          oth.bal.kick(mul(out, Math.max(0, -vn) * 0.35 * (1 - 0.45 * oth.stance)));
          onHit(scr, oth, Math.max(0, -vn));
        }
        continue;
      }
      const aa = anchorOf(a), ab = anchorOf(b);
      // 軽い（押し負ける）側ほど大きく動く
      const wa = ab / (aa + ab);
      const wb = 1 - wa;
      a.p = madd(a.p, nrm, -overlap * wa);
      b.p = madd(b.p, nrm, overlap * wb);
      const vrel = dot(a.v, nrm) - dot(b.v, nrm);
      if (vrel > 0) {
        a.v = madd(a.v, nrm, -vrel * wa);
        b.v = madd(b.v, nrm, vrel * wb);
      }
      const key = key0;
      now.add(key);

      // 押し合い（相手同士）: それぞれ相手の方へ進みたい度合い×本気度×押す力。勝った方が前へ、負けた方は押し下げられる
      if (a.team !== b.team) {
        const ct = (contactT.get(key) ?? 0) + dt;
        contactT.set(key, ct);
        const Fa = pushPower(a) * a.effort * intentToward(a, nrm.x, nrm.z);
        const Fb = pushPower(b) * b.effort * intentToward(b, -nrm.x, -nrm.z);
        if (Fa + Fb > 1) {
          const net = (Fa - Fb) / (Fa + Fb); // +: a が b を押す
          const step = net * (a.postUp || b.postUp ? POST_PUSH_SPEED : PUSH_SPEED) * dt;
          a.p = madd(a.p, nrm, step);
          b.p = madd(b.p, nrm, step);
          const loser = net > 0 ? b : a;
          const sgn = net > 0 ? 1 : -1;
          loser.bal.kick(mul(nrm, sgn * Math.abs(net) * 2.2 * dt * (1 - 0.45 * loser.stance)));
          // 押し合いが続いて明らかに勝っている → 一気に押しのける（相手は崩れてジャンプも確保もできない）
          const win = net > 0 ? a : b;
          if (ct > 0.25 && Math.abs(net) > 0.35 && win.effort >= 0.85 && win.shoveCd <= 0) {
            win.shoveCd = 1.2;
            loser.bal.kick(mul(nrm, sgn * (1.0 + 1.6 * Math.abs(net)) * (1 - 0.4 * loser.stance)));
            loser.v = madd(loser.v, nrm, sgn * 1.0);
            loser.fallWhy = "押しのけられた";
            loser.fallWhyT = 0.8;
            onShove?.(win, loser);
          }
        }
      }
      if (!prev.has(key) && vrel > 0.6) {
        const sameTeam = a.team === b.team;
        const k = sameTeam ? 0.15 : 0.45;
        // 重心へ撃力。押し負けた側ほど大きい。構えていれば小さい
        a.bal.kick(mul(nrm, -vrel * wa * k * (1 - 0.45 * a.stance)));
        b.bal.kick(mul(nrm, vrel * wb * k * (1 - 0.45 * b.stance)));
        if (!sameTeam) onHit(a, b, vrel);
      }
    }
  }
  for (const k of contactT.keys()) if (!now.has(k)) contactT.delete(k);
  return now;
}
