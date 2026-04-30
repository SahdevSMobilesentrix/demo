// Angel One SmartAPI — market data (quote) fetching.
// Uses POST /rest/secure/angelbroking/market/v1/quote/
// Docs: https://smartapi.angelbroking.com/docs/MarketData

import axios from "axios";

const QUOTE_URL =
  "https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/quote/";

const CANDLE_URL =
  "https://apiconnect.angelone.in/rest/secure/angelbroking/historical/v1/getCandleData";

// Angel One instrument master — maps tradingsymbol to token
const INSTRUMENT_URL =
  "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json";

let instrumentCache = null;

/**
 * Download and cache the full Angel One instrument master list.
 * Returns a Map: "EXCHANGE:SYMBOL" -> { token, symbol, name, exchange, ... }
 */
export async function loadInstruments() {
  if (instrumentCache) return instrumentCache;

  const { data } = await axios.get(INSTRUMENT_URL, { timeout: 30000 });
  instrumentCache = new Map();
  for (const row of data) {
    // Key by exchange:symbol  e.g. "NSE:RELIANCE-EQ"
    const key = `${row.exch_seg}:${row.symbol}`;
    instrumentCache.set(key, {
      token: row.token,
      symbol: row.symbol,
      name: row.name,
      exchange: row.exch_seg,
      instrumentType: row.instrumenttype,
    });
  }
  return instrumentCache;
}

/**
 * Resolve a tradingsymbol to its Angel One token.
 * For indices (NIFTY 50, NIFTY BANK) look in NSE with name match.
 * For stocks, look for NSE:SYMBOL-EQ.
 */
export function resolveToken(instruments, tradingSymbol) {
  // Check if it's an index
  const indexNames = {
    "NIFTY 50": "Nifty 50",
    "NIFTY BANK": "Nifty Bank",
  };

  if (indexNames[tradingSymbol]) {
    // Indices are in NSE with token like 99926000 (Nifty 50) etc.
    for (const [, inst] of instruments) {
      if (
        inst.exchange === "NSE" &&
        inst.name.toUpperCase() === indexNames[tradingSymbol].toUpperCase() &&
        inst.instrumentType === "AMXIDX"
      ) {
        return inst;
      }
    }
    // Fallback: search by symbol containing the name
    for (const [, inst] of instruments) {
      if (
        inst.exchange === "NSE" &&
        inst.symbol.toUpperCase() === tradingSymbol.toUpperCase()
      ) {
        return inst;
      }
    }
    return null;
  }

  // Stock — look for NSE:SYMBOL-EQ
  const key = `NSE:${tradingSymbol}-EQ`;
  if (instruments.has(key)) return instruments.get(key);

  // Fallback: try without -EQ suffix
  const key2 = `NSE:${tradingSymbol}`;
  if (instruments.has(key2)) return instruments.get(key2);

  // Fallback: scan NSE EQ instruments for symbol or name match. Some Angel One
  // entries use "-BE" or "-BL" suffixes, or include the underlying symbol in
  // the `name` field rather than `symbol`.
  const upper = tradingSymbol.toUpperCase();
  let bestEq = null;
  for (const [, inst] of instruments) {
    if (inst.exchange !== "NSE") continue;
    if (inst.instrumentType && inst.instrumentType !== "" && inst.instrumentType !== "AMXIDX") continue;
    // Match on name (most reliable for cash equities)
    if (inst.name && inst.name.toUpperCase() === upper) {
      // Prefer -EQ symbol, else first match
      if (inst.symbol && inst.symbol.toUpperCase().endsWith("-EQ")) return inst;
      if (!bestEq) bestEq = inst;
    }
  }
  if (bestEq) return bestEq;

  return null;
}

/**
 * Fetch full quotes from Angel One for a batch of tokens.
 * Angel One allows max 50 tokens per request, so we batch.
 *
 * @param {string} jwtToken  — Bearer token from login
 * @param {string} apiKey    — SmartAPI private key
 * @param {Array<{exchange: string, token: string, symbol: string}>} tokens
 * @returns {Object} map of symbol -> { ltp, open, close, high, low }
 */
