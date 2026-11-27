// Assets with a live price feed (gold-api.com unless `feed` says otherwise); `grid` is the section each card goes in.
const LIVE_ASSETS = [
  { symbol: "XAU", name: "Gold", unit: "USD/oz", use: "Connectors, bonding wire, contacts", color: "#c9a227" },
  { symbol: "XAG", name: "Silver", unit: "USD/oz", use: "Solder, conductive pastes, contacts", color: "#8c99a6" },
  { symbol: "XPT", name: "Platinum", unit: "USD/oz", use: "Hard-disk platters, sensors", color: "#5b8db8" },
  { symbol: "XPD", name: "Palladium", unit: "USD/oz", use: "Multilayer ceramic capacitors", color: "#9b6fc4" },
  { symbol: "HG", name: "Copper", unit: "USD/lb", use: "Wiring, PCBs, motors", color: "#c66b3d" },
  { symbol: "BTC", name: "Bitcoin", unit: "USD", use: "Cryptocurrency", color: "#f7931a", grid: "crypto-grid" },
  { symbol: "ETH", name: "Ethereum", unit: "USD", use: "Cryptocurrency", color: "#627eea", grid: "crypto-grid" },
  { symbol: "SOL", name: "Solana", unit: "USD", use: "Cryptocurrency", color: "#14b8a6", grid: "crypto-grid", feed: "coinbase" },
  { symbol: "XRP", name: "XRP", unit: "USD", use: "Cryptocurrency", color: "#5a6b7d", grid: "crypto-grid", feed: "coinbase" },
];

async function fetchLivePrice(asset) {
  if (asset.feed === "coinbase") {
    return Number((await fetchJson(`https://api.coinbase.com/v2/prices/${asset.symbol}-USD/spot`)).data.amount);
  }
  return Number((await fetchJson(`https://api.gold-api.com/price/${asset.symbol}`)).price);
}
const RARE_COLORS = ["#2a9d8f", "#e76f51", "#7b6ce0", "#d4a017", "#3a86ff", "#e05a8a", "#6a994e"];
const REFRESH_MS = 60_000;
const MIN_RECORD_GAP_MS = 5 * 60_000;
const MAX_LOCAL_POINTS = 1000;

const charts = {};

// --- Crypto candles, timeframes and moving averages ---
// Daily candles come from Coinbase Exchange's free public API (no key). 3-day, weekly and
// monthly candles are built from them in the browser. "Live" keeps the original snapshot chart.
const TIMEFRAMES = [["live", "Live"], ["1", "1D"], ["3", "3D"], ["7", "1W"], ["30", "1M"]];
const spanLabel = (n, days) => days === 30 ? `${n} months` : days === 7 ? `${n} weeks` : `${n * days} days`;
const VISIBLE_CANDLES = { 1: 180, 3: 120, 7: 156, 30: Infinity };
const MA_PERIODS = [20, 50, 200];
const MA_COLORS = { 20: "#3a86ff", 50: "#e05a8a", 200: "#d4a017" };
const CANDLE_PAGES = 6; // 6 × 300 daily candles ≈ 5 years, enough for a 200-week average
const CANDLE_TTL_MS = 6 * 60 * 60_000;
const DAY_MS = 864e5;
const candleRequests = {};

function defaultView() {
  return { tf: "1", kind: "sma", show: { 20: true, 50: true, 200: true } };
}
function loadView(id) {
  return { ...defaultView(), ...loadLocal(`view-${id}`, {}) };
}

// Returns ascending [{ t, o, h, l, c }] daily candles, cached in this browser for a few hours.
function fetchCandles(symbol) {
  const cached = loadLocal(`candles-${symbol}`, null);
  if (cached && Date.now() - cached.fetched < CANDLE_TTL_MS) {
    return Promise.resolve(cached.rows.map(([t, o, h, l, c]) => ({ t, o, h, l, c })));
  }
  candleRequests[symbol] ??= (async () => {
    const byTime = new Map();
    let end = Date.now();
    for (let page = 0; page < CANDLE_PAGES; page++) {
      const start = end - 300 * DAY_MS;
      const url = `https://api.exchange.coinbase.com/products/${symbol}-USD/candles?granularity=86400` +
        `&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`;
      const rows = await fetchJson(url); // [time (s), low, high, open, close, volume], newest first
      if (!Array.isArray(rows) || !rows.length) break;
      rows.forEach(([t, l, h, o, c]) => byTime.set(t * 1000, { t: t * 1000, o, h, l, c }));
      end = start;
    }
    const candles = [...byTime.values()].sort((a, b) => a.t - b.t);
    if (!candles.length) throw new Error(`No candles for ${symbol}`);
    saveLocal(`candles-${symbol}`, { fetched: Date.now(), rows: candles.map(x => [x.t, x.o, x.h, x.l, x.c]) });
    return candles;
  })().finally(() => { delete candleRequests[symbol]; });
  return candleRequests[symbol];
}

