// セットオフェンス（ハンドラーがコール）と、守備の対抗策（カバレッジ）の選択。
// プレーは「導線を作る仕掛け」: スクリーンで守備者の到達時間を遅らせ、カットで待ち合わせの導線を作る。
import { n } from "./attrs";
import { RIM, SPOT } from "./court";
import { V, V2, dirTo, dist, dot, lerpV, madd, mul, right, sub, Rng } from "./math";
import type { Offense } from "./offense";
import { Player } from "./player";

export type CallId = "MOTION" | "PNR" | "PNP" | "HORNS" | "PINDOWN" | "BACKSCREEN" | "DHO" | "ISO";
export type CoverageId =
  | "MAN" | "PACK" | "DENY" | "DROP" | "HEDGE" | "SWITCH" | "ICE" | "BLITZ"
  | "CHASE" | "UNDER" | "HELP" | "NOHELP" | "DOUBLE";

export const CALL_LABEL: Record<CallId, string> = {
  MOTION: "モーション（ドライブ&キック）",
  PNR: "ピック&ロール",
  PNP: "ピック&ポップ",
  HORNS: "ホーンズ",
  PINDOWN: "ピンダウン",
  BACKSCREEN: "バックスクリーン（ロブ）",
  DHO: "ハンドオフ",
  ISO: "アイソレーション",
};

export const COVER_LABEL: Record<CoverageId, string> = {
  MAN: "マンツーマン",
  PACK: "パックライン（ドライブの導線を消す）",
  DENY: "ディナイ（パスの導線を消す）",
  DROP: "ドロップ",
  HEDGE: "ヘッジ",
  SWITCH: "スイッチ",
  ICE: "ICE（スクリーンを使わせない）",
  BLITZ: "ブリッツ（トラップ）",
  CHASE: "チェイス（オーバーで追う）",
  UNDER: "アンダー",
  HELP: "ヘルプ",
  NOHELP: "ノーヘルプ（シューター優先）",
  DOUBLE: "ダブルチーム",
};

export interface Play {
  id: CallId;
  /** スクリーンの向き（+1/-1） */
  side: number;
  done: boolean;
  /** ハンドラーが自由に1on1してよいか */
  iso: boolean;
  /** 関与する選手（守備の台本が参照） */
  screener: Player | null;
  user: Player | null;
  setup(o: Offense): Map<Player, V2>;
  start(o: Offense): void;
  update(o: Offense, dt: number): void;
}

/** スクリーナー S を使って U が dest へ抜けるときの通過点（S を挟んで UD の反対側） */
export function aroundScreen(S: Player, UD: Player, U: Player, dest: V2): V2 {
  const dir = dirTo(UD.p, dest);
  const perp = right(dir);
  let side = Math.sign(dot(sub(U.p, UD.p), perp));
  if (side === 0) side = 1;
  return madd(madd(S.p, perp, side * (S.radius + U.radius + 0.15)), dir, 0.2);
}

const others = (o: Offense, ex: Player[]): Player[] => o.pl.filter((p) => !ex.includes(p));
const best = (ps: Player[], f: (p: Player) => number): Player => [...ps].sort((a, b) => f(b) - f(a))[0];

// ---------------------------------------------------------------------------

class MotionPlay implements Play {
  id: CallId = "MOTION";
  side = 1;
  done = false;
  iso = true;
  screener: Player | null = null;
  user: Player | null = null;
  setup(o: Offense): Map<Player, V2> {
    const m = new Map<Player, V2>();
    const H = o.handler0;
    m.set(H, SPOT.top());
    const rest = others(o, [H]);
    const inside = rest.filter((p) => p.d.pos === "C" && p.a.three < 60).slice(0, 1);
    const outs = rest.filter((p) => !inside.includes(p));
    inside.forEach((p) => m.set(p, SPOT.dunker(1)));
    const spots = inside.length ? [SPOT.wing(1), SPOT.wing(-1), SPOT.corner(-1), SPOT.corner(1)] : [SPOT.wing(1), SPOT.wing(-1), SPOT.corner(1), SPOT.corner(-1)];
    outs.forEach((p, i) => m.set(p, spots[i % spots.length]));
    return m;
  }
  start(o: Offense): void {
    for (const p of o.pl) o.stOf(p).scripted = false;
  }
  update(): void {}
}

