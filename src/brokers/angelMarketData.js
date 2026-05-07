// Angel One SmartAPI — market data (quote) fetching.
// Uses POST /rest/secure/angelbroking/market/v1/quote/
// Docs: https://smartapi.angelbroking.com/docs/MarketData

import axios from "axios";

const QUOTE_URL =
  "https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/quote/";

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
          opnInterest: q.opnInterest != null ? parseFloat(q.opnInterest) : null,
          tradeVolume: q.tradeVolume != null ? parseFloat(q.tradeVolume) : null,
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