// Groups daily candles into 3-day, weekly (Monday start) or calendar-month candles.
function aggregateCandles(daily, days) {
  if (days === 1) return daily;
  const key = t => {
    if (days === 30) { const d = new Date(t); return d.getUTCFullYear() * 12 + d.getUTCMonth(); }
    if (days === 7) return Math.floor((t / DAY_MS + 3) / 7);
    return Math.floor(t / DAY_MS / days);
  };
  const out = [];
  let group = null;
  for (const x of daily) {
    const k = key(x.t);
    if (!group || group.k !== k) {
      group = { k, t: x.t, o: x.o, h: x.h, l: x.l, c: x.c };
      out.push(group);
    } else {
      group.h = Math.max(group.h, x.h);
      group.l = Math.min(group.l, x.l);
      group.c = x.c;
    }
  }
  return out;
}

function sma(values, n) {
  let sum = 0;
  return values.map((v, i) => {
    sum += v;
    if (i >= n) sum -= values[i - n];
    return i >= n - 1 ? sum / n : null;
  });
}
function ema(values, n) {
  const k = 2 / (n + 1);
  let e = null;
  return values.map((v, i) => {
    if (i === n - 1) e = values.slice(0, n).reduce((a, b) => a + b) / n;
    else if (i >= n) e = v * k + e * (1 - k);
    return e;
  });
}

function addCryptoControls(card, id) {
  const box = document.createElement("div");
  box.className = "view-controls";
  box.innerHTML = `
    <div class="seg" role="group" aria-label="Timeframe">${TIMEFRAMES.map(([v, label]) =>
      `<button type="button" data-tf="${v}">${label}</button>`).join("")}</div>
    <div class="seg ma-controls" role="group" aria-label="Moving averages">${MA_PERIODS.map(n =>
      `<button type="button" data-ma="${n}" style="--ma:${MA_COLORS[n]}">${n}</button>`).join("")}
      <button type="button" data-kind>SMA</button></div>`;
  box.addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b) return;
    const view = loadView(id);
    if (b.dataset.tf) view.tf = b.dataset.tf;
    else if (b.dataset.ma) view.show[b.dataset.ma] = !view.show[b.dataset.ma];
    else if ("kind" in b.dataset) view.kind = view.kind === "sma" ? "ema" : "sma";
    saveLocal(`view-${id}`, view);
    drawAsset(LIVE_ASSETS.find(a => a.symbol === id));
  });
  card.querySelector(".card-head").after(box);
  const legend = document.createElement("p");
  legend.className = "ma-legend";
  card.querySelector(".chart-wrap").after(legend);
}