export async function fetchQuotes(jwtToken, apiKey, tokens) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-UserType": "USER",
    "X-SourceID": "WEB",
    "X-ClientLocalIP": "127.0.0.1",
    "X-ClientPublicIP": "127.0.0.1",
    "X-MACAddress": "00:00:00:00:00:00",
    "X-PrivateKey": apiKey,
    Authorization: `Bearer ${jwtToken}`,
  };

  // Build a reverse map: "exchange:token" -> symbol
  const tokenToSymbol = {};
  for (const t of tokens) {
    tokenToSymbol[`${t.exchange}:${t.token}`] = t.symbol;
  }

  // Batch into chunks of 50
  const BATCH_SIZE = 50;
  const result = {};

  for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
    const batch = tokens.slice(i, i + BATCH_SIZE);
    const grouped = {};
    for (const t of batch) {
      if (!grouped[t.exchange]) grouped[t.exchange] = [];
      grouped[t.exchange].push(t.token);
    }

    const body = { mode: "FULL", exchangeTokens: grouped };
    const { data } = await axios.post(QUOTE_URL, body, {
      headers,
      timeout: 15000,
      validateStatus: () => true,
    });

    if (!data || data.status === false || !data.data) {
      const msg = data?.message || "quote fetch failed";
      const err = new Error(msg);
      err.raw = data;
      throw err;
    }

    const fetched = data.data.fetched || [];
    for (const q of fetched) {
      const sym = tokenToSymbol[`${q.exchange}:${q.symbolToken}`];
      if (sym) {
        result[sym] = {
          ltp: parseFloat(q.ltp),
          open: parseFloat(q.open),
          close: parseFloat(q.close),
          high: parseFloat(q.high),
          low: parseFloat(q.low),
          // ATP = Average Traded Price (VWAP) from exchange — Angel One returns
          // this as `avgPrice` in FULL mode quotes. This is the exchange's
          // official VWAP and matches NSE bhavcopy AVG_PRICE.
          avgPrice: q.avgPrice != null ? parseFloat(q.avgPrice) : null,
        };
      }
    }

    // Small delay between batches to avoid rate limits
    if (i + BATCH_SIZE < tokens.length) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  return result;
}

/**
 * Fetch daily OHLC candles for one symbol over a date range.
 *
 * Angel One historical API does NOT return VWAP / avgPrice — only OHLCV.
 * Caller must approximate ATP from OHLC (e.g. (O+H+L+C)/4).
 *
 * @param {string} jwtToken
 * @param {string} apiKey
 * @param {{exchange: string, token: string}} instrument
 * @param {Date} fromDate — date-only Date (midnight UTC)
 * @param {Date} toDate   — date-only Date (midnight UTC)
 * @returns {Array<{date: string, open: number, high: number, low: number, close: number, volume: number}>}
 */
export async function fetchHistoricalDaily(jwtToken, apiKey, instrument, fromDate, toDate) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-UserType": "USER",
    "X-SourceID": "WEB",
    "X-ClientLocalIP": "127.0.0.1",
    "X-ClientPublicIP": "127.0.0.1",
    "X-MACAddress": "00:00:00:00:00:00",
    "X-PrivateKey": apiKey,
    Authorization: `Bearer ${jwtToken}`,
  };

  const fmt = (d) =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
      d.getUTCDate()
    ).padStart(2, "0")}`;

  // Angel One historical API can be inclusive/exclusive on boundary depending
  // on time-of-day. Using 00:00 from-time and 23:59 to-time guarantees both
  // endpoint days are returned.
  const body = {
    exchange: instrument.exchange,
    symboltoken: instrument.token,
    interval: "ONE_DAY",
    fromdate: `${fmt(fromDate)} 00:00`,
    todate: `${fmt(toDate)} 23:59`,
  };

  const { data } = await axios.post(CANDLE_URL, body, {
    headers,
    timeout: 15000,
    validateStatus: () => true,
  });

  if (!data || data.status === false) {
    const msg = data?.message || data?.errorcode || "candle fetch failed";
    const err = new Error(msg);
    err.raw = data;
    throw err;
  }

  // Response: data.data is array of [timestamp, open, high, low, close, volume]
  const rows = (data.data || []).map((r) => ({
    date: r[0].slice(0, 10), // "2026-04-29T..." → "2026-04-29"
    open: parseFloat(r[1]),
    high: parseFloat(r[2]),
    low: parseFloat(r[3]),
    close: parseFloat(r[4]),
    volume: parseFloat(r[5]),
  }));

  return rows;
}
