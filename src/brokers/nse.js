// NSE end-of-day broker (free, no token).
//
// Pulls two public CSVs from archives.nseindia.com:
//   - sec_bhavdata_full_DDMMYYYY.csv  (equity close + AVG_PRICE)
//   - ind_close_all_DDMMYYYY.csv      (index close)
//
// Both publish ~6:30 PM IST after market close. If today's file isn't up
// yet, we walk back day-by-day (up to 5 days) to the most recent file.

import axios from "axios";
import fs from "node:fs";
import path from "node:path";

const BHAV_URL = (ddmmyyyy) =>
  `https://archives.nseindia.com/products/content/sec_bhavdata_full_${ddmmyyyy}.csv`;
const IDX_URL = (ddmmyyyy) =>
  `https://archives.nseindia.com/content/indices/ind_close_all_${ddmmyyyy}.csv`;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  Accept: "text/csv,*/*",
};

function ddmmyyyy(d) {
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  return `${dd}${mm}${yyyy}`;
}

function istToday() {
  // IST = UTC + 5:30
  const now = new Date(Date.now() + 5.5 * 3600 * 1000);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

async function tryFetch(url, cachePath) {
  if (fs.existsSync(cachePath) && fs.statSync(cachePath).size > 0) {
    return fs.readFileSync(cachePath, "utf8");
  }
  const res = await axios.get(url, {
    headers: HEADERS,
    responseType: "text",
    timeout: 30000,
    validateStatus: (s) => s < 500,
  });
  if (res.status !== 200 || !res.data || String(res.data).length < 1000) {
    return null;
  }
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, res.data);
  return res.data;
}

async function loadCsvWithFallback(builder, cacheDir, prefix, log, start, maxBack) {
  for (let back = 0; back < maxBack; back++) {
    const d = new Date(start.getTime() - back * 24 * 3600 * 1000);
    const dmy = ddmmyyyy(d);
    const cachePath = path.join(cacheDir, `${prefix}_${dmy}.csv`);
    try {
      const csv = await tryFetch(builder(dmy), cachePath);
      if (csv) {
        return { csv, dmy };
      }
    } catch (err) {
      log.warn({ prefix, dmy, err: err.message }, "nse fetch attempt failed");
    }
  }
  return null;
}

function parseCsvHeader(line) {
  return line.split(",").map((s) => s.trim());
}

function parseEquityCsv(csv) {
  const lines = csv.split(/\r?\n/);
  const header = parseCsvHeader(lines[0]);
  const idxSym = header.indexOf("SYMBOL");
  const idxSeries = header.indexOf("SERIES");
  const idxClose = header.indexOf("CLOSE_PRICE");
  const idxAvg = header.indexOf("AVG_PRICE");
  if (idxSym < 0 || idxClose < 0 || idxAvg < 0) {
    throw new Error("NSE bhav CSV missing expected columns");
  }
  const map = new Map(); // SYMBOL (upper) -> { close, atp }
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((s) => s.trim());
    if (cols.length < header.length) continue;
    if (idxSeries >= 0 && cols[idxSeries] !== "EQ" && cols[idxSeries] !== "BE") continue;
    const sym = cols[idxSym].toUpperCase();
    const close = Number(cols[idxClose]);
    const atp = Number(cols[idxAvg]);
    if (!Number.isFinite(close) || !Number.isFinite(atp)) continue;
    map.set(sym, { close, atp });
  }
  return map;
}

function parseIndexCsv(csv) {
  const lines = csv.split(/\r?\n/);
  const header = parseCsvHeader(lines[0]);
  const idxName = header.findIndex((h) => /^index name$/i.test(h));
  const idxClose = header.findIndex((h) => /closing index value/i.test(h));
  if (idxName < 0 || idxClose < 0) {
    throw new Error("NSE index CSV missing expected columns");
  }
  const map = new Map();
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((s) => s.trim());
    if (cols.length < header.length) continue;
    const name = cols[idxName].toUpperCase();
    const close = Number(cols[idxClose]);
    if (!Number.isFinite(close)) continue;
    map.set(name, { close, atp: close });
  }
  return map;
}

// items: [{ sheet, tradingSymbol, isIndex }]
// `date`: optional JS Date — when given, fetches that exact day only.
//         when omitted, fetches today's IST date with up to 5 days fallback.
// returns Map<sheet, { close, atp }>
export async function fetchQuotes(items, { dataDir, log, date }) {
  const cacheDir = path.join(dataDir, "nse-cache");
  const start = date
    ? new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
    : istToday();
  const maxBack = date ? 1 : 6;
  const eq = await loadCsvWithFallback(BHAV_URL, cacheDir, "bhav", log, start, maxBack);
  const ix = await loadCsvWithFallback(IDX_URL, cacheDir, "idx", log, start, maxBack);
  if (!eq || !ix) {
    log.warn({ start: ddmmyyyy(start), exact: !!date }, "nse: csv unavailable");
    return new Map();
  }
  log.info({ bhavDate: eq.dmy, idxDate: ix.dmy }, "nse: csvs loaded");

  const eqMap = parseEquityCsv(eq.csv);
  const ixMap = parseIndexCsv(ix.csv);

  const result = new Map();
  for (const it of items) {
    const key = it.tradingSymbol.toUpperCase();
    const hit = it.isIndex ? ixMap.get(key) : eqMap.get(key);
    if (!hit) {
      log.warn(
        { sheet: it.sheet, tradingSymbol: it.tradingSymbol, isIndex: it.isIndex },
        "nse: symbol not found in EOD CSV",
      );
      continue;
    }
    result.set(it.sheet, hit);
  }
  return result;
}
