# Metals Market Tracker

A simple static website that tracks and plots prices of metals used in electronics, plus cryptocurrencies:

- **Live spot prices** (gold, silver, platinum, palladium, copper) and **crypto** (Bitcoin, Ethereum)
  from the free, keyless [gold-api.com](https://gold-api.com) API, plus Solana and XRP from Coinbase's
  public price API, refreshed every minute.
- **Rare earth & specialty metals** (NdPr, neodymium, dysprosium, terbium, gallium, germanium, indium).
  These have no free public price feed, so prices come from `data/rare-earths.json` plus any
  you enter on the page (saved in your browser).

Crypto cards have **timeframe buttons** (Live, 1D, 3D, 1W, 1M). The candle timeframes load about
five years of daily candles from Coinbase Exchange's free public API (no key), build 3-day, weekly and
monthly candles from them in the browser, and overlay 20, 50 and 200 moving averages. Click a number to
show or hide that average, and **SMA/EMA** to switch between simple and exponential averages. Candles are
cached in your browser for six hours, and each card remembers its own settings.

Each card has a ▾ button to show or hide its chart, and **Hide all charts** at the top collapses
everything to a compact price list. Your choice is remembered in your browser.

## Run it

It's plain HTML/CSS/JS — serve the folder with any static server:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

Or enable **GitHub Pages** (Settings → Pages → deploy from branch) to host it.

## Price history

- `data/history.json` holds daily snapshots of the live prices. The GitHub Action
  `.github/workflows/update-prices.yml` appends one each weekday (or run it manually from the
  Actions tab). You can also run `python3 scripts/update_prices.py` locally.
- While the page is open it also records live prices in your browser, so charts fill in over time.
- To add rare earth history for everyone, append `{ "date": "YYYY-MM-DD", "price": 72.5 }`
  entries to the relevant `prices` array in `data/rare-earths.json`.

Prices are indicative only — not financial advice.
