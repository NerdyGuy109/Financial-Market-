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
    renderCard(m.symbol, m, livePoints(m.symbol));
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
  LIVE_ASSETS.forEach(m => renderCard(m.symbol, m, livePoints(m.symbol)));

  document.getElementById("refresh").addEventListener("click", refreshLive);
  document.getElementById("toggle-all").addEventListener("click", toggleAll);
  initRare();
  refreshLive();
  setInterval(refreshLive, REFRESH_MS);
}

init();
