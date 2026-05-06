// Server-driven version of oiWritingTest — same OI/bias logic, but exposed
// via start/getState/stop so a browser can drive it instead of a CLI.

import { loadInstruments, fetchQuotes } from "./brokers/angelMarketData.js";

const POLL_SEC = 60;
const LOOKBACK_MIN = 15;
const STRIKE_STEP = 50;
const NIFTY_LOT_SIZE = 75;

const istNow = () =>
  new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
const fmtIST = (d = istNow()) => d.toTimeString().slice(0, 8);
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

function parseExpiry(s) {
  const months = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };
  const m = s.match(/^(\d{2})([A-Z]{3})(\d{2})$/);
  if (!m) return null;
  const [, dd, mon, yy] = m;
  const month = months[mon];
  if (month == null) return null;
  return new Date(2000 + parseInt(yy, 10), month, parseInt(dd, 10), 15, 30);
}

function findNearestWeeklyExpiry(instruments) {
  const today = istNow();
  let best = null;
  for (const [, inst] of instruments) {
    if (inst.exchange !== "NFO") continue;
    if (!inst.symbol || !inst.symbol.startsWith("NIFTY")) continue;
    if (inst.instrumentType !== "OPTIDX") continue;
    if (inst.name !== "NIFTY") continue;
    const m = inst.symbol.match(/^NIFTY(\d{2}[A-Z]{3}\d{2})(\d+)(CE|PE)$/);
    if (!m) continue;
    const expDate = parseExpiry(m[1]);
    if (!expDate || expDate < today) continue;
    if (!best || expDate < best.date) best = { date: expDate, str: m[1] };
  }
  return best;
}

function pickStrikes(instruments, expiryStr, atm) {
  const wanted = [-2, -1, 0, 1, 2].map((k) => atm + k * STRIKE_STEP);
  const out = [];
  for (const strike of wanted) {
    for (const side of ["CE", "PE"]) {
      const sym = `NIFTY${expiryStr}${strike}${side}`;
      const inst = instruments.get(`NFO:${sym}`);
      if (inst) out.push({ ...inst, strike, side });
    }
  }
  return out;
}

function findNiftyIndex(instruments) {
  const candidates = [];
  for (const [, inst] of instruments) {
    if (inst.exchange !== "NSE") continue;
    const sym  = (inst.symbol || "").toUpperCase();
    const name = (inst.name   || "").toUpperCase();
    const itype = (inst.instrumentType || "").toUpperCase();
    const isIndex = itype === "AMXIDX" || itype === "INDEX" || itype === "";
    if (!isIndex) continue;
    if (sym === "NIFTY" || sym === "NIFTY 50" || sym === "NIFTY50" ||
        name === "NIFTY 50" || name === "NIFTY") {
      candidates.push({ inst, score: sym.replace(/\s/g,"") === "NIFTY50" ? 3 : name === "NIFTY 50" ? 2 : 1 });
    }
  }
  candidates.sort((a,b) => b.score - a.score);
  return candidates[0]?.inst || null;
}

function computeBias(history, latest, priceBull, priceBear) {
  const cutoff = latest.ts - LOOKBACK_MIN * 60 * 1000;
  let ref = null;
  for (const h of history) { if (h.ts <= cutoff) ref = h; else break; }
  if (!ref) return { ready: false };

  const ceDelta = latest.ceTotal - ref.ceTotal;
  const peDelta = latest.peTotal - ref.peTotal;
  const netFlow = peDelta - ceDelta;
  const pcrOI = latest.peTotal / Math.max(latest.ceTotal, 1);

  const recent = history.slice(-60);
  const ceDeltas = recent.map((h, i, a) => i > 0 ? h.ceTotal - a[0].ceTotal : 0);
  const peDeltas = recent.map((h, i, a) => i > 0 ? h.peTotal - a[0].peTotal : 0);
  const std = (xs) => {
    const m = xs.reduce((a,b)=>a+b,0)/Math.max(xs.length,1);
    return Math.sqrt(xs.reduce((a,b)=>a+(b-m)**2,0)/Math.max(xs.length,1)) || 1;
  };
  const ceN = ceDelta / std(ceDeltas);
  const peN = peDelta / std(peDeltas);
  const net = peN - ceN;

  let bias = "Neutral";
  if (Math.abs(netFlow) > 50000) {
    if (net > 1.5 && priceBull)       bias = "Strong Bullish";
    else if (net > 0.5 && priceBull)  bias = "Bullish";
    else if (net < -1.5 && priceBear) bias = "Strong Bearish";
    else if (net < -0.5 && priceBear) bias = "Bearish";
  }

  return {
    ready: true,
    ceDelta, peDelta, netFlow, pcrOI: round(pcrOI, 3),
    ceN: round(ceN, 2), peN: round(peN, 2), net: round(net, 2),
    bias,
    strength: round(Math.min(Math.abs(net) * 40, 100), 0),
  };
}

