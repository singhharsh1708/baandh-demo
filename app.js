const D = window.BR_DATA;
const PANELS = ["scenario", "flood", "compare", "sph", "damage", "satellite", "downloads"];
const MAP_PANELS = ["scenario", "flood", "compare", "damage", "satellite", "downloads"];
const ENG = ["d3d", "swesph"];
const ENG_LABEL = { d3d: "Delft3D FM", swesph: "SWE-SPH" };
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}";
const TILE_ATTR = "Tiles: Esri, HERE, Garmin, OpenStreetMap contributors. Terrain: Copernicus GLO-30";
const VAL_V = ((D.validation || {}).villages || []);
const VAL_REP = new Map(VAL_V.flatMap(v => [[v.name, !!v.reported_flooded], [v.osm_name, !!v.reported_flooded]]));
const VAL_NOTE = new Map(VAL_V.flatMap(v => [[v.name, v.evidence || ""], [v.osm_name, v.evidence || ""]]));
const isReported = p => VAL_REP.has(p.label) ? VAL_REP.get(p.label) : VAL_REP.has(p.osm_name) ? VAL_REP.get(p.osm_name) : true;
const REPORTED = new Set(((D.geo.reported || {}).features || []).filter(f => isReported(f.properties)).flatMap(f => [f.properties.label, f.properties.osm_name]));
const S = { panel: "scenario", engine: null, layer: "depth", frame: 0, playing: null, cmode: "swipe", swipe: 35, sat: "ann", media: "partial" };

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function fmt(v, d = 0) {
  if (v == null || v === "" || (typeof v === "number" && !isFinite(v))) return "n/a";
  if (typeof v !== "number") return esc(v);
  return v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtAuto(v) {
  if (typeof v !== "number") return esc(v);
  const a = Math.abs(v);
  return fmt(v, a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3);
}
function minutes(m) {
  if (m == null) return "not reached";
  const h = Math.floor(m / 60), r = Math.round(m - 60 * h);
  return `${fmt(m, 0)} min` + (h ? ` <span class="sub-inline">(${h} h ${r} min)</span>` : "");
}
function cap(t) { t = String(t || ""); return t.charAt(0).toUpperCase() + t.slice(1); }
function label(k) { return String(k).replace(/_/g, " ").replace(/\bm3s\b/, "m3/s").replace(/\bkm2\b/, "km2"); }
function statusChip(st) {
  const s = st || "pending";
  const cls = s === "done" ? "done" : s === "partial" ? "partial" : s === "failed" ? "failed" : "pending";
  const txt = s === "pending" ? "engine run pending" : s;
  return `<span class="status-chip ${cls}">${esc(txt)}</span>`;
}
function engReady(k) { return !!(D.engines[k] && D.engines[k].depth_png); }
function readyEngines() { return ENG.filter(engReady); }
function kpi(lab, val, of, extra = "") {
  return `<div class="kpi ${extra}"><div class="label">${lab}</div><div class="value">${val}</div><div class="of">${of || ""}</div></div>`;
}

const map = L.map("map", { zoomControl: true, attributionControl: true, zoomSnap: 0.25 });
L.tileLayer(ESRI, { maxZoom: 16, attribution: TILE_ATTR }).addTo(map);
const B = L.latLngBounds(D.bbox_bounds);
map.fitBounds(B, { padding: [10, 10] });
L.imageOverlay(D.hillshade.png, D.hillshade.bounds, { opacity: 0.78, className: "hill-img", interactive: false }).addTo(map);

const base = L.layerGroup().addTo(map);
if (D.geo.reservoir) L.geoJSON(D.geo.reservoir, { style: { color: "#86b6ef", weight: 1.2, fillColor: "#3987e5", fillOpacity: 0.28 }, interactive: false }).addTo(base);
if (D.geo.river) L.geoJSON(D.geo.river, { style: { color: "#6fa8e8", weight: 1.6, opacity: 0.85 }, interactive: false }).addTo(base);
const damIcon = L.divIcon({ className: "", html: '<div class="dam-mark"></div>', iconSize: [16, 16], iconAnchor: [8, 8] });
const damM = L.marker(D.geo.dam, { icon: damIcon, keyboard: false }).addTo(base);
damM.bindTooltip(`<div class="tt-street">Annamayya dam</div><div class="tt-row">Height<b>${fmt(D.scenario.inputs.height, 0)} m</b></div><div class="tt-row">Crest (top bund)<b>${fmt(D.scenario.inputs.crest_elev, 1)} m</b></div><div class="tt-row">Gross storage<b>${fmt(D.scenario.inputs.storage, 2)} Mcum</b></div>`, { className: "jd-tip", direction: "top", offset: [0, -8] });

const panelLayers = L.layerGroup().addTo(map);
const villageLayer = L.layerGroup().addTo(map);
let engineOverlay = null;
let swipeOverlays = null;

function villageRows() {
  const byKey = new Map();
  const key = (lat, lon) => `${(+lat).toFixed(4)},${(+lon).toFixed(4)}`;
  ((D.geo.reported || {}).features || []).forEach(f => {
    const [lon, lat] = f.geometry.coordinates;
    byKey.set(key(lat, lon), { name: f.properties.label, lat, lon, reported: isReported(f.properties), named: true });
  });
  ENG.forEach(k => {
    (D.engines[k].villages || []).forEach(r => {
      if (r.lat == null || r.lon == null) return;
      const kk = key(r.lat, r.lon);
      if (!byKey.has(kk)) byKey.set(kk, { name: r.name, lat: r.lat, lon: r.lon, reported: REPORTED.has(r.name) });
      const o = byKey.get(kk);
      if (!o[k] || (r.max_depth_m || 0) > (o[k].max_depth_m || 0)) o[k] = r;
    });
  });
  return [...byKey.values()];
}
function maxDepthAny(o) { return Math.max(...ENG.map(k => (o[k] && o[k].max_depth_m) || 0)); }

function depthColor(d) {
  const L_ = D.legend.depth;
  if (d == null || d < L_.bins[0]) return "#5f6a7b";
  let c = L_.colors[0];
  L_.bins.forEach((b, i) => { if (d >= b) c = L_.colors[i]; });
  return c;
}

function villagePopup(o) {
  let h = `<div class="tt-street">${esc(o.name)} ${o.reported ? '<span class="pill yes">reported</span>' : ""}</div>`;
  ENG.forEach(k => {
    const r = o[k];
    if (!engReady(k)) { h += `<div class="tt-row">${ENG_LABEL[k]}<b>pending</b></div>`; return; }
    h += `<div class="tt-row">${ENG_LABEL[k]} depth<b>${r ? fmt(r.max_depth_m, 2) + " m" : "n/a"}</b></div>`;
    h += `<div class="tt-row">${ENG_LABEL[k]} arrival<b>${r && r.arrival_min != null ? fmt(r.arrival_min, 0) + " min" : "not reached"}</b></div>`;
  });
  if (o.reported) h += `<div class="tt-src">Reported flooded in Nov 2021 (SANDRP, The News Minute)</div>`;
  else if (o.named) h += `<div class="tt-src">Not reported flooded; shown for context. ${esc(VAL_NOTE.get(o.name) || "")}</div>`;
  return h;
}

function drawVillages(show) {
  villageLayer.clearLayers();
  if (!show) return;
  const eng = S.engine || readyEngines()[0];
  villageRows().forEach(o => {
    if (o.lat == null || o.lon == null) return;
    const r = eng && o[eng];
    const m = L.circleMarker([o.lat, o.lon], {
      radius: o.reported ? 7 : o.named ? 6 : (r && r.max_depth_m >= 0.1) ? 5 : 3.5, color: o.reported ? "#f5a524" : o.named ? "#c9d1dc" : "#0b0e13", weight: o.reported ? 2.5 : o.named ? 2 : 1,
      fillColor: r ? depthColor(r.max_depth_m) : "#b4bcc8", fillOpacity: 0.95
    }).addTo(villageLayer);
    m.bindPopup(villagePopup(o));
    if (o.reported || o.named) m.bindTooltip(esc(o.name), { permanent: true, direction: "right", offset: [8, 0], className: "map-label" });
  });
}

function clearEngine() {
  if (engineOverlay) { map.removeLayer(engineOverlay); engineOverlay = null; }
  if (swipeOverlays) { swipeOverlays.forEach(l => map.removeLayer(l)); swipeOverlays = null; }
  $("swipe-line").hidden = true;
}

function legendHtml(kind) {
  let h = "";
  if (kind === "depth" || kind === "arrival" || kind === "diff") {
    const L_ = D.legend[kind];
    const t = kind === "depth" ? "Max water depth, m" : kind === "arrival" ? "Arrival of 0.3 m depth, min after t = 0" : "Delft3D FM minus SWE-SPH, m";
    h += `<div class="title">${t}</div>`;
    L_.colors.forEach((c, i) => {
      const lo = L_.bins[i], hi = L_.bins[i + 1];
      let txt;
      if (kind === "diff") txt = i === 0 ? `below ${fmt(L_.bins[1], 1)}` : hi == null ? `above ${fmt(lo, 1)}` : `${fmt(lo, 1)} to ${fmt(hi, 1)}`;
      else txt = hi == null ? `${fmt(lo, kind === "depth" ? 1 : 0)} or more` : `${fmt(lo, kind === "depth" ? 1 : 0)} to ${fmt(hi, kind === "depth" ? 1 : 0)}`;
      h += `<div class="row"><span class="sw" style="background:${c}"></span>${txt}</div>`;
    });
  }
  return h;
}

function baseLegend() {
  return `<div class="title" style="margin-top:8px">Map</div>
    <div class="row"><span class="dam-mark" style="width:10px;height:10px;margin:0 6px"></span>Annamayya dam</div>
    <div class="row"><span class="sw" style="background:rgba(57,135,229,0.45);border:1px solid #86b6ef"></span>Reservoir at the 206.7 m top bund</div>
    <div class="row"><span class="ln" style="border-top:2px solid #6fa8e8"></span>Cheyyeru river</div>
    <div class="row"><span class="ring"></span>Village reported flooded</div>
    <div class="row"><span class="ring" style="border-color:#c9d1dc"></span>Named for context, not reported flooded</div>`;
}

function setLegend(h) { $("legend").innerHTML = h; $("legend").hidden = !h; }

function renderEngineMap() {
  clearEngine();
  $("frame-card").hidden = true;
  const k = S.engine;
  const e = k && D.engines[k];
  let h = "";
  if (!e || !e.depth_png) {
    h = `<div class="title">Flood layer</div><div class="row">Engine run pending</div>` + baseLegend();
  } else if (S.layer === "frames" && e.frames && e.frames.length) {
    if (e.frames_overlay) engineOverlay = L.imageOverlay(e.frames[S.frame] || e.frames[0], e.bounds, { opacity: 0.95, className: "engine-img", interactive: false }).addTo(map);
    else { $("frame-img").src = e.frames[S.frame] || e.frames[0]; $("frame-card").hidden = false; }
    h = `<div class="title">${ENG_LABEL[k]} time-lapse</div><div class="note-l">Frame ${S.frame + 1} of ${e.frames.length}, water depth during the flood. Press play below.</div>` + baseLegend();
  } else {
    const lay = S.layer === "arrival" && e.arrival_png ? "arrival" : "depth";
    engineOverlay = L.imageOverlay(lay === "arrival" ? e.arrival_png : e.depth_png, e.bounds, { opacity: 0.92, className: "engine-img", interactive: false }).addTo(map);
    h = legendHtml(lay) + `<div class="note-l">${ENG_LABEL[k]}, ${e.meta && e.meta.cell_size_m ? "cell " + fmt(e.meta.cell_size_m, 0) + " m" : e.meta && e.meta.particle_spacing_m ? "particle spacing " + fmt(e.meta.particle_spacing_m, 0) + " m" : "grid of the 30 m DEM"}</div>` + baseLegend();
  }
  setLegend(h);
  drawVillages(true);
}

function segButtons(el, items, cur, onPick) {
  el.innerHTML = items.map(it => `<button data-v="${it.v}" aria-pressed="${it.v === cur}" ${it.disabled ? "disabled" : ""}>${it.t}</button>`).join("");
  el.querySelectorAll("button").forEach(b => b.addEventListener("click", () => { if (!b.disabled) onPick(b.dataset.v); }));
}

function renderDock() {
  const ready = readyEngines();
  segButtons($("dk-engine"), ENG.map(k => ({ v: k, t: ENG_LABEL[k] + (engReady(k) ? "" : " (pending)"), disabled: !engReady(k) })), S.engine, v => { S.engine = v; S.frame = 0; stopPlay(); renderFlood(); writeUrl(); });
  const e = S.engine && D.engines[S.engine];
  const layers = [{ v: "depth", t: "Max depth", disabled: !e || !e.depth_png }, { v: "arrival", t: "Arrival time", disabled: !e || !e.arrival_png }];
  if (e && e.frames && e.frames.length) layers.push({ v: "frames", t: "Time-lapse" });
  segButtons($("dk-layer"), layers, S.layer, v => { S.layer = v; stopPlay(); renderFlood(); writeUrl(); });
  const fr = S.layer === "frames" && e && e.frames && e.frames.length;
  $("dk-frames").hidden = !fr;
  if (fr) {
    $("dk-slider").max = e.frames.length - 1;
    $("dk-slider").value = S.frame;
    const mm = (e.frames[S.frame].match(/(\d+)min/) || [])[1];
    $("dk-t").textContent = mm ? `${+mm} min` : `${S.frame + 1} / ${e.frames.length}`;
  }
  $("dk-fine").innerHTML = ready.length ? `Same breach hydrograph (peak <b>${fmt(D.scenario.hydrograph.peak_total_m3s, 0)} m3/s</b>) and the same 30 m DEM for both engines.` : "Both engine runs are pending. The map shows the terrain, reservoir, river and reported villages.";
  setPlayIcon();
}

function setPlayIcon() {
  $("dk-play").innerHTML = S.playing
    ? '<svg width="14" height="14" viewBox="0 0 14 14"><rect x="2" y="1" width="3.5" height="12" fill="#e9edf2"/><rect x="8.5" y="1" width="3.5" height="12" fill="#e9edf2"/></svg>'
    : '<svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 1l10 6-10 6z" fill="#e9edf2"/></svg>';
}
function stopPlay() { if (S.playing) { clearInterval(S.playing); S.playing = null; } }
$("dk-play").addEventListener("click", () => {
  const e = D.engines[S.engine];
  if (!e || !e.frames) return;
  if (S.playing) { stopPlay(); setPlayIcon(); return; }
  S.playing = setInterval(() => { S.frame = (S.frame + 1) % e.frames.length; renderEngineMap(); renderDock(); }, 350);
  setPlayIcon();
});
$("dk-slider").addEventListener("input", ev => { S.frame = +ev.target.value; renderEngineMap(); renderDock(); });

function chart(el, tipEl, cfg) {
  const W = 400, H = cfg.h || 200, m = { l: 48, r: 12, t: 10, b: 30 };
  const xs = v => m.l + (v - cfg.x.min) / (cfg.x.max - cfg.x.min) * (W - m.l - m.r);
  const ys = v => H - m.b - (v - cfg.y.min) / (cfg.y.max - cfg.y.min) * (H - m.t - m.b);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(cfg.aria || "chart")}">`;
  cfg.y.ticks.forEach(t => { s += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${ys(t)}" y2="${ys(t)}"/><text class="axis" x="${m.l - 6}" y="${ys(t) + 3.5}" text-anchor="end">${cfg.y.fmt(t)}</text>`; });
  cfg.x.ticks.forEach(t => { s += `<text class="axis" x="${xs(t)}" y="${H - m.b + 14}" text-anchor="middle">${cfg.x.fmt(t)}</text>`; });
  s += `<text class="lab" x="${(m.l + W - m.r) / 2}" y="${H - 2}" text-anchor="middle">${esc(cfg.x.label)}</text>`;
  s += `<text class="lab" x="10" y="${(H - m.b + m.t) / 2}" text-anchor="middle" transform="rotate(-90 10 ${(H - m.b + m.t) / 2})">${esc(cfg.y.label)}</text>`;
  (cfg.hlines || []).forEach(hl => { s += `<line x1="${m.l}" x2="${W - m.r}" y1="${ys(hl.y)}" y2="${ys(hl.y)}" stroke="${hl.color}" stroke-dasharray="4 3" stroke-width="1.2"/>`; if (hl.label) s += `<text class="axis" x="${W - m.r}" y="${ys(hl.y) - 4}" text-anchor="end" fill="${hl.color}" style="fill:${hl.color}">${esc(hl.label)}</text>`; });
  (cfg.vlines || []).forEach(vl => { s += `<line x1="${xs(vl.x)}" x2="${xs(vl.x)}" y1="${m.t}" y2="${H - m.b}" stroke="${vl.color}" stroke-dasharray="3 3" stroke-width="1"/>`; });
  cfg.series.forEach(se => {
    if (se.type === "dots") se.x.forEach((xv, i) => { s += `<circle cx="${xs(xv)}" cy="${ys(se.y[i])}" r="3.2" fill="${se.color}" stroke="#0b0e13" stroke-width="1"/>`; });
    else s += `<path d="${se.x.map((xv, i) => (i ? "L" : "M") + xs(xv).toFixed(1) + "," + ys(se.y[i]).toFixed(1)).join("")}" fill="none" stroke="${se.color}" stroke-width="${se.width || 1.8}" ${se.dash ? `stroke-dasharray="${se.dash}"` : ""}/>`;
  });
  s += `<line class="cursor" id="${el.id}-cur" x1="0" x2="0" y1="${m.t}" y2="${H - m.b}" visibility="hidden"/>`;
  s += `<rect x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="transparent" id="${el.id}-hit"/></svg>`;
  el.querySelectorAll("svg").forEach(n => n.remove());
  el.insertAdjacentHTML("beforeend", s);
  if (!cfg.hoverX) return;
  const svg = el.querySelector("svg"), cur = $(`${el.id}-cur`);
  svg.addEventListener("mousemove", ev => {
    const r = svg.getBoundingClientRect();
    const px = (ev.clientX - r.left) / r.width * W;
    const xv = cfg.x.min + (px - m.l) / (W - m.l - m.r) * (cfg.x.max - cfg.x.min);
    let bi = 0;
    cfg.hoverX.forEach((v, i) => { if (Math.abs(v - xv) < Math.abs(cfg.hoverX[bi] - xv)) bi = i; });
    cur.setAttribute("x1", xs(cfg.hoverX[bi])); cur.setAttribute("x2", xs(cfg.hoverX[bi])); cur.setAttribute("visibility", "visible");
    tipEl.innerHTML = cfg.tip(bi);
  });
  svg.addEventListener("mouseleave", () => cur.setAttribute("visibility", "hidden"));
}

function niceTicks(max, n = 5) {
  const raw = max / n, p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(k => k * p).find(k => raw <= k);
  const out = [];
  for (let v = 0; v <= max + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}

function pipeState(st) { return st === "done" ? "" : st === "partial" ? "part" : "pend"; }
function renderPipe() {
  const eng = k => engReady(k) ? ((D.engines[k].meta || {}).status || "done") : "pending";
  const steps = [
    ["Scenario and breach", "done", "scenario"],
    ["SPH near-field", D.sph && D.sph.section && Object.keys(D.sph.section).length ? "done" : "pending", "sph"],
    ["Delft3D FM", eng("d3d"), "flood"],
    ["SWE-SPH", eng("swesph"), "flood"],
    ["Compare", readyEngines().length === 2 ? "done" : readyEngines().length ? "partial" : "pending", "compare"],
    ["Loss and damage", D.damage && D.damage.json ? (D.damage.json.status || "done") : "pending", "damage"],
    ["Satellite (GEE)", D.gee && D.gee.headline ? "done" : "pending", "satellite"],
    ["SHP / KML", (D.downloads || []).length ? "done" : "pending", "downloads"]
  ];
  $("sc-pipe").innerHTML = steps.map(([t, st, p]) => `<li class="${pipeState(st)}" data-p="${p}" title="${esc(st)}"><span class="st"></span>${esc(t)}</li>`).join("");
  $("sc-pipe").querySelectorAll("li").forEach(li => li.addEventListener("click", () => { show(li.dataset.p); writeUrl(); }));
}

function renderScenario() {
  renderPipe();
  const sc = D.scenario, dam = D.dam, ev = dam.event || {}, hy = sc.hydrograph, fb = sc.breach.froehlich2008;
  $("sc-lede").innerHTML = `The earthen Annamayya dam on the Cheyyeru overtopped and breached at about 05:30 (The News Minute) to 06:00 (SANDRP). Deaths: ${esc((ev.deaths || {}).value || "")}. Inflow was about <b>${fmt((ev.inflow_lakh_cusec || {}).m3s, 0)} m3/s</b> against a spillway capacity of ${fmt((dam.spillway_capacity_m3s || {}).value, 0)} m3/s, with ${esc((ev.gates_jammed || {}).value || "")} gates jammed.`;
  $("sc-kpis").innerHTML =
    kpi("Breach width, average", `${fmt(fb.b_avg_m, 0)}<small>m</small>`, "Froehlich (2008), overtopping") +
    kpi("Breach formation time", `${fmt(fb.t_f_h, 2)}<small>h</small>`, "Froehlich (2008)") +
    kpi("Peak outflow", `${fmt(hy.peak_total_m3s, 0)}<small>m3/s</small>`, `at ${fmt(hy.time_to_peak_total_h, 2)} h, breach + spillway, inflow held on`) +
    kpi("Water released", `${fmt(hy.breach_only_volume_released_mcum, 1)}<small>Mcum</small>`, `pool volume at the ${fmt(sc.inputs.crest_elev, 1)} m crest, DEM`);
  const H = D.hydro;
  const ymax = Math.ceil(Math.max(...H.q_out) / 5000) * 5000;
  const xmax = H.t_min[H.t_min.length - 1];
  const rep = sc.inputs.reported_peak;
  chart($("hy-chart"), $("hy-tip"), {
    aria: "Outflow hydrograph", h: 210,
    x: { min: 0, max: xmax, ticks: niceTicks(xmax / 60, 6).map(v => v * 60), fmt: v => `${v / 60}`, label: "hours after breach start" },
    y: { min: 0, max: ymax, ticks: niceTicks(ymax, 5), fmt: v => `${v / 1000}k`, label: "m3/s" },
    series: [
      { x: H.t_min, y: H.q_spill, color: "#7f8a9a", width: 1.4, dash: "4 3" },
      { x: H.t_min, y: H.q_breach, color: "#ec835a", width: 1.6 },
      { x: H.t_min, y: H.q_out, color: "#4f9be8", width: 2.2 }
    ],
    hlines: rep ? [{ y: rep, color: "#f5a524", label: "reported surge, about 2 lakh cusec" }] : [],
    hoverX: H.t_min,
    tip: i => `t ${fmt(H.t_min[i] / 60, 2)} h &middot; total ${fmt(H.q_out[i], 0)} &middot; breach ${fmt(H.q_breach[i], 0)} &middot; pool ${fmt(H.level[i], 2)} m`
  });
  $("hy-note").innerHTML = `<span class="swatch" style="background:#4f9be8"></span> total outflow (the flood models use this) &nbsp;<span class="swatch" style="background:#ec835a"></span> breach &nbsp;<span class="swatch" style="background:#7f8a9a"></span> spillway, ${Math.round(sc.inputs.gates_open_frac * 5)} of 5 gates. Inflow held at ${fmt(hy.inflow_m3s, 0)} m3/s for ${fmt(hy.duration_h, 0)} h. The breach grows linearly over t<sub>f</sub> and discharges as a broad-crested weir (C = ${fmt(sc.inputs.weir_c, 1)} US units).`;
  $("sc-peaks").innerHTML = `<tr><th>Method</th><th class="r">Peak, m3/s</th></tr>
    <tr><td>Weir-routed, breach only<span class="sub">no spillway, no inflow</span></td><td class="r num">${fmt(hy.breach_only_peak_m3s, 0)}</td></tr>
    <tr><td>Weir-routed, event case<span class="sub">breach + spillway, ${fmt(hy.inflow_m3s, 0)} m3/s inflow held on</span></td><td class="r num">${fmt(hy.peak_total_m3s, 0)}</td></tr>
    <tr><td>Froehlich (2016) regression</td><td class="r num">${fmt(sc.breach.peak_froehlich2016_m3s, 0)}</td></tr>
    <tr><td>Froehlich (1995) regression</td><td class="r num">${fmt(sc.breach.peak_froehlich1995_m3s, 0)}</td></tr>
    <tr><td>Reported downstream surge<span class="sub">SANDRP, press figure, not a gauge</span></td><td class="r num">${fmt((ev.downstream_gush_lakh_cusec || {}).m3s, 0)}</td></tr>`;
  const rows = [["Register ID", "pic"], ["River", "river"], ["District", "district"], ["Type", "type"], ["Completed", "year_completed"], ["Height, m", "height_m"], ["Crest length, m", "length_m"], ["Gross storage, Mcum", "gross_storage_mcum"], ["Live storage, Mcum", "live_storage_mcum"], ["Reservoir area, km2", "reservoir_area_km2"], ["Spillway capacity, m3/s", "spillway_capacity_m3s"], ["Gates", "gates"], ["Top bund level, m", "top_bund_level_m"], ["Latitude", "lat"], ["Longitude", "lon"]];
  $("sc-dam").innerHTML = `<tr><th>Attribute</th><th>Value</th><th>Source</th></tr>` + rows.filter(([, k]) => dam[k]).map(([t, k]) => {
    const a = dam[k];
    const v = a.text || (typeof a.value === "number" ? (k === "year_completed" ? String(a.value) : Number.isInteger(a.value) && a.value >= 1000 ? fmt(a.value, 0) : String(a.value)) : esc(a.value));
    const src = String(a.source || "").split(/[;(]/)[0].trim();
    return `<tr><td>${t}</td><td class="num">${v}</td><td class="src" title="${esc(a.source)}">${esc(src)}</td></tr>`;
  }).join("");
  buildForm();
  const cav = sc.caveats || [];
  $("sc-ncav").textContent = cav.length;
  $("sc-caveats").innerHTML = cav.map(c => `<li>${esc(c)}</li>`).join("");
  const srcs = Object.assign({}, dam.sources || {}, sc.sources || {});
  $("sc-sources").innerHTML = Object.entries(srcs).map(([k, v]) => {
    const url = (String(v).match(/https?:\/\/\S+/) || [])[0];
    const txt = esc(String(v).replace(/https?:\/\/\S+/, "").replace(/,\s*$/, ""));
    return `<li><b>${esc(k)}</b>: ${txt}${url ? ` <a class="src" href="${esc(url.replace(/[),.]+$/, ""))}" target="_blank" rel="noopener">link</a>` : ""}</li>`;
  }).join("");
}

const FORM = [
  { k: "name", t: "Dam name", type: "text" },
  { k: "dam_lat", t: "Latitude, deg N", step: "0.000001" },
  { k: "dam_lon", t: "Longitude, deg E", step: "0.000001" },
  { k: "height", t: "Dam height, m", step: "0.1" },
  { k: "storage", t: "Gross storage, Mcum", step: "0.01" },
  { k: "crest_elev", t: "Top of dam, m", step: "0.1" },
  { k: "vw", t: "Water at breach, Mcum", step: "0.01" },
  { k: "mode", t: "Failure mode", type: "select", opts: ["overtopping", "piping"] },
  { k: "inflow", t: "Inflow, m3/s", step: "1" },
  { k: "spill_capacity", t: "Spillway capacity, m3/s", step: "1" },
  { k: "gates_open_frac", t: "Gates working, share", step: "0.1" },
  { k: "hours", t: "Hydrograph, hours", step: "1" }
];
function defaults() {
  const i = D.scenario.inputs;
  const o = {};
  FORM.forEach(f => { o[f.k] = i[f.k]; });
  o.vw = +(D.scenario.breach.V_w_m3 / 1e6).toFixed(2);
  o.name = "Annamayya";
  return o;
}
let FV = defaults();
function buildForm() {
  $("sc-form").innerHTML = FORM.map(f => {
    if (f.type === "select") return `<label>${f.t}<select data-k="${f.k}">${f.opts.map(o => `<option ${o === FV[f.k] ? "selected" : ""}>${o}</option>`).join("")}</select></label>`;
    return `<label>${f.t}<input data-k="${f.k}" type="${f.type || "number"}" ${f.step ? `step="${f.step}"` : ""} value="${esc(FV[f.k])}"></label>`;
  }).join("");
  $("sc-form").querySelectorAll("input,select").forEach(el => el.addEventListener("input", () => { FV[el.dataset.k] = el.type === "number" ? +el.value : el.value; updateCmd(); }));
  updateCmd();
}
function updateCmd() {
  const i = D.scenario.inputs;
  const name = String(FV.name || "dam").trim().replace(/\s+/g, "_");
  const parts = ["python -m baandh.scenario", `--name ${name}`, `--dam-lat ${FV.dam_lat}`, `--dam-lon ${FV.dam_lon}`, `--height ${FV.height}`, `--storage ${FV.storage}`];
  if (FV.crest_elev) parts.push(`--crest-elev ${FV.crest_elev}`);
  parts.push(`--mode ${FV.mode}`);
  if (FV.inflow) parts.push(`--inflow ${FV.inflow}`);
  if (FV.spill_capacity) parts.push(`--spill-capacity ${FV.spill_capacity}`, `--gates-open-frac ${FV.gates_open_frac}`);
  parts.push(`--hours ${FV.hours}`);
  if (name.toLowerCase() === "annamayya") {
    const q = v => /\s/.test(String(v)) ? `"${v}"` : v;
    [["--length", i.length], ["--area", i.area], ["--weir-c", i.weir_c], ["--gate-height", i.gate_height], ["--river", i.river], ["--river-name", i.river_name], ["--exposure", i.exposure], ["--attrs", i.attrs], ["--places", i.places], ["--reported-peak", i.reported_peak], ["--figures", i.figures], ["--out-dir", i.out_dir], ["--json-out", i.json_out]]
      .forEach(([f, v]) => { if (v != null) parts.push(`${f} ${q(v)}`); });
    if (i.bbox) parts.push(`--bbox ${i.bbox.join(" ")}`);
  } else {
    parts.push(`--out-dir data/${name.toLowerCase()}`, `--json-out results/${name.toLowerCase()}_scenario.json`);
  }
  $("sc-cmd").textContent = parts.join(" \\\n  ");
  const g = 9.81, vw = FV.vw * 1e6, hb = FV.height;
  const ko = FV.mode === "piping" ? 1.0 : 1.3;
  const ok = vw > 0 && hb > 0;
  const bavg = ok ? 0.27 * ko * Math.pow(vw, 0.32) * Math.pow(hb, 0.04) : null;
  const tf = ok ? 63.2 * Math.sqrt(vw / (g * hb * hb)) / 3600 : null;
  $("sc-quick").innerHTML = kpi("Breach width, average", ok ? `${fmt(bavg, 0)}<small>m</small>` : "n/a", `B = 0.27 K<sub>o</sub> V<sup>0.32</sup> h<sup>0.04</sup>, K<sub>o</sub> = ${ko}`) +
    kpi("Formation time", ok ? `${fmt(tf, 2)}<small>h</small>` : "n/a", "t = 63.2 (V / g h&sup2;)<sup>0.5</sup>");
}
$("sc-copy").addEventListener("click", () => { try { navigator.clipboard.writeText($("sc-cmd").textContent.replace(/\\\n\s+/g, "")); $("sc-copy").textContent = "Copied"; setTimeout(() => { $("sc-copy").textContent = "Copy command"; }, 1500); } catch (e) { $("sc-copy").textContent = "Select and copy"; } });
$("sc-reset").addEventListener("click", () => { FV = defaults(); buildForm(); });

function simH(m) { return m.simulated_hours != null ? m.simulated_hours : m.simulated_s != null ? m.simulated_s / 3600 : null; }
function engineCard(k) {
  const e = D.engines[k], m = e.meta || {};
  let h = `<div class="eng-card"><div class="eh">${ENG_LABEL[k]} ${statusChip(e.status)}</div>`;
  if (!e.depth_png) return h + `<div class="pending-box">Engine run pending. The layer appears here when the run writes data/processed/${k}_maxdepth.tif.</div></div>`;
  const area = m.flooded_area_km2 != null ? m.flooded_area_km2 : e.wet_area_km2_raster;
  const res = m.cell_size_m != null ? `${fmt(m.cell_size_m, 0)} m cells` : m.particle_spacing_m != null ? `${fmt(m.particle_spacing_m, 0)} m spacing` : "";
  const n = m.n_cells != null ? `${fmt(m.n_cells, 0)} cells` : m.n_particles != null ? `${fmt(m.n_particles, 0)} particles` : "";
  h += `<div class="kpis">` + kpi("Flooded area", `${fmt(area, 1)}<small>km2</small>`, "max depth over 0.1 m") + kpi("Deepest water", `${fmt(e.max_depth_m_raster, 1)}<small>m</small>`, "any cell, incl. river bed") + kpi("Resolution", `<span class="value sm">${esc(res || "n/a")}</span>`, esc(n)) + kpi("Runtime", m.runtime_s != null ? `${fmt(m.runtime_s / 60, 1)}<small>min</small>` : "n/a", simH(m) != null ? `for ${fmt(simH(m), 1)} h of flood, this laptop` : "wall clock, this laptop") + `</div>`;
  return h + `</div>`;
}

function renderFlood() {
  const ready = readyEngines();
  if (!S.engine || !engReady(S.engine)) S.engine = ready[0] || "d3d";
  if (S.layer === "arrival" && !(D.engines[S.engine] || {}).arrival_png) S.layer = "depth";
  $("fl-engines").innerHTML = ENG.map(engineCard).join("");
  renderValidation();
  $("fl-samp").textContent = "Depth is the maximum water depth " + ENG.filter(engReady).map(k => `${D.engines[k].village_sampling || "at the village point"} (${ENG_LABEL[k]})`).join(", ") + ".";
  const all = villageRows();
  const rows = all.filter(o => o.reported || maxDepthAny(o) >= 0.1).sort((a, b) => (b.reported - a.reported) || (maxDepthAny(b) - maxDepthAny(a)));
  const cell = (o, k, f) => !engReady(k) ? `<td class="r num nw" style="color:var(--muted)">pending</td>` : `<td class="r num nw">${o[k] ? f(o[k]) : "n/a"}</td>`;
  $("fl-villages").innerHTML = `<tr><th>Village</th><th class="r">D3D depth</th><th class="r">D3D arrival</th><th class="r">SPH depth</th><th class="r">SPH arrival</th></tr>` +
    rows.slice(0, 80).map((o, i) => `<tr class="clickable" data-i="${i}"><td>${esc(o.name)} ${o.reported ? '<span class="pill yes">reported</span>' : ""}</td>` +
      cell(o, "d3d", r => `${fmt(r.max_depth_m, 2)} m`) + cell(o, "d3d", r => r.arrival_min != null ? `${fmt(r.arrival_min, 0)} min` : "dry") +
      cell(o, "swesph", r => `${fmt(r.max_depth_m, 2)} m`) + cell(o, "swesph", r => r.arrival_min != null ? `${fmt(r.arrival_min, 0)} min` : "dry") + `</tr>`).join("") +
    `<tr><td colspan="5" class="src">${fmt(rows.length, 0)} of ${fmt(all.length, 0)} OSM villages and hamlets shown: the reported ones and those with 0.1 m or more in either engine.${rows.length > 80 ? " First 80 listed; the full table is in Downloads." : ""}</td></tr>`;
  $("fl-villages").querySelectorAll("tr.clickable").forEach(tr => tr.addEventListener("click", () => {
    const o = rows[+tr.dataset.i];
    if (o.lat != null) map.flyTo([o.lat, o.lon], 13, { duration: 0.6 });
    L.popup().setLatLng([o.lat, o.lon]).setContent(villagePopup(o)).openOn(map);
  }));
  const cav = [];
  ENG.forEach(k => ((D.engines[k].meta || {}).caveats || []).forEach(c => cav.push(`${ENG_LABEL[k]}: ${c}`)));
  ((D.validation || {}).caveats || []).forEach(c => cav.push(c));
  cav.push("Copernicus GLO-30 is a 30 m surface model: tree and building tops are included and narrow channels are smoothed.");
  cav.push("Breach width and formation time come from the Froehlich (2008) regression, not a surveyed breach.");
  if (!D.validation) cav.push("No satellite flood extent exists for this event (first Sentinel-1 look was 9 days later), so the maps are checked against the villages reported flooded.");
  $("fl-caveats").innerHTML = cav.map(c => `<li>${esc(c)}</li>`).join("");
  renderDock();
  renderEngineMap();
}

function renderValidation() {
  const V = D.validation;
  const e = S.engine;
  if (!V || !V.summary || !V.summary[e]) {
    $("fl-val").innerHTML = `<div class="pending-box">Village check pending for ${ENG_LABEL[e] || "this engine"}. It fills in from results/validation.json.</div>`;
    return;
  }
  const sm = V.summary[e];
  const unl = Object.keys(V.cwc_unlocated || {});
  let h = `<div class="kpis">` +
    kpi("Reported villages flooded", `${fmt(sm.reported_flooded_hit, 0)}<small>of ${fmt(sm.reported_flooded_total, 0)}</small>`, `houses rule; ${fmt(sm.reported_point_hit, 0)} of ${fmt(sm.reported_flooded_total, 0)} at the village point`) +
    kpi("CWC/IISc modelled villages", `${fmt(sm.cwc_modelled_hit, 0)}<small>of ${fmt(sm.cwc_modelled_located, 0)}</small>`, `${fmt(sm.cwc_modelled_listed, 0)} listed${unl.length ? `, ${esc(unl.join(", "))} not found in OSM` : ""}`) +
    kpi("First water near them", sm.first_water_range_clock_0530 ? `<span class="value sm">${esc(sm.first_water_range_clock_0530.map(t => t.replace(/^19 Nov /, "")).join(" to "))}</span>` : "n/a", `${fmt((sm.first_water_range_min || [])[0], 0)} to ${fmt((sm.first_water_range_min || [])[1], 0)} min, if the breach was at 05:30`) +
    kpi("Houses under 0.3 m+", sm.houses_arrival_range_clock_0530 ? `<span class="value sm">${esc(sm.houses_arrival_range_clock_0530.map(t => t.replace(/^19 Nov /, "")).join(" to "))}</span>` : "n/a", "median over the village houses, same clock") +
    `</div>`;
  h += `<table class="data" style="margin-top:8px"><tr><th>Village</th><th>Listed by</th><th class="r">Flooded</th><th class="r">Wet houses</th><th class="r">Median depth</th><th class="r">First water</th></tr>` +
    (V.villages || []).map(v => {
      const r = v[e] || {};
      const by = [v.reported_flooded ? "press" : "", v.cwc_modelled ? "CWC" : ""].filter(Boolean).join(", ");
      return `<tr title="${esc(v.evidence || "")}"><td>${esc(v.name)}</td><td class="src">${esc(by)}</td><td class="r">${r.flooded == null ? "n/a" : r.flooded ? '<span class="pill hit">yes</span>' : '<span class="pill miss">no</span>'}</td><td class="r num">${r.buildings_wet_share != null ? fmt(100 * r.buildings_wet_share, 0) + "%" : "n/a"}</td><td class="r num nw">${r.wet_buildings_median_depth_m != null ? fmt(r.wet_buildings_median_depth_m, 2) + " m" : "n/a"}</td><td class="r num nw">${r.arrival_min != null ? fmt(r.arrival_min, 0) + " min" : "n/a"}<span class="sub">${esc((r.arrival_clock_if_breach_0530 || "").replace(/^19 Nov /, ""))}</span></td></tr>`;
    }).join("") + `</table>`;
  const m = V.method || {};
  h += `<p class="note">${esc(m.flooded_rule ? "Flooded: " + m.flooded_rule + "." : "")} ${esc(m.rule_note ? "The " + m.rule_note + "." : "")}</p>`;
  const nb = V.nandaluru_bridge && V.nandaluru_bridge[e];
  if (nb) h += `<p class="note">Nandaluru road bridge on the Cheyyeru: <b>${fmt(nb.max_depth_m, 2)} m</b> of water, first at ${fmt(nb.arrival_min, 0)} min. ${esc(cap(nb.note))}.</p>`;
  $("fl-val").innerHTML = h;
}

function flattenScalars(o, pre = "", out = []) {
  if (o == null) return out;
  Object.entries(o).forEach(([k, v]) => {
    const p = pre ? `${pre} / ${k}` : k;
    if (v != null && typeof v === "object" && !Array.isArray(v)) flattenScalars(v, p, out);
    else if (typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && v.length < 80)) out.push([p, v]);
  });
  return out;
}

function findKey(o, re, skip) {
  let hit = null;
  (function walk(x, path) {
    if (hit || x == null || typeof x !== "object") return;
    for (const [k, v] of Object.entries(x)) {
      if (skip && skip.test(k)) continue;
      if (typeof v === "number" && re.test(k)) { hit = { k: path ? `${path} / ${k}` : k, v }; return; }
      if (v && typeof v === "object" && !Array.isArray(v)) walk(v, path ? `${path} / ${k}` : k);
    }
  })(o, "");
  return hit;
}

function genericHtml(obj, depth = 0) {
  if (obj == null) return "";
  let h = "";
  const scal = Object.entries(obj).filter(([k, v]) => (typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && v.length <= 40)) && k !== "status");
  const longs = Object.entries(obj).filter(([k, v]) => typeof v === "string" && v.length > 40);
  if (longs.length) h += longs.map(([k, v]) => `<p class="note"><b>${esc(cap(label(k)))}:</b> ${esc(v)}</p>`).join("");
  if (scal.length) h += `<div class="kv">` + scal.map(([k, v]) => `<div class="k">${esc(label(k))}</div><div class="v">${typeof v === "number" ? fmtAuto(v) : esc(v)}</div>`).join("") + `</div>`;
  Object.entries(obj).forEach(([k, v]) => {
    if (v == null || typeof v !== "object") return;
    if (/caveat|note/i.test(k) && Array.isArray(v)) { h += `<h3>${esc(label(k))}</h3><ul class="caveats">${v.map(c => `<li>${esc(typeof c === "string" ? c : JSON.stringify(c))}</li>`).join("")}</ul>`; return; }
    if (/source|citation|reference/i.test(k)) {
      const items = Array.isArray(v) ? v : Object.entries(v).map(([a, b]) => `${a}: ${typeof b === "string" ? b : JSON.stringify(b)}`);
      h += `<h3>${esc(label(k))}</h3><ul class="caveats src-list">${items.map(c => `<li>${esc(typeof c === "string" ? c : JSON.stringify(c))}</li>`).join("")}</ul>`; return;
    }
    if (Array.isArray(v)) {
      if (v.length && v.every(r => r && typeof r === "object" && !Array.isArray(r))) {
        const cols = [...new Set(v.flatMap(r => Object.keys(r).filter(c => r[c] == null || typeof r[c] !== "object")))].slice(0, 7);
        h += `<h3>${esc(label(k))}</h3><div style="overflow-x:auto"><table class="data"><tr>${cols.map(c => `<th${typeof v[0][c] === "number" ? ' class="r"' : ""}>${esc(label(c))}</th>`).join("")}</tr>` +
          v.slice(0, 60).map(r => `<tr>${cols.map(c => typeof r[c] === "number" ? `<td class="r num">${fmtAuto(r[c])}</td>` : `<td>${esc(r[c] == null ? "" : r[c])}</td>`).join("")}</tr>`).join("") + `</table></div>`;
        if (v.length > 60) h += `<p class="note">${v.length - 60} more rows in the downloads.</p>`;
      } else if (v.length && v.every(x => typeof x !== "object")) {
        if (v.length <= 12) h += `<div class="kv"><div class="k">${esc(label(k))}</div><div class="v">${v.map(x => typeof x === "number" ? fmtAuto(x) : esc(x)).join(" / ")}</div></div>`;
      }
      return;
    }
    const vals = Object.values(v);
    if (depth < 3 && vals.length && vals.every(x => x && typeof x === "object" && !Array.isArray(x)) && vals.every(x => Object.values(x).every(y => y == null || typeof y !== "object"))) {
      const cols = [...new Set(vals.flatMap(x => Object.keys(x)))].slice(0, 7);
      h += `<h3>${esc(label(k))}</h3><div style="overflow-x:auto"><table class="data"><tr><th></th>${cols.map(c => `<th class="r">${esc(label(c))}</th>`).join("")}</tr>` +
        Object.entries(v).map(([rk, r]) => `<tr><td>${esc(label(rk))}</td>${cols.map(c => typeof r[c] === "number" ? `<td class="r num">${fmtAuto(r[c])}</td>` : `<td class="r">${esc(r[c] == null ? "" : r[c])}</td>`).join("")}</tr>`).join("") + `</table></div>`;
      return;
    }
    if (depth < 3) h += `<h3>${esc(label(k))}</h3>` + genericHtml(v, depth + 1);
  });
  return h;
}

function renderCompare() {
  const ready = readyEngines();
  const C = D.compare || {};
  const cj = C.json;
  const skip = /river_profile|villages|per_engine|engines|figures/;
  const csiRe = /^(csi|critical_success_index)$/i;
  const cjHas = !!(cj && findKey(cj, csiRe, skip));
  let st = "";
  if (ready.length < 2) st = `<div class="pending-box">Comparison pending: ${ENG.map(k => `${ENG_LABEL[k]} ${engReady(k) ? "done" : "pending"}`).join(", ")}. It fills in when both engines have written their maximum depth rasters.</div>`;
  else if (!cjHas && C.fallback) st = `<div class="callout twin">results/compare.json has no two-engine scores yet. These come from the dashboard export on the same two rasters: Delft3D FM as reference, 0.1 m threshold, over ${esc(C.fallback.scope || "the model box")}. ${(D.engines.swesph.meta || {}).status === "partial" ? "SWE-SPH is a partial run (see its caveats), so part of the gap is run length, not method." : ""}</div>`;
  $("cm-status").innerHTML = st;
  const both = ready.length === 2;
  const src = both ? (cjHas ? cj : C.fallback) : null;
  let k = "";
  if (src) {
    const csi = findKey(src, csiRe, skip), pod = findKey(src, /^(pod|hit_rate|probability_of_detection)$/i, skip), far = findKey(src, /^(far|false_alarm_ratio)$/i, skip), dd = findKey(src, /^(mean_abs|mae|rmse|mean_abs_diff|mean_abs_depth_diff)[a-z_]*(_m)?$|depth.*(mae|rmse|mean_abs)/i, skip);
    const sub = h => h && h.k.includes("/") ? esc(label(h.k)) : "";
    k += kpi("CSI, flood extent", csi ? fmt(csi.v, 2) : "n/a", sub(csi) || "1 = identical extents");
    k += kpi("POD", pod ? fmt(pod.v, 2) : "n/a", sub(pod) || "share of Delft3D FM wet cells SPH also floods");
    k += kpi("FAR", far ? fmt(far.v, 2) : "n/a", sub(far) || "share of SPH wet cells Delft3D FM leaves dry");
    k += kpi("Depth difference", dd ? `${fmt(dd.v, 2)}<small>m</small>` : "n/a", sub(dd) || "mean absolute, where both are wet");
  } else {
    k = ["CSI, flood extent", "POD", "FAR", "Depth difference"].map(t => kpi(t, "pending", "needs both engines", "pending")).join("");
  }
  if (both && cj && cj.extent_agreement && cj.extent_agreement.csi != null) {
    const ea = cj.extent_agreement, dd = cj.depth_difference || {}, ad = cj.arrival_difference || {}, fd = (cj.full_domain || {}).extent_agreement || {};
    const reach = (cj.comparison_domain || {}).common_reach_km;
    k = kpi("CSI, flood extent", fmt(ea.csi, 2), `common ${reach != null ? fmt(reach, 0) + " km " : ""}reach${fd.csi != null ? `; whole valley ${fmt(fd.csi, 2)}` : ""}`) +
      kpi("POD / FAR", `${fmt(ea.pod, 2)}<small>/ ${fmt(ea.far, 2)}</small>`, "Delft3D FM as reference") +
      kpi("Depth difference", `${fmt(dd.mae_m, 2)}<small>m MAE</small>`, `SPH minus Delft3D FM: bias ${fmt(dd.mean_bias_m, 2)} m, r ${fmt(dd.pearson_r, 2)}`) +
      kpi("Arrival difference", `${fmt(ad.median_min, 0)}<small>min</small>`, `median, SPH minus Delft3D FM${ad.median_min < 0 ? " (SPH earlier)" : ad.median_min > 0 ? " (SPH later)" : ""}`);
    let t = `<table class="data" style="margin-top:8px"><tr><th>Common reach, km2</th><th class="r">Both wet</th><th class="r">Delft3D FM only</th><th class="r">SWE-SPH only</th></tr><tr><td>Flooded area</td><td class="r num">${fmt(ea.both_wet_km2, 1)}</td><td class="r num">${fmt(ea.reference_only_km2, 1)}</td><td class="r num">${fmt(ea.candidate_only_km2, 1)}</td></tr></table>`;
    const cd = cj.comparison_domain || {};
    if (cd.rule) t += `<p class="note">Common reach: ${esc(cd.rule)}. ${esc(((cj.metric_definitions || {}).note) || "")}</p>`;
    $("cm-detail").innerHTML = t;
  } else $("cm-detail").innerHTML = "";
  $("cm-kpis").innerHTML = k;
  const row = (t, f) => `<tr><td>${t}</td>${ENG.map(e => `<td class="r num">${engReady(e) || D.engines[e].meta ? f(D.engines[e], D.engines[e].meta || {}) : "pending"}</td>`).join("")}</tr>`;
  $("cm-table").innerHTML = `<tr><th></th><th class="r">Delft3D FM</th><th class="r">SWE-SPH</th></tr>` +
    row("Status", e => statusChip(e.status)) +
    row("Method", (e, m) => e.key === "d3d" ? "finite volume, grid" : "SPH particles") +
    row("Resolution", (e, m) => m.cell_size_m != null ? `${fmt(m.cell_size_m, 0)} m cells` : m.particle_spacing_m != null ? `${fmt(m.particle_spacing_m, 0)} m spacing` : "n/a") +
    row("Size", (e, m) => m.n_cells != null ? `${fmt(m.n_cells, 0)} cells` : m.n_particles != null ? `${fmt(m.n_particles, 0)} particles` : "n/a") +
    row("Runtime", (e, m) => m.runtime_s != null ? `${fmt(m.runtime_s / 60, 1)} min` : "n/a") +
    row("Flooded area", (e, m) => m.flooded_area_km2 != null ? `${fmt(m.flooded_area_km2, 1)} km2` : e.wet_area_km2_raster != null ? `${fmt(e.wet_area_km2_raster, 1)} km2` : "n/a") +
    row("Hydrograph", (e, m) => esc(m.hydrograph_used ? ((String(m.hydrograph_used).match(/[\w.-]+\.csv/) || [])[0] || "see run notes") : "n/a"));
  let ex = "";
  const pe = (cj && cj.per_engine) || {};
  const rp = cj && cj.river_profile;
  if (Object.keys(pe).length) {
    const r2 = (t, f) => `<tr><td>${t}</td>${ENG.map(e => `<td class="r num">${pe[e] ? f(pe[e], ((rp || {}).engines || {})[e] || {}) : "pending"}</td>`).join("")}</tr>`;
    ex += `<h3>Flood statistics, valley below the dam</h3><table class="data"><tr><th></th><th class="r">Delft3D FM</th><th class="r">SWE-SPH</th></tr>` +
      r2("Flooded area", p => `${fmt(p.flooded_area_km2, 1)} km2`) + r2("Mean depth", p => `${fmt(p.mean_depth_m, 2)} m`) + r2("95th pct depth", p => `${fmt(p.p95_depth_m, 1)} m`) +
      r2("Median arrival", p => `${fmt(p.arrival_median_min, 0)} min`) + r2("Flood wave speed", (p, r) => r.front_speed ? `${fmt(r.front_speed.front_speed_kmh, 1)} km/h` : "n/a") +
      r2("Reaches", (p, r) => r.farthest_arrival_km != null ? `${fmt(r.farthest_arrival_km, 1)} km in ${fmt(r.arrival_at_farthest_min, 0)} min` : "n/a") + `</table>`;
    if (cj.domain_note) ex += `<p class="note">${esc(cj.domain_note)}</p>`;
  }
  if (rp && rp.distance_km) ex += `<h3>Along the Cheyyeru</h3><div class="chart" id="cm-prof"><div class="chart-tip" id="cm-prof-tip"></div></div><p class="note" id="cm-prof-note"></p>`;
  ENG.forEach(e => {
    const b = (D.engines[e].meta || {}).benchmark;
    if (b) ex += `<h3>${ENG_LABEL[e]} benchmark</h3>` + genericHtml(typeof b === "object" ? b : { value: b });
  });
  if (cj && (cj.caveats || []).length) ex += `<details class="limits"><summary>Comparison caveats (${cj.caveats.length})</summary><ul class="caveats">${cj.caveats.map(c => `<li>${esc(c)}</li>`).join("")}</ul></details>`;
  $("cm-extra").innerHTML = ex;
  if (rp && rp.distance_km && $("cm-prof")) profileChart(rp);
  $("cm-figs").innerHTML = (C.figures || []).map(f => `<div class="fig-block"><a href="${f}" target="_blank" rel="noopener"><img src="${f}" alt="comparison figure" loading="lazy"></a></div>`).join("");
  renderCompareMap();
}

function renderCompareMap() {
  clearEngine();
  const ready = readyEngines();
  const C = D.compare || {};
  segButtons($("ck-mode"), [{ v: "swipe", t: "Swipe", disabled: ready.length < 2 }, { v: "diff", t: "Difference", disabled: !C.diff_png }, { v: "d3d", t: "Delft3D FM", disabled: !engReady("d3d") }, { v: "swesph", t: "SWE-SPH", disabled: !engReady("swesph") }], S.cmode, v => { S.cmode = v; renderCompareMap(); writeUrl(); });
  $("ck-swipe-row").hidden = S.cmode !== "swipe" || ready.length < 2;
  let h = "";
  if (S.cmode === "swipe" && ready.length === 2) {
    const a = L.imageOverlay(D.engines.d3d.depth_png, D.engines.d3d.bounds, { opacity: 0.92, className: "engine-img", interactive: false }).addTo(map);
    const b = L.imageOverlay(D.engines.swesph.depth_png, D.engines.swesph.bounds, { opacity: 0.92, className: "engine-img", interactive: false }).addTo(map);
    swipeOverlays = [a, b];
    $("swipe-line").hidden = false;
    updateSwipe();
    h = `<div class="title">Left Delft3D FM, right SWE-SPH</div>` + legendHtml("depth");
  } else if (S.cmode === "diff" && C.diff_png) {
    engineOverlay = L.imageOverlay(C.diff_png, D.bbox_bounds, { opacity: 0.92, className: "engine-img", interactive: false }).addTo(map);
    h = legendHtml("diff") + `<div class="note-l">Grey: both wet within 0.5 m. Blue: Delft3D FM deeper. Orange: SWE-SPH deeper.</div>`;
  } else if (engReady(S.cmode)) {
    engineOverlay = L.imageOverlay(D.engines[S.cmode].depth_png, D.engines[S.cmode].bounds, { opacity: 0.92, className: "engine-img", interactive: false }).addTo(map);
    h = `<div class="title">${ENG_LABEL[S.cmode]}</div>` + legendHtml("depth");
  } else {
    h = `<div class="title">Comparison</div><div class="row">Needs both engine runs; pending</div>`;
  }
  setLegend(h + baseLegend());
  $("ck-fine").innerHTML = ready.length < 2 ? "Both engine runs are needed for the swipe and difference views." : S.cmode === "swipe" ? "Drag the slider to swipe between the two engines. Both use the same DEM and hydrograph." : S.cmode === "diff" ? `Difference over ${esc((D.compare.fallback || {}).scope || "the common area")}.` : "Same DEM and hydrograph for both engines.";
  drawVillages(true);
}

function profileChart(rp) {
  const x = rp.distance_km, bed = rp.bed_m;
  const cols = { d3d: "#4f9be8", swesph: "#ec835a" };
  const series = [{ x, y: bed, color: "#7f8a9a", width: 1.4 }];
  const wl = {};
  ENG.forEach(e => {
    const r = (rp.engines || {})[e];
    if (!r || !r.max_depth_m) return;
    wl[e] = bed.map((b, i) => b + (r.max_depth_m[i] || 0));
    series.push({ x, y: wl[e], color: cols[e], width: 1.8 });
  });
  const all = [...bed, ...Object.values(wl).flat()].filter(v => v != null && isFinite(v));
  const ymin = Math.floor(Math.min(...all) / 20) * 20, ymax = Math.ceil(Math.max(...all) / 20) * 20;
  const xmax = Math.ceil(x[x.length - 1] / 10) * 10;
  const yt = []; for (let v = ymin; v <= ymax; v += 20) yt.push(v);
  chart($("cm-prof"), $("cm-prof-tip"), {
    aria: "River bed and maximum water level along the Cheyyeru", h: 190,
    x: { min: 0, max: xmax, ticks: niceTicks(xmax, 5), fmt: v => `${v}`, label: "km below the dam" },
    y: { min: ymin, max: ymax, ticks: yt, fmt: v => `${v}`, label: "m" },
    series, hoverX: x,
    tip: i => `${fmt(x[i], 1)} km &middot; bed ${fmt(bed[i], 1)} m` + ENG.filter(e => wl[e]).map(e => ` &middot; ${ENG_LABEL[e]} ${fmt(rp.engines[e].max_depth_m[i], 1)} m deep` + (rp.engines[e].arrival_min && rp.engines[e].arrival_min[i] != null ? `, ${fmt(rp.engines[e].arrival_min[i], 0)} min` : "")).join("")
  });
  $("cm-prof-note").innerHTML = `<span class="swatch" style="background:#7f8a9a"></span> river bed (DEM) ` + ENG.filter(e => wl[e]).map(e => `<span class="swatch" style="background:${cols[e]}"></span> ${ENG_LABEL[e]} highest water level`).join(" ") + ". Hover for depth and arrival time.";
}

function updateSwipe() {
  if (!swipeOverlays) return;
  const cont = map.getContainer().getBoundingClientRect();
  const x = cont.left + S.swipe / 100 * cont.width;
  $("swipe-line").style.left = `${(map.getContainer().offsetLeft || 0) + S.swipe / 100 * cont.width - 1}px`;
  const left = swipeOverlays[0].getElement();
  if (left) {
    const lr = left.getBoundingClientRect();
    const ls = left.offsetWidth ? left.offsetWidth / Math.max(1, lr.width) : 1;
    const keep = Math.max(0, (x - lr.left) * ls);
    left.style.clipPath = `inset(0 ${Math.max(0, left.offsetWidth - keep)}px 0 0)`;
  }
  const img = swipeOverlays[1].getElement();
  if (!img) return;
  const ir = img.getBoundingClientRect();
  const scale = img.offsetWidth ? img.offsetWidth / Math.max(1, ir.width) : 1;
  const clip = Math.max(0, (x - ir.left) * scale);
  img.style.clipPath = `inset(0 0 0 ${clip}px)`;
}
$("ck-swipe").addEventListener("input", ev => { S.swipe = +ev.target.value; updateSwipe(); });
map.on("move zoom zoomend moveend resize viewreset", updateSwipe);

function renderSph() {
  const s = D.sph;
  const v2 = s.validation["0.02"], v1 = s.validation["0.01"];
  const full = s.section.full_dp10, fine = s.section.full_dp05, part = s.section.partial_dp10;
  $("sp-kpis").innerHTML =
    kpi("Lab front error, RMS", v2 ? `${fmt(v2.rms_rel_err_tip_position * 100, 1)}<small>%</small>` : "n/a", v2 ? `0.02 m spacing, ${esc((v2.particles || "").replace(/^Total particles: ([\d,]+).*/, "$1"))} particles` : "") +
    kpi("Finer spacing", v1 ? `${fmt(v1.rms_rel_err_tip_position * 100, 1)}<small>%</small>` : "n/a", "0.01 m, not converged, see caveats") +
    kpi("Breach discharge vs Ritter", fine ? `${fmt(fine.ratio_mean_window_to_ritter, 2)}` : "n/a", fine ? `${fmt(fine.q_mean_window_vol_m2_s, 1)} vs ${fmt(fine.q_ritter_m2_s, 1)} m2/s, 0.5 m spacing` : "") +
    kpi("Solver time, fine run", fine ? `${fmt(fine.solver_wall_s / 60, 1)}<small>min</small>` : "n/a", fine ? `${fmt(fine.n_fluid_particles, 0)} fluid particles, CPU` : "");
  if (v2) {
    const t = v2.t_exp;
    const tmax = 0.75, xmin = 1, xmax = 4.2;
    chart($("sp-chart"), $("sp-tip"), {
      aria: "Dam break front position against experiment", h: 200,
      x: { min: 0, max: tmax, ticks: [0, 0.2, 0.4, 0.6], fmt: v => v.toFixed(1), label: "time, s" },
      y: { min: xmin, max: xmax, ticks: [1, 2, 3, 4], fmt: v => `${v}`, label: "front position, m" },
      series: [
        ...(v1 ? [{ x: v1.t_exp, y: v1.x_sph, color: "#93c3f3", width: 1.5, dash: "4 3" }] : []),
        { x: t, y: v2.x_sph, color: "#3987e5", width: 2 },
        { x: t, y: v2.x_exp, color: "#e9edf2", type: "dots" }
      ],
      hoverX: t,
      tip: i => `t ${fmt(t[i], 2)} s &middot; exp ${fmt(v2.x_exp[i], 2)} m &middot; SPH ${fmt(v2.x_sph[i], 2)} m`
    });
    $("sp-note").innerHTML = `<span class="swatch" style="background:#e9edf2;height:8px;width:8px;border-radius:50%"></span> experiment &nbsp;<span class="swatch" style="background:#3987e5"></span> DualSPHysics 0.02 m &nbsp;<span class="swatch" style="background:#93c3f3"></span> 0.01 m. Water column released in a tank, front position of the surge. Solver wall time ${fmt(v2.solver_wall_s, 1)} s at 0.02 m.`;
  }
  const rowS = (name, r) => r ? `<tr><td>${name}<span class="sub">${fmt(r.head_over_invert_m, 1)} m head, ${fmt(r.dp, 1)} m spacing</span></td><td class="r num">${fmt(r.q_peak_vol_m2_s, 1)}</td><td class="r num">${fmt(r.q_mean_window_vol_m2_s, 1)}</td><td class="r num">${fmt(r.q_ritter_m2_s, 1)}</td><td class="r num">${fmt(r.ratio_mean_window_to_ritter, 2)}</td></tr>` : "";
  $("sp-table").innerHTML = `<tr><th>Run</th><th class="r">Peak</th><th class="r">Mean</th><th class="r">Ritter</th><th class="r">Ratio</th></tr>` + rowS("Full section", fine) + rowS("Full section", full) + rowS("Partial breach", part);
  const dq = s.media["sph_breach_discharge.png"];
  $("sp-fig").innerHTML = dq ? `<div class="fig-block"><a href="${dq}" target="_blank" rel="noopener"><img src="${dq}" alt="Breach discharge per metre width against time, SPH and Ritter" loading="lazy"></a></div>` : "";
  const cav = s.caveats || [];
  $("sp-ncav").textContent = cav.length;
  $("sp-caveats").innerHTML = cav.map(c => `<li>${esc(c)}</li>`).join("");
  renderMedia();
}

function renderMedia() {
  const M = D.sph.media;
  const opts = [];
  if (M["sph_breach_anim.mp4"]) opts.push({ v: "partial", t: "Partial breach, 12.5 m head" });
  if (M["sph_breach_full_anim.mp4"]) opts.push({ v: "full", t: "Full section, 25 m head" });
  if (!opts.find(o => o.v === S.media) && opts.length) S.media = opts[0].v;
  segButtons($("md-seg"), opts, S.media, v => { S.media = v; renderMedia(); });
  const vid = S.media === "full" ? M["sph_breach_full_anim.mp4"] : M["sph_breach_anim.mp4"];
  const snap = S.media === "full" ? M["sph_breach_full_snapshots.png"] : M["sph_breach_snapshots.png"];
  const v = $("md-video");
  if (vid && v.getAttribute("src") !== vid) {
    v.setAttribute("src", vid);
    if (snap) v.setAttribute("poster", snap);
    const p = v.play();
    if (p && p.catch) p.catch(() => {});
  }
  if (snap) $("md-snap").src = snap;
  $("md-cap").textContent = S.media === "full" ? "DualSPHysics, 0.5 m particles, colour is speed" : "DualSPHysics, 1 m particles, colour is speed";
}

const CLS = ["0.1-0.5 m", "0.5-1.5 m", ">1.5 m"];
const CLS_COLOR = { "0.1-0.5 m": "#93c3f3", "0.5-1.5 m": "#f5a524", ">1.5 m": "#e0443a" };
function damageEngines() {
  const j = (D.damage || {}).json;
  return j ? ENG.filter(k => j.per_engine && j.per_engine[k]) : [];
}
function renderDamage() {
  const dmg = D.damage || {};
  const j = dmg.json;
  const eds = damageEngines();
  if (!S.dengine || !eds.includes(S.dengine)) S.dengine = eds[0] || null;
  let h = "";
  if (!j || !S.dengine) {
    h = `<div class="pending-box">Loss and damage run pending. It needs a flood depth raster from an engine; this panel fills in from results/damage.json when that run finishes.</div>`;
  } else {
    const e = j.per_engine[S.dengine], hd = (j.headline || {})[S.dengine] || {};
    h += `<div class="seg-group" style="margin-bottom:10px"><span class="label">Engine</span><div class="seg" id="dm-eng">${ENG.map(k => `<button data-v="${k}" aria-pressed="${k === S.dengine}" ${eds.includes(k) ? "" : "disabled"}>${ENG_LABEL[k]}${eds.includes(k) ? "" : " (pending)"}</button>`).join("")}</div></div>`;
    const b = e.buildings || {}, pd = e.population_dasymetric || {}, pw = e.population_worldpop_area || {}, cr = e.cropland || {}, rd = e.roads || {}, rl = e.railways || {}, br = e.bridges || {};
    h += `<div class="kpis">` +
      kpi("People under water", fmt(pd.total_exposed, 0), `${fmt(pw.total_exposed, 0)} by area weighting; WorldPop 2020`) +
      kpi("Buildings under water", fmt(b.total_exposed, 0), `of ${fmt(b.total_in_domain, 0)} in the box`) +
      kpi("Damage-equivalent houses", fmt(b.damage_equivalent_buildings, 0), `mean damage factor ${fmt(b.mean_damage_factor_exposed, 2)}, JRC Asia curve`) +
      kpi("Cropland flooded", `${fmt(cr.total_exposed_km2, 1)}<small>km2</small>`, `of ${fmt(cr.cropland_in_domain_km2, 0)} km2 in the box`) +
      kpi("Roads flooded", `${fmt(rd.total_exposed_km, 1)}<small>km</small>`, `rail ${fmt(rl.total_exposed_km, 1)} km`) +
      kpi("Bridges flooded", fmt(br.exposed, 0), `${fmt(br.exposed_road, 0)} road, ${fmt(br.exposed_rail, 0)} rail, of ${fmt(br.total_in_domain, 0)}`) +
      `</div>`;
    if (b.indicative_structure_loss_eur2010 != null) h += `<p class="note">Indicative structure loss: <b>EUR ${fmt(b.indicative_structure_loss_eur2010 / 1e6, 1)} million</b> (2010 prices). ${esc(cap(b.indicative_loss_basis))}.</p>`;
    const area = e.flooded_area_km2_by_class || {};
    const row = (t, o, d = 0) => `<tr><td>${t}</td>${CLS.map(c => `<td class="r num">${o && o[c] != null ? fmt(o[c], d) : "n/a"}</td>`).join("")}</tr>`;
    h += `<h3>Totals by depth class</h3><div style="overflow-x:auto"><table class="data"><tr><th></th>${CLS.map(c => `<th class="r"><span class="swatch" style="background:${CLS_COLOR[c]};height:8px;width:8px;border-radius:2px"></span> ${esc(c)}</th>`).join("")}</tr>` +
      row("Area, km2", area, 1) + row("People", pd.by_class, 0) + row("Buildings", b.count_by_class, 0) + row("Cropland, km2", cr.by_class_km2, 1) + row("Roads, km", rd.km_by_class, 1) + row("Bridges", br.exposed_by_class, 0) + `</table></div>`;
    const vs = e.villages_top || [];
    if (vs.length) {
      h += `<h3>Worst-hit villages (${fmt(e.villages_with_wet_buildings, 0)} with wet buildings)</h3><div style="overflow-x:auto"><table class="data"><tr><th>Village</th><th class="r">Wet / all houses</th><th class="r">People</th><th class="r">Damage eq.</th><th class="r">Max depth</th></tr>` +
        vs.slice(0, 25).map((v, i) => `<tr class="clickable" data-i="${i}"><td>${esc(v.name)}${REPORTED.has(v.name) ? ' <span class="pill yes">reported</span>' : ""}</td><td class="r num nw">${fmt(v.bldg_wet, 0)} / ${fmt(v.bldg_total, 0)}</td><td class="r num">${fmt(v.pop_wet, 0)}</td><td class="r num">${fmt(v.dmg_eq, 0)}</td><td class="r num nw">${fmt(v.max_depth, 1)} m</td></tr>`).join("") + `</table></div>`;
      h += `<p class="note">Houses are Google Open Buildings points within the village's catchment in the damage layer; damage equivalent = sum of JRC damage factors. Full table in Downloads.</p>`;
    }
    const cw = j.cwc_context;
    if (cw) h += `<div class="callout info"><b>Context:</b> the CWC/IISc study estimated that nearly ${fmt(cw.cwc_iisc_people_could_be_affected, 0)} people could be affected. ${esc(cap(cw.note))}.</div>`;
    const df = j.damage_functions || {};
    if (df.citation) h += `<h3>Damage curves</h3><p class="note">${esc(df.citation)} ${df.url ? `<a class="src" href="${esc(df.url)}" target="_blank" rel="noopener">link</a>` : ""}</p>`;
    if ((j.caveats || []).length) h += `<details class="limits"><summary>Caveats (${j.caveats.length})</summary><ul class="caveats">${j.caveats.map(c => `<li>${esc(c)}</li>`).join("")}</ul></details>`;
    if (j.status && j.status !== "done") h += `<p class="note">Status ${statusChip(j.status)} ${(j.pending_engines || []).map(k => ENG_LABEL[k] || k).join(", ")} still to run.</p>`;
  }
  h += (dmg.figures || []).map(f => `<div class="fig-block"><a href="${f}" target="_blank" rel="noopener"><img src="${f}" alt="damage figure" loading="lazy"></a></div>`).join("");
  $("dm-body").innerHTML = h;
  if ($("dm-eng")) $("dm-eng").querySelectorAll("button").forEach(bt => bt.addEventListener("click", () => { if (!bt.disabled) { S.dengine = bt.dataset.v; renderDamage(); } }));
  if (j && S.dengine) {
    const vs = j.per_engine[S.dengine].villages_top || [];
    $("dm-body").querySelectorAll("tr.clickable").forEach(tr => tr.addEventListener("click", () => { const v = vs[+tr.dataset.i]; if (v && v.lat != null) map.flyTo([v.lat, v.lon], 14, { duration: 0.6 }); }));
  }
  const ex = D.scenario.exposure || {};
  const osm = ex.osm || {}, bld = ex.buildings || {}, wc = (ex.worldcover || {}).class_area_km2 || {}, pop = ex.population || {};
  $("dm-exposure").innerHTML =
    kpi("People", fmt(pop.domain_total_1km_cells_overlapping_bbox, 0), "WorldPop 2020, 1 km cells touching the box") +
    kpi("Buildings", fmt(bld.count, 0), "Google Open Buildings footprints") +
    kpi("Cropland", `${fmt(wc.cropland, 1)}<small>km2</small>`, "ESA WorldCover 2021") +
    kpi("Roads", `${fmt(osm.road_km, 0)}<small>km</small>`, `${fmt(osm.bridges_ways, 0)} bridges, OpenStreetMap`);
  $("dm-src").innerHTML = [pop.source, bld.source, (ex.worldcover || {}).source, "OpenStreetMap contributors, ODbL, via Overpass"].filter(Boolean).map(x => `<li>${esc(x)}</li>`).join("");
  clearEngine();
  panelLayers.clearLayers();
  const layers = dmg.layers || {};
  const pre = S.dengine ? `damage_${S.dengine}_` : "damage_";
  let leg = "";
  const eng = S.dengine && engReady(S.dengine) ? S.dengine : readyEngines()[0];
  if (eng) {
    engineOverlay = L.imageOverlay(D.engines[eng].depth_png, D.engines[eng].bounds, { opacity: 0.45, className: "engine-img", interactive: false }).addTo(map);
  }
  const popup = (n, f) => `<div class="tt-street">${esc(f.properties.name || label(n))}</div>` + Object.entries(f.properties || {}).filter(([k]) => !["osm_id", "lon", "lat", "name"].includes(k)).slice(0, 9).map(([k, v]) => `<div class="tt-row">${esc(label(k))}<b>${typeof v === "number" ? fmtAuto(v) : esc(v)}</b></div>`).join("");
  ["roads", "railways", "bridges"].forEach(t => {
    const gj = layers[pre + t];
    if (!gj) return;
    L.geoJSON(gj, { style: f => ({ color: CLS_COLOR[f.properties.depth_cls] || "#e9edf2", weight: t === "bridges" ? 6 : t === "railways" ? 2.4 : 2, opacity: 0.95, dashArray: t === "railways" ? "5 4" : null }), onEachFeature: (f, l) => l.bindPopup(popup(t, f)) }).addTo(panelLayers);
  });
  const vg = layers[pre + "villages"];
  if (vg) {
    L.geoJSON(vg, {
      pointToLayer: (f, ll) => L.circleMarker(ll, { radius: Math.max(4, Math.min(16, 2.5 * Math.sqrt(f.properties.dmg_eq || 0))), color: "#0b0e13", weight: 1, fillColor: "#ec835a", fillOpacity: 0.85 }),
      onEachFeature: (f, l) => l.bindPopup(popup("villages", f))
    }).addTo(panelLayers);
  }
  if (Object.keys(layers).some(k => k.startsWith(pre))) {
    leg = `<div class="title">Assets under water, by depth</div>` + CLS.map(c => `<div class="row"><span class="ln" style="border-top:3px solid ${CLS_COLOR[c]}"></span>${esc(c)}</div>`).join("") +
      `<div class="row"><span class="ln" style="border-top:3px dashed #b4bcc8"></span>Railway</div><div class="row"><span class="dot" style="background:#ec835a"></span>Village, size = damaged houses</div>` +
      (eng ? `<div class="note-l">Faint blue: ${ENG_LABEL[eng]} max depth</div>` : "");
  } else if (eng) leg = legendHtml("depth");
  setLegend(leg + baseLegend());
  drawVillages(!vg);
}

function geeLayers() {
  panelLayers.clearLayers();
  clearEngine();
  const g = D.geo;
  let leg = "";
  if (S.sat === "bar" && g.gee_barpeta) {
    const l = L.geoJSON(g.gee_barpeta, { style: { color: "#4f9be8", weight: 0.8, fillColor: "#4f9be8", fillOpacity: 0.55 } }).addTo(panelLayers);
    l.eachLayer(x => x.bindTooltip(`Flagged ${fmt(x.feature.properties.area_ha, 2)} ha`, { className: "jd-tip short", sticky: true }));
    map.flyToBounds(l.getBounds(), { padding: [30, 30], duration: 0.8 });
    leg = `<div class="title">Barpeta, June 2022</div><div class="row"><span class="sw" style="background:#4f9be8"></span>Sentinel-1 flood, 16 Jun 2022</div><div class="note-l">UN-SPIDER change detection on the open twin</div>`;
    drawVillages(false);
  } else {
    if (g.gee_reservoir) {
      const byDate = { "2021-11-16": { color: "#6fe0f0", fill: 0.12, t: "Reservoir water, 16 Nov (before)" }, "2021-11-28": { color: "#f5a524", fill: 0.7, t: "Reservoir water, 28 Nov (after)" } };
      L.geoJSON(g.gee_reservoir, { filter: f => byDate[f.properties.date], style: f => ({ color: byDate[f.properties.date].color, weight: 1.2, fillColor: byDate[f.properties.date].color, fillOpacity: byDate[f.properties.date].fill }) })
        .eachLayer(x => { x.bindTooltip(`${esc(x.feature.properties.date)}: ${fmt(x.feature.properties.area_ha, 1)} ha`, { className: "jd-tip short", sticky: true }); x.addTo(panelLayers); });
      Object.values(byDate).forEach(o => { leg += `<div class="row"><span class="sw" style="background:${o.color}"></span>${o.t}</div>`; });
    }
    if (g.gee_reach) {
      L.geoJSON(g.gee_reach, { style: { color: "#e0443a", weight: 0.8, fillColor: "#e0443a", fillOpacity: 0.5 } })
        .eachLayer(x => { x.bindTooltip(`Change flag ${fmt(x.feature.properties.area_ha, 2)} ha, not claimed as flood`, { className: "jd-tip short", sticky: true }); x.addTo(panelLayers); });
      leg += `<div class="row"><span class="sw" style="background:#e0443a"></span>Reach change flags, 28 Nov (not flood)</div>`;
    }
    leg = `<div class="title">Sentinel-1, Nov 2021</div>` + leg;
    if (!B.contains(map.getCenter())) map.flyToBounds(B, { padding: [10, 10], duration: 0.8 });
    drawVillages(true);
  }
  setLegend(leg + (S.sat === "bar" ? "" : baseLegend()));
  $("sa-show-ann").setAttribute("aria-pressed", S.sat === "ann");
  $("sa-show-bar").setAttribute("aria-pressed", S.sat === "bar");
}

function renderSatellite() {
  const G = D.gee, hl = G.headline || {}, c = G.cases || {};
  $("sa-lede").innerHTML = `The UN-SPIDER Sentinel-1 change-detection recipe, written for Google Earth Engine and run here on an open twin (Microsoft Planetary Computer, no account). It gives a near-real-time flood extent from radar, through cloud, within a day of a satellite pass.`;
  $("sa-ann").innerHTML =
    kpi("Reservoir water, 16 Nov", `${fmt(hl.annamayya_reservoir_water_km2_before, 2)}<small>km2</small>`, "3 days before the breach") +
    kpi("Reservoir water, 28 Nov", `${fmt(hl.annamayya_reservoir_water_km2_after, 3)}<small>km2</small>`, `${fmt(hl.annamayya_reservoir_water_loss_pct, 1)}% gone: the breach emptied it`) +
    kpi("First look after breach", "9<small>days</small>", "S1 orbit 92 passes: 4, 16, 28 Nov") +
    kpi("Reach change flags", `${fmt(hl.annamayya_reach_flagged_ha, 0)}<small>ha</small>`, `${fmt(hl.annamayya_reach_flagged_pct_of_aoi, 2)}% of the reach box, not flood`);
  $("sa-ann-note").innerHTML = `<b>No satellite flood extent exists for this event.</b> The flood had drained before the next Sentinel-1 pass. The flags on the reach lie along the river bed (sand, scour, residual water) and are fewer than the dry-season false positives at Barpeta, so they are not used to validate the models. The reservoir loss is real and is the satellite evidence of the breach.`;
  $("sa-bar").innerHTML =
    kpi("Flood mapped", `${fmt(hl.barpeta_flood_ha, 0)}<small>ha</small>`, `${fmt(hl.barpeta_polygons, 0)} polygons, 16 Jun 2022`) +
    kpi("Dry-season control", `${fmt(hl.barpeta_dry_control_ha, 0)}<small>ha</small>`, "same box and orbit, Feb 2022") +
    kpi("Flood vs control", `${fmt(hl.barpeta_flood_to_control_ratio, 2)}<small>x</small>`, "signal over false positives") +
    kpi("Run time", `${fmt((c.barpeta_2022 || {}).seconds, 0)}<small>s</small>`, `${fmt((c.barpeta_2022 || {}).res_m, 0)} m grid, open twin`);
  $("sa-bar-note").innerHTML = `Barpeta was among the worst-hit districts in the June 2022 Assam floods (Sphere India). Box ${((c.barpeta_2022 || {}).bbox || []).join(", ")}; before ${esc((c.barpeta_2022 || {}).before_period)}, after ${esc((c.barpeta_2022 || {}).after_period)}.`;
  const figCap = { "gee_annamayya_reach.png": "Annamayya reach, before and after", "gee_annamayya_reservoir.png": "Annamayya reservoir water", "gee_barpeta_2022.png": "Barpeta flood, June 2022", "gee_summary.png": "Summary" };
  $("sa-figs").innerHTML = (G.figures || []).map(f => `<a href="${f}" target="_blank" rel="noopener"><img src="${f}" alt="${esc(figCap[f.split("/").pop()] || "figure")}" loading="lazy"><span>${esc(figCap[f.split("/").pop()] || f)}</span></a>`).join("");
  const m = G.method || {};
  $("sa-method").innerHTML = `<b>Recipe.</b> ${esc(m.recipe || "")}<br><br><b>On Earth Engine:</b> gee/gee_flood.js and gee_flood.py, for a free noncommercial Earth Engine project. ${m.gee_scripts_executed_on_gee === false ? "Not yet run on Earth Engine itself." : ""}<br><b>Open twin:</b> ${esc(m.open_twin || "")}.`;
  const dls = (D.downloads || []).filter(d => /Satellite/.test(d.group));
  $("sa-dl").innerHTML = dlRows(dls);
  const cav = G.caveats || [];
  $("sa-ncav").textContent = cav.length;
  $("sa-caveats").innerHTML = cav.map(x => `<li>${esc(x)}</li>`).join("");
  geeLayers();
}
$("sa-show-ann").addEventListener("click", () => { S.sat = "ann"; geeLayers(); writeUrl(); });
$("sa-show-bar").addEventListener("click", () => { S.sat = "bar"; geeLayers(); writeUrl(); });

function dlRows(list) {
  const byLab = new Map();
  list.forEach(d => { const k = `${d.group}|${d.label}`; if (!byLab.has(k)) byLab.set(k, []); byLab.get(k).push(d); });
  return [...byLab.values()].map(ds => `<div class="dl-row"><span class="dl-lab">${esc(ds[0].label)}</span>${ds.map(d => `<a class="kind" href="${esc(d.href)}" download title="${esc(d.size)}">${esc(d.kind)}</a><span class="sz">${esc(d.size)}</span>`).join("")}</div>`).join("");
}

function renderDownloads() {
  const groups = ["Delft3D FM", "SWE-SPH", "Loss and damage", "Scenario", "Satellite (GEE twin)", "Other"];
  const all = D.downloads || [];
  let h = "";
  groups.forEach(g => {
    const ds = all.filter(d => d.group === g);
    const eng = g === "Delft3D FM" ? "d3d" : g === "SWE-SPH" ? "swesph" : null;
    if (!ds.length && !eng && g !== "Loss and damage") return;
    h += `<div class="dl-group"><h3>${esc(g)}</h3>`;
    if (!ds.length) h += `<div class="pending-box">${eng ? "Engine run pending." : "Loss and damage run pending."} Files appear here when the run finishes.</div>`;
    else h += dlRows(ds);
    h += `</div>`;
  });
  $("dl-list").innerHTML = h;
  $("dl-gen").textContent = `Bundle built ${D.generated_utc} by python -m baandh.export_web.`;
  const eng = readyEngines()[0];
  clearEngine();
  if (eng) engineOverlay = L.imageOverlay(D.engines[eng].depth_png, D.engines[eng].bounds, { opacity: 0.9, className: "engine-img", interactive: false }).addTo(map);
  setLegend((eng ? legendHtml("depth") + `<div class="note-l">${ENG_LABEL[eng]} max depth</div>` : "") + baseLegend());
  drawVillages(true);
}

function renderScenarioMap() {
  clearEngine();
  setLegend(`<div class="title">Terrain</div><div class="row">Copernicus GLO-30 DEM hillshade</div>` + baseLegend());
  drawVillages(true);
}

const RENDER = { scenario: () => { renderScenario(); renderScenarioMap(); }, flood: renderFlood, compare: renderCompare, sph: renderSph, damage: renderDamage, satellite: renderSatellite, downloads: renderDownloads };

function show(p) {
  if (!PANELS.includes(p)) p = "scenario";
  const prev = S.panel;
  S.panel = p;
  stopPlay();
  document.body.dataset.panel = p;
  document.querySelectorAll(".tab").forEach(t => t.setAttribute("aria-selected", t.dataset.panel === p));
  document.querySelectorAll(".panel").forEach(s => { s.hidden = s.dataset.panel !== p; });
  const onMap = MAP_PANELS.includes(p);
  $("map").hidden = !onMap;
  $("media").hidden = onMap;
  $("legend").hidden = !onMap;
  $("dock").hidden = p !== "flood";
  $("frame-card").hidden = true;
  $("cdock").hidden = p !== "compare";
  if (p !== "sph") { const v = $("md-video"); if (!v.paused) v.pause(); }
  panelLayers.clearLayers();
  if (prev === "satellite" && p !== "satellite" && !B.contains(map.getCenter())) map.fitBounds(B, { padding: [10, 10] });
  RENDER[p]();
  if (onMap) setTimeout(() => { map.invalidateSize(); updateSwipe(); }, 0);
  document.querySelector(".side").scrollTop = 0;
}

function readUrl() {
  const q = new URLSearchParams(location.search);
  const p = q.get("panel");
  if (q.get("engine") && ENG.includes(q.get("engine"))) S.engine = q.get("engine");
  if (["depth", "arrival", "frames"].includes(q.get("layer"))) S.layer = q.get("layer");
  if (["swipe", "diff", "d3d", "swesph"].includes(q.get("view"))) S.cmode = q.get("view");
  if (q.get("sat") === "bar") S.sat = "bar";
  return PANELS.includes(p) ? p : "scenario";
}

function writeUrl() {
  const q = new URLSearchParams();
  q.set("panel", S.panel);
  if (S.panel === "flood" && S.engine) { q.set("engine", S.engine); q.set("layer", S.layer); }
  if (S.panel === "compare") q.set("view", S.cmode);
  if (S.panel === "satellite" && S.sat === "bar") q.set("sat", "bar");
  history.replaceState(null, "", `${location.pathname}?${q}`);
}

document.querySelectorAll(".tab").forEach(t => t.addEventListener("click", () => { show(t.dataset.panel); writeUrl(); }));
if (readyEngines().length < 2 && S.cmode === "swipe") S.cmode = readyEngines()[0] || "swipe";
show(readUrl());
window.BaandhRakshak = { data: D, show };
