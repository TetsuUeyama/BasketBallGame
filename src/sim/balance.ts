// 重心（倒立振子＋支持円）。
//   c  = 重心 − 支持点(足) のずれ [m]（ワールド x,z）
//   cv = 重心の速度（ワールド）
//   c' = cv − 足の速度
//   cv' = −K(c − lean) − C(cv − 足の速度)      … 接地中だけ
// 足の急な加減速・接触の撃力・体重の寄せ(lean)の逆への加速で c が支持円を出ると「崩れ」。
// 崩れの出入りはヒステリシス（入り ratio>1 / 出 ratio<0.55 かつ最短時間）。
import { V, V2, len, madd, sub } from "./math";

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

  step(dt: number, footV: V2, K: number, R: number, minOff: number, grounded: boolean): boolean {
    const rel = sub(this.cv, footV);
    this.c = madd(this.c, rel, dt);
    if (grounded) {
      const C = 2 * 0.8 * Math.sqrt(K);
      const ax = -K * (this.c.x - this.lean.x) - C * rel.x;
      const az = -K * (this.c.z - this.lean.z) - C * rel.z;
      this.cv = { x: this.cv.x + ax * dt, z: this.cv.z + az * dt };
    }
    this.ratio = len(this.c) / R;
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