// ---------- runner state (single in-process run at a time) ----------
let state = null;
// state shape: { status, startedAt, endsAt, params, ticks: [], trades: [], openTrade, error, atm, expiry, spotOpen }

function freshState(params) {
  return {
    status: "starting",
    startedAt: Date.now(),
    endsAt: Date.now() + params.minutes * 60 * 1000,
    params,
    ticks: [],
    trades: [],
    openTrade: null,
    error: null,
    atm: null,
    expiry: null,
    spotOpen: null,
    log: [],
  };
}

function pushLog(msg) {
  if (!state) return;
  state.log.push({ ts: Date.now(), msg });
  if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
}

function maybeEnter(bias, latest, atm) {
  if (!state || state.openTrade) return;
  const { lots, maxRupees } = state.params;
  let side = null;
  if (bias === "Strong Bullish") side = "LONG_CE";
  else if (bias === "Strong Bearish") side = "LONG_PE";
  if (!side) return;

  const key = side === "LONG_CE" ? `${atm}CE` : `${atm}PE`;
  const px = latest.premiumByStrike[key];
  if (!px) return;
  const cost = px * NIFTY_LOT_SIZE * lots;
  if (cost > maxRupees) {
    pushLog(`skip ${side} @ ${px} — cost ₹${round(cost)} > cap ₹${maxRupees}`);
    return;
  }
  state.openTrade = {
    entryTs: latest.ts, side, strike: atm,
    symbol: side === "LONG_CE" ? "NIFTY-ATM-CE" : "NIFTY-ATM-PE",
    entryPx: px, cost,
  };
  pushLog(`PAPER BUY ${state.openTrade.symbol} strike=${atm} @ ₹${px} cost=₹${round(cost)}`);
}

function maybeExit(bias, latest, reason = null) {
  if (!state || !state.openTrade) return;
  const { lots, maxRupees } = state.params;
  const ot = state.openTrade;
  const key = ot.side === "LONG_CE" ? `${ot.strike}CE` : `${ot.strike}PE`;
  const px = latest.premiumByStrike[key];
  if (!px) return;
  const pnl = (px - ot.entryPx) * NIFTY_LOT_SIZE * lots;
  const flipped =
    (ot.side === "LONG_CE" && (bias === "Strong Bearish" || bias === "Bearish")) ||
    (ot.side === "LONG_PE" && (bias === "Strong Bullish" || bias === "Bullish"));
  const stop = pnl < -maxRupees * 0.4;
  const target = pnl > maxRupees * 0.5;
  const why = reason || (flipped ? "BIAS_FLIP" : stop ? "STOP" : target ? "TARGET" : null);
  if (!why) return;
  state.trades.unshift({ ...ot, exitTs: latest.ts, exitPx: px, pnl: round(pnl), reason: why });
  pushLog(`PAPER EXIT ${ot.symbol} @ ₹${px} P&L=₹${round(pnl)} reason=${why}`);
  state.openTrade = null;
}

export function getOiState() {
  if (!state) return { status: "idle" };
  return {
    status: state.status,
    startedAt: state.startedAt,
    endsAt: state.endsAt,
    params: state.params,
    atm: state.atm,
    expiry: state.expiry,
    spotOpen: state.spotOpen,
    error: state.error,
    openTrade: state.openTrade,
    // Newest first for both lists
    ticks: state.ticks.slice(0, 500),
    trades: state.trades.slice(0, 100),
    log: state.log.slice(-50).reverse(),
  };
}

export function stopOiTest() {
  if (!state) return { ok: true, message: "not running" };
  state.status = "stopping";
  return { ok: true };
}

