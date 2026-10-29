const LIVE_METALS = [
  { symbol: "XAU", name: "Gold", unit: "USD/oz", use: "Connectors, bonding wire, contacts", color: "#c9a227" },
  { symbol: "XAG", name: "Silver", unit: "USD/oz", use: "Solder, conductive pastes, contacts", color: "#8c99a6" },
  { symbol: "XPT", name: "Platinum", unit: "USD/oz", use: "Hard-disk platters, sensors", color: "#5b8db8" },
  { symbol: "XPD", name: "Palladium", unit: "USD/oz", use: "Multilayer ceramic capacitors", color: "#9b6fc4" },
  { symbol: "HG", name: "Copper", unit: "USD/lb", use: "Wiring, PCBs, motors", color: "#c66b3d" },
];
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
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })} ` +
    `<small>${unit.replace("USD/", "/")}</small>`;
}

function createCard(container, id, info) {
  const node = document.getElementById("card-template").content.firstElementChild.cloneNode(true);
  node.id = `card-${id}`;
  node.querySelector(".name").textContent = info.name;
  node.querySelector(".use").textContent = `${info.use} · ${info.unit}`;
  container.appendChild(node);
  return node;
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
  return toPoints([...(dailyHistory[symbol] ?? []), ...local]);
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
    LIVE_METALS.map(m => fetchJson(`https://api.gold-api.com/price/${m.symbol}`))
  );
  let failed = 0;
  results.forEach((r, i) => {
    const m = LIVE_METALS[i];
    if (r.status === "fulfilled" && Number.isFinite(Number(r.value.price))) recordLive(m.symbol, Number(r.value.price));
    else failed++;
    renderCard(m.symbol, m, livePoints(m.symbol));
  });
  if (failed) {
    status.textContent = `Could not reach the live price feed for ${failed} metal(s); showing saved data.`;
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
  const liveGrid = document.getElementById("live-grid");
  LIVE_METALS.forEach(m => createCard(liveGrid, m.symbol, m));
  try {
    dailyHistory = (await fetchJson("data/history.json")).series ?? {};
  } catch { /* history file is optional */ }
  LIVE_METALS.forEach(m => renderCard(m.symbol, m, livePoints(m.symbol)));

  document.getElementById("refresh").addEventListener("click", refreshLive);
  initRare();
  refreshLive();
  setInterval(refreshLive, REFRESH_MS);
}

init();