class PnRPlay implements Play {
  id: CallId;
  side: number;
  done = false;
  iso = false;
  screener: Player | null;
  user: Player | null = null;
  protected t = 0;
  protected phase = 0;
  protected pop: boolean;
  protected H: Player;

  constructor(id: CallId, o: Offense, rng: Rng) {
    this.id = id;
    this.side = rng.sign();
    this.H = o.handler0;
    const bigs = o.bigs().filter((p) => p !== this.H).slice(0, 3);
    this.screener = id === "PNP" ? best(bigs, (p) => p.a.three) : bigs[0];
    this.pop = id === "PNP" || (this.screener.a.three >= 72 && rng.chance(0.4));
  }

  setup(o: Offense): Map<Player, V2> {
    const m = new Map<Player, V2>();
    const s = this.side;
    m.set(this.H, SPOT.top());
    m.set(this.screener!, SPOT.elbow(s));
    const rest = others(o, [this.H, this.screener!]);
    const spots = [SPOT.corner(s), SPOT.corner(-s), SPOT.wing(-s)];
    rest.forEach((p, i) => m.set(p, spots[i % spots.length]));
    return m;
  }

  start(o: Offense): void {
    this.user = this.H;
    o.setScreen(this.screener!, this.H, null, this.pop ? "pop" : "roll", this.pop ? SPOT.slot(-this.side) : null, 2.2);
    for (const p of others(o, [this.H, this.screener!])) o.stOf(p).scripted = false;
  }

  update(o: Offense, dt: number): void {
    this.t += dt;
    const h = o.handler();
    const S = this.screener!;
    const st = o.stOf(S);
    if (!h || h !== this.H) { this.finish(o); return; }
    if (this.phase === 0) {
      if (st.mode === "screen" && st.setT > 0.15) {
        this.phase = 1;
        // スクリーナーは守備者の死角（背中側）で守備者の進む向きをふさいでいる。
        // ハンドラーはスクリーナーの肩をかすめて抜け、守備者がスクリーナーの向こうに止められてできたギャップを下る
        const axis = dirTo(h.p, RIM);
        const sideV = mul(right(axis), this.side);
        const r = S.radius + h.radius;
        const brush = madd(madd(S.p, axis, -(r + 0.2)), sideV, 0.3);
        const turn = madd(madd(S.p, sideV, r + 0.35), axis, 0.5);
        const down = madd(turn, axis, 1.6);
        // 離れていれば、まず逆へ半歩見せて守備者を寄せてから
        o.setGoal(dist(h.p, brush) > 1.4 ? [madd(h.p, sideV, -0.6), brush, turn, down] : [brush, turn, down]);
        o.g.log(`${o.g.tag(S)} がオンボールスクリーン`, "screen", o.team);
      } else if (this.t > 5) this.finish(o);
    } else if (this.phase === 1) {
      if (st.mode !== "screen") { this.phase = 2; this.t = 0; this.iso = true; }
      else if (this.t > 7) this.finish(o);
    } else if (this.t > 2.5) {
      this.finish(o);
    }
  }

  protected finish(o: Offense): void {
    if (this.done) return;
    this.done = true;
    this.iso = true;
    o.setGoal(null);
    o.toFlow();
  }
}

