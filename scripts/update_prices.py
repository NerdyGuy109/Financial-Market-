"""Fetch current spot prices and append today's snapshot to data/history.json."""
import datetime
import json
import pathlib
import urllib.request

SYMBOLS = ["XAU", "XAG", "XPT", "XPD", "HG", "BTC", "ETH"]
HISTORY = pathlib.Path(__file__).resolve().parent.parent / "data" / "history.json"


def fetch(symbol):
    req = urllib.request.Request(
        f"https://api.gold-api.com/price/{symbol}",
        headers={"User-Agent": "financial-market-tracker"},
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return float(json.load(resp)["price"])


def main():
    data = json.loads(HISTORY.read_text())
    today = datetime.date.today().isoformat()
    for symbol in SYMBOLS:
        try:
            price = fetch(symbol)
        except Exception as exc:  # keep going if one symbol fails
            print(f"{symbol}: {exc}")
            continue
        points = data["series"].setdefault(symbol, [])
        points[:] = [p for p in points if p["date"] != today]
        points.append({"date": today, "price": round(price, 4)})
        print(f"{symbol}: {price}")
    HISTORY.write_text(json.dumps(data, indent=2) + "\n")


if __name__ == "__main__":
    main()
