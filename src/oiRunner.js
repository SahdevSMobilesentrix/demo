// Server-driven version of oiWritingTest — same OI/bias logic, but exposed
// via start/getState/stop so a browser can drive it instead of a CLI.

import { loadInstruments, fetchQuotes } from "./brokers/angelMarketData.js";
import { recordTrade } from "./oiHistory.js";
import { RiskGuard, StateStore, HistoryStore, TickStore } from "./oiGuards.js";

// Persistent capital across runs/days. The "Starting capital" UI value is
// only used the first time (when no state file exists). After that, the
// running balance is the source of truth — profits add, losses subtract.
const stateStore = new StateStore();
// Persisted OI snapshots — survives server restart so warmup doesn't
// restart from scratch after a deploy.
const historyStore = new HistoryStore();
// Persisted UI tick rows — so the page after refresh / restart still
// shows the most recent activity instead of going blank.
const tickStore = new TickStore();
let riskGuard = null;
function ensureRiskGuard(startingCapital) {
  if (riskGuard) return riskGuard;
  riskGuard = new RiskGuard({ startingCapital });
  const prior = stateStore.load();
  if (prior?.risk) riskGuard.restore(prior.risk);
  return riskGuard;
}

const POLL_SEC = 60;
const LOOKBACK_MIN = 15;
const STRIKE_STEP = 50;
const NIFTY_LOT_SIZE = 75;

// Exit thresholds, expressed as fractions of `maxRupees` (per-trade cap).
// Tuned for intraday OI-flow scalps — small, frequent moves rather than
// session-long swings. Edit here to retune.
// Per-trade SL/TP as fractions of the trade's actual cost (premium paid).
// Profit target sits inside the 10–15% band; hard loss is capped at 10%.
const TARGET_FRAC = 0.15; // +15% of trade cost → take profit
const STOP_FRAC   = 0.10; // -10% of trade cost → cut loss

// Per-day trade caps (counted against IST calendar day):
//   - Hard cap: at most params.tradesPerDay entries (user-configurable; default 2).
//   - "Cut losses" rule: if the FIRST completed trade of the day is a loss,
//     no further entries that day (so on a losing first trade, only 1 trade total).
const istDateKey = () => {
  const d = istNow();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
};

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
  // Lowered netFlow gate so the classifier actually fires during typical
  // intraday OI swings — the previous 50k floor was almost never hit on
  // ATM±2 NIFTY weeklies, leaving bias stuck at Neutral and no entries.
  if (Math.abs(netFlow) > 10000) {
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
    halt: null,         // { day, reason, message } — surfaces as UI banner
    lastBlockedDay: null,
  };
}

function pushLog(msg) {
  if (!state) return;
  state.log.push({ ts: Date.now(), msg });
  if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
}

function maybeEnter(bias, latest, atm) {
  if (!state || state.openTrade) return;

  // Daily caps (IST calendar day).
  const today = istDateKey();
  // Reset halt banner when a new IST day starts.
  if (state.halt && state.halt.day !== today) state.halt = null;

  const cap = Math.max(1, +(state.params.tradesPerDay || 2));
  const todays = state.trades.filter(t => t.dayKey === today);

  if (todays.length >= cap) {
    const msg = `Daily cap reached: ${cap} trade${cap>1?"s":""} done for ${today}. No more entries today.`;
    if (state.lastBlockedDay !== today) { pushLog(msg); state.lastBlockedDay = today; }
    state.halt = { day: today, reason: "cap", message: msg };
    return;
  }
  // After a losing first trade, lock the day at 1 trade — regardless of cap.
  // Use netPnl (after charges) when available so the rule matches what hits the wallet.
  const first = todays[todays.length - 1];
  const firstPnl = first ? (first.netPnl ?? first.pnl) : 0;
  if (todays.length >= 1 && firstPnl < 0) {
    const msg = `First trade of ${today} closed at a loss (₹${firstPnl}). Trading disabled for the rest of the day.`;
    if (state.lastBlockedDay !== today) { pushLog(msg); state.lastBlockedDay = today; }
    state.halt = { day: today, reason: "loss", message: msg };
    return;
  }

  const { lots } = state.params;
  let side = null;
  if (bias === "Strong Bullish" || bias === "Bullish") side = "LONG_CE";
  else if (bias === "Strong Bearish" || bias === "Bearish") side = "LONG_PE";
  if (!side) return;

  const key = side === "LONG_CE" ? `${atm}CE` : `${atm}PE`;
  const px = latest.premiumByStrike[key];
  if (!px) {
    pushLog(`skip ${side} — no premium for ${key}`);
    return;
  }
  const cost = px * NIFTY_LOT_SIZE * lots;

  // Running balance is the source of truth — not a per-day allowance.
  const bal = riskGuard ? riskGuard.capital : 0;
  if (cost > bal) {
    pushLog(`skip ${side} @ ${px} — cost ₹${round(cost)} > balance ₹${round(bal)}`);
    state.halt = { day: today, reason: "insufficient_capital", message: `Insufficient balance: ₹${round(bal)} available, trade needs ₹${round(cost)}.` };
    return;
  }
  state.openTrade = {
    entryTs: latest.ts, side, strike: atm,
    symbol: side === "LONG_CE" ? "NIFTY-ATM-CE" : "NIFTY-ATM-PE",
    entryPx: px, cost,
  };
  stateStore.save({ openTrade: state.openTrade, risk: riskGuard?.snapshot() });
  pushLog(`PAPER BUY ${state.openTrade.symbol} strike=${atm} @ ₹${px} cost=₹${round(cost)} [bal=₹${round(bal)}]`);
}