class HornsPlay extends PnRPlay {
  private b2: Player;
  private chosen = false;
  constructor(o: Offense, rng: Rng) {
    super("HORNS", o, rng);
    const bigs = o.bigs().filter((p) => p !== this.H).slice(0, 2);
    this.b2 = bigs[1] ?? bigs[0];
    this.screener = bigs[0];
  }
  setup(o: Offense): Map<Player, V2> {
    const m = new Map<Player, V2>();
    m.set(this.H, SPOT.top());
    m.set(this.screener!, SPOT.elbow(1));
    m.set(this.b2, SPOT.elbow(-1));
    const rest = others(o, [this.H, this.screener!, this.b2]);
    rest.forEach((p, i) => m.set(p, SPOT.corner(i === 0 ? 1 : -1)));
    return m;
  }
  start(o: Offense): void {
    this.user = this.H;
    for (const p of others(o, [this.H])) o.stOf(p).scripted = false;
    o.stOf(this.screener!).scripted = true;
    o.stOf(this.b2).scripted = true;
  }
  update(o: Offense, dt: number): void {
    if (!this.chosen) {
      this.t += dt;
      if (this.t < 0.8) return;
      // マッチアップの弱い方（守備者の機動力が低い方）とPnR
      const mob = (p: Player) => {
        const d = o.defOf(p);
        return d ? n(d.a.speed + d.a.agility + d.a.perD) / 3 : 0.5;
      };
      if (mob(this.b2) < mob(this.screener!)) [this.screener, this.b2] = [this.b2, this.screener!];
      this.side = this.screener!.p.x >= 0 ? 1 : -1;
      this.pop = this.screener!.a.three >= 72;
      this.chosen = true;
      this.t = 0;
      o.setScreen(this.screener!, this.H, null, this.pop ? "pop" : "roll", this.pop ? SPOT.slot(-this.side) : null, 2.2);
      if (this.b2.a.three >= 65) o.setSpot(this.b2, SPOT.slot(-this.side), true);
      else o.setCut(this.b2, [SPOT.dunker(-this.side)], false, 1.5, "ダイブ");
      return;
    }
    super.update(o, dt);
  }
}

class PinDownPlay implements Play {
  id: CallId = "PINDOWN";
  side: number;
  done = false;
  iso = false;
  screener: Player | null;
  user: Player | null;
  private H: Player;
  private t = 0;
  private phase = 0;
  constructor(o: Offense, rng: Rng) {
    this.side = rng.sign();
    this.H = o.handler0;
    const rest = others(o, [this.H]);
    this.user = best(rest.filter((p) => p.d.pos !== "C"), (p) => p.a.three);
    this.screener = best(others(o, [this.H, this.user]), (p) => p.a.screen + p.a.height * 20);
  }
  setup(o: Offense): Map<Player, V2> {
    const s = this.side;
    const m = new Map<Player, V2>();
    m.set(this.H, SPOT.top());
    m.set(this.user!, V(2.7 * s, 12.0));
    m.set(this.screener!, V(3.0 * s, 9.4));
    const rest = others(o, [this.H, this.user!, this.screener!]);
    const spots = [SPOT.corner(-s), SPOT.wing(-s)];
    rest.forEach((p, i) => m.set(p, spots[i % 2]));
    return m;
  }
  start(o: Offense): void {
    for (const p of others(o, [this.H, this.user!, this.screener!])) o.stOf(p).scripted = false;
    o.stOf(this.user!).scripted = true;
    o.setScreen(this.screener!, this.user!, SPOT.wing(this.side), "spot", SPOT.elbow(this.side), 2.2);
    o.setGoal([SPOT.slot(this.side)]);
  }
  update(o: Offense, dt: number): void {
    this.t += dt;
    const h = o.handler();
    if (!h || h !== this.H) { this.finish(o); return; }
    const S = this.screener!, U = this.user!;
    const st = o.stOf(S);
    if (this.phase === 0) {
      if (st.mode === "screen" && st.setT > 0.15) {
        this.phase = 1;
        const UD = o.defOf(U);
        const dest = SPOT.wing(this.side);
        const pass = UD ? aroundScreen(S, UD, U, dest) : S.p;
        // 守備者がぴったり付いてくる → カールでリムへ／離れている → 外へ出て撃つ
        const trail = UD ? dist(UD.p, U.p) < 1.0 : false;
        if (trail) {
          o.setCut(U, [pass, madd(RIM, dirTo(RIM, pass), 1.3)], false, 1.6, "カール");
          o.g.log(`${o.g.tag(U)} がピンダウンをカール`, "screen", o.team);
        } else {
          o.setCut(U, [pass, dest], false, 1.5, "ピンダウン");
          o.g.log(`${o.g.tag(U)} がピンダウンから外へ`, "screen", o.team);
        }
        this.t = 0;
      } else if (this.t > 5) this.finish(o);
    } else if (this.t > 3.5) {
      this.finish(o);
    }
  }
  private finish(o: Offense): void {
    if (this.done) return;
    this.done = true;
    this.iso = true;
    o.setGoal(null);
    o.toFlow();
  }
}

