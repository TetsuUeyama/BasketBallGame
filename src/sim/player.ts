// 選手（円柱）。位置は加速度制限つきの移動でしか変わらない（ワープ禁止）。
// AI は「行きたい場所(tgt) / 直接の速度指令(vCmd) / 向きたい向き(face) / 構え / 体重の寄せ」だけを出す。
import { Attrs, PlayerDef, n } from "./attrs";
import { Balance } from "./balance";
import {
  V, V2, add, clamp, copy, dot, len, lerp, madd, mul, norm, rotateTowards, sub,
} from "./math";

export const DT = 1 / 60;
export type Team = 0 | 1;
/** 体重の寄せの最大量 [m] */
export const LEAN_MAX = 0.12;

/** 相手から見える姿（反応の遅れぶん古い姿を読むための履歴） */
export interface Snap {
  p: V2;
  v: V2;
  /** 横への「見せ」（フェイクの向き。ワールド、大きさ0..1） */
  sell: V2;
  /** 止まる/撃つ見せ（ヘジテーション・ポンプフェイク） */
  sellStop: number;
  sellShot: number;
}

const HIST = 48;

export interface V3 { x: number; y: number; z: number }
export const dist3 = (a: V3, b: V3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/**
 * 手。肩からの相対位置 off で持ち、AI が出す目標 cmd（ワールド）へ手の速さの上限で動く。
 * 腕の長さを超える目標は肩を中心とした球の上へ縮める。
 */
export interface Hand {
  off: V3;
  cmd: V3 | null;
}
/** 0 = 右手(+1) / 1 = 左手(-1) */
export const HAND_SIDE = [1, -1];

export class Player {
  readonly id: number;
  readonly team: Team;
  readonly slot: number;
  readonly d: PlayerDef;
  readonly a: Attrs;

  p: V2;
  v: V2 = V();
  /** 体の前（単位ベクトル） */
  f: V2;
  stance = 0;
  bal = new Balance();

  // ---- AI からの指令 ----
  tgt: V2;
  /** 最高速に対する割合 */
  spd = 1;
  face: V2 | null = null;
  vCmd: V2 | null = null;
  stanceCmd = 0;
  /** 体重の寄せ（ワールド、大きさ0..1） */
  leanCmd: V2 = V();
  /** 押し合いの強さの倍率（パワードライブ・スクリーン） */
  pushBoost = 1;

  // ---- 見せ（相手が読む） ----
  sell: V2 = V();
  sellStop = 0;
  sellShot = 0;

  /** ドリブル中（最高速が落ちる） */
  dribbling = false;
  /** ボールを持つ手。+1=右 / -1=左 */
  hand = 1;

  airT = 0;
  airDur = 0;
  /** 今のジャンプの高さ */
  jumpHNow = 0;
  /** 着地・シュート後の硬直（バランスを戻すまでの残り時間）。この間は遅く、跳べない */
  landT = 0;

  /** セットしたスクリーナー（接触で動かない・当たった守備者を止める） */
  screenSet = false;
  /**
   * 急ぐ度合い（0..1）。毎フレームAIが決める。高いほど地面を強く踏んで止まり・切り返す（1on1・クローズアウト等）。
   * 低ければ（ジョグで持ち場へ等）従来どおり滑るように止まる。
   */
  urgency = 0.2;
  /** 押し合いの本気度（0..1）。毎フレームAIが決める（ボックスアウト・リバウンド・ポスト争いで高い） */
  effort = 0.25;
  /** 押しのけの再使用までの時間 */
  shoveCd = 0;
  /** 転倒: 倒れている残り時間・倒れる向き・合計時間、起き上がった直後の残り時間 */
  fallT = 0;
  fallDur = 0;
  fallDir: V2 = V(0, 1);
  getUpT = 0;
  /** 逆を突かれた（体重を寄せた向きへ動いていて急ブレーキ）残り時間。この間は倒れやすい */
  crossedT = 0;
  /** 直前に受けた「倒れうる出来事」（ログ用）と、その有効時間 */
  fallWhy = "";
  fallWhyT = 0;
  /** スティールの飛び込み（0..1）と残り時間 */
  lunge = 0;
  lungeT = 0;
  /** 腰をかがめる量（0..1）。腕を伸ばしても届かない低いボールを拾う。毎フレームAI/手の狙いが決める */
  bend = 0;
  bendCmd = 0;
  /** スクリーンに止められている残り時間（足が出せない） */
  screenHeld = 0;
  /** オンボール守備の警戒の向き。+1=シュート警戒（密着・手を上げる） / -1=ドライブ警戒（離れて低く広く） */
  guardFocus = 0;

  hands: Hand[] = [
    { off: { x: 0, y: -0.8, z: 0 }, cmd: null },
    { off: { x: 0, y: -0.8, z: 0 }, cmd: null },
  ];

  label = "";
  labelT = 0;

  private hist: Snap[] = [];
  private histI = 0;

  constructor(id: number, team: Team, slot: number, def: PlayerDef, p: V2, f: V2) {
    this.id = id;
    this.team = team;
    this.slot = slot;
    this.d = def;
    this.a = def.a;
    this.p = copy(p);
    this.f = norm(f);
    this.tgt = copy(p);
    for (let i = 0; i < HIST; i++) this.hist.push({ p: copy(p), v: V(), sell: V(), sellStop: 0, sellShot: 0 });
  }

  // ---- 能力からの導出値 ----
  get maxSpeed(): number { return 5.4 + 2.8 * n(this.a.speed); }
  get accelMax(): number { return 6 + 6 * n(this.a.accel); }
  /** 地面を踏んで止まる力 [m/s²]。加速より強い（俊敏さ・構えで強くなる） */
  get brakeMax(): number { return this.accelMax * (1.6 + 0.6 * n(this.a.agility)) * (1 + 0.2 * this.stance); }
  /** 今の止まる力: 急いでいなければ加速並み（滑って止まる）、急いでいれば踏ん張る */
  get brakeNow(): number { return lerp(this.accelMax * 0.8, this.brakeMax, this.urgency); }
  get radius(): number { return clamp(0.23 + (this.a.weight - 85) * 0.0025, 0.22, 0.33); }
  get mass(): number { return this.a.weight; }
  /** 相手を見る遅れ [s] */
  get reactT(): number { return 0.34 - 0.2 * n(this.a.reaction); }
  get standReach(): number { return this.a.height * 1.32; }
  get jumpH(): number { return 0.45 + 0.45 * n(this.a.vertical); }
  /** 今の手の最高到達点（跳んでいれば跳躍ぶん） */
  get reachNow(): number { return this.standReach + this.airY(); }
  get reachMax(): number { return this.standReach + this.jumpH; }
  get airborne(): boolean { return this.airT > 0; }
  get fallen(): boolean { return this.fallT > 0; }

  /**
   * 転倒する重心のずれ（支持円の何倍か）。普段の崩れ(1.0倍)よりずっと大きい。
   * バランスが良いほど・構えているほど倒れにくい。
   */
  fallLimit(): number { return 2.6 + 0.8 * n(this.a.balance) + 0.3 * this.stance - (this.crossedT > 0 ? 1.1 : 0); }

  private startFall(why: string): void {
    const c = this.bal.c;
    const l = len(c);
    this.fallDir = l > 1e-4 ? mul(c, 1 / l) : (len(this.v) > 0.1 ? norm(this.v) : this.f);
    this.fallDur = 1.0 + 0.9 * (1 - n(this.a.balance)) + Math.min(0.3, 0.15 * (this.bal.ratio - this.fallLimit()));
    this.fallT = this.fallDur;
    this.fallWhy = why;
    this.airT = 0;
    this.airDur = 0;
    this.lunge = 0;
    this.lungeT = 0;
    this.stance = 0;
  }

  get armLen(): number { return this.a.height * 0.44 * (1 + 0.22 * this.lunge); }
  /** 手の速さ（肩に対して）[m/s] */
  get handSpeed(): number { return 6 + 6 * n(this.a.reaction); }
  get shoulderY(): number { return this.a.height * 0.81 * (1 - 0.12 * this.stance); }

  shoulder(i: number): V3 {
    const r = { x: -this.f.z, z: this.f.x };
    const w = (this.radius + 0.04) * HAND_SIDE[i];
    const fw = 0.22 * this.lunge + 0.3 * this.bend; // 飛び込む・かがむと肩が前へ出る
    return { x: this.p.x + r.x * w + this.f.x * fw, y: this.shoulderY + this.airY() - 0.15 * this.lunge - 0.85 * this.bend, z: this.p.z + r.z * w + this.f.z * fw };
  }

  handW(i: number): V3 {
    const s = this.shoulder(i);
    const o = this.hands[i].off;
    return { x: s.x + o.x, y: Math.max(0.08, s.y + o.y), z: s.z + o.z };
  }

  /** ボールを持っている位置（ドリブル中はドリブルの手、そうでなければ両手の間） */
  ballHand(): V3 {
    if (this.dribbling) return this.handW(this.hand > 0 ? 0 : 1);
    const a = this.handW(0), b = this.handW(1);
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
  }

  /** 高さ y のボールに手が届く水平距離（跳んでよければ跳躍ぶん肩が上がる）。届かなければ -1 */
  handReachAt(y: number, canJump: boolean): number {
    const sy = this.shoulderY;
    const L = this.armLen;
    let dy = y - sy;
    if (dy > L && canJump) dy = Math.max(0, y - (sy + this.jumpH));
    if (Math.abs(dy) > L) return -1;
    return this.radius + 0.04 + Math.sqrt(L * L - dy * dy);
  }

  /** 低いボールへ深くかがんで（構え1.0）手を伸ばしたときに届く水平距離。届かなければ -1 */
  handReachLow(y: number): number {
    const sy = Math.max(this.a.height * 0.81 * 0.88 - 0.85, Math.min(this.a.height * 0.81 * 0.88, y + this.armLen * 0.5));
    const L = this.armLen;
    const dy = y - sy;
    if (Math.abs(dy) > L) return -1;
    return (this.radius + 0.04 + Math.sqrt(L * L - dy * dy)) * 0.9;
  }

  private restOff(i: number): V3 {
    const r = { x: -this.f.z, z: this.f.x };
    const s = HAND_SIDE[i] * 0.05;
    return { x: this.f.x * 0.12 + r.x * s, y: -this.armLen * 0.85, z: this.f.z * 0.12 + r.z * s };
  }

  private updateHands(dt: number): void {
    const L = this.armLen;
    const maxStep = this.handSpeed * dt;
    for (let i = 0; i < 2; i++) {
      const h = this.hands[i];
      let want: V3;
      if (h.cmd) {
        const s = this.shoulder(i);
        want = { x: h.cmd.x - s.x, y: h.cmd.y - s.y, z: h.cmd.z - s.z };
        const l = Math.hypot(want.x, want.y, want.z);
        if (l > L) want = { x: (want.x * L) / l, y: (want.y * L) / l, z: (want.z * L) / l };
      } else want = this.restOff(i);
      const dx = want.x - h.off.x, dy = want.y - h.off.y, dz = want.z - h.off.z;
      const d = Math.hypot(dx, dy, dz);
      const k = d > maxStep ? maxStep / d : 1;
      h.off = { x: h.off.x + dx * k, y: h.off.y + dy * k, z: h.off.z + dz * k };
    }
  }

  airY(): number {
    if (this.airT <= 0 || this.airDur <= 0) return 0;
    const u = 1 - this.airT / this.airDur;
    return this.jumpHNow * 4 * u * (1 - u);
  }

  /** ドリブルや構えを含めた今の最高速 */
  speedNow(): number {
    let s = this.maxSpeed;
    if (this.dribbling) s *= 0.8 + 0.15 * n(this.a.handle);
    return s;
  }

  /** 向き直りの速さ [rad/s]。止まっていて 4〜7、走っているほど遅い（6m/sで約半分） */
  turnRate(): number {
    return (4 + 3 * n(this.a.agility)) / (1 + 0.18 * len(this.v));
  }

  /**
   * 体の向きに対する移動方向の速さの倍率（前1.0 / 横=サイドステップ / 後ろ=バックペダル）。
   * 構えると横は少し速くなるが、全体の最高速は落ちる。
   */
  dirSpeedFactor(dir: V2): number {
    const c = dot(dir, this.f);
    const lat = 0.42 + 0.12 * n(this.a.agility) + 0.12 * this.stance;
    const back = 0.36 + 0.08 * n(this.a.agility) + 0.06 * this.stance;
    return c >= 0 ? lerp(lat, 1, c * c) : lerp(lat, back, c * c);
  }

  /** 方向ごとの加速のしやすさ（前1.0 / 横0.85 / 後ろ0.6） */
  dirAccelFactor(dir: V2): number {
    const c = dot(dir, this.f);
    return c >= 0 ? lerp(0.85, 1, c) : lerp(0.85, 0.6, -c);
  }

  /** 支持円の半径 */
  supportR(): number {
    return (0.24 + 0.24 * this.stance) * (0.85 + 0.3 * n(this.a.balance));
  }

  /**
   * ジャンプ。carry = 踏み切りで残す横の勢い（0=真上、1=走った勢いのまま）。
   * リバウンド・ブロックは踏み切りで止まって真上へ、レイアップは踏み込んだ勢いのまま。
   */
  jump(power = 0.66, carry = 0.25): void {
    if (this.airT > 0 || this.bal.off || this.fallT > 0 || this.getUpT > 0 || this.landT > 0) return;
    // 跳ぶ高さ（power は全力に対する強さ 0.66≒全力）と、その高さに合う滞空時間 2√(2h/g)
    this.jumpHNow = this.jumpH * clamp(power / 0.66, 0.55, 1);
    const dur = 2 * Math.sqrt((2 * this.jumpHNow) / 9.8);
    this.airT = dur;
    this.airDur = dur;
    // 空中では慣性で流れる（ある程度は勢いが残る）
    const k = Math.max(0.35, carry);
    this.v = mul(this.v, k);
    // 踏み切りで重心も一緒に止める（足だけ止まって体が流れない）
    this.bal.cv = mul(this.bal.cv, k);
  }

  /**
   * リバウンドで跳ぶべきか: 0.25秒先のボールが自分の真上近く（水平0.7m以内）で、降りてきていて、
   * 跳べば手が届く高さにあるときだけ。それまでは落下点へ動いて位置を取る。
   */
  shouldJumpFor(bp: V2, bv: V2, bh: number, bvy: number): boolean {
    // ボールの軌道（重力込み）を先読みし、跳んだ頂点（約0.3秒後）の前後でボールが手の届く所へ来るなら跳ぶ
    const reachH = 0.5; // 頭上へ伸ばした手が届く水平の余裕
    for (let i = 0; i <= 8; i++) {
      const t = 0.2 + i * 0.03; // 0.20〜0.44秒後
      const fx = bp.x + bv.x * t, fz = bp.z + bv.z * t;
      const fh = bh + bvy * t - 4.9 * t * t;
      if (fh < this.standReach - 0.1 || fh > this.reachMax + 0.2) continue;
      // 跳ぶ前にまだ少し寄れる分（今の速度で）
      const px = this.p.x + this.v.x * 0.15, pz = this.p.z + this.v.z * 0.15;
      if (Math.hypot(fx - px, fz - pz) < reachH + this.radius) return true;
    }
    return false;
  }

  /** 選手ごとの癖（0..1、id から決まる固定値。k で別の値を取り出す） */
  quirk(k: number): number {
    const x = Math.sin((this.id + 1) * 12.9898 + k * 78.233) * 43758.5453;
    return x - Math.floor(x);
  }

  say(text: string, dur = 1.0): void {
    this.label = text;
    this.labelT = dur;
  }

  /** 遅れ lag 秒前の姿 */
  perceived(lag: number): Snap {
    const k = clamp(Math.round(lag / DT), 0, HIST - 1);
    return this.hist[(this.histI - 1 - k + HIST * 2) % HIST];
  }

  /** 0=何もなし 1=崩れに入った 2=転倒した */
  update(dt: number): number {
    const off = this.bal.off;
    let vd: V2;
    if (this.fallT > 0) {
      // 倒れている: 床を少し滑って止まるだけ
      this.fallT -= dt;
      this.v = mul(this.v, Math.exp(-dt * 6));
      this.p = madd(this.p, this.v, dt);
      if (this.fallT <= 0) {
        this.fallT = 0;
        this.getUpT = 0.4;
        this.bal.reset(V());
        this.v = V();
      }
      for (const hd of this.hands) hd.cmd = null;
      this.updateHands(dt);
      if (this.labelT > 0) this.labelT -= dt;
      this.pushHist();
      return 0;
    }
    // 崩れている最中に、崩れた向きと逆へ戻ろうとすると足がもつれてずれが大きくなる（アンクルブレイク）
    if (off && this.airT <= 0) {
      const want = this.vCmd ?? sub(this.tgt, this.p);
      const wl = len(want);
      const cl0 = len(this.bal.c);
      if (wl > 0.2 && cl0 > 1e-4 && dot(mul(want, 1 / wl), mul(this.bal.c, 1 / cl0)) < -0.3) {
        const grow = this.crossedT > 0 ? 1.0 : 0.35;
        this.bal.c = madd(this.bal.c, this.bal.c, (grow * dt * (1.2 - n(this.a.agility)) * Math.min(1, wl / 2.5)));
      }
    }
    if (this.airT > 0) {
      vd = this.v;
    } else if (this.screenHeld > 0) {
      // スクリーンに当たって止められている
      vd = V();
    } else if (off) {
      // 崩れているあいだは重心を追いかけて足が出る（立て直しの踏み出し）
      vd = madd(this.bal.cv, this.bal.c, 2.5 + 3 * n(this.a.balance));
    } else if (this.vCmd) {
      vd = this.vCmd;
    } else {
      const d = sub(this.tgt, this.p);
      const L = len(d);
      if (L < 0.04) vd = V();
      else {
        const sp = Math.min(this.speedNow() * this.spd, Math.sqrt(2 * this.brakeNow * 0.6 * L));
        vd = mul(d, sp / L);
      }
    }

    // 体の向きに対する移動方向で上限が変わる（前1.0 / 横 / 後ろ）
    const sp = len(vd);
    if (sp > 1e-6 && this.airT <= 0) {
      const dir = mul(vd, 1 / sp);
      const cap = this.speedNow() * this.dirSpeedFactor(dir) * (1 - 0.3 * this.stance) * (off ? 0.6 : 1) * (this.getUpT > 0 ? 0.3 : 1) * (1 - 0.55 * this.bend) * (this.landT > 0 ? 0.5 : 1);
      if (sp > cap) vd = mul(dir, cap);
    }

    // 加速度の上限。寄せた向きへは速く、逆へは遅い
    if (this.airT <= 0) {
      const dv = sub(vd, this.v);
      const dvl = len(dv);
      if (dvl > 1e-9) {
        // ブレーキ成分: 今の進行方向の速度を落とす向き。地面を踏んで止まる（加速より強い）
        const spNow = len(this.v);
        let dvB = V();
        let dvA = dv;
        if (spNow > 0.05) {
          const u = mul(this.v, 1 / spNow);
          const along = dot(dv, u);
          if (along < 0) {
            // 止まるのは今の速さまで（その先の逆向きは加速で出す）
            const b = Math.max(along, -spNow);
            dvB = mul(u, b);
            dvA = sub(dv, dvB);
          }
        }
        const bl = len(dvB);
        let braked = V();
        if (bl > 1e-9) {
          const k = Math.min(1, (this.brakeNow * (off ? 0.8 : 1) * (this.landT > 0 ? 0.35 : 1) * dt) / bl);
          braked = mul(dvB, k);
          this.v = add(this.v, braked);
          // 体重を寄せた向き（フェイクにつられた向き）へ動いていたなら、その体重は止められない＝重心が置いていかれる
          const lm = len(this.bal.lean) / LEAN_MAX;
          const committed = spNow > 1.2 && lm > 0.15 ? Math.max(0, dot(norm(this.bal.lean), mul(dvB, -1 / Math.max(1e-6, bl)))) * lm : 0;
          if (committed > 0.35 && bl > spNow * 0.4 && this.crossedT <= 0) {
            this.crossedT = 0.6;
            this.fallWhy = "アンクルブレイク";
            this.fallWhyT = 0.9;
          }
          // 踏ん張ったぶん体（重心）も一緒に止まる（体だけ滑っていかない）。急いでいなければ少しだけ
          this.bal.cv = madd(this.bal.cv, braked, lerp(0.15, 0.5 + 0.3 * n(this.a.balance), this.urgency) * (1 - 0.9 * committed));
        }
        // 加速成分（向きの加速しやすさ・体重の寄せ・構え）
        const al = len(dvA);
        if (al > 1e-9) {
          const dir = mul(dvA, 1 / al);
          let am = this.accelMax * (1 + 0.15 * this.stance) * this.dirAccelFactor(dir);
          const lm = len(this.bal.lean) / LEAN_MAX;
          if (lm > 0.01) {
            const k = dot(dir, norm(this.bal.lean));
            am *= k >= 0 ? 1 + 0.35 * lm * k : 1 + 0.5 * lm * k;
          }
          if (off) am *= 0.8; // 立て直しの踏み出し
          if (this.landT > 0) am *= 0.35; // 着地の硬直
          this.v = madd(this.v, dvA, Math.min(1, (am * dt) / al));
        }
      }
    }
    this.p = madd(this.p, this.v, dt);

    const want = this.face ?? (len(vd) > 0.3 ? vd : null);
    if (want && this.airT <= 0) this.f = rotateTowards(this.f, want, this.turnRate() * dt);

    this.stance += clamp(this.stanceCmd - this.stance, -3 * dt, 3 * dt);

    const K = 40 + 30 * n(this.a.balance);
    const minOff = 0.3 + 0.35 * (1 - n(this.a.balance));
    const lc = len(this.leanCmd);
    this.bal.lean = lc > 1 ? mul(this.leanCmd, LEAN_MAX / lc) : mul(this.leanCmd, LEAN_MAX);
    if (off) this.bal.lean = V();
    const entered = this.bal.step(dt, this.v, K, this.supportR(), minOff, this.airT <= 0);
    if (this.getUpT > 0) this.getUpT -= dt;
    if (this.landT > 0 && this.airT <= 0) this.landT = Math.max(0, this.landT - dt);
    if (this.crossedT > 0) this.crossedT -= dt;
    // 地上で重心が支持円から大きく外れたら転倒
    let fellNow = false;
    if (this.airT <= 0 && this.bal.off && this.bal.ratio > this.fallLimit()) {
      this.startFall(this.fallWhy || "重心が大きく外れた");
      fellNow = true;
    }

    if (this.screenHeld > 0) this.screenHeld = Math.max(0, this.screenHeld - dt);
    this.bend += clamp(this.bendCmd - this.bend, -4 * dt, 4 * dt);
    if (this.shoveCd > 0) this.shoveCd -= dt;
    if (this.lungeT > 0) { this.lungeT -= dt; this.lunge = Math.min(1, this.lunge + dt * 7); }
    else this.lunge = Math.max(0, this.lunge - dt * 3);
    if (this.airT > 0) {
      this.airT -= dt;
      if (this.airT <= 0) {
        this.airT = 0;
        this.airDur = 0;
        // 着地: 足で横の勢いを吸収する（体は3〜4割まで、重心も同じように止まる）
        // 空中では踏ん張れない＝押されたずれがそのまま残る。着地の瞬間に大きければ転倒
        if (this.bal.ratio > this.fallLimit() && this.fallT <= 0) {
          this.startFall("空中で押されて着地");
          return 2;
        }
        if (this.bal.ratio > 1 && !this.bal.off) { this.bal.off = true; this.bal.offT = 0; this.bal.falls++; }
        const keep = lerp(0.8, 0.42 - 0.12 * n(this.a.balance), this.urgency);
        this.v = mul(this.v, keep);
        this.bal.cv = mul(this.bal.cv, keep + 0.1);
        // 着地の硬直: 高く跳んだほど長く、バランスが良いほど短い。重心のずれが大きければさらに延びる
        this.landT = Math.max(this.landT, Math.min(0.75, (0.2 + 0.35 * (this.jumpHNow / 0.9)) * (1.25 - 0.5 * n(this.a.balance)) + 0.15 * Math.min(1, this.bal.ratio)));
        // 膝を曲げて衝撃を吸収する（構えが深くなる）
        this.stance = Math.max(this.stance, 0.7);
      }
    }

    this.updateHands(dt);

    const decay = Math.exp(-dt * 6);
    this.sell = mul(this.sell, decay);
    this.sellStop *= decay;
    this.sellShot *= decay;
    if (this.labelT > 0) this.labelT -= dt;

    this.pushHist();
    if (this.fallWhyT > 0) { this.fallWhyT -= dt; if (this.fallWhyT <= 0) this.fallWhy = ""; }
    return fellNow ? 2 : entered ? 1 : 0;
  }

  /** 攻守交代: コート中心で180°回した座標へ（x,z を反転）。表示は Game.flip で逆に回すので画面上は動かない */
  flipFrame(): void {
    const ng = (v: V2): V2 => ({ x: -v.x, z: -v.z });
    this.p = ng(this.p);
    this.v = ng(this.v);
    this.f = ng(this.f);
    this.tgt = ng(this.tgt);
    if (this.vCmd) this.vCmd = ng(this.vCmd);
    if (this.face) this.face = ng(this.face);
    this.leanCmd = ng(this.leanCmd);
    this.sell = ng(this.sell);
    this.fallDir = ng(this.fallDir);
    this.bal.c = ng(this.bal.c);
    this.bal.cv = ng(this.bal.cv);
    this.bal.lean = ng(this.bal.lean);
    for (const h of this.hands) { h.off = { x: -h.off.x, y: h.off.y, z: -h.off.z }; h.cmd = null; }
    for (const s of this.hist) { s.p = ng(s.p); s.v = ng(s.v); s.sell = ng(s.sell); }
  }

  private pushHist(): void {
    const s = this.hist[this.histI];
    s.p = copy(this.p);
    s.v = copy(this.v);
    s.sell = copy(this.sell);
    s.sellStop = this.sellStop;
    s.sellShot = this.sellShot;
    this.histI = (this.histI + 1) % HIST;
  }

  /** ボールを持っている手の位置（平面） */
  handPos(): V2 {
    const b = this.ballHand();
    return { x: b.x, z: b.z };
  }
}
