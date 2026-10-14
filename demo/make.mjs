// Record the Kanopy demo video from the live verifier page.
//
//   node demo/make.mjs [--chrome <path>] [--url <verifier url>]
//
// Each scene is narrated with a built-in Windows voice (demo/tts.ps1), recorded from headless
// Chrome over the DevTools protocol while a scripted cursor works the page, and cut to the length
// of its narration. ffmpeg joins the scenes and burns in captions. Writes demo/out/kanopy-demo.mp4
// (narrated) and demo/out/kanopy-demo-silent.mp4 (captions only, for recording your own voice),
// plus demo/out/narration.txt.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, "build"), OUT = path.join(HERE, "out");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const CHROME = arg("--chrome", "C:/Program Files/Google/Chrome/Application/chrome.exe");
const URL = arg("--url", "https://kamhq.com/kanopy/verify/");
const W = 1280, H = 720, SCALE = 1.5; // CSS pixels, recorded at 1920x1080
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(BUILD, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

// ── the script ──────────────────────────────────────────────────────────────
// `text` is the caption; `say` (if given) is how the voice should pronounce it.
const S = [
  { id: "title", card: "title",
    text: "Kanopy: forest baselines anyone can check. Built by Kam Edge for the IEEE ClimateChain Global Hackathon, in the Climate Data and Environmental Monitoring track." },
  { id: "problem", card: "problem",
    text: "Nigeria's forest reserves are disappearing, but the numbers behind forest carbon usually arrive as a consultant's report. You can't rerun it. You can't tell if it was changed. And nothing stops two projects drawn over the same forest from both counting it." },
  { id: "measure", area: "omo",
    text: "This is the Kanopy verifier, live at kamhq.com/kanopy/verify. Omo Forest Reserve in Ogun State covers about 132,000 hectares. Almost 15,000 hectares of tree cover have been lost since 2001, and under 17 percent is still undisturbed forest. The carbon stock is 17.7 million tonnes of CO₂, plus or minus 11. We publish the uncertainty, not just the number.",
    say: "This is the Kanopy verifier, live at kam H Q dot com, slash kanopy, slash verify. Omo Forest Reserve in Ogun State covers about 132,000 hectares. Almost 15,000 hectares of tree cover have been lost since 2001, and under 17 percent is still undisturbed forest. The carbon stock is 17.7 million tonnes of C O 2, plus or minus 11. We publish the uncertainty, not just the number.",
    async run(p) {
      await p.at(0.12, () => p.scrollTo("#h-figures", 70));
      await p.at(0.3, () => p.hover(".tile:nth-child(1)"));
      await p.at(0.42, () => p.hover(".tile:nth-child(2)"));
      await p.at(0.55, () => p.hover("#bars svg rect:last-of-type"));
      await p.at(0.66, () => p.hover(".tile:nth-child(3)"));
      await p.at(0.78, () => p.hover(".tile:nth-child(4)"));
    } },
  { id: "fingerprints", area: "omo",
    text: "Every measurement is fingerprinted: the boundary, ten satellite rasters, the analysis code and the result. The fingerprints live in our registry contract on Ethereum Sepolia. This page recomputes them in your browser and compares. All six match.",
    async run(p) {
      await p.at(0.02, () => p.scrollTo("#h-checks", 24));
      await p.at(0.2, () => p.hover("#checks tbody tr:nth-child(5) td:nth-child(2)"));
      await p.at(0.32, () => p.hover("#checks tbody tr:nth-child(3) td:nth-child(2)"));
      await p.at(0.42, () => p.hover("#checks tbody tr:nth-child(4) td:nth-child(2)"));
      await p.at(0.52, () => p.hover("#checks tbody tr:nth-child(1) td:nth-child(2)"));
      await p.at(0.62, () => p.hover("#checks tbody tr:nth-child(1) td.hash"));
      await p.at(0.84, () => p.hover("#verdict"));
    } },
  { id: "tamper", area: "omo",
    text: "Now let's tamper with it. We halve the forest loss and inflate the carbon stock in the browser's copy. Two fingerprints fail immediately. Restore the file, and everything matches again. Nobody, including us, can quietly edit a baseline.",
    async run(p) {
      await p.at(0.08, () => p.click("#tamper"));
      await p.at(0.4, () => p.hover("#checks tbody tr:nth-child(1) td:last-child"));
      await p.at(0.5, () => p.hover("#checks tbody tr:nth-child(6) td:last-child"));
      await p.at(0.62, () => p.click("#restore"));
      await p.at(0.85, () => p.hover("#verdict"));
    } },
  { id: "claims", area: "omo",
    text: "The registry also records who counts which ground. The world is cut into grid cells of one hundredth of a degree, about 122 hectares each. Omo's steward has claimed all 1,083 cells for 2025. Try to claim them again, and the contract refuses.",
    async run(p) {
      await p.at(0.02, () => p.scrollTo("#h-figures", 70));
      await p.at(0.2, () => p.hover("#map svg rect.cell:nth-of-type(400)"));
      await p.at(0.45, () => p.scrollTo("#h-claim", 160));
      await p.at(0.55, () => p.hover("#claim dl"));
      await p.at(0.74, () => p.click("#claim .btn"));
      await p.waitFor(`!!document.querySelector("#claim .outcome:not([hidden])")`); await p.hold(2500);
    } },
  { id: "overlap", area: "omo",
    text: "Here is a test project: a rectangle we drew across Omo's eastern edge. 173 of its 300 cells are already counted, shown hatched on the map. When its steward tries to claim, the smart contract rejects it. Double counting is stopped by the contract itself, not by paperwork.",
    async run(p) {
      await p.at(0.0, () => p.scrollTo("#tabs", 140));
      await p.at(0.06, () => p.click('#tabs button[data-key="overlap"]'));
      await p.waitFor(`!!document.querySelector("#verdict .st") && document.querySelectorAll("#map svg g rect").length > 0`);
      await p.at(0.18, () => p.scrollTo("#h-figures", 70));
      await p.at(0.3, () => p.hover("#map svg g rect:nth-of-type(60)"));
      await p.at(0.5, () => p.scrollTo("#h-claim", 160));
      await p.at(0.6, () => p.click("#claim .btn"));
      await p.waitFor(`!!document.querySelector("#claim .outcome:not([hidden])")`); await p.hold(2500);
      await p.at(0.8, () => p.hover("#claim .outcome code"));
    } },
  { id: "pandam", area: "overlap",
    text: "Pandam Wildlife Park, open savanna in Plateau State, has no claim yet. The same call would be accepted.",
    async run(p) {
      await p.at(0.0, () => p.scrollTo("#tabs", 140));
      await p.at(0.06, () => p.click('#tabs button[data-key="pandam"]'));
      await p.waitFor(`!!document.querySelector("#verdict .st") && !document.getElementById("note").textContent`);
      await p.at(0.3, () => p.scrollTo("#h-claim", 160));
      await p.at(0.45, () => p.click("#claim .btn"));
      await p.waitFor(`!!document.querySelector("#claim .outcome:not([hidden])")`); await p.hold(2500);
    } },
  { id: "terminal", card: "terminal",
    text: "For a full check, anyone can clone the repository and run verify.py. It reruns the analysis from the raw satellite rasters, recomputes every fingerprint, and then asks the chain. Fifteen contract tests run against the real reserve footprints.",
    say: "For a full check, anyone can clone the repository and run verify dot pie. It reruns the analysis from the raw satellite rasters, recomputes every fingerprint, and then asks the chain. Fifteen contract tests run against the real reserve footprints." },
  { id: "next", card: "next",
    text: "Kanopy doesn't issue credits. It is the measurement and the ledger underneath them. Next, we'll fly LiDAR drones to measure forest structure directly, and install IoT sensors that sign their readings, with batches anchored on-chain. A chainsaw alert becomes a tamper-evident record.",
    say: "Kanopy doesn't issue credits. It is the measurement and the ledger underneath them. Next, we'll fly lidar drones to measure forest structure directly, and install I O T sensors that sign their readings, with batches anchored on chain. A chainsaw alert becomes a tamper-evident record." },
  { id: "close", card: "close", text: "Kanopy. The forest, measured. The measurement, checkable." },
];

// ── narration ───────────────────────────────────────────────────────────────
function duration(file) {
  return Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString().trim());
}
const LEAD = 0.4, TAIL = 0.9; // seconds of picture before and after the voice
S.forEach((s, k) => {
  s.n = String(k + 1).padStart(2, "0");
  s.wav = path.join(BUILD, `${s.n}-${s.id}.wav`);
  const txt = path.join(BUILD, `${s.n}-${s.id}.txt`), say = s.say || s.text;
  if (!fs.existsSync(s.wav) || !fs.existsSync(txt) || fs.readFileSync(txt, "utf8") !== say) {
    fs.writeFileSync(txt, say);
    execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(HERE, "tts.ps1"), txt, s.wav]);
  }
  s.voice = duration(s.wav);
  console.log(`${s.n} ${s.id.padEnd(12)} voice ${s.voice.toFixed(1)}s`);
});