export async function startOiTest({ jwtToken, apiKey, minutes = 60, lots = 1, maxRupees = 15000 }) {
  if (state && (state.status === "running" || state.status === "starting")) {
    throw new Error("OI test already running. Stop it first.");
  }
  if (!jwtToken || !apiKey) throw new Error("jwtToken and apiKey required");
  const params = { minutes: +minutes, lots: +lots, maxRupees: +maxRupees };
  state = freshState(params);

  // Run the loop in the background; surface errors via state.error.
  (async () => {
    try {
      pushLog("loading instrument master...");
      const instruments = await loadInstruments();
      pushLog(`loaded ${instruments.size} instruments`);

      const niftyIdx = findNiftyIndex(instruments);
      if (!niftyIdx) throw new Error("NIFTY 50 index instrument not found");

      const idxQuote = await fetchQuotes(jwtToken, apiKey, [{
        exchange: niftyIdx.exchange, token: niftyIdx.token, symbol: "NIFTY50",
      }]);
      const spot = idxQuote.NIFTY50?.ltp;
      if (!spot) throw new Error("Failed to fetch NIFTY 50 spot");
      const atm = Math.round(spot / STRIKE_STEP) * STRIKE_STEP;
      state.atm = atm;
      state.spotOpen = spot;

      const expiry = findNearestWeeklyExpiry(instruments);
      if (!expiry) throw new Error("No NIFTY weekly expiry found");
      state.expiry = expiry.str;

      const optTokens = pickStrikes(instruments, expiry.str, atm);
      if (optTokens.length === 0) throw new Error("No option tokens resolved for ATM±2");
      pushLog(`spot=${spot} ATM=${atm} expiry=${expiry.str} options=${optTokens.length}`);

      const history = [];
      const vwapBuf = [];
      state.status = "running";

      while (Date.now() < state.endsAt && state.status === "running") {
        try {
          const tokens = [
            { exchange: niftyIdx.exchange, token: niftyIdx.token, symbol: "NIFTY50" },
            ...optTokens.map(t => ({ exchange: t.exchange, token: t.token, symbol: t.symbol })),
          ];
          const q = await fetchQuotes(jwtToken, apiKey, tokens);
          const curSpot = q.NIFTY50?.ltp ?? spot;
          vwapBuf.push(curSpot);
          const vwap = vwapBuf.reduce((a,b)=>a+b,0) / vwapBuf.length;
          const priceBull = curSpot > vwap;
          const priceBear = curSpot < vwap;

          let ceTotal = 0, peTotal = 0;
          const premiumByStrike = {};
          for (const t of optTokens) {
            const row = q[t.symbol];
            if (!row) continue;
            if (row.opnInterest != null) {
              if (t.side === "CE") ceTotal += row.opnInterest;
              else                 peTotal += row.opnInterest;
            }
            premiumByStrike[`${t.strike}${t.side}`] = row.ltp;
          }

          const latest = { ts: Date.now(), ceTotal, peTotal, spot: curSpot, premiumByStrike };
          history.push(latest);
          const r = computeBias(history, latest, priceBull, priceBear);

          // Newest-first into state.ticks
          state.ticks.unshift({
            ts: latest.ts,
            tsIST: fmtIST(),
            spot: curSpot,
            ceTotal, peTotal,
            ceDelta: r.ceDelta ?? null,
            peDelta: r.peDelta ?? null,
            netFlow: r.netFlow ?? null,
            pcrOI: r.pcrOI ?? null,
            net: r.net ?? null,
            bias: r.ready ? r.bias : "WARMUP",
            strength: r.strength ?? null,
            priceBull, priceBear,
            tradeNote: state.openTrade ? `OPEN_${state.openTrade.side}@${state.openTrade.strike}` : "",
          });
          if (state.ticks.length > 1000) state.ticks.length = 1000;

          if (r.ready) {
            maybeExit(r.bias, latest);
            maybeEnter(r.bias, latest, atm);
          }
        } catch (e) {
          pushLog(`poll error: ${e.message}`);
        }

        // Sleep but stay responsive to stop
        for (let i = 0; i < POLL_SEC && state.status === "running"; i++) {
          await new Promise(r => setTimeout(r, 1000));
        }
      }

      if (state.openTrade && history.length) {
        maybeExit(null, history[history.length - 1], "SESSION_END");
      }
      state.status = "finished";
      pushLog(`run finished. ticks=${state.ticks.length} trades=${state.trades.length}`);
    } catch (e) {
      if (state) {
        state.status = "error";
        state.error = e.message;
        pushLog(`FATAL: ${e.message}`);
      }
    }
  })();

  return { ok: true, status: state.status, endsAt: state.endsAt };
}
