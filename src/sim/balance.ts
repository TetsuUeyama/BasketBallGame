// 重心（倒立振子＋支持円）。
//   c  = 重心 − 支持点(足) のずれ [m]（ワールド x,z）
//   cv = 重心の速度（ワールド）
//   c' = cv − 足の速度
//   cv' = −K(c − lean) − C(cv − 足の速度)      … 接地中だけ
// 足の急な加減速・接触の撃力・体重の寄せ(lean)の逆への加速で c が支持円を出ると「崩れ」。
// 崩れの出入りはヒステリシス（入り ratio>1 / 出 ratio<0.55 かつ最短時間）。
// 前後の差: 上半身は前へは曲げられるが後ろへは倒せない。前へのずれは上半身を曲げて戻せるが、
// 後ろ（体の向き f の逆）へのずれは戻す力が弱く（BACK_K）、耐えられるずれも小さい（BACK_R）。
import { V, V2, dot, len, madd, sub } from "./math";

/** 後ろへのずれを戻す力の倍率 */
export const BACK_K = 0.8;
/** 後ろへの支持円の半径の倍率（前・横は1） */
export const BACK_R = 0.88;

export class Balance {
  c: V2 = V();
  cv: V2 = V();
  /** 体重を寄せたい向きとずれ量（ワールド、m）。守備の先読み */
  lean: V2 = V();
  ratio = 0;
  off = false;
  offT = 0;
  /** 崩れに入った回数（統計用） */
  falls = 0;

  reset(v: V2): void {
    this.c = V();
    this.cv = { x: v.x, z: v.z };
    this.off = false;
    this.offT = 0;
    this.ratio = 0;
  }

  /** 撃力（重心の速度変化） */
  kick(dv: V2): void {
    this.cv = madd(this.cv, dv, 1);
  }

  /** 支持円に対するずれの比。後ろ（f の逆）は支持円が BACK_R 倍に狭い */
  measure(R: number, f: V2): number {
    const a = dot(this.c, f);
    if (a >= 0) return len(this.c) / R;
    const px = this.c.x - f.x * a, pz = this.c.z - f.z * a;
    return Math.hypot(px, pz, a / BACK_R) / R;
  }

  /** f = 体（下半身）の前。後ろへのずれは戻す力が弱い */
  step(dt: number, footV: V2, K: number, R: number, minOff: number, grounded: boolean, f: V2): boolean {
    const rel = sub(this.cv, footV);
    this.c = madd(this.c, rel, dt);
    if (grounded) {
      const C = 2 * 0.8 * Math.sqrt(K);
      // 戻す力: 前後成分が後ろ向き（体の後ろへずれている）なら BACK_K 倍
      const ex = this.c.x - this.lean.x, ez = this.c.z - this.lean.z;
      const a = ex * f.x + ez * f.z;
      const back = a < 0 ? (1 - BACK_K) * a : 0;
      const ax = -K * (ex - f.x * back) - C * rel.x;
      const az = -K * (ez - f.z * back) - C * rel.z;
      this.cv = { x: this.cv.x + ax * dt, z: this.cv.z + az * dt };
    }
    this.ratio = this.measure(R, f);
    let entered = false;
    if (!this.off && this.ratio > 1) {
      this.off = true;
      this.offT = 0;
      this.falls++;
      entered = true;
    }
    if (this.off) {
      this.offT += dt;
      if (this.ratio < 0.55 && this.offT > minOff) this.off = false;
    }
    return entered;
  }
}