class BackScreenPlay implements Play {
  id: CallId = "BACKSCREEN";
  side: number;
  done = false;
  iso = false;
  screener: Player | null;
  user: Player | null;
  private H: Player;
  private t = 0;
  private phase = 0;
  constructor(o: Offense, rng: Rng) {
    this.side = rng.sign();
    this.H = o.handler0;
    const rest = others(o, [this.H]);
    this.user = best(rest.filter((p) => p.d.pos !== "C"), (p) => p.reachMax * 50 + p.a.finish + p.a.speed * 0.5);
    this.screener = best(others(o, [this.H, this.user]), (p) => p.a.screen + p.a.height * 20);
  }
  setup(o: Offense): Map<Player, V2> {
    const s = this.side;
    const m = new Map<Player, V2>();
    m.set(this.H, SPOT.slot(s));
    m.set(this.user!, SPOT.wing(s));
    m.set(this.screener!, SPOT.elbow(s));
    const rest = others(o, [this.H, this.user!, this.screener!]);
    const spots = [SPOT.corner(-s), SPOT.wing(-s)];
    rest.forEach((p, i) => m.set(p, spots[i % 2]));
    return m;
  }
  start(o: Offense): void {
    for (const p of others(o, [this.H, this.user!, this.screener!])) o.stOf(p).scripted = false;
    o.stOf(this.user!).scripted = true;
    o.setScreen(this.screener!, this.user!, RIM, "pop", SPOT.top(), 1.8);
  }
  update(o: Offense, dt: number): void {
    this.t += dt;
    const h = o.handler();
    if (!h || h !== this.H) { this.finish(o); return; }
    const S = this.screener!, U = this.user!;
    const st = o.stOf(S);
    if (this.phase === 0) {
      if (st.mode === "screen" && st.setT > 0.15) {
        this.phase = 1;
        const UD = o.defOf(U);
        const pass = UD ? aroundScreen(S, UD, U, RIM) : S.p;
        const alley = U.reachMax >= 3.3 && h.a.passing >= 55;
        o.setCut(U, [pass, madd(RIM, dirTo(RIM, pass), 0.9)], alley, alley ? 3.25 : 1.6, alley ? "アリウープ狙い" : "バックカット");
        o.g.log(`${o.g.tag(S)} のバックスクリーン → ${o.g.tag(U)} がリムへ${alley ? "（アリウープ狙い）" : ""}`, "screen", o.team);
        this.t = 0;
      } else if (this.t > 5) this.finish(o);
    } else if (this.t > 3) {
      this.finish(o);
    }
  }
  private finish(o: Offense): void {
    if (this.done) return;
    this.done = true;
    this.iso = true;
    o.toFlow();
  }
}