// ── cards ───────────────────────────────────────────────────────────────────
const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
function terminalLines() {
  const verify = fs.readFileSync(path.join(BUILD, "verify_omo.txt"), "utf8").trim().split(/\r?\n/);
  // check.js runs after the recompute, but its output reaches a redirected file first
  const split = verify.findIndex((l) => l.startsWith("wdpa-36820  recomputed"));
  const recompute = verify.slice(split), chain = verify.slice(0, split).filter((l, i, a) => l || a[i - 1]);
  const tests = fs.readFileSync(path.join(BUILD, "tests.txt"), "utf8").split(/\r?\n/).filter((l) => /✔|passing|KanopyRegistry|^\s{4}\w/.test(l));
  return [
    ["cmd", "$ python tools/verify.py omo"], ...recompute.map((l) => ["out", l]), ["out", ""], ...chain.map((l) => ["out", l]),
    ["break", ""],
    ["cmd", "$ npx hardhat test"], ...tests.map((l) => ["out", l]),
  ];
}
function card(s) {
  const base = `<!doctype html><meta charset="utf-8"><style>
  :root{--bg:#111;--fg:#fff;--dim:#b0b0b0;--mute:#7d7d7d;--hair:#262626;--accent:#35d07f}
  *{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font-family:Inter,"Segoe UI",Arial,sans-serif;-webkit-font-smoothing:antialiased}
  .wrap{position:absolute;inset:0;padding:84px 104px;display:flex;flex-direction:column;justify-content:center;gap:22px}
  .eyebrow{color:var(--accent);font-size:13px;font-weight:700;letter-spacing:3px;text-transform:uppercase}
  h1{font-size:64px;line-height:1.04;letter-spacing:-.02em;margin:0}h1 span{color:var(--mute)}
  p{color:var(--dim);font-size:22px;line-height:1.5;margin:0;max-width:900px}
  .brand{position:absolute;left:104px;top:56px;display:flex;align-items:center;gap:12px;font-size:13px;font-weight:700;letter-spacing:3px;text-transform:uppercase}
  .glyph{width:16px;height:16px;border:2px solid var(--accent);position:relative}.glyph:after{content:"";position:absolute;inset:3px;background:var(--accent)}
  .list{display:grid;gap:14px;margin-top:6px}.list div{display:flex;gap:16px;font-size:24px;color:var(--fg);align-items:baseline}
  .list b{color:var(--accent);font-size:13px;letter-spacing:2px;min-width:70px}
  .fade{opacity:0;transform:translateY(10px);animation:in .7s ease forwards}@keyframes in{to{opacity:1;transform:none}}
  .links{display:grid;gap:10px;font:20px/1.4 ui-monospace,Consolas,monospace;color:var(--fg)}.links span{color:var(--mute);display:inline-block;min-width:120px;font-family:Inter,"Segoe UI",Arial,sans-serif;font-size:13px;letter-spacing:2px;text-transform:uppercase}
  .term{position:absolute;inset:56px 80px;border:1px solid var(--hair);background:#0b0b0b;padding:26px 30px;font:14.5px/1.55 ui-monospace,Consolas,monospace;color:#cfcfcf;overflow:hidden;white-space:pre}
  .term .cmd{color:var(--accent)}.term .ok{color:var(--accent)}
  </style><div class="brand"><span class="glyph"></span>Kanopy</div>`;
  const d = (k) => `style="animation-delay:${k}s"`;
  if (s.card === "title") return base + `<div class="wrap">
    <div class="eyebrow fade" ${d(0.1)}>IEEE ClimateChain Global Hackathon · Climate Data &amp; Environmental Monitoring</div>
    <h1 class="fade" ${d(0.3)}>The forest, measured.<br><span>The measurement, checkable.</span></h1>
    <p class="fade" ${d(0.8)}>Forest reserve baselines from open satellite data, fingerprinted in a public registry so anyone can recompute and verify them. By Kam Edge.</p></div>`;
  if (s.card === "problem") return base + `<div class="wrap">
    <div class="eyebrow fade" ${d(0.1)}>The problem</div>
    <h1 class="fade" style="font-size:48px;animation-delay:.3s">Forest carbon numbers you have to take on trust.</h1>
    <div class="list">
      <div class="fade" ${d(s.voice * 0.42)}><b>01</b>You can't rerun them.</div>
      <div class="fade" ${d(s.voice * 0.55)}><b>02</b>You can't tell if they were changed.</div>
      <div class="fade" ${d(s.voice * 0.68)}><b>03</b>Two projects can count the same forest.</div></div></div>`;
  if (s.card === "next") return base + `<div class="wrap">
    <div class="eyebrow fade" ${d(0.1)}>What it is, and what comes next</div>
    <h1 class="fade" style="font-size:44px;animation-delay:.3s">Not a credit. The measurement and the ledger underneath one.</h1>
    <div class="list">
      <div class="fade" ${d(s.voice * 0.36)}><b>LIDAR</b>Drone surveys that measure forest structure directly</div>
      <div class="fade" ${d(s.voice * 0.56)}><b>IOT</b>Field sensors that sign their readings, anchored on-chain</div>
      <div class="fade" ${d(s.voice * 0.78)}><b>ALERTS</b>A chainsaw heard becomes a tamper-evident record</div></div></div>`;
  if (s.card === "close") return base + `<div class="wrap">
    <h1 class="fade" ${d(0.1)}>The forest, measured.<br><span>The measurement, checkable.</span></h1>
    <div class="links fade" ${d(0.9)}>
      <div><span>Try it</span>kamhq.com/kanopy/verify</div>
      <div><span>Code</span>github.com/anaivi1960/kanopy</div>
      <div><span>Registry</span>Sepolia 0x21166Dd8970adFF801effE70232c1cB6e8C3Fd17</div></div></div>`;
  if (s.card === "terminal") {
    const lines = terminalLines(), per = (s.voice * 0.92) / lines.length;
    const html = lines.map(([k, t], i) => `<div class="fade" style="animation:in .15s ease forwards;animation-delay:${(i * per).toFixed(2)}s" data-k="${k}">${
      k === "cmd" ? `<span class="cmd">${esc(t)}</span>` : esc(t).replace(/^(\s*)(match|✔)/, '$1<span class="ok">$2</span>')}</div>`).join("");
    // the test listing replaces the verify output once it starts, like a cleared screen
    const at = (lines.findIndex(([k]) => k === "break") * per).toFixed(2);
    return base + `<div class="term">${html}</div><script>setTimeout(()=>{const t=document.querySelector(".term");let on=false;for(const e of [...t.children]){if(e.dataset.k==="break"){on=true;}if(!on)e.remove();}},${at}*1000)</script>`;
  }
}

