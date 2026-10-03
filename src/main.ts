// 起動と HUD。sim は固定刻み（DT）で回し、再生速度は1フレームあたりの刻み数で変える。
import type { StadiumQuality } from "./render/stadium";
import { CamMode, LaneMode, View } from "./render/view";
import { Game } from "./sim/game";
import { DT } from "./sim/player";
import type { Option } from "./sim/options";

const canvas = document.getElementById("c") as HTMLCanvasElement;
const game = new Game((Date.now() & 0xffff) + 1);
const view = new View(canvas, game);

let speed = 1;
let paused = false;
let acc = 0;
let hudT = 0;

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));

// ---------------------------------------------------------------- 操作

interface Btn { label: string; on: () => boolean; act: () => void; title?: string }
const groups: Btn[][] = [
  [{ label: "⏸", on: () => paused, act: () => { paused = !paused; }, title: "一時停止 (Space)" }],
  [0.25, 0.5, 1, 2, 4].map((s) => ({ label: `${s}x`, on: () => speed === s, act: () => { speed = s; } })),
  ([["handler", "導線"], ["all", "導線+守備"], ["off", "導線なし"]] as [LaneMode, string][]).map(([m, l]) => ({
    label: l, on: () => view.laneMode === m, act: () => { view.laneMode = m; },
  })),
  [{ label: "重心", on: () => view.showBalance, act: () => { view.showBalance = !view.showBalance; }, title: "支持円と重心 (B)" }],
  ([["side", "斜め"], ["top", "真上"], ["behind", "正面"], ["follow", "追従"]] as [CamMode, string][]).map(([m, l]) => ({
    label: l, on: () => view.camMode === m, act: () => view.setCam(m),
  })),
  ([["off", "会場なし"], ["low", "会場:軽"], ["high", "会場:高"]] as [StadiumQuality, string][]).map(([q, l]) => ({
    label: l, on: () => view.stadium.quality === q, act: () => { void view.stadium.setQuality(q).then(refreshBtns); },
  })),
];
const ctrl = $("ctrl");
const btnEls: { el: HTMLButtonElement; b: Btn }[] = [];
for (const g of groups) {
  const grp = document.createElement("div");
  grp.className = "grp";
  for (const b of g) {
    const el = document.createElement("button");
    el.textContent = b.label;
    if (b.title) el.title = b.title;
    el.onclick = () => { b.act(); refreshBtns(); };
    grp.appendChild(el);
    btnEls.push({ el, b });
  }
  ctrl.appendChild(grp);
}
function refreshBtns(): void {
  for (const { el, b } of btnEls) el.classList.toggle("on", b.on());
}
refreshBtns();

window.addEventListener("keydown", (e) => {
  if (e.code === "Space") paused = !paused;
  else if (e.key >= "1" && e.key <= "5") speed = [0.25, 0.5, 1, 2, 4][Number(e.key) - 1];
  else if (e.key === "l" || e.key === "L") view.laneMode = view.laneMode === "handler" ? "all" : view.laneMode === "all" ? "off" : "handler";
  else if (e.key === "b" || e.key === "B") view.showBalance = !view.showBalance;
  else if (e.key === "c" || e.key === "C") {
    const order: CamMode[] = ["side", "top", "behind", "follow"];
    view.setCam(order[(order.indexOf(view.camMode) + 1) % order.length]);
  } else return;
  refreshBtns();
});

// ---------------------------------------------------------------- HUD

const STYLE_SHORT: Record<string, string> = { chest: "チェスト", bounce: "バウンズ", overhead: "頭上", lob: "ロブ", jump: "ジャンプ" };
const KIND_LABEL: Record<string, string> = { shoot: "シュート", drive: "ドライブ", pass: "パス", lead: "リード", lob: "ロブ", hold: "保持" };

