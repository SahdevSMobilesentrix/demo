// NSE Bhavcopy fetcher — official EOD close/VWAP source.
//
// Why this exists:
//   Angel One historical candle API does NOT return VWAP, only OHLC. The user
//   manually types real exchange VWAP (NSE bhavcopy AVG_PRICE), so the candle
//   approximation (O+H+L+C)/4 disagrees with manual values by ₹0.5–₹2 every
//   backfilled day, which then cascades into all 2DATP..20DATP rolling averages.
//
// What we use:
//   - Equities: https://archives.nseindia.com/products/content/sec_bhavdata_full_DDMMYYYY.csv
//     Columns include CLOSE_PRICE (settled close) and AVG_PRICE (VWAP).
//   - Indices:  https://archives.nseindia.com/content/indices/ind_close_all_DDMMYYYY.csv
//     Has Closing Index Value but no VWAP (indices don't trade — composite).
//
// Cache:
//   data/nse-cache/bhav_DDMMYYYY.csv
//   data/nse-cache/idx_DDMMYYYY.csv
//   Permanent — bhavcopy values never change once published.
//
// Publication timing:
//   Equities bhavcopy publishes ~18:00 IST. Index file publishes ~17:30 IST.
//   If we ask for today's data before that, archives 404 — caller falls back to
//   candle / live quote.

import axios from "axios";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, "..", "..", "data", "nse-cache");

const BHAV_URL = (ddmmyyyy) =>
  `https://archives.nseindia.com/products/content/sec_bhavdata_full_${ddmmyyyy}.csv`;
const IDX_URL = (ddmmyyyy) =>
  `https://archives.nseindia.com/content/indices/ind_close_all_${ddmmyyyy}.csv`;

// NSE archives reject requests without a browser-style UA + Referer.
const NSE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "text/csv,application/csv,*/*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.nseindia.com/",
};

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

/** YYYY-MM-DD (UTC date-only Date) → DDMMYYYY for NSE URLs. */
function toDDMMYYYY(date) {
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = date.getUTCFullYear();
  return `${dd}${mm}${yyyy}`;
}

/**
 * Parse a CSV line, trimming whitespace from each field. Handles the trailing
 * commas / spaces commonly seen in NSE files. No quoted-string handling needed
 * — bhavcopy/index CSVs do not contain embedded commas.
 */
function parseCsvLine(line) {
  return line.split(",").map((s) => s.trim());
}

async function fetchOrCache(url, cachePath) {
  if (fs.existsSync(cachePath)) {
    return fs.readFileSync(cachePath, "utf8");
  }
  ensureCacheDir();
  const { data, status } = await axios.get(url, {
    headers: NSE_HEADERS,
    timeout: 20000,
    validateStatus: () => true,
    responseType: "text",
    transformResponse: [(d) => d], // keep as string
  });
  if (status !== 200 || typeof data !== "string" || data.length < 200) {
    const err = new Error(`NSE archive fetch failed (${status})`);
    err.status = status;
    throw err;
  }
  fs.writeFileSync(cachePath, data, "utf8");
  return data;
}

/**
 * Fetch and parse the equities bhavcopy for a given date.
 *
 * @param {Date} date — date-only midnight-UTC
 * @returns {Promise<Map<string, {close: number, avgPrice: number, open: number, high: number, low: number}>> | null}
 *   keyed by SYMBOL (uppercase), only SERIES=EQ rows. Returns null if archive
 *   is not yet published (404 / network error).
 */
export async function getBhavcopy(date) {
  const ddmmyyyy = toDDMMYYYY(date);
  const cachePath = path.join(CACHE_DIR, `bhav_${ddmmyyyy}.csv`);
  let csv;
  try {
    csv = await fetchOrCache(BHAV_URL(ddmmyyyy), cachePath);
  } catch {
    return null;
  }

  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return null;

  const header = parseCsvLine(lines[0]);
  const idx = (name) => header.indexOf(name);
  const iSym = idx("SYMBOL");
  const iSer = idx("SERIES");
  const iOpen = idx("OPEN_PRICE");
  const iHigh = idx("HIGH_PRICE");
  const iLow = idx("LOW_PRICE");
  const iClose = idx("CLOSE_PRICE");
  const iAvg = idx("AVG_PRICE");
  if (iSym < 0 || iClose < 0 || iAvg < 0) return null;

  const result = new Map();
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    if (iSer >= 0 && cols[iSer] !== "EQ") continue; // cash equities only
    const sym = (cols[iSym] || "").toUpperCase();
    if (!sym) continue;
    const close = parseFloat(cols[iClose]);
    const avg = parseFloat(cols[iAvg]);
    if (!isFinite(close) || !isFinite(avg)) continue;
    result.set(sym, {
      close,
      avgPrice: avg,
      open: parseFloat(cols[iOpen]),
      high: parseFloat(cols[iHigh]),
      low: parseFloat(cols[iLow]),
    });
  }
  return result;
}

/**
 * Fetch and parse the indices close file for a given date.
 *
 * @param {Date} date
 * @returns {Promise<Map<string, {close: number, open: number, high: number, low: number}>> | null}
 *   keyed by uppercase index name (e.g. "NIFTY 50", "NIFTY BANK").
 */
export async function getIndexClose(date) {
  const ddmmyyyy = toDDMMYYYY(date);
  const cachePath = path.join(CACHE_DIR, `idx_${ddmmyyyy}.csv`);
  let csv;
  try {
    csv = await fetchOrCache(IDX_URL(ddmmyyyy), cachePath);
  } catch {
    return null;
  }

  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return null;

  const header = parseCsvLine(lines[0]);
  const idx = (name) => header.indexOf(name);
  const iName = idx("Index Name");
  const iOpen = idx("Open Index Value");
  const iHigh = idx("High Index Value");
  const iLow = idx("Low Index Value");
  const iClose = idx("Closing Index Value");
  if (iName < 0 || iClose < 0) return null;

  const result = new Map();
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const name = (cols[iName] || "").toUpperCase();
    const close = parseFloat(cols[iClose]);
    if (!name || !isFinite(close)) continue;
    result.set(name, {
      close,
      open: parseFloat(cols[iOpen]),
      high: parseFloat(cols[iHigh]),
      low: parseFloat(cols[iLow]),
    });
  }
  return result;
}

/**
 * Look up one symbol's EOD data for a date, transparently using either the
 * equities bhavcopy or the indices file.
 *
 * For indices, AVG_PRICE is not published — we approximate VWAP as
 * (H+L+C)/3 (Typical Price), which is closer to actual index VWAP than
 * (O+H+L+C)/4 because indices weight intraday recency similarly to TP.
 *
 * @param {string} tradingSymbol — already mapped through symbol_overrides
 * @param {Date} date
 * @returns {Promise<{close: number, atp: number} | null>}
 */
export async function getEodFor(tradingSymbol, date) {
  const upper = tradingSymbol.toUpperCase();
  const isIndex = upper === "NIFTY 50" || upper === "NIFTY BANK";

  if (isIndex) {
    const idxMap = await getIndexClose(date);
    if (!idxMap) return null;
    const row = idxMap.get(upper);
    if (!row) return null;
    const tp = (row.high + row.low + row.close) / 3;
    return {
      close: row.close,
      atp: Math.round(tp * 100) / 100,
    };
  }

  const bhav = await getBhavcopy(date);
  if (!bhav) return null;
  const row = bhav.get(upper);
  if (!row) return null;
  return { close: row.close, atp: row.avgPrice };
}