function syncControls(card, view) {
  card.querySelectorAll("[data-tf]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.tf === view.tf)));
  card.querySelectorAll("[data-ma]").forEach(b => b.setAttribute("aria-pressed", String(!!view.show[b.dataset.ma])));
  const kind = card.querySelector("[data-kind]");
  kind.textContent = view.kind.toUpperCase();
  kind.title = view.kind === "sma" ? "Simple moving average (click for exponential)" : "Exponential moving average (click for simple)";
  card.querySelector(".ma-controls").hidden = view.tf === "live";
}

// Draws a card in whichever mode it is in: live snapshots, or candles with moving averages.
async function drawAsset(info) {
  const id = info.symbol;
  const card = document.getElementById(`card-${id}`);
  if (info.grid !== "crypto-grid") return renderCard(id, info, livePoints(id));
  const view = loadView(id);
  syncControls(card, view);
  const legend = card.querySelector(".ma-legend");
  if (charts[id] && charts[id].$mode !== view.tf) { charts[id].destroy(); delete charts[id]; }
  if (view.tf === "live") {
    legend.textContent = "";
    renderCard(id, info, livePoints(id));
    if (charts[id]) charts[id].$mode = "live";
    return;
  }
  if (!charts[id]) legend.textContent = "Loading price history…";
  let daily;
  try {
    daily = await fetchCandles(id);
  } catch (err) {
    console.warn(err);
    if (charts[id]) { charts[id].destroy(); delete charts[id]; }
    legend.textContent = "Could not load price history from Coinbase. Showing live snapshots instead.";
    renderCard(id, info, livePoints(id));
    if (charts[id]) charts[id].$mode = view.tf;
    return;
  }
  if (loadView(id).tf !== view.tf) return; // the user switched again while this was loading
  renderCandleCard(card, info, view, daily);
}

function renderCandleCard(card, info, view, daily) {
  const id = info.symbol;
  const days = Number(view.tf);
  const candles = aggregateCandles(daily, days);
  const closes = candles.map(x => x.c);
  const from = Math.max(0, candles.length - VISIBLE_CANDLES[days]);
  const average = view.kind === "ema" ? ema : sma;
  const lines = MA_PERIODS.map(n => ({ n, values: average(closes, n) }));

  // Header: the newest live reading if there is one, else the latest close.
  const live = loadLocal(`live-${id}`, []).at(-1);
  const price = live && Date.now() - live.t < 2 * DAY_MS ? live.price : closes.at(-1);
  card.querySelector(".empty").hidden = true;
  card.querySelector(".price").innerHTML = formatPrice(price, info.unit);
  const first = closes[from];
  const pct = ((price - first) / first) * 100;
  const changeEl = card.querySelector(".change");
  changeEl.textContent = `${pct >= 0 ? "▲" : "▼"} ${Math.abs(pct).toFixed(2)}% over ${spanLabel(candles.length - from, days)}`;
  changeEl.className = `change ${pct >= 0 ? "up" : "down"}`;

  const legend = card.querySelector(".ma-legend");
  legend.replaceChildren(...lines.filter(l => view.show[l.n]).map(l => {
    const span = document.createElement("span");
    const last = l.values.at(-1);
    span.style.setProperty("--ma", MA_COLORS[l.n]);
    span.textContent = last == null
      ? `${l.n} ${view.kind.toUpperCase()}: needs ${l.n} candles (have ${candles.length})`
      : `${l.n} ${view.kind.toUpperCase()} $${last.toLocaleString(undefined, { maximumFractionDigits: last < 10 ? 4 : 0 })}`;
    return span;
  }));

  const toData = values => values.slice(from).map((y, i) => ({ x: candles[from + i].t, y }));
  const datasets = [
    { label: "Close", data: toData(closes), borderColor: info.color, backgroundColor: info.color + "22", fill: true, borderWidth: 1.6, pointRadius: 0, tension: 0 },
    ...lines.filter(l => view.show[l.n]).map(l => ({
      label: `${l.n} ${view.kind.toUpperCase()}`, data: toData(l.values), borderColor: MA_COLORS[l.n],
      borderWidth: 1.6, pointRadius: 0, fill: false, spanGaps: false,
    })),
  ];
  if (charts[id]) charts[id].destroy();
  if (typeof Chart === "undefined") return;
  const style = getComputedStyle(document.documentElement);
  const muted = style.getPropertyValue("--muted").trim();
  const grid = style.getPropertyValue("--border").trim();
  const dateFmt = days === 30 ? { month: "short", year: "2-digit" } : days === 1 ? { month: "short", day: "numeric" } : { month: "short", year: "2-digit" };
  charts[id] = new Chart(card.querySelector("canvas"), {
    type: "line",
    data: { datasets },
    options: {
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          filter: item => item.parsed.y != null,
          callbacks: {
            title: items => new Date(items[0].parsed.x).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }),
            label: item => `${item.dataset.label}: $${item.parsed.y.toLocaleString(undefined, { maximumFractionDigits: item.parsed.y < 10 ? 4 : 2 })}`,
          },
        },
      },
      scales: {
        x: { type: "linear", min: candles[from].t, max: candles.at(-1).t,
          ticks: { color: muted, maxTicksLimit: 5, callback: v => new Date(v).toLocaleDateString(undefined, dateFmt) }, grid: { color: grid } },
        y: { ticks: { color: muted, maxTicksLimit: 5 }, grid: { color: grid } },
      },
    },
  });
  charts[id].$mode = view.tf;
}

