// 2D(コート平面 x,z)のベクトル演算と乱数。sim 層は Babylon に依存しない。

export interface V2 { x: number; z: number }

export const V = (x = 0, z = 0): V2 => ({ x, z });
export const add = (a: V2, b: V2): V2 => ({ x: a.x + b.x, z: a.z + b.z });
export const sub = (a: V2, b: V2): V2 => ({ x: a.x - b.x, z: a.z - b.z });
export const mul = (a: V2, s: number): V2 => ({ x: a.x * s, z: a.z * s });
/** a + b*s */
export const madd = (a: V2, b: V2, s: number): V2 => ({ x: a.x + b.x * s, z: a.z + b.z * s });
export const dot = (a: V2, b: V2): number => a.x * b.x + a.z * b.z;
export const cross = (a: V2, b: V2): number => a.x * b.z - a.z * b.x;
export const len = (a: V2): number => Math.hypot(a.x, a.z);
export const dist = (a: V2, b: V2): number => Math.hypot(a.x - b.x, a.z - b.z);
export const norm = (a: V2): V2 => {
  const l = Math.hypot(a.x, a.z);
  return l > 1e-9 ? { x: a.x / l, z: a.z / l } : { x: 0, z: 0 };
};
export const dirTo = (from: V2, to: V2): V2 => norm(sub(to, from));
export const lerpV = (a: V2, b: V2, t: number): V2 => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
export const copy = (a: V2): V2 => ({ x: a.x, z: a.z });

/**
 * 体の右方向。右手系・上=+Y で、前 f の人の右は f×up = (−f.z, f.x)。
 * 例: f=+Z を向いた人の右は −X。
 */
export const right = (f: V2): V2 => ({ x: -f.z, z: f.x });

export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
export const sat = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smooth = (t: number): number => { const u = sat(t); return u * u * (3 - 2 * u); };

/** 線分 ab 上で p に最も近い点のパラメータ(0..1) */
export function closestT(p: V2, a: V2, b: V2): number {
  const abx = b.x - a.x, abz = b.z - a.z;
  const l2 = abx * abx + abz * abz;
  if (l2 < 1e-12) return 0;
  return sat(((p.x - a.x) * abx + (p.z - a.z) * abz) / l2);
}
export function distToSeg(p: V2, a: V2, b: V2): number {
  return dist(p, lerpV(a, b, closestT(p, a, b)));
}

/** 符号付きの角度 a→b（rad） */
export const angleBetween = (a: V2, b: V2): number => Math.atan2(cross(a, b), dot(a, b));

/** 単位ベクトル f を target の向きへ最大 maxAng だけ回す */
export function rotateTowards(f: V2, target: V2, maxAng: number): V2 {
  const t = norm(target);
  if (t.x === 0 && t.z === 0) return f;
  const ang = angleBetween(f, t);
  if (Math.abs(ang) <= maxAng) return t;
  const a = Math.sign(ang) * maxAng;
  const c = Math.cos(a), s = Math.sin(a);
  // cross(a,b)>0 の向きへ回す（angleBetween と同じ規約）
  return norm({ x: f.x * c - f.z * s, z: f.x * s + f.z * c });
}

/** ベクトルを角度 a [rad] 回す（angleBetween と同じ向きが正） */
export function rot(v: V2, a: number): V2 {
  const c = Math.cos(a), s = Math.sin(a);
  return { x: v.x * c - v.z * s, z: v.x * s + v.z * c };
}

/** 折れ線の長さ */
export function polyLen(pts: V2[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]);
  return s;
}
/** 折れ線を先頭から距離 d だけ進んだ点 */
export function alongPoly(pts: V2[], d: number): V2 {
  if (pts.length === 0) return V();
  let rem = d;
  for (let i = 1; i < pts.length; i++) {
    const seg = dist(pts[i - 1], pts[i]);
    if (rem <= seg) return lerpV(pts[i - 1], pts[i], seg > 1e-9 ? rem / seg : 0);
    rem -= seg;
  }
  return copy(pts[pts.length - 1]);
}

/** 決定論の乱数（mulberry32） */
export class Rng {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0; }
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number { return a + (b - a) * this.next(); }
  int(a: number, b: number): number { return Math.floor(this.range(a, b + 1)); }
  chance(p: number): boolean { return this.next() < p; }
  pick<T>(arr: readonly T[]): T { return arr[Math.floor(this.next() * arr.length) % arr.length]; }
  sign(): number { return this.next() < 0.5 ? -1 : 1; }
  /** 重み付き選択（重みは0以上） */
  weighted<T>(items: readonly T[], w: readonly number[]): T {
    let tot = 0;
    for (const x of w) tot += Math.max(0, x);
    if (tot <= 0) return items[0];
    let r = this.next() * tot;
    for (let i = 0; i < items.length; i++) {
      r -= Math.max(0, w[i]);
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  }
}
