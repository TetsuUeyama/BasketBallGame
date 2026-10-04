// 選手（円柱）。位置は加速度制限つきの移動でしか変わらない（ワープ禁止）。
// AI は「行きたい場所(tgt) / 直接の速度指令(vCmd) / 向きたい向き(face) / 構え / 体重の寄せ」だけを出す。
import { Attrs, PlayerDef, n } from "./attrs";
import { Balance } from "./balance";
import { BALL_MASS } from "./court";
import {
  V, V2, add, angleBetween, clamp, copy, dist, dot, len, lerp, madd, mul, norm, rot, rotateTowards, sub,
} from "./math";

export const DT = 1 / 60;
export type Team = 0 | 1;
/** 体重の寄せの最大量 [m] */
export const LEAN_MAX = 0.12;
/** 上半身の前屈の最大 [rad]（約77°） */
export const TRUNK_MAX = 1.35;
/** かがむ（bend）ぶんの下半身の前傾の最大 [rad]（かがみきったとき、約29°） */
export const LOWER_TILT_MAX = 0.5;
/** 上半身の前屈に対する下半身の前傾の割合（上半身を曲げると下半身もこの割合で一緒に傾く） */
export const LOWER_PER_TRUNK = 0.25;
/** 上半身のひねりの最大 [rad]（下半身の前から左右に85°） */
export const TWIST_MAX = (85 * Math.PI) / 180;
/** 上半身をひねる速さ [rad/s] */
export const TWIST_RATE = 5;
/** 頭の向きの最大 [rad]（上半身の前から左右に85°） */
export const HEAD_MAX = (85 * Math.PI) / 180;
/** 頭を向ける速さ [rad/s] */
export const HEAD_RATE = 9;
/** パスを出せる向き: 上半身の前から左右に90°（真横）まで */
export const PASS_ARC = Math.PI / 2;

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
  /**
   * ボールをキープして守っている（ハンドラー）。受けた直後・突破中・ムーブ中・パスやシュートの構え中は守れない。
   * 守っている間はボールの出方（exposure）が小さく、スティールの手が届く見込みも低い
   */
  protecting = false;
  /** 押し込みドリブル中（ゴールに背を向け、マークを背中で押してゴール下へ進む） */
  postUp = false;
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
  /** 腰をかがめる量（0..1。膝と股関節を曲げて腰＝上半身の付け根を下げる）。毎フレームAI/手の狙いが決める */
  bend = 0;
  bendCmd = 0;
  /** 上半身の前屈（腰から上の角度 rad、0=直立〜TRUNK_MAX）。後ろへは倒せない。毎フレーム手の狙いが決める */
  trunk = 0;
  trunkCmd = 0;
  /** 上半身のひねり（下半身の向き f に対する角度 rad、angleBetween と同じ向きが正、±TWIST_MAX） */
  twist = 0;
  twistCmd = 0;
  /** 頭の向き（上半身の前 upperF に対する角度 rad、angleBetween と同じ向きが正、±HEAD_MAX） */
  headYaw = 0;
  /** 見たい所（毎フレーム手の狙いと一緒に決める。null なら上半身の前） */
  lookAt: V2 | null = null;
  /** 着地で上半身を曲げて衝撃を吸収している前屈（rad、時間で戻る） */
  landFlex = 0;
  /**
   * フォロースルー: シュート・パスを放った後、投げた向きへ上半身を傾け、戻すまで次の動きに移れない。
   * followMax = 傾ける最大の角度(rad)、followT = 戻しきるまでの残り時間、followDur = 合計、followDir = 投げた向き
   */
  followMax = 0;
  followT = 0;
  followDur = 0;
  followDir: V2 = V(0, 1);
  /** スクリーンに止められている残り時間（足が出せない） */
  screenHeld = 0;
  /** オンボール守備の警戒の向き。+1=シュート警戒（密着・手を上げる） / -1=ドライブ警戒（離れて低く広く） */
  guardFocus = 0;

  hands: Hand[] = [
    { off: { x: 0, y: -0.8, z: 0 }, cmd: null },
    { off: { x: 0, y: -0.8, z: 0 }, cmd: null },
  ];

  /** キャッチで手がボールに押し込まれた後、手の戻りが遅い残り時間 */
  giveT = 0;

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
   * スティールで手を出して空振りした（または取りきれなかった）後、体が流れて構え直すまでの残り時間。
   * この間は遅く・跳べず、導線の到達時間にもこの時間が足される（＝抑えていた導線が開く）
   */
  commitT = 0;
  /** ふらついている（転倒の手前で踏みとどまろうとしている）。この間は跳べず、足は重心を追いかけるだけ */
  staggering = false;
  /** ふらつき始めてからの時間 */
  staggerT = 0;

  /**
   * 転倒する重心のずれ（支持円の何倍か）。普段の崩れ(1.0倍)よりずっと大きい。
   * バランスが良いほど・構えているほど倒れにくい。
   */
  fallLimit(): number { return 2.6 + 0.8 * n(this.a.balance) + 0.3 * this.stance - (this.crossedT > 0 ? 1.1 : 0); }

  /**
   * ふらつきで持ちこたえられる重心のずれの限界（支持円の何倍か）。
   * fallLimit を超えてもここまでは転ばずに「ふらつく」（足を素早く何歩も出して重心を追いかけて戻る）。超えたら転倒。
   * バランスが良いほど幅が広い。
   */
  staggerLimit(): number { return this.fallLimit() + 1.0 + 0.8 * n(this.a.balance); }

  private startFall(why: string): void {
    const c = this.bal.c;
    const l = len(c);
    this.fallDir = l > 1e-4 ? mul(c, 1 / l) : (len(this.v) > 0.1 ? norm(this.v) : this.f);
    this.fallDur = 1.0 + 0.9 * (1 - n(this.a.balance)) + Math.min(0.3, 0.15 * (this.bal.ratio - this.fallLimit()));
    this.fallT = this.fallDur;
    this.fallWhy = why;
    this.airT = 0;
    this.airDur = 0;
    this.staggering = false;
    this.lunge = 0;
    this.lungeT = 0;
    this.stance = 0;
    this.followT = 0;
  }

  get armLen(): number { return this.a.height * 0.44 * (1 + 0.22 * this.lunge); }
  /** 手の速さ（肩に対して）[m/s] */
  get handSpeed(): number { return 6 + 6 * n(this.a.reaction); }
  /** 直立（かがまず・上半身を曲げない）ときの肩の高さ。AI が「高い/低い」の基準に使う */
  get shoulderY(): number { return this.a.height * 0.81 * (1 - 0.12 * this.stance); }

  // ---- 体の分割: 下半身（足〜腰）＋上半身（腰〜肩・頭）。腰が上半身の付け根 ----
  /** 下半身の長さ＝足から腰まで（構え・かがむで縮む） */
  get legLen(): number { return this.a.height * 0.52 * (1 - 0.12 * this.stance) * (1 - 0.4 * this.bend); }
  /** 下半身の前傾 [rad]（かがむほど、また上半身を前へ曲げるほど脚ごと前へ傾き、腰が前へ出る） */
  get lowerTilt(): number { return LOWER_TILT_MAX * this.bend + LOWER_PER_TRUNK * this.trunkNow; }
  /** 腰の高さ */
  get hipY(): number { return this.legLen * Math.cos(this.lowerTilt); }
  /** 腰が足の真上から前（下半身の向き f）へ出る量 */
  get hipFwd(): number { return this.legLen * Math.sin(this.lowerTilt); }
  /** 腰から肩までの長さ（直立なら hipY + torsoLen = shoulderY） */
  get torsoLen(): number { return this.a.height * 0.29 * (1 - 0.12 * this.stance); }
  /** 今の上半身の前屈（狙いの前屈＋着地の吸収） */
  get trunkNow(): number { return Math.min(TRUNK_MAX, this.trunk + this.landFlex + this.followNow); }
  /** フォロースルーの今の前傾: 最初の25%で傾けきり、残りで戻す */
  get followNow(): number {
    if (this.followT <= 0 || this.followDur <= 0) return 0;
    const u = 1 - this.followT / this.followDur;
    return this.followMax * (u < 0.25 ? u / 0.25 : (1 - u) / 0.75);
  }
  /** フォロースルー中（上半身を戻しきるまで次の動きに移れない） */
  get following(): boolean { return this.followT > 0; }

  /**
   * シュート・パスを放った: 投げた向き dir へ上半身を傾ける。飛ばす距離が長いほど深く（パスは 0.1〜0.55rad、
   * シュートは腕で押し出すぶん浅く 0.08〜0.4rad）、深いほど戻すのに時間がかかる（バランスが良いほど速い）。
   */
  followThrough(dir: V2, distance: number, shot: boolean, scale = 1): void {
    const flex = (shot ? clamp(0.05 + 0.03 * distance, 0.08, 0.4) : clamp(0.06 + 0.04 * distance, 0.1, 0.55)) * scale;
    this.followMax = flex;
    this.followDur = (0.12 + 0.8 * flex) * (1.15 - 0.3 * n(this.a.balance));
    this.followT = this.followDur;
    this.followDir = norm(dir);
  }
  /** 上半身の前（下半身の向きからひねった向き） */
  upperF(): V2 { return this.twist === 0 ? this.f : rot(this.f, this.twist); }
  /** 頭の前（上半身の前から頭を回した向き） */
  headF(): V2 { return rot(this.upperF(), this.headYaw); }

  /**
   * 向き dir へパスを出せるようになるまでの時間。パスは上半身の前から真横（PASS_ARC）までしか出せない。
   * 足（下半身）の向きはそのままで上半身をひねって向け（±TWIST_MAX、TWIST_RATE）、ひねりきっても足りない分だけ足を回す（turnRate）。
   * ひねりと足の回転は同時に進む。
   */
  passTurnTime(dir: V2): number {
    const aF = angleBetween(this.f, dir);
    const sg = aF >= 0 ? 1 : -1;
    // 上半身を下半身からどれだけひねれば dir が上半身の真横以内に入るか
    const need = Math.max(0, Math.abs(aF) - PASS_ARC);
    if (need <= 0) return 0;
    const twistNeed = Math.min(need, TWIST_MAX);
    const tTwist = Math.max(0, twistNeed - this.twist * sg) / TWIST_RATE;
    const tFeet = Math.max(0, need - TWIST_MAX) / this.turnRate();
    return Math.max(tTwist, tFeet);
  }

  /** 今の上半身の向きで dir へパスを出せるか（前から真横まで） */
  canPassTo(dir: V2): boolean {
    return Math.abs(angleBetween(this.upperF(), dir)) <= PASS_ARC + 1e-3;
  }

  /** 腰（上半身の付け根）の位置 */
  hip(): V3 {
    const k = this.hipFwd;
    return { x: this.p.x + this.f.x * k, y: this.hipY + this.airY(), z: this.p.z + this.f.z * k };
  }

  shoulder(i: number): V3 {
    const fu = this.upperF();
    const r = { x: -fu.z, z: fu.x };
    const w = (this.radius + 0.04) * HAND_SIDE[i];
    const th = this.trunkNow;
    const T = this.torsoLen;
    // 上半身を前へ曲げると肩は前へ出て下がる。飛び込み（リーチイン）でも肩が前へ
    const fw = T * Math.sin(th) + 0.22 * this.lunge;
    const hp = this.hip();
    const y = hp.y + T * Math.cos(th) - 0.15 * this.lunge;
    return { x: hp.x + r.x * w + fu.x * fw, y, z: hp.z + r.z * w + fu.z * fw };
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

  /**
   * 低いボールへ深くかがみ（構え1.0・腰を落とし）、上半身を前へ曲げて手を伸ばしたときに届く水平距離。
   * 上半身の曲げ方は届く距離が最も長くなる角度を選ぶ。届かなければ -1
   */
  handReachLow(y: number): number {
    const h = this.a.height;
    // かがみきった姿勢: 下半身は LOWER_TILT_MAX＋上半身の前屈の LOWER_PER_TRUNK 倍だけ前へ傾き、腰は前へ出て下がる
    const leg = h * 0.52 * 0.88 * 0.6;
    const T = h * 0.29 * 0.88;
    const L = this.armLen;
    let best = -1;
    for (let k = 0; k <= 6; k++) {
      const th = (TRUNK_MAX * k) / 6;
      const lt = LOWER_TILT_MAX + LOWER_PER_TRUNK * th;
      const hip = leg * Math.cos(lt);
      const hipF = leg * Math.sin(lt);
      const dy = y - (hip + T * Math.cos(th));
      if (Math.abs(dy) > L) continue;
      best = Math.max(best, this.radius + 0.04 + hipF + T * Math.sin(th) + Math.sqrt(L * L - dy * dy));
    }
    return best < 0 ? -1 : best * 0.9;
  }

  private restOff(i: number): V3 {
    const fu = this.upperF();
    const r = { x: -fu.z, z: fu.x };
    const s = HAND_SIDE[i] * 0.05;
    return { x: fu.x * 0.12 + r.x * s, y: -this.armLen * 0.85, z: fu.z * 0.12 + r.z * s };
  }

  /**
   * キャッチ: ボールの勢い v（m/s、ワールド）で両手が押し込まれ（v×0.045、最大0.3m）、少しのあいだ手の戻りが遅い。
   * 体（重心）にもボールの運動量（質量比）が伝わる。
   */
  catchGive(v: V3): void {
    let dx = v.x * 0.045, dy = v.y * 0.045, dz = v.z * 0.045;
    const l = Math.hypot(dx, dy, dz);
    if (l > 0.3) { dx *= 0.3 / l; dy *= 0.3 / l; dz *= 0.3 / l; }
    const L = this.armLen;
    for (const h of this.hands) {
      let o = { x: h.off.x + dx, y: h.off.y + dy, z: h.off.z + dz };
      const ol = Math.hypot(o.x, o.y, o.z);
      if (ol > L) o = { x: (o.x * L) / ol, y: (o.y * L) / ol, z: (o.z * L) / ol };
      h.off = o;
    }
    this.giveT = 0.2;
    this.bal.kick({ x: (v.x * BALL_MASS) / this.mass, z: (v.z * BALL_MASS) / this.mass });
  }

  private updateHands(dt: number): void {
    const L = this.armLen;
    // キャッチの直後は手がボールの重さを受けてゆっくり戻る
    if (this.giveT > 0) this.giveT = Math.max(0, this.giveT - dt);
    const maxStep = this.handSpeed * dt * (this.giveT > 0 ? 0.25 : 1);
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
    if (this.airT > 0 || this.bal.off || this.staggering || this.commitT > 0 || this.fallT > 0 || this.getUpT > 0 || this.landT > 0 || this.followT > 0) return;
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

  /** 0=何もなし 1=崩れに入った 2=転倒した 3=ふらついた（転倒の手前で踏みとどまる） */
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
      // ふらつき中はもっと素早く足を出して（小刻みに何歩も）重心を追いかける
      vd = madd(this.bal.cv, this.bal.c, (this.staggering ? 4.5 : 2.5) + 3 * n(this.a.balance));
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
      const cap = this.speedNow() * this.dirSpeedFactor(dir) * (1 - 0.3 * this.stance) * (this.staggering ? 0.85 : off ? 0.6 : 1) * (this.getUpT > 0 ? 0.3 : 1) * (1 - 0.55 * this.bend) * (this.landT > 0 ? 0.5 : 1) * (this.followT > 0 ? 0.25 : 1) * (this.commitT > 0 ? 0.35 : 1);
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
          if (this.staggering) am *= 1.15; // ふらつき: 慌てて足を出す
          else if (off) am *= 0.8; // 立て直しの踏み出し
          if (this.landT > 0) am *= 0.35; // 着地の硬直
          if (this.followT > 0) am *= 0.3; // フォロースルー（上半身を戻すまで動き出せない）
          if (this.commitT > 0) am *= 0.4; // スティールの空振りで体が流れている
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
    const entered = this.bal.step(dt, this.v, K, this.supportR(), minOff, this.airT <= 0, this.f);
    if (this.getUpT > 0) this.getUpT -= dt;
    if (this.landT > 0 && this.airT <= 0) this.landT = Math.max(0, this.landT - dt);
    if (this.crossedT > 0) this.crossedT -= dt;
    // 地上で重心が支持円から大きく外れたら: ふらつきの限界までは踏みとどまる（ふらつく）、超えたら転倒
    let fellNow = false;
    let staggerNow = false;
    if (this.airT <= 0 && this.bal.off) {
      if (this.bal.ratio > this.staggerLimit()) {
        this.startFall(this.fallWhy || "重心が大きく外れた");
        fellNow = true;
      } else if (this.bal.ratio > this.fallLimit() && !this.staggering) {
        this.staggering = true;
        this.staggerT = 0;
        staggerNow = true;
      }
    }
    if (this.staggering) {
      this.staggerT += dt;
      // 重心が支持円の中へ戻り、最低0.35秒ふらついたら持ち直す
      if (this.bal.ratio < 0.8 && this.staggerT > 0.35) this.staggering = false;
    }

    if (this.screenHeld > 0) this.screenHeld = Math.max(0, this.screenHeld - dt);
    this.bend += clamp(this.bendCmd - this.bend, -4 * dt, 4 * dt);
    // 上半身: 前屈は 0..TRUNK_MAX（後ろへは倒せない）、ひねりは ±TWIST_MAX
    this.trunk = clamp(this.trunk + clamp(this.trunkCmd - this.trunk, -3 * dt, 3 * dt), 0, TRUNK_MAX);
    // フォロースルー中は上半身を投げた向きへひねる（手の狙いのひねりより優先）
    if (this.followT > 0) this.twistCmd = clamp(angleBetween(this.f, this.followDir), -TWIST_MAX, TWIST_MAX);
    this.twist = clamp(this.twist + clamp(this.twistCmd - this.twist, -TWIST_RATE * dt, TWIST_RATE * dt), -TWIST_MAX, TWIST_MAX);
    // 頭: 見たい所へ（上半身の前から ±HEAD_MAX）
    {
      const want = this.lookAt && dist(this.lookAt, this.p) > 0.05 ? clamp(angleBetween(this.upperF(), sub(this.lookAt, this.p)), -HEAD_MAX, HEAD_MAX) : 0;
      this.headYaw = clamp(this.headYaw + clamp(want - this.headYaw, -HEAD_RATE * dt, HEAD_RATE * dt), -HEAD_MAX, HEAD_MAX);
    }
    if (this.landFlex > 0) this.landFlex = Math.max(0, this.landFlex - 1.6 * dt);
    if (this.followT > 0) this.followT = Math.max(0, this.followT - dt);
    if (this.commitT > 0) this.commitT = Math.max(0, this.commitT - dt);
    if (this.shoveCd > 0) this.shoveCd -= dt;
    if (this.lungeT > 0) { this.lungeT -= dt; this.lunge = Math.min(1, this.lunge + dt * 7); }
    else this.lunge = Math.max(0, this.lunge - dt * 3);
    if (this.airT > 0) {
      this.airT -= dt;
      if (this.airT <= 0) {
        this.airT = 0;
        this.airDur = 0;
        // 着地: 上半身を前へ曲げて衝撃を吸収する（高く跳んだ・勢いがあるほど深く、バランスが良いほど上手に）。
        // 吸収したぶん重心のずれが小さくなり、着地の硬直も短い
        const flex = clamp((0.15 + 0.35 * (this.jumpHNow / 0.9) + 0.04 * len(this.v)) * (0.8 + 0.4 * n(this.a.balance)), 0, 0.6);
        this.landFlex = Math.max(this.landFlex, flex);
        const absorb = flex / 0.6;
        this.bal.c = mul(this.bal.c, 1 - 0.15 * absorb);
        this.bal.ratio = this.bal.measure(this.supportR(), this.f);
        // 足で横の勢いを吸収する（体は3〜4割まで、重心も同じように止まる）
        // 空中では踏ん張れない＝押されたずれがそのまま残る。着地の瞬間に大きければ転倒
        if (this.bal.ratio > this.staggerLimit() && this.fallT <= 0) {
          this.startFall("空中で押されて着地");
          return 2;
        }
        if (this.bal.ratio > this.fallLimit() && !this.staggering) {
          this.bal.off = true;
          this.staggering = true;
          this.staggerT = 0;
          staggerNow = true;
        }
        if (this.bal.ratio > 1 && !this.bal.off) { this.bal.off = true; this.bal.offT = 0; this.bal.falls++; }
        const keep = lerp(0.8, 0.42 - 0.12 * n(this.a.balance), this.urgency);
        this.v = mul(this.v, keep);
        this.bal.cv = mul(this.bal.cv, keep + 0.1);
        // 着地の硬直: 高く跳んだほど長く、バランスが良いほど短い。重心のずれが大きければさらに延びる
        this.landT = Math.max(this.landT, Math.min(0.75, (0.2 + 0.35 * (this.jumpHNow / 0.9)) * (1.25 - 0.5 * n(this.a.balance)) + 0.15 * Math.min(1, this.bal.ratio)) * (1 - 0.2 * absorb));
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
    return fellNow ? 2 : staggerNow ? 3 : entered ? 1 : 0;
  }

  /** 攻守交代: コート中心で180°回した座標へ（x,z を反転）。表示は Game.flip で逆に回すので画面上は動かない */
  flipFrame(): void {
    const ng = (v: V2): V2 => ({ x: -v.x, z: -v.z });
    this.p = ng(this.p);
    this.v = ng(this.v);
    this.f = ng(this.f);
    this.followDir = ng(this.followDir);
    if (this.lookAt) this.lookAt = ng(this.lookAt);
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