// --- localStorage helpers (storage can be unavailable, e.g. private mode) ---
function loadLocal(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function saveLocal(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

// Points are { t: epoch ms, price: number }, sorted by t.
function toPoints(entries) {
  return entries
    .map(e => ({ t: e.t ?? Date.parse(`${e.date}T12:00`), price: Number(e.price) }))
    .filter(p => Number.isFinite(p.t) && Number.isFinite(p.price))
    .sort((a, b) => a.t - b.t);
}

function formatPrice(value, unit) {
  const digits = value < 10 ? 3 : 2;
  const per = unit.includes("/") ? ` <small>${unit.replace("USD/", "/")}</small>` : "";
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}${per}`;
}

function createCard(container, id, info) {
  const node = document.getElementById("card-template").content.firstElementChild.cloneNode(true);
  node.id = `card-${id}`;
  node.querySelector(".name").textContent = info.name;
  node.querySelector(".use").textContent = `${info.use} · ${info.unit}`;
  const toggle = node.querySelector(".toggle");
  toggle.setAttribute("aria-label", `Show or hide ${info.name} chart`);
  toggle.addEventListener("click", () => setCollapsed(id, !node.classList.contains("collapsed")));
  if (info.grid === "crypto-grid") addCryptoControls(node, id);
  container.appendChild(node);
  setCollapsed(id, loadLocal("collapsed", {})[id] ?? false, false);
  return node;
}

// --- Show / hide charts (remembered in this browser) ---
function setCollapsed(id, collapsed, save = true) {
  const card = document.getElementById(`card-${id}`);
  card.classList.toggle("collapsed", collapsed);
  card.querySelector(".toggle").setAttribute("aria-expanded", String(!collapsed));
  if (save) {
    const state = loadLocal("collapsed", {});
    state[id] = collapsed;
    saveLocal("collapsed", state);
  }
  updateToggleAll();
}

function updateToggleAll() {
  const cards = [...document.querySelectorAll(".card")];
  const allCollapsed = cards.length > 0 && cards.every(c => c.classList.contains("collapsed"));
  document.getElementById("toggle-all").textContent = allCollapsed ? "Show all charts" : "Hide all charts";
}

function toggleAll() {
  const cards = [...document.querySelectorAll(".card")];
  const collapse = !cards.every(c => c.classList.contains("collapsed"));
  cards.forEach(c => setCollapsed(c.id.replace("card-", ""), collapse));
}

function renderCard(id, info, points) {
  const card = document.getElementById(`card-${id}`);
  const priceEl = card.querySelector(".price");
  const changeEl = card.querySelector(".change");
  card.querySelector(".empty").hidden = points.length > 0;

  if (points.length) {
    const last = points[points.length - 1];
    priceEl.innerHTML = formatPrice(last.price, info.unit);
    if (points.length > 1) {
      const first = points[0];
      const pct = ((last.price - first.price) / first.price) * 100;
      changeEl.textContent = `${pct >= 0 ? "▲" : "▼"} ${Math.abs(pct).toFixed(2)}% since ${new Date(first.t).toLocaleDateString()}`;
      changeEl.className = `change ${pct >= 0 ? "up" : "down"}`;
    } else {
      changeEl.textContent = `as of ${new Date(last.t).toLocaleDateString()}`;
      changeEl.className = "change";
    }
  }

  const data = points.map(p => ({ x: p.t, y: p.price }));
  // Keep at least a one-day window so a single point doesn't produce a meaningless axis.
  const xRange = {};
  if (data.length) {
    const lo = data[0].x, hi = data[data.length - 1].x, pad = Math.max(0, 864e5 - (hi - lo)) / 2;
    Object.assign(xRange, { min: lo - pad, max: hi + pad });
  }
  if (charts[id]) {
    charts[id].data.datasets[0].data = data;
    Object.assign(charts[id].options.scales.x, xRange);
    charts[id].update("none");
    return;
  }
  if (typeof Chart === "undefined") return;
  const style = getComputedStyle(document.documentElement);
  const muted = style.getPropertyValue("--muted").trim();
  const grid = style.getPropertyValue("--border").trim();
  charts[id] = new Chart(card.querySelector("canvas"), {
    type: "line",
    data: {
      datasets: [{
        data,
        borderColor: info.color,
        backgroundColor: info.color + "22",
        fill: true,
        borderWidth: 2,
        pointRadius: data.length < 30 ? 3 : 0,
        tension: 0.2,
      }],
    },
    options: {
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "nearest", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: items => new Date(items[0].parsed.x).toLocaleString(),
            label: item => `$${item.parsed.y.toLocaleString(undefined, { maximumFractionDigits: 3 })} ${info.unit}`,
          },
        },
      },
      scales: {
        x: {
          type: "linear",
          ...xRange,
          ticks: { color: muted, maxTicksLimit: 5, callback: v => new Date(v).toLocaleDateString(undefined, { month: "short", day: "numeric" }) },
          afterBuildTicks: axis => { if (!data.length) axis.ticks = []; },
          grid: { color: grid },
        },
        y: { ticks: { color: muted, maxTicksLimit: 5 }, grid: { color: grid } },
      },
    },
  });
}

// --- Live metals ---
let dailyHistory = {};

function livePoints(symbol) {
  const local = loadLocal(`live-${symbol}`, []);
  // On days with live readings, prefer them over the daily snapshot so the newest price is always the live one.
  const liveDays = new Set(local.map(p => new Date(p.t).toLocaleDateString("sv")));
  const daily = (dailyHistory[symbol] ?? []).filter(p => !liveDays.has(p.date));
  return toPoints([...daily, ...local]);
}

function recordLive(symbol, price) {
  const local = loadLocal(`live-${symbol}`, []);
  const now = Date.now();
  const last = local[local.length - 1];
  if (last && now - last.t < MIN_RECORD_GAP_MS) local[local.length - 1] = { t: now, price };
  else local.push({ t: now, price });
  saveLocal(`live-${symbol}`, local.slice(-MAX_LOCAL_POINTS));
}

async function refreshLive() {
  const status = document.getElementById("status");
  status.textContent = "Updating…";
  status.className = "status";
  const results = await Promise.allSettled(
    LIVE_ASSETS.map(fetchLivePrice)
  );
  let failed = 0;
  results.forEach((r, i) => {
    const m = LIVE_ASSETS[i];
    if (r.status === "fulfilled" && Number.isFinite(r.value)) recordLive(m.symbol, r.value);
    else failed++;
    drawAsset(m);
  });
  if (failed) {
    status.textContent = `Could not reach the live price feed for ${failed} asset(s); showing saved data.`;
    status.className = "status error";
  } else {
    status.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  }
}

// --- Rare earths ---
function rarePoints(id, metal) {
  return toPoints([...metal.prices, ...loadLocal(`rare-${id}`, [])]);
}

function addRareForm(card, id, metal) {
  const form = document.createElement("form");
  form.className = "add-form";
  form.innerHTML = `
    <input type="date" name="date" required aria-label="Date">
    <input type="number" name="price" step="any" min="0" required placeholder="Price (${metal.unit})" aria-label="Price">
    <button type="submit">Add price</button>`;
  form.date.valueAsDate = new Date();
  form.addEventListener("submit", e => {
    e.preventDefault();
    const local = loadLocal(`rare-${id}`, []);
    local.push({ date: form.date.value, price: Number(form.price.value) });
    saveLocal(`rare-${id}`, local);
    form.price.value = "";
    renderCard(id, metal, rarePoints(id, metal));
  });
  card.appendChild(form);
}

async function initRare() {
  const grid = document.getElementById("rare-grid");
  let metals = {};
  try {
    metals = (await fetchJson("data/rare-earths.json")).metals;
  } catch (err) {
    grid.textContent = "Could not load data/rare-earths.json.";
    return;
  }
  Object.entries(metals).forEach(([id, metal], i) => {
    metal.color = RARE_COLORS[i % RARE_COLORS.length];
    const card = createCard(grid, id, metal);
    addRareForm(card, id, metal);
    renderCard(id, metal, rarePoints(id, metal));
  });
}

async function init() {
  LIVE_ASSETS.forEach(m => createCard(document.getElementById(m.grid ?? "live-grid"), m.symbol, m));
  try {
    dailyHistory = (await fetchJson("data/history.json")).series ?? {};
  } catch { /* history file is optional */ }
  LIVE_ASSETS.forEach(drawAsset);

  document.getElementById("refresh").addEventListener("click", refreshLive);
  document.getElementById("toggle-all").addEventListener("click", toggleAll);
  initRare();
  refreshLive();
  setInterval(refreshLive, REFRESH_MS);
}

init();