class DhoPlay implements Play {
  id: CallId = "DHO";
  side: number;
  done = false;
  iso = false;
  screener: Player | null;
  user: Player | null;
  private H: Player;
  private R: Player;
  private t = 0;
  private phase = 0;
  constructor(o: Offense, rng: Rng) {
    this.side = rng.sign();
    this.H = o.handler0;
    this.R = best(others(o, [this.H]).filter((p) => p.d.pos !== "C"), (p) => p.a.three + p.a.handle * 0.5);
    this.screener = this.H;
    this.user = this.R;
  }
  setup(o: Offense): Map<Player, V2> {
    const s = this.side;
    const m = new Map<Player, V2>();
    m.set(this.H, SPOT.top());
    m.set(this.R, SPOT.wing(s));
    const rest = others(o, [this.H, this.R]);
    const spots = [SPOT.corner(-s), SPOT.wing(-s), SPOT.dunker(-s)];
    rest.forEach((p, i) => m.set(p, spots[i % 3]));
    return m;
  }
  start(o: Offense): void {
    for (const p of others(o, [this.H, this.R])) o.stOf(p).scripted = false;
    o.setGoal([lerpV(SPOT.slot(this.side), SPOT.wing(this.side), 0.3)]);
    const st = o.stOf(this.R);
    st.mode = "handoff";
    st.scripted = true;
  }
  update(o: Offense, dt: number): void {
    this.t += dt;
    const h = o.handler();
    if (this.phase === 0) {
      if (!h || h !== this.H) { this.finish(o); return; }
      if (dist(h.p, this.R.p) < 1.25 && !o.hs.passing && !o.hs.shooting) {
        o.forcePass(h, this.R, "ハンドオフ");
        this.phase = 1;
        this.t = 0;
      } else if (this.t > 5) this.finish(o);
    } else if (this.phase === 1) {
      if (h === this.R) {
        // 受けた勢いのままドリブル。渡した側はそのままスクリーンになる
        o.hs.dribbled = true;
        const after = this.H.a.three >= 65 ? "pop" : "roll";
        o.setScreen(this.H, this.R, RIM, after, after === "pop" ? SPOT.slot(-this.side) : null, 1.4);
        this.phase = 2;
        this.t = 0;
      } else if (this.t > 1.5) this.finish(o);
    } else if (this.t > 2.5 || h !== this.R) {
      this.finish(o);
    }
  }
  private finish(o: Offense): void {
    if (this.done) return;
    this.done = true;
    this.iso = true;
    o.setGoal(null);
    o.toFlow();
  }
}

class IsoPlay implements Play {
  id: CallId = "ISO";
  side: number;
  done = false;
  iso = true;
  screener: Player | null = null;
  user: Player | null = null;
  private H: Player;
  private spot: V2;
  constructor(o: Offense, rng: Rng) {
    this.side = rng.sign();
    this.H = o.handler0;
    this.spot = rng.chance(0.5) ? SPOT.top() : SPOT.wing(this.side);
  }
  setup(o: Offense): Map<Player, V2> {
    const s = this.side;
    const m = new Map<Player, V2>();
    m.set(this.H, SPOT.top());
    // 片側を空ける
    const rest = others(o, [this.H]);
    const big = rest.find((p) => p.d.pos === "C" && p.a.three < 60);
    const spots = [SPOT.slot(-s), SPOT.wing(-s), SPOT.corner(-s)];
    let i = 0;
    for (const p of rest) {
      if (p === big) m.set(p, SPOT.dunker(-s));
      else m.set(p, i < spots.length ? spots[i++] : SPOT.corner(s));
    }
    if (!big) m.set(rest[rest.length - 1], SPOT.dunker(-s));
    return m;
  }
  start(o: Offense): void {
    for (const p of others(o, [this.H])) o.stOf(p).scripted = false;
    o.setGoal([this.spot]);
  }
  update(o: Offense): void {
    if (o.handler() !== this.H) { this.done = true; o.toFlow(); }
  }
}

export function createPlay(id: CallId, o: Offense, rng: Rng): Play {
  switch (id) {
    case "PNR":
    case "PNP": return new PnRPlay(id, o, rng);
    case "HORNS": return new HornsPlay(o, rng);
    case "PINDOWN": return new PinDownPlay(o, rng);
    case "BACKSCREEN": return new BackScreenPlay(o, rng);
    case "DHO": return new DhoPlay(o, rng);
    case "ISO": return new IsoPlay(o, rng);
    default: return new MotionPlay();
  }
}

// ---------------------------------------------------------------------------
// コールの選択（ハンドラーがマッチアップを見て決める）