function optRow(o: Option, best: boolean): string {
  const open = o.lane ? o.lane.open : 1;
  const col = open < 0.5 ? `rgb(242,${Math.round(51 + open * 332)},38)` : `rgb(${Math.round(242 - (open - 0.5) * 383)},217,51)`;
  let name = KIND_LABEL[o.kind];
  if (o.lane && (o.kind === "pass" || o.kind === "lead")) name = (o.kind === "lead" ? "リード" : "") + STYLE_SHORT[o.lane.style];
  if (o.to) name += ` →#${o.to.d.num}`;
  return `<div class="row${best ? " best" : ""}"><span>${esc(name)}</span>` +
    `<span class="bar"><i style="width:${(open * 100).toFixed(0)}%;background:${col}"></i></span>` +
    `<span>${o.value.toFixed(2)}</span></div>`;
}

function hud(): void {
  const g = game;
  const off = g.offTeam;
  const cls = ["red", "blue"];
  $("score").innerHTML =
    `<span class="red">${g.names[0]} ${g.score[0]}</span>` +
    `<span class="clock">${g.phase === "live" ? Math.max(0, g.shotClock).toFixed(1) : g.phase === "setup" ? "SET" : g.phase === "throwin" ? "IN" : g.phase === "jumpball" ? "JUMP" : "—"}</span>` +
    `<span class="blue">${g.score[1]} ${g.names[1]}</span>` +
    `<span class="poss">攻撃: <span class="${cls[off]}">${g.names[off]}</span></span>`;

  const h = g.holder();
  const hTxt = h ? `${g.names[h.team]} #${h.d.num} ${h.d.pos}` : "—";
  const def = g.def;
  $("call").innerHTML =
    `<div><span class="k">攻撃コール</span> <span class="v ${cls[off]}">${esc(g.callLabel())}</span></div>` +
    `<div><span class="k">守備の対抗</span> <span class="v ${cls[1 - off]}">${esc(def.reading ? "（コールを読んでいる…）" : g.coverLabel())}</span></div>` +
    `<div><span class="k">ボール</span> ${esc(hTxt)}</div>`;

  const opts = h && h.team === off ? g.off.options : [];
  if (opts.length) {
    const sorted = [...opts].sort((a, b) => b.value - a.value).slice(0, 8);
    $("opts").innerHTML =
      `<div class="k" style="color:var(--dim);margin-bottom:3px">ハンドラーの導線（バー=開き / 数値=期待値）</div>` +
      sorted.map((o, i) => optRow(o, i === 0)).join("");
  } else {
    $("opts").innerHTML = `<div style="color:var(--dim)">導線: 赤=守備が先に届く / 緑=攻撃が先に着く<br>白線=導線を消している守備者（導線+守備）<br>足元の円=支持円・点=重心（赤=崩れ）</div>`;
  }

  const ev = g.events.slice(-9);
  $("feed").innerHTML = ev.map((e) => {
    const c = e.team === 0 ? "var(--red)" : e.team === 1 ? "var(--blue)" : "var(--fg)";
    return `<div class="${e.kind}"><span style="color:${c}">●</span> ${esc(e.text)}</div>`;
  }).join("");

  const s = g.stats;
  const pct = (m: number, a: number) => (a ? `${m}/${a}` : "0/0");
  $("stats").innerHTML =
    `<table><tr><th></th><th>FG</th><th>3P</th><th>OR</th><th>TO</th><th>STL</th><th>崩し</th></tr>` +
    [0, 1].map((t) => `<tr><td class="${cls[t]}" style="color:${t ? "var(--blue)" : "var(--red)"}">${g.names[t]}</td>` +
      `<td>${pct(s[t].fgm, s[t].fga)}</td><td>${pct(s[t].tpm, s[t].tpa)}</td><td>${s[t].oreb}</td><td>${s[t].to}</td>` +
      `<td>${s[t].stl}</td><td>${s[t].breaks}</td></tr>`).join("") + `</table>`;
}

// ---------------------------------------------------------------- ループ

view.engine.runRenderLoop(() => {
  const frame = Math.min(0.1, view.engine.getDeltaTime() / 1000);
  if (!paused) {
    acc += frame * speed;
    let n = 0;
    while (acc >= DT && n < 10) {
      game.update(DT);
      acc -= DT;
      n++;
    }
    if (n >= 10) acc = 0;
  }
  view.render(game);
  hudT -= frame;
  if (hudT <= 0) {
    hudT = 0.1;
    hud();
  }
});
window.addEventListener("resize", () => view.engine.resize());