function maybeExit(bias, latest, reason = null) {
  if (!state || !state.openTrade) return;
  const { lots } = state.params;
  const ot = state.openTrade;
  const key = ot.side === "LONG_CE" ? `${ot.strike}CE` : `${ot.strike}PE`;
  const px = latest.premiumByStrike[key];
  if (!px) return;
  const pnl = (px - ot.entryPx) * NIFTY_LOT_SIZE * lots;
  const flipped =
    (ot.side === "LONG_CE" && (bias === "Strong Bearish" || bias === "Bearish")) ||
    (ot.side === "LONG_PE" && (bias === "Strong Bullish" || bias === "Bullish"));
  // Stop/target are anchored to the trade's actual cost (premium paid),
  // not a phantom per-day allowance.
  const stop = pnl < -ot.cost * STOP_FRAC;
  const target = pnl > ot.cost * TARGET_FRAC;
  const why = reason || (flipped ? "BIAS_FLIP" : stop ? "STOP" : target ? "TARGET" : null);
  if (!why) return;
  const dayKey = istDateKey();
  const closed = { ...ot, exitTs: latest.ts, exitPx: px, pnl: round(pnl), reason: why, dayKey };
  let enriched;
  try {
    enriched = recordTrade({
      ...closed,
      lots: state.params.lots,
      lotSize: NIFTY_LOT_SIZE,
    });
  } catch (e) {
    pushLog(`history persist failed: ${e.message}`);
    enriched = closed;
  }
  state.trades.unshift(enriched);

  // Update running balance with realised P&L (after charges if available).
  const realised = (enriched && typeof enriched.netPnl === "number") ? enriched.netPnl : pnl;
  if (riskGuard) {
    riskGuard.recordExit(realised);
    stateStore.save({ openTrade: null, risk: riskGuard.snapshot() });
  }
  const bal = riskGuard ? riskGuard.capital : null;
  pushLog(`PAPER EXIT ${ot.symbol} @ ₹${px} P&L=₹${round(pnl)} reason=${why}${bal != null ? ` [bal=₹${round(bal)}]` : ""}`);
  if (riskGuard?.halted) {
    pushLog(`RISK HALT: ${riskGuard.haltReason}`);
    state.halt = { day: istDateKey(), reason: "risk", message: `Risk halt: ${riskGuard.haltReason}` };
  }
  state.openTrade = null;
}

export function getOiState() {
  // Always surface the current capital + daily P&L, even when idle, so the
  // UI can show the running balance before any run starts.
  if (!state) {
    const r = riskGuard || (function(){ try { return ensureRiskGuard(15000); } catch { return null; } })();
    // Show the last persisted ticks so a browser refresh / server restart
    // doesn't visually wipe the recent activity.
    const persistedTicks = tickStore.load();
    return {
      status: "idle",
      risk: r ? r.snapshot() : null,
      ticks: persistedTicks.slice(0, 500),
    };
  }
  return {
    status: state.status,
    risk: riskGuard ? riskGuard.snapshot() : null,
    startedAt: state.startedAt,
    endsAt: state.endsAt,
    params: state.params,
    atm: state.atm,
    expiry: state.expiry,
    spotOpen: state.spotOpen,
    error: state.error,
    halt: state.halt,
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

// Default cap = 375 min (full NSE trading day). Frontend doesn't pass minutes;
// runs until Stop is clicked or this hard cap is hit.
export async function startOiTest({ jwtToken, apiKey, minutes = 375, lots = 1, maxRupees = 15000, tradesPerDay = 2 }) {
  if (state && (state.status === "running" || state.status === "starting")) {
    throw new Error("OI test already running. Stop it first.");
  }
  if (!jwtToken || !apiKey) throw new Error("jwtToken and apiKey required");
  const params = { minutes: +minutes, lots: +lots, maxRupees: +maxRupees, tradesPerDay: Math.max(1, +tradesPerDay) };
  state = freshState(params);

  // Initialise / restore running capital. `maxRupees` from the form is treated
  // as the seed capital used ONLY when there is no prior persisted state.
  ensureRiskGuard(+maxRupees || 15000);
  // If there's an open trade persisted from a crashed previous run, surface it.
  const prior = stateStore.load();
  if (prior?.openTrade) {
    state.openTrade = prior.openTrade;
    pushLog(`restored open trade: ${prior.openTrade.symbol} @ ₹${prior.openTrade.entryPx}`);
  }
  pushLog(`capital balance: ₹${round(riskGuard.capital)} (today P&L: ₹${round(riskGuard.dailyPnl)})`);

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

      // Resume snapshot history & tick log from disk — bypasses warmup if
      // recent enough snapshots survive across restarts/deploys.
      const persistedHistory = historyStore.load();
      const cutoffMs = Date.now() - LOOKBACK_MIN * 60 * 1000 * 4;   // keep up to 4× lookback
      const history = persistedHistory.filter(h => h && typeof h.ts === "number" && h.ts >= cutoffMs);
      if (history.length > 0) {
        pushLog(`resumed ${history.length} OI snapshots from disk (warmup bypassed)`);
      }
      const persistedTicks = tickStore.load();
      if (persistedTicks.length > 0) {
        // Newest-first; cap to UI limit.
        state.ticks = persistedTicks.slice(0, 1000);
      }
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
          // Trim in-memory + persist so the warmup window survives restarts.
          if (history.length > 240) history.splice(0, history.length - 240);
          historyStore.save(history);
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
          // Persist UI ticks (cap to 500 for disk size) so a refresh / restart
          // doesn't show an empty table.
          tickStore.save(state.ticks.slice(0, 500));

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