// ── browser ─────────────────────────────────────────────────────────────────
const PORT = 9391;
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(BUILD, "chrome-profile")}`, `--window-size=${W},${H}`, "--mute-audio", "about:blank"], { stdio: "ignore" });
let target;
for (let i = 0; i < 60 && !target; i++) { await sleep(500); try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === "page"); } catch {} }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0; const pending = new Map(), listeners = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result ?? d); pending.delete(d.id); }
  else if (d.method) listeners.forEach((f) => f(d));
};
const send = (method, params = {}) => new Promise((r) => { pending.set(++seq, r); ws.send(JSON.stringify({ id: seq, method, params })); });
const ev = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: SCALE, mobile: false });
await send("Page.enable");

const CURSOR = `(() => { if (document.getElementById("__cur")) return;
  const c = document.createElement("div"); c.id = "__cur";
  c.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M4 2.5l14.5 9.2-6.3 1.4 3.7 6.9-2.8 1.5-3.6-6.9L4.6 19z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  Object.assign(c.style, { position: "fixed", left: "0", top: "0", zIndex: 99999, pointerEvents: "none", transition: "transform .85s cubic-bezier(.45,0,.2,1)",
    transform: "translate(" + (window.__cx ?? ${W * 0.62}) + "px," + (window.__cy ?? ${H * 0.56}) + "px)" });
  document.documentElement.appendChild(c); })()`;
const centre = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null;
  const r = e.getBoundingClientRect(); return { x: r.left + Math.min(r.width / 2, 220), y: r.top + r.height / 2 }; })()`);