export function chooseCall(o: Offense, rng: Rng): CallId {
  const H = o.handler0;
  const defTeam = o.g.teams[1 - o.team];
  const hd = defTeam[H.slot];
  const rest = others(o, [H]);
  const bigs = o.bigs().filter((p) => p !== H);
  const adv = (n(H.a.speed) + n(H.a.agility) + n(H.a.handle)) / 3 - (n(hd.a.perD) + n(hd.a.agility) + n(hd.a.reaction)) / 3;
  const bigMob = (p: Player) => { const d = defTeam[p.slot]; return n(d.a.speed + d.a.agility) / 2; };
  const b0 = bigs[0];
  const shooter = Math.max(...rest.map((p) => n(p.a.three)));
  const flyer = Math.max(...rest.map((p) => (p.reachMax - 3.0) * 2 + n(p.a.finish) * 0.5));
  const ids: CallId[] = ["MOTION", "PNR", "PNP", "HORNS", "PINDOWN", "BACKSCREEN", "DHO", "ISO"];
  const w = [
    0.55,
    0.5 + n(b0.a.screen) * 0.4 + (1 - bigMob(b0)) * 0.6 + (n(H.a.passing) - 0.6),
    0.15 + Math.max(...bigs.slice(0, 3).map((p) => n(p.a.three))) * 0.9 - 0.4,
    0.3 + (bigs.length >= 2 && bigs[1].a.screen >= 55 ? 0.25 : 0),
    0.15 + shooter * 0.7 - 0.3,
    0.1 + flyer * 0.5 + (n(H.a.passing) - 0.6) * 0.5,
    0.2 + shooter * 0.4 - 0.15,
    0.25 + adv * 3.0,
  ].map((x) => Math.max(0.03, x) ** 2);
  return rng.weighted(ids, w);
}

// ---------------------------------------------------------------------------
// 守備の対抗策（コールを読んだあとに選ぶ）

export function chooseCoverage(call: CallId, o: Offense, defs: Player[], rng: Rng): CoverageId {
  const play = o.play;
  const markOf = (p: Player | null) => (p ? defs[p.slot] : null);
  const H = o.handler0;
  const shootH = n(Math.max(H.a.three, H.a.mid));
  switch (call) {
    case "PNR":
    case "PNP":
    case "HORNS":
    case "DHO": {
      const S = play?.screener ?? null;
      const sd = markOf(S);
      const hd = markOf(H);
      const mob = sd ? n(sd.a.speed + sd.a.agility + sd.a.perD) / 3 : 0.5;
      const sizeGap = sd && hd ? Math.abs(sd.a.height - hd.a.height) : 0.2;
      const popper = S ? n(S.a.three) : 0.3;
      const ids: CoverageId[] = ["DROP", "HEDGE", "SWITCH", "ICE", "BLITZ"];
      const w = [
        // ドロップが基本形（リムを守る）。撃てるスクリーナー（ポップ）には弱い
        0.45 + (1 - mob) * 1.0 + (1 - shootH) * 0.5 - popper * 0.9,
        mob * 0.9,
        mob * 0.6 + (0.25 - sizeGap) * 2,
        0.35,
        n(H.a.handle + H.a.three) / 2 > 0.78 ? 0.7 : 0.1,
      ].map((x) => Math.max(0.03, x) ** 2);
      return rng.weighted(ids, w);
    }
    case "PINDOWN":
    case "BACKSCREEN": {
      const U = play?.user ?? null;
      const ids: CoverageId[] = ["CHASE", "UNDER", "SWITCH"];
      const w = call === "PINDOWN"
        ? [n(U?.a.three ?? 60) * 1.1, (1 - n(U?.a.three ?? 60)) * 1.1, 0.35]
        : [0.5, 0.15, 0.55];
      return rng.weighted(ids, w.map((x) => Math.max(0.03, x) ** 2));
    }
    case "ISO": {
      const shooters = others(o, [H]).filter((p) => p.a.three >= 72).length;
      const ids: CoverageId[] = ["HELP", "NOHELP", "DOUBLE"];
      const w = [0.6, 0.15 + shooters * 0.2, n(H.a.handle + H.a.finish) / 2 > 0.75 ? 0.6 : 0.15];
      return rng.weighted(ids, w.map((x) => x * x));
    }
    default: {
      const shoot = others(o, [H]).reduce((s, p) => s + n(p.a.three), 0) / 4;
      const ids: CoverageId[] = ["PACK", "DENY", "MAN"];
      return rng.weighted(ids, [(1 - shoot) * 1.2, shoot * 1.0, 0.4].map((x) => x * x));
    }
  }
}
