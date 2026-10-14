/* Kanopy verifier. Reads the published files in data/, recomputes their fingerprints in the
   browser and compares them with the registry named in deployment.json. No wallet is needed:
   every chain call here is a read. */
(() => {
  "use strict";
  const { ethers } = window;
  const $ = (id) => document.getElementById(id);
  const SVG = "http://www.w3.org/2000/svg";
  const ROW_TYPE = ["tuple(uint32 lat, uint16 word, uint256 mask)[]"];
  const LOSS_BINS = [1, 5, 15, 30]; // % of a cell lost: below 1, 1-5, 5-15, 15-30, 30 and over

  const S = { dep: null, reg: null, index: [], key: null, cur: null, names: new Map() };

  // ── small helpers ────────────────────────────────────────────────────────
  function el(tag, attrs = {}, ...kids) {
    const ns = ["svg", "rect", "path", "line", "text", "g", "defs", "pattern"].includes(tag);
    const e = ns ? document.createElementNS(SVG, tag) : document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v == null) continue;
      if (k === "class") e.setAttribute("class", v);
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null) e.append(kid);
    return e;
  }
  const fmt = (n, d = 0) => Number(n).toLocaleString("en-GB", { minimumFractionDigits: d, maximumFractionDigits: d });
  const short = (a) => `${a.slice(0, 8)}…${a.slice(-6)}`;
  const hex = (buf) => "0x" + [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const sha256 = async (bytes) => hex(await crypto.subtle.digest("SHA-256", bytes));
  const utf8 = (s) => new TextEncoder().encode(s);
  const popcount = (x) => { let n = 0; for (; x; x &= x - 1n) n++; return n; };
  const listingHash = (entries) =>
    sha256(utf8([...entries].sort((a, b) => (a.name < b.name ? -1 : 1)).map((e) => `${e.sha256}  ${e.name}\n`).join("")));
  const footprintHash = (rows) => ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(ROW_TYPE, [rows]));
  const when = (ts) => new Date(Number(ts) * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const getJson = async (url) => (await fetch(url, { cache: "no-store" })).json();

  const tip = $("tip");
  function showTip(ev, title, lines) {
    tip.replaceChildren(el("b", {}, title), ...lines.map((l) => el("span", { style: "display:block" }, l)));
    tip.hidden = false;
    const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.min(window.innerWidth - w - 8, Math.max(8, ev.clientX + pad)) + "px";
    tip.style.top = (ev.clientY + pad + h > window.innerHeight ? ev.clientY - h - pad : ev.clientY + pad) + "px";
  }
  const hideTip = () => { tip.hidden = true; };
  const spin = () => el("span", { class: "spin", "aria-hidden": "true" });
  const spinner = (text) => el("div", { class: "loading", role: "status" }, spin(), text);
  const reading = (text) => el("span", { class: "reading", role: "status" }, spin(), text);

  // ── theme: dark unless the viewer switches to light; the choice is remembered ─
  const SUN = '<circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"/>';
  const MOON = '<path d="M13.5 9.6A5.6 5.6 0 0 1 6.4 2.5a5.6 5.6 0 1 0 7.1 7.1z"/>';
  function setTheme(light, remember) {
    const root = document.documentElement, b = $("theme");
    if (light) root.dataset.theme = "light";
    else delete root.dataset.theme;
    // The button names the theme it switches TO.
    b.setAttribute("aria-pressed", String(light));
    b.setAttribute("aria-label", light ? "Dark theme" : "Light theme");
    b.querySelector("svg").innerHTML = light ? MOON : SUN;
    b.querySelector("span").textContent = light ? "Dark" : "Light";
    if (remember) try { localStorage.setItem("kanopy-theme", light ? "light" : "dark"); } catch (e) {}
  }
  setTheme(document.documentElement.dataset.theme === "light", false);
  $("theme").addEventListener("click", () => setTheme(document.documentElement.dataset.theme !== "light", true));

  // ── start ────────────────────────────────────────────────────────────────
  async function start() {
    S.index = await getJson("data/index.json");
    S.ready = connect();
    $("tabs").replaceChildren(
      ...S.index.map((r) => el("button", { type: "button", "data-key": r.key, "aria-pressed": "false", onclick: () => select(r.key) }, r.name)),
    );
    $("tamper").addEventListener("click", tamper);
    $("restore").addEventListener("click", () => select(S.key));
    const wanted = new URLSearchParams(location.search).get("area");
    await select(S.index.some((r) => r.key === wanted) ? wanted : S.index[0].key);
  }

  // Runs alongside the first file load: the page draws the measurement while the chain answers.
  async function connect() {
    try {
      S.dep = await getJson("deployment.json");
    } catch (e) {
      S.reg = null;
      $("net").textContent = "No registry deployment found";
      return;
    }
    try {
      const provider = new ethers.JsonRpcProvider(S.dep.rpcUrl, S.dep.chainId, { staticNetwork: true });
      const reg = new ethers.Contract(S.dep.address, S.dep.abi, provider);
      await reg.reserveCount();
      S.reg = reg;
      const where = `${S.dep.network} (chain ${S.dep.chainId})`;
      const addr = S.dep.explorer
        ? el("a", { href: `${S.dep.explorer.replace(/\/$/, "")}/address/${S.dep.address}`, style: "color:inherit" }, short(S.dep.address))
        : el("b", {}, short(S.dep.address));
      $("net").replaceChildren("Registry ", addr, ` on ${where}`);
      $("foot-contract").textContent = `Registry contract ${S.dep.address} on ${where}.`;
    } catch (e) {
      S.reg = null;
      $("net").textContent = `Registry unreachable at ${S.dep.rpcUrl}`;
    }
  }

  function showLoading() {
    $("tiles").replaceChildren(spinner("Loading the measurement…"));
    $("bars").replaceChildren(spinner("Loading the chart…"));
    $("map").replaceChildren(spinner("Loading the map…"));
    $("legend").replaceChildren();
    $("checks").tBodies[0].replaceChildren(el("tr", {}, el("td", { colspan: 4 }, spinner("Loading the fingerprints…"))));
    $("verdict").replaceChildren(reading("Loading…"));
    $("claim").replaceChildren(spinner("Loading…"));
  }

  async function select(key) {
    S.key = key;
    const token = (S.token = (S.token || 0) + 1); // a later tab click makes this load stale
    for (const b of $("tabs").children) b.setAttribute("aria-pressed", String(b.dataset.key === key));
    $("tamper").hidden = true;
    $("restore").hidden = true;
    $("tamper-note").hidden = true;
    showLoading();
    const base = `data/${key}/`;
    const [statsBuf, manifest, cells] = await Promise.all([
      fetch(base + "stats.json", { cache: "no-store" }).then((r) => r.arrayBuffer()),
      getJson(base + "manifest.json"),
      getJson(base + "cells.json"),
    ]);
    const rows = cells.rows.map(([lat, word, mask]) => ({ lat, word, mask: BigInt(mask) }));
    if (token !== S.token) return;
    const cur = { key, manifest, cells, rows, statsBytes: new Uint8Array(statsBuf), tampered: null, chain: null, pending: true };
    cur.stats = JSON.parse(new TextDecoder().decode(cur.statsBytes));
    S.cur = cur;
    const note = $("note");
    note.hidden = !manifest.synthetic;
    note.textContent = manifest.synthetic ? `Test area. ${manifest.boundary_note}` : "";
    await render(); // the measurement now; the registry's side fills in when it answers
    await S.ready;
    if (S.reg) cur.chain = await readChain(manifest, rows).catch((e) => ({ error: e.shortMessage || e.message }));
    if (token !== S.token) return;
    cur.pending = false;
    $("tamper").hidden = false;
    await render();
  }

  async function readChain(manifest, rows) {
    const id = ethers.encodeBytes32String(manifest.reserve_id);
    const year = S.dep.year;
    const reserve = await S.reg.reserves(id);
    if (reserve.cellCount === 0n) return { error: "This area is not in the registry." };
    const [baseline, masks, n] = await Promise.all([
      S.reg.baseline(id, reserve.baselineCount),
      S.reg.claimedMasks(year, rows),
      S.reg.claimCount(),
    ]);
    // every claim, then every unnamed claimant, each in one parallel round trip
    const all = (await Promise.all(Array.from({ length: Number(n) }, (_, k) => S.reg.getClaim(k))))
      .map((c, k) => ({ k, c })).filter(({ c }) => Number(c.year) === year);
    const unnamed = [...new Set(all.map(({ c }) => c.reserveId))].filter((i) => !S.names.has(i));
    (await Promise.all(unnamed.map((i) => S.reg.reserves(i)))).forEach((r, k) => S.names.set(unnamed[k], r.name));
    const claims = all.map(({ k, c }) => ({ id: k, reserveId: c.reserveId, name: S.names.get(c.reserveId), cells: Number(c.cellCount), version: Number(c.baselineVersion), at: c.claimedAt, by: c.claimant }));
    const taken = new Set();
    rows.forEach((r, k) => {
      for (let b = 0n; b < 256n; b++) if ((masks[k] >> b) & 1n) taken.add(`${r.lat}:${r.word * 256 + Number(b)}`);
    });
    return { id, year, reserve, baseline, claims, own: claims.find((c) => c.reserveId === id) || null, taken };
  }

  // ── render ───────────────────────────────────────────────────────────────
  async function render() {
    const c = S.cur;
    const s = c.tampered ? c.tampered.stats : c.stats;
    renderTiles(s, c);
    renderBars(s);
    renderMap(c);
    await renderChecks(c, s);
    renderClaim(c);
  }

  function renderTiles(s, c) {
    const loss = s.gfc.inside.any, moist = s.tmf.moist_forest_domain_pct >= 20;
    const tiles = [
      ["Area measured", fmt(s.area_ha), "ha", `${fmt(c.cells.cell_count)} grid cells of about ${fmt(c.cells.cell_ha_mean)} ha`],
      ["Tree cover lost, 2001 to 2025", fmt(loss.loss_total_ha), "ha", `${loss.loss_total_pct}% of the area. ${fmt(loss.loss_recent_ha_per_yr)} ha a year since 2021`],
      moist
        ? ["Undisturbed moist forest", s.tmf.undisturbed_pct_inside, "%", `${s.tmf.classes["20"].pct}% degraded, ${s.tmf.classes["30"].pct}% regrowth`]
        : ["Tree cover, 2021", s.worldcover["10"].pct, "%", `${s.worldcover["20"].pct}% shrubland. Open savanna woodland`],
      ["Carbon stock", `${fmt(s.biomass.co2e_mt, 1)} ± ${fmt(s.biomass.co2e_sd_mt, 1)}`, "Mt CO₂e", "Above ground only. ± is one standard deviation"],
    ];
    $("tiles").replaceChildren(
      ...tiles.map(([label, value, unit, sub]) =>
        el("div", { class: "tile" }, el("span", { class: "tile-label" }, label), el("div", { class: "tile-value" }, `${value} `, el("small", {}, unit)), el("div", { class: "tile-sub" }, sub)),
      ),
    );
  }

  function renderBars(s) {
    const years = s.gfc.years, vals = s.gfc.inside.any.loss_by_year_ha;
    const W = 520, H = 250, L = 44, R = 6, T = 16, B = 22, pw = W - L - R, ph = H - T - B;
    const max = Math.max(...vals), mag = 10 ** Math.floor(Math.log10(max)), step = [1, 2, 5, 10].map((m) => m * mag).find((m) => max / m <= 4);
    const top = Math.ceil(max / step) * step, y = (v) => T + ph - (v / top) * ph, band = pw / years.length;
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `Tree-cover loss by year, ${years[0]} to ${years.at(-1)}, in hectares. The largest year is ${years[vals.indexOf(max)]} with ${fmt(max)} hectares.` });
    for (let v = 0; v <= top; v += step) {
      svg.append(el("line", { class: "grid", x1: L, x2: W - R, y1: y(v), y2: y(v) }), el("text", { x: L - 6, y: y(v) + 3, "text-anchor": "end" }, fmt(v)));
    }
    years.forEach((yr, k) => {
      const x = L + k * band + 1, w = band - 2, h = Math.max(1, T + ph - y(vals[k])), r = Math.min(3, h, w / 2);
      const d = `M${x},${T + ph}v${-(h - r)}q0,${-r} ${r},${-r}h${w - 2 * r}q${r},0 ${r},${r}v${h - r}z`;
      svg.append(el("path", { class: "bar", d }));
      // a full-height strip is the hover target, so thin bars are easy to hit
      svg.append(el("rect", { x: L + k * band, y: T, width: band, height: ph, fill: "transparent",
        onmousemove: (ev) => { showTip(ev, String(yr), [`${fmt(vals[k])} ha lost`]); svg.querySelectorAll(".bar")[k].classList.add("on"); },
        onmouseleave: () => { hideTip(); svg.querySelectorAll(".bar")[k].classList.remove("on"); } }));
      if (yr % 5 === 0 || k === 0) svg.append(el("text", { x: x + w / 2, y: H - 6, "text-anchor": "middle" }, yr));
      if (vals[k] === max) svg.append(el("text", { x: x + w / 2, y: y(max) - 5, "text-anchor": k > years.length - 3 ? "end" : "middle", style: "fill:var(--fg-dim)" }, `${fmt(max)} ha`));
    });
    $("bars").replaceChildren(svg);
    $("loss-sub").textContent = "Hectares a year inside the boundary. Hansen Global Forest Change, every pixel that lost tree cover.";
  }

  function renderMap(c) {
    const cells = c.cells.cells, taken = c.chain && c.chain.taken ? c.chain.taken : new Set(), own = c.chain && c.chain.own;
    const is = cells.map((x) => x[0]), js = cells.map((x) => x[1]);
    const i0 = Math.min(...is), i1 = Math.max(...is), j0 = Math.min(...js), j1 = Math.max(...js), u = 10;
    const svg = el("svg", { viewBox: `0 0 ${(j1 - j0 + 1) * u} ${(i1 - i0 + 1) * u}`, style: "max-height:440px", role: "img",
      "aria-label": `Map of ${cells.length} grid cells shaded by the share of each cell that lost tree cover.` });
    svg.append(el("defs", {}, el("pattern", { id: "hatch", width: 4, height: 4, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" },
      el("line", { x1: 0, y1: 0, x2: 0, y2: 4, style: "stroke:var(--fg);stroke-width:1.4" }))));
    const rings = el("g");
    for (const [i, j, loss, recent] of cells) {
      const x = (j - j0) * u, y = (i1 - i) * u, bin = LOSS_BINS.filter((b) => loss >= b).length;
      const other = taken.has(`${i}:${j}`) && !own;
      const lat = (i + 0.5) / 100 - 90, lon = (j + 0.5) / 100 - 180;
      const status = c.pending ? "Reading the registry…" : !c.chain || c.chain.error ? "Registry not read" : own ? `Counted for ${c.chain.year} by this area` : other ? `Counted for ${c.chain.year} by another project` : `Not counted for ${c.chain.year}`;
      svg.append(el("rect", { class: "cell", x, y, width: u, height: u, style: `fill:var(--l${bin})`,
        onmousemove: (ev) => showTip(ev, `Cell ${i}:${j}`, [`${lat.toFixed(3)}° N, ${lon.toFixed(3)}° E`, `${loss}% lost since 2001, ${recent}% since 2021`, status]),
        onmouseleave: hideTip }));
      if (other) rings.append(el("rect", { x: x + 0.5, y: y + 0.5, width: u - 1, height: u - 1, class: "ring", style: "fill:url(#hatch);stroke:var(--fg)" }));
    }
    svg.append(rings);
    $("map").replaceChildren(svg);
    const nTaken = own ? 0 : taken.size;
    $("map-sub").textContent = `Each square is one grid cell, about ${fmt(c.cells.cell_ha_mean)} ha. North is up.`;
    const ramp = el("span", { class: "ramp" }, "Share of cell lost since 2001: ", el("span", {}, "under 1%"),
      ...[0, 1, 2, 3, 4].map((b) => el("i", { style: `background:var(--l${b})` })), el("span", {}, "30% and over"));
    const key = nTaken ? [el("span", {}, el("i", { class: "k-taken" }), `Counted for ${c.chain.year} by another project (${fmt(nTaken)} cells)`)] : [];
    $("legend").replaceChildren(ramp, ...key, ...(c.pending ? [reading("Reading claims from the registry…")] : []));
  }

  async function renderChecks(c, s) {
    const m = c.manifest, ch = c.chain && !c.chain.error ? c.chain : null;
    const bytes = c.tampered ? c.tampered.bytes : c.statsBytes;
    const kt = (mt) => Math.round(mt * 1000);
    const headline = (a, k, sd) => `${fmt(a)} ha · ${fmt(k)} ± ${fmt(sd)} kt CO₂e`;
    const rows = [
      ["Result", "stats.json: every figure on this page", "SHA-256 of the file, hashed in this browser", await sha256(bytes), ch && ch.baseline.resultHash],
      ["Footprint", `The ${fmt(c.cells.cell_count)} grid cells the area covers`, "Keccak-256 of the cell rows, hashed in this browser", footprintHash(c.rows), ch && ch.reserve.footprintHash],
      ["Inputs", `${m.inputs.length} clipped satellite rasters`, "SHA-256 of the published list of raster hashes", await listingHash(m.inputs), ch && ch.baseline.inputsHash],
      ["Code", `${m.code.length} analysis scripts`, "SHA-256 of the published list of script hashes", await listingHash(m.code), ch && ch.baseline.codeHash],
      ["Boundary", "The boundary polygon", "Published value compared. The file is checked by verify.py", "0x" + m.hashes.boundary, ch && ch.reserve.boundaryHash],
      ["Headline", "Area and carbon stock, held in the registry as numbers", "Compared with the file", headline(s.area_ha, kt(s.biomass.co2e_mt), kt(s.biomass.co2e_sd_mt)),
        ch && headline(ch.baseline.areaHa, ch.baseline.co2eKt, ch.baseline.co2eSdKt)],
    ];
    let bad = 0;
    const body = rows.map(([name, what, how, mine, theirs]) => {
      if (c.pending) {
        return el("tr", {}, el("td", {}, name), el("td", {}, what, el("span", { class: "how" }, how)),
          el("td", { class: "hash" }, reading("Reading the registry…"), el("code", { class: "how" }, `this file: ${mine}`)),
          el("td", {}, reading("Checking")));
      }
      const ok = theirs ? mine === theirs : null;
      if (ok === false) bad++;
      const st = ok === null ? ["na", "Not compared"] : ok ? ["ok", "Match"] : ["no", "Mismatch"];
      return el("tr", {}, el("td", {}, name), el("td", {}, what, el("span", { class: "how" }, how)),
        el("td", { class: "hash" }, el("code", {}, theirs || "—"), ok === false ? el("code", { class: "mine" }, `this file: ${mine}`) : null, ok === null ? el("code", { class: "how" }, `this file: ${mine}`) : null),
        el("td", {}, el("span", { class: `st ${st[0]}` }, st[1])));
    });
    $("checks").tBodies[0].replaceChildren(...body);
    const v = $("verdict");
    if (c.pending) v.replaceChildren(reading("Comparing these fingerprints with the registry…"));
    else if (!ch) v.replaceChildren(el("span", { class: "st na" }, "Not compared"), c.chain && c.chain.error ? c.chain.error : "No registry could be read, so the fingerprints are shown without a comparison.");
    else if (bad) v.replaceChildren(el("span", { class: "st no" }, "Mismatch"), `${bad} of ${rows.length} fingerprints do not match the registry.`);
    else v.replaceChildren(el("span", { class: "st ok" }, "Match"), `All ${rows.length} fingerprints match baseline version ${ch.reserve.baselineCount}, attested ${when(ch.baseline.attestedAt)}.`);
  }

  function tamper() {
    const c = S.cur, stats = JSON.parse(new TextDecoder().decode(c.statsBytes));
    const loss = stats.gfc.inside.any, was = [loss.loss_total_ha, stats.biomass.co2e_mt];
    loss.loss_total_ha = Math.round(loss.loss_total_ha / 2);
    loss.loss_total_pct = Math.round(loss.loss_total_pct * 5) / 10;
    stats.biomass.co2e_mt = Math.round(stats.biomass.co2e_mt * 15) / 10;
    c.tampered = { stats, bytes: utf8(JSON.stringify(stats, null, 1)) };
    $("tamper").hidden = true;
    $("restore").hidden = false;
    const n = $("tamper-note");
    n.hidden = false;
    n.className = "note warn";
    n.textContent = `Test: in the copy held in this browser, tree-cover loss was halved from ${fmt(was[0])} to ${fmt(loss.loss_total_ha)} ha and the carbon stock raised from ${fmt(was[1], 1)} to ${fmt(stats.biomass.co2e_mt, 1)} Mt. The published file is untouched.`;
    render();
  }

  function renderClaim(c) {
    const box = $("claim"), ch = c.chain;
    if (c.pending) return box.replaceChildren(spinner("Reading claims from the registry…"));
    if (!ch || ch.error) return box.replaceChildren(el("p", {}, ch ? ch.error : "No registry could be read."));
    const total = c.cells.cell_count, year = ch.year, others = ch.claims.filter((x) => x.reserveId !== ch.id);
    const out = el("div", { hidden: true });
    const button = (label) => el("button", { class: "btn", type: "button", style: "width:fit-content", onclick: (ev) => simulate(c, out, ev.target) }, label);
    const key = (a) => (a === S.dep.testSteward ? " (test address; nobody holds its key)" : a === S.dep.steward ? " (Kam Edge test key)" : "");
    if (ch.own) {
      box.replaceChildren(
        el("p", {}, el("strong", {}, `All ${fmt(ch.own.cells)} cells are counted for ${year} by this area.`), " No other project can count any of them for that year."),
        el("dl", {}, el("dt", {}, "Claim"), el("dd", {}, `#${ch.own.id}, citing baseline version ${ch.own.version}`), el("dt", {}, "Made by"), el("dd", {}, ch.own.by + key(ch.own.by)), el("dt", {}, "Recorded"), el("dd", {}, when(ch.own.at))),
        button("Simulate the same claim again"), out);
    } else if (ch.taken.size) {
      const holder = others.length === 1 ? others[0].name : "other projects";
      box.replaceChildren(
        el("p", {}, el("strong", {}, `${fmt(ch.taken.size)} of this area's ${fmt(total)} cells are already counted for ${year} by ${holder}.`), ` They are hatched on the map. The other ${fmt(total - ch.taken.size)} are free.`),
        el("dl", {}, el("dt", {}, "Steward"), el("dd", {}, ch.reserve.steward + key(ch.reserve.steward))),
        button(`Simulate this area's claim for ${year}`), out);
    } else {
      box.replaceChildren(
        el("p", {}, el("strong", {}, `None of this area's ${fmt(total)} cells is counted for ${year}.`), " Its steward has made no claim."),
        el("dl", {}, el("dt", {}, "Steward"), el("dd", {}, ch.reserve.steward + key(ch.reserve.steward))),
        button(`Simulate this area's claim for ${year}`), out);
    }
  }

  async function simulate(c, out, btn) {
    const ch = c.chain;
    btn.disabled = true;
    const tail = "This was a read-only call to the live contract from the steward's address. Nothing was sent, and a real transaction would end the same way.";
    try {
      await S.reg.claim.staticCall(ch.id, ch.year, ch.reserve.baselineCount, c.rows, { from: ch.reserve.steward });
      out.className = "outcome ok";
      out.replaceChildren(el("span", { class: "st ok" }, "Would be accepted"), el("span", {}, `The registry would record ${fmt(c.cells.cell_count)} cells for ${ch.year} under this area.`), el("span", { class: "small" }, tail));
    } catch (e) {
      const r = e.revert;
      out.className = "outcome no";
      if (r && r.name === "CellsAlreadyClaimed") {
        const [year, lat, word, mask] = r.args;
        const n = ch.own ? c.cells.cell_count : ch.taken.size;
        out.replaceChildren(el("span", { class: "st no" }, "Refused by the contract"),
          el("span", {}, `${fmt(n)} of the ${fmt(c.cells.cell_count)} cells are already counted for ${year}. The contract stopped at the first row it met with a taken cell: latitude row ${lat}, ${popcount(mask)} cell${popcount(mask) === 1 ? "" : "s"}.`),
          el("code", {}, `CellsAlreadyClaimed(year ${year}, lat ${lat}, word ${word}, taken 0x${mask.toString(16)})`), el("span", { class: "small" }, tail));
      } else {
        out.replaceChildren(el("span", { class: "st no" }, "Refused by the contract"), el("code", {}, r ? `${r.name}(${r.args.join(", ")})` : e.shortMessage || e.message), el("span", { class: "small" }, tail));
      }
    }
    out.hidden = false;
    btn.disabled = false;
  }

  start().catch((e) => {
    $("net").textContent = "Could not load the published files";
    console.error(e);
  });
})();