async function moveTo(x, y) {
  await ev(`window.__cx=${x};window.__cy=${y};document.getElementById("__cur").style.transform="translate(${x}px,${y}px)"`);
  await sleep(900);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
}
const P = {
  t0: 0, D: 0,
  async at(frac, fn) { const due = this.t0 + frac * this.D * 1000; if (Date.now() < due) await sleep(due - Date.now()); await fn(); },
  async scrollTo(sel, offset) {
    await ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); window.scrollTo({ top: e.getBoundingClientRect().top + scrollY - ${offset}, behavior: "smooth" }); })()`);
    await sleep(1300);
  },
  async hover(sel) { const c = await centre(sel); if (c) await moveTo(c.x, c.y); else console.warn("  no element", sel); },
  async click(sel) {
    const c = await centre(sel); if (!c) return console.warn("  no element", sel);
    await moveTo(c.x, c.y);
    await ev(`(() => { const r = document.createElement("div"); Object.assign(r.style, { position: "fixed", left: ${c.x - 18}+"px", top: ${c.y - 18}+"px", width: "36px", height: "36px",
      borderRadius: "50%", border: "2px solid #35d07f", zIndex: 99998, pointerEvents: "none", transition: "transform .5s ease, opacity .5s ease" });
      document.documentElement.appendChild(r); requestAnimationFrame(() => { r.style.transform = "scale(1.8)"; r.style.opacity = "0"; }); setTimeout(() => r.remove(), 600); })()`);
    await ev(`document.querySelector(${JSON.stringify(sel)}).click()`);
    await sleep(400);
  },
  hold: (ms) => sleep(ms),
  async waitFor(expr, ms = 45000) { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return; await sleep(300); } console.warn("  timed out waiting for", expr); },
};

async function open(url, ready) {
  await send("Page.navigate", { url });
  await sleep(800);
  if (ready) await P.waitFor(ready, 90000);
  await ev(CURSOR);
}

// ── record ──────────────────────────────────────────────────────────────────
let current = null;
listeners.push((d) => {
  if (d.method !== "Page.screencastFrame") return;
  send("Page.screencastFrameAck", { sessionId: d.params.sessionId });
  if (!current) return;
  const f = path.join(current.dir, `${String(current.frames.length).padStart(5, "0")}.jpg`);
  fs.writeFileSync(f, Buffer.from(d.params.data, "base64"));
  current.frames.push({ f, t: Date.now() });
});
const PAGE_READY = `!!document.querySelector("#verdict .st") && document.querySelector("#net").textContent.includes("Registry")`;
let area = null;
for (const s of S) {
  if (s.card) {
    const file = path.join(BUILD, `${s.n}-${s.id}.html`);
    fs.writeFileSync(file, card(s));
    await open(pathToFileURL(file).href);
    await ev(`document.getElementById("__cur").style.display="none"`);
    area = null;
  } else if (area !== s.area) {
    await open(`${URL}?area=${s.area}`, PAGE_READY);
    area = s.area;
  }
  if (s.id === "measure") await ev("scrollTo(0,0)");
  const dir = path.join(BUILD, `${s.n}-${s.id}`);
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir);
  current = { dir, frames: [] };
  P.D = s.voice; P.t0 = Date.now() + LEAD * 1000;
  await send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: W * SCALE, maxHeight: H * SCALE, everyNthFrame: 1 });
  // nudge the compositor so the first frame arrives at once even on a still page
  await ev(`document.body.style.outline="0 solid transparent";requestAnimationFrame(()=>document.body.style.outline="")`);
  if (s.run) await s.run(P);
  const end = P.t0 + (s.voice + TAIL) * 1000;
  if (Date.now() < end) await sleep(end - Date.now());
  await ev(`document.body.style.outline="0 solid transparent";requestAnimationFrame(()=>document.body.style.outline="")`);
  await sleep(250);
  await send("Page.stopScreencast");
  s.frames = current.frames; s.start = current.frames[0]?.t; s.length = (Date.now() - s.start) / 1000;
  current = null;
  if (s.id === "pandam") area = "pandam";
  if (s.id === "overlap") area = "overlap";
  console.log(`${s.n} ${s.id.padEnd(12)} recorded ${s.frames.length} frames, ${s.length.toFixed(1)}s`);
}
ws.close(); chrome.kill();

// ── assemble ────────────────────────────────────────────────────────────────
const ff = (args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { cwd: BUILD, stdio: "inherit" });
const parts = [];
let clock = 0;
const srt = [];
const stamp = (t) => { const ms = Math.round(t * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, sec = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`; };
for (const s of S) {
  const list = s.frames.map((fr, i) => {
    const next = i + 1 < s.frames.length ? s.frames[i + 1].t : s.start + s.length * 1000;
    return `file '${path.basename(s.frames[i].f)}'\nduration ${((next - fr.t) / 1000).toFixed(3)}`;
  }).join("\n") + `\nfile '${path.basename(s.frames.at(-1).f)}'\n`;
  fs.writeFileSync(path.join(BUILD, `${s.n}-${s.id}`, "frames.txt"), list);
  const out = `${s.n}-${s.id}.mp4`, fade = s.card ? `,fade=t=in:st=0:d=0.35,fade=t=out:st=${(s.length - 0.4).toFixed(2)}:d=0.4` : "";
  ff(["-f", "concat", "-safe", "0", "-i", `${s.n}-${s.id}/frames.txt`, "-i", path.basename(s.wav),
    "-filter_complex", `[0:v]fps=30,scale=1920:1080:flags=lanczos,format=yuv420p${fade}[v];[1:a]aresample=48000,adelay=${LEAD * 1000}|${LEAD * 1000},apad[a]`,
    "-map", "[v]", "-map", "[a]", "-t", s.length.toFixed(3), "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-r", "30",
    "-c:a", "aac", "-b:a", "160k", "-ac", "2", out]);
  parts.push(out);
  // captions: one sentence at a time, timed by its share of the narration
  const sentences = s.text.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g).map((x) => x.trim()).filter(Boolean);
  const total = sentences.reduce((n, x) => n + x.length, 0);
  let t = clock + LEAD;
  for (const x of sentences) {
    const d = (x.length / total) * s.voice;
    srt.push(`${srt.length + 1}\n${stamp(t)} --> ${stamp(t + d - 0.05)}\n${x}\n`);
    t += d;
  }
  clock += s.length;
}
fs.writeFileSync(path.join(BUILD, "parts.txt"), parts.map((p) => `file '${p}'`).join("\n") + "\n");
fs.writeFileSync(path.join(BUILD, "captions.srt"), srt.join("\n"));
ff(["-f", "concat", "-safe", "0", "-i", "parts.txt", "-c", "copy", "joined.mp4"]);
const style = "FontName=Segoe UI,FontSize=11,PrimaryColour=&H00FFFFFF,OutlineColour=&H40000000,BorderStyle=3,Outline=7,Shadow=0,MarginV=14,MarginL=40,MarginR=40";
ff(["-i", "joined.mp4", "-vf", `subtitles=captions.srt:force_style='${style}'`, "-c:v", "libx264", "-preset", "medium", "-crf", "19",
  "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "48000", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", path.join(OUT, "kanopy-demo.mp4")]);
ff(["-i", path.join(OUT, "kanopy-demo.mp4"), "-c:v", "copy", "-an", "-movflags", "+faststart", path.join(OUT, "kanopy-demo-silent.mp4")]);
fs.writeFileSync(path.join(OUT, "narration.txt"), S.map((s) => `[${s.n} ${s.id}]\n${s.text}\n`).join("\n"));
fs.copyFileSync(path.join(BUILD, "captions.srt"), path.join(OUT, "kanopy-demo.srt"));
console.log(`done: ${clock.toFixed(1)}s -> demo/out/kanopy-demo.mp4`);
