// ============================================================
// OI Writing Pressure — Intraday Indicator Test (READ-ONLY)
// ============================================================
// Pulls live NIFTY option-chain OI from Angel One SmartAPI,
// computes 15-min Delta OI / Put-Writing vs Call-Writing bias,
// and runs a SIMULATED (paper) intraday trade log.
//
// NO ORDERS ARE PLACED. This script only reads market data.
//
// Usage:
//   node src/oiWritingTest.js <TOTP> [--minutes=60] [--lots=1] [--maxRupees=15000]
//
// Env vars (read from .env):
//   ANGEL_API_KEY, ANGEL_CLIENT_CODE, ANGEL_PIN
// ============================================================

import "dotenv/config";
import fs from "fs";
import path from "path";
import { loginAngelOne } from "./brokers/angelone.js";
import {
  loadInstruments,
  fetchQuotes,
} from "./brokers/angelMarketData.js";
import {
  GUARDS,
  Ema,
  RiskGuard,
  StateStore,
  HistoryStore,
  validateTick,
  premiumExitReason,
  msUntilNextCandle,
  trimHistory,
  inSession,
} from "./oiGuards.js";

// ---------- CLI args ----------
const totp = process.argv[2];
if (!totp || !/^\d{6}$/.test(totp)) {
  console.error("Usage: node src/oiWritingTest.js <6-digit TOTP> [--minutes=60] [--lots=1] [--maxRupees=15000]");
  process.exit(1);
}
const argMap = Object.fromEntries(
  process.argv.slice(3).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v];
  })
);
const RUN_MINUTES = parseInt(argMap.minutes ?? "60", 10);
const LOTS        = parseInt(argMap.lots ?? "1", 10);
// Starting capital — only used the FIRST time. After that the running balance
// is persisted in oi_state.json and carries across sessions/days.
const STARTING_CAPITAL = parseFloat(argMap.capital ?? argMap.maxRupees ?? "15000");
const LOOKBACK_MIN = 15;
const STRIKE_STEP = 50;
const NIFTY_LOT_SIZE = 75;

const { ANGEL_API_KEY, ANGEL_CLIENT_CODE, ANGEL_PIN } = process.env;
if (!ANGEL_API_KEY || !ANGEL_CLIENT_CODE || !ANGEL_PIN) {
  console.error("Missing ANGEL_API_KEY / ANGEL_CLIENT_CODE / ANGEL_PIN in .env");
  process.exit(1);
}

// ---------- helpers ----------
const istNow = () => new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
const fmtIST = (d = istNow()) => d.toTimeString().slice(0, 8);
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

function findNearestWeeklyExpiry(instruments) {
  const today = istNow();
  let best = null;
  for (const [, inst] of instruments) {
    if (inst.exchange !== "NFO") continue;
    if (!inst.symbol || !inst.symbol.startsWith("NIFTY")) continue;
    if (inst.instrumentType !== "OPTIDX") continue;
    if (inst.name !== "NIFTY") continue;
    // symbol format e.g. NIFTY08MAY2525000CE
    const m = inst.symbol.match(/^NIFTY(\d{2}[A-Z]{3}\d{2})(\d+)(CE|PE)$/);
    if (!m) continue;
    const [, expStr] = m;
    const expDate = parseExpiry(expStr);
    if (!expDate) continue;
    if (expDate < today) continue;
    if (!best || expDate < best.date) best = { date: expDate, str: expStr };
  }
  return best;
}

function parseExpiry(s) {
  // "08MAY25" → Date(2025-05-08)
  const months = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };
  const m = s.match(/^(\d{2})([A-Z]{3})(\d{2})$/);
  if (!m) return null;
  const [, dd, mon, yy] = m;
  const month = months[mon];
  if (month == null) return null;
  return new Date(2000 + parseInt(yy, 10), month, parseInt(dd, 10), 15, 30);
}

function pickStrikes(instruments, expiryStr, atm) {
  const wanted = [-2, -1, 0, 1, 2].map((k) => atm + k * STRIKE_STEP);
  const out = [];
  for (const strike of wanted) {
    for (const side of ["CE", "PE"]) {
      const sym = `NIFTY${expiryStr}${strike}${side}`;
      const key = `NFO:${sym}`;
      const inst = instruments.get(key);
      if (inst) out.push({ ...inst, strike, side });
    }
  }
  return out;
}

function findNiftyIndex(instruments) {
  // Angel's instrument master labels indices inconsistently across snapshots.
  // Try several match strategies in priority order.
  const candidates = [];
  for (const [, inst] of instruments) {
    if (inst.exchange !== "NSE") continue;
    const sym  = (inst.symbol || "").toUpperCase();
    const name = (inst.name   || "").toUpperCase();
    const itype = (inst.instrumentType || "").toUpperCase();
    const isIndex = itype === "AMXIDX" || itype === "INDEX" || itype === "" ;
    if (!isIndex) continue;
    if (sym === "NIFTY" || sym === "NIFTY 50" || sym === "NIFTY50" ||
        name === "NIFTY 50" || name === "NIFTY") {
      candidates.push({ inst, score: sym.replace(/\s/g,"") === "NIFTY50" ? 3 : name === "NIFTY 50" ? 2 : 1 });
    }
  }
  candidates.sort((a,b) => b.score - a.score);
  if (candidates[0]) return candidates[0].inst;

  // Last resort: dump a few index-like rows so user can see what's available
  const sample = [];
  for (const [, inst] of instruments) {
    if (inst.exchange === "NSE" && (inst.name || "").toUpperCase().includes("NIFTY")) {
      sample.push(`${inst.symbol} | name="${inst.name}" | type=${inst.instrumentType} | token=${inst.token}`);
      if (sample.length >= 8) break;
    }
  }
  console.error("DEBUG sample of NSE rows containing 'NIFTY':\n  " + sample.join("\n  "));
  return null;
}

// ---------- indicator logic ----------
function computeBias(history, latest, priceBull, priceBear) {
  // history: array of { ts, ceTotal, peTotal, spot, premiumByStrike }
  const cutoff = latest.ts - LOOKBACK_MIN * 60 * 1000;
  let ref = null;
  for (const h of history) { if (h.ts <= cutoff) ref = h; else break; }
  if (!ref) return { ready: false };

  const ceDelta = latest.ceTotal - ref.ceTotal;
  const peDelta = latest.peTotal - ref.peTotal;
  const netFlow = peDelta - ceDelta;
  const pcrOI = latest.peTotal / Math.max(latest.ceTotal, 1);

  // crude normalization vs all stored deltas in last hour
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
    ceDelta, peDelta, netFlow, pcrOI,
    ceN: round(ceN, 2), peN: round(peN, 2), net: round(net, 2),
    bias,
    strength: round(Math.min(Math.abs(net) * 40, 100), 0),
  };
}

// ---------- paper trade engine ----------
const trades = [];   // { entryTs, side, strike, symbol, entryPx, exitTs, exitPx, pnl, reason }
let openTrade = null;

const riskGuard = new RiskGuard({ startingCapital: STARTING_CAPITAL });
const stateStore = new StateStore();

function maybeEnter(bias, latest, atm, r) {
  if (openTrade) return;
  if (bias !== "Strong Bullish" && bias !== "Strong Bearish") return;

  const side = bias === "Strong Bullish" ? "LONG_CE" : "LONG_PE";
  const optKey = side === "LONG_CE" ? `${atm}CE` : `${atm}PE`;
  const sym = side === "LONG_CE" ? `NIFTY-ATM-CE` : `NIFTY-ATM-PE`;
  const px = latest.premiumByStrike[optKey];
  const oi = latest.oiByStrike?.[optKey];

  if (!px) return;
  const cost = px * NIFTY_LOT_SIZE * LOTS;

  const veto = riskGuard.vetoEntry({
    netFlowAbs: Math.abs(r?.netFlow ?? 0),
    optionOI: oi,
    optionPx: px,
    tradeCost: cost,
  });
  if (veto) {
    console.log(`  ⤳ skip ${side} — veto:${veto}`);
    return;
  }

  openTrade = {
    entryTs: latest.ts, side, strike: atm, symbol: sym, entryPx: px, cost,
    peakPx: px,
  };
  stateStore.save({ openTrade, risk: riskGuard.snapshot() });
  console.log(`  ✅ PAPER BUY  ${sym} strike=${atm} @ ₹${px}  cost=₹${round(cost)}  [bal=₹${round(riskGuard.capital)}]`);
}

function maybeExit(bias, latest, reason = null) {
  if (!openTrade) return;
  const key = openTrade.side === "LONG_CE" ? `${openTrade.strike}CE` : `${openTrade.strike}PE`;
  const px = latest.premiumByStrike[key];
  if (!px) return;

  // enforce minimum hold so we don't churn on noisy bias flips
  const heldSec = (latest.ts - openTrade.entryTs) / 1000;
  const tooEarly = heldSec < GUARDS.minHoldSec;

  const pnl = (px - openTrade.entryPx) * NIFTY_LOT_SIZE * LOTS;
  const flipped =
    (openTrade.side === "LONG_CE" && (bias === "Strong Bearish" || bias === "Bearish")) ||
    (openTrade.side === "LONG_PE" && (bias === "Strong Bullish" || bias === "Bullish"));
  // capital-anchored caps still use entry cost (what was actually risked on this trade)
  const capStop = pnl < -openTrade.cost * 0.4;
  const capTarget = pnl > openTrade.cost * 0.5;
  const premiumReason = premiumExitReason(openTrade, px, latest.ts);

  let why = reason;
  if (!why && premiumReason) why = premiumReason;          // premium-based stops always win
  if (!why && !tooEarly && flipped) why = "BIAS_FLIP";
  if (!why && capStop) why = "CAP_STOP";
  if (!why && capTarget) why = "CAP_TARGET";
  if (!why) return;

  trades.push({ ...openTrade, exitTs: latest.ts, exitPx: px, pnl, reason: why });
  riskGuard.recordExit(pnl);
  stateStore.save({ openTrade: null, risk: riskGuard.snapshot() });
  console.log(`  ❎ PAPER EXIT ${openTrade.symbol} @ ₹${px}  P&L=₹${round(pnl)}  reason=${why}  [bal=₹${round(riskGuard.capital)}  dayPnl=₹${round(riskGuard.dailyPnl)}]`);
  if (riskGuard.halted) console.log(`  🛑 RISK HALT: ${riskGuard.haltReason} — no further entries today`);
  openTrade = null;
}

// ---------- main ----------
(async () => {
  console.log(`\n=== OI Writing Indicator — Paper Test (READ-ONLY) ===`);
  console.log(`Run window: ${RUN_MINUTES} min  |  Lots: ${LOTS}  |  Starting capital (first run only): ₹${STARTING_CAPITAL}\n`);

  console.log("→ Logging in to Angel One...");
  const session = await loginAngelOne({
    apiKey: ANGEL_API_KEY,
    clientCode: ANGEL_CLIENT_CODE,
    pin: ANGEL_PIN,
    totp,
  });
  console.log("  ✓ login ok");

  console.log("→ Loading instrument master...");
  const instruments = await loadInstruments();
  console.log(`  ✓ ${instruments.size} instruments`);

  const niftyIdx = findNiftyIndex(instruments);
  if (!niftyIdx) throw new Error("NIFTY 50 index instrument not found");

  // Get spot to determine ATM
  const idxQuote = await fetchQuotes(session.jwtToken, ANGEL_API_KEY, [{
    exchange: niftyIdx.exchange, token: niftyIdx.token, symbol: "NIFTY50",
  }]);
  const spot = idxQuote.NIFTY50?.ltp;
  if (!spot) throw new Error("Failed to fetch NIFTY 50 spot");
  const atm = Math.round(spot / STRIKE_STEP) * STRIKE_STEP;
  console.log(`  ✓ NIFTY spot=${spot}  ATM=${atm}`);

  const expiry = findNearestWeeklyExpiry(instruments);
  if (!expiry) throw new Error("No NIFTY weekly expiry found in instrument master");
  console.log(`  ✓ nearest expiry: ${expiry.str}`);

  const optTokens = pickStrikes(instruments, expiry.str, atm);
  if (optTokens.length === 0) throw new Error("No option tokens resolved for ATM±2");
  console.log(`  ✓ resolved ${optTokens.length} option tokens (CE+PE × ATM±2)\n`);

  // history of OI snapshots — restored from disk so warmup doesn't restart
  // from scratch after a process restart / git push.
  const historyStore = new HistoryStore();
  const persistedHistory = historyStore.load();
  const cutoffMs = Date.now() - LOOKBACK_MIN * 60 * 1000 * 4;
  const history = persistedHistory.filter(h => h && typeof h.ts === "number" && h.ts >= cutoffMs);
  if (history.length > 0) console.log(`  ↻ resumed ${history.length} OI snapshots from disk (warmup bypassed)`);
  // EMA replaces the cumulative-mean "VWAP" — same priceBull/priceBear contract
  const spotEma = new Ema(GUARDS.emaPeriod);

  // restore prior session state if present (crash-safe + carries running balance across days)
  const prior = stateStore.load();
  if (prior) {
    if (prior.openTrade) { openTrade = prior.openTrade; console.log(`  ↻ restored open trade: ${openTrade.symbol} @ ₹${openTrade.entryPx}`); }
    if (prior.risk) riskGuard.restore(prior.risk);
  }
  console.log(`  💰 capital balance: ₹${round(riskGuard.capital)}  (today P&L so far: ₹${round(riskGuard.dailyPnl)})`);

  // Write the CSV report into the runtime data dir (Render persistent disk
  // when DATA_DIR is set). Project root is ephemeral on hosted platforms.
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const reportPath = path.join(dataDir, `oi_test_report_${Date.now()}.csv`);
  fs.writeFileSync(reportPath,
    "ts,spot,atm,ceTotal,peTotal,ceDelta,peDelta,netFlow,pcrOI,ceN,peN,net,bias,strength,priceBull,priceBear,trade\n"
  );

  const endAt = Date.now() + RUN_MINUTES * 60 * 1000;

  while (Date.now() < endAt) {
    try {
      const tokens = [
        { exchange: niftyIdx.exchange, token: niftyIdx.token, symbol: "NIFTY50" },
        ...optTokens.map(t => ({ exchange: t.exchange, token: t.token, symbol: t.symbol })),
      ];
      const q = await fetchQuotes(session.jwtToken, ANGEL_API_KEY, tokens);
      const curSpot = q.NIFTY50?.ltp ?? spot;

      // session window — skip processing entirely outside trading hours
      if (!inSession()) {
        console.log(`[${fmtIST()}] outside session — skipping tick`);
        await new Promise(r => setTimeout(r, msUntilNextCandle()));
        continue;
      }

      // quote integrity — reject partial responses (would corrupt OI deltas)
      const expectedSyms = optTokens.map(t => t.symbol);
      const integ = validateTick({ q, expectedSymbols: expectedSyms });
      if (!integ.ok) {
        console.log(`[${fmtIST()}] tick rejected: ${integ.reason}`);
        await new Promise(r => setTimeout(r, msUntilNextCandle()));
        continue;
      }

      const emaVal = spotEma.push(curSpot);
      const priceBull = emaVal != null && curSpot > emaVal;
      const priceBear = emaVal != null && curSpot < emaVal;

      let ceTotal = 0, peTotal = 0;
      const premiumByStrike = {};
      const oiByStrike = {};
      for (const t of optTokens) {
        const row = q[t.symbol];
        if (!row) continue;
        if (row.opnInterest != null) {
          if (t.side === "CE") ceTotal += row.opnInterest;
          else                 peTotal += row.opnInterest;
          oiByStrike[`${t.strike}${t.side}`] = row.opnInterest;
        }
        premiumByStrike[`${t.strike}${t.side}`] = row.ltp;
      }

      const latest = { ts: Date.now(), ceTotal, peTotal, spot: curSpot, premiumByStrike, oiByStrike };
      history.push(latest);
      trimHistory(history);
      historyStore.save(history);

      const r = computeBias(history, latest, priceBull, priceBear);

      const ts = fmtIST();
      if (!r.ready) {
        console.log(`[${ts}] spot=${curSpot}  ceOI=${ceTotal}  peOI=${peTotal}  (warming up — need ${LOOKBACK_MIN} min of data)`);
      } else {
        console.log(
          `[${ts}] spot=${curSpot}  ceΔ=${r.ceDelta}  peΔ=${r.peDelta}  net=${r.net}  PCR=${round(r.pcrOI,2)}  bias=${r.bias}  strength=${r.strength}%  ${priceBull?"🟢":priceBear?"🔴":"⚪"}`
        );

        // exit first (so we can re-enter on flip in same tick)
        maybeExit(r.bias, latest);
        maybeEnter(r.bias, latest, atm, r);
      }

      const tradeNote = openTrade ? `OPEN_${openTrade.side}@${openTrade.strike}` : "";
      fs.appendFileSync(reportPath,
        `${ts},${curSpot},${atm},${ceTotal},${peTotal},${r.ceDelta ?? ""},${r.peDelta ?? ""},${r.netFlow ?? ""},${round(r.pcrOI ?? 0,3)},${r.ceN ?? ""},${r.peN ?? ""},${r.net ?? ""},${r.bias ?? "WARMUP"},${r.strength ?? ""},${priceBull},${priceBear},${tradeNote}\n`
      );
    } catch (e) {
      console.error(`  ! poll error: ${e.message}`);
    }

    // candle-aligned scheduling: wake 5s after the next minute boundary
    await new Promise(r => setTimeout(r, msUntilNextCandle()));
  }

  // force-close any open trade at session end
  if (openTrade && history.length) {
    maybeExit(null, history[history.length - 1], "SESSION_END");
  }

  // ---------- final report ----------
  console.log(`\n=== TEST REPORT ===`);
  console.log(`CSV log: ${reportPath}`);
  console.log(`Total ticks polled: ${history.length}`);
  console.log(`Paper trades: ${trades.length}`);
  if (trades.length) {
    let gross = 0, wins = 0, losses = 0;
    for (const t of trades) {
      gross += t.pnl;
      if (t.pnl > 0) wins++; else losses++;
      console.log(
        `  ${new Date(t.entryTs).toLocaleTimeString("en-IN",{timeZone:"Asia/Kolkata"})} → ${new Date(t.exitTs).toLocaleTimeString("en-IN",{timeZone:"Asia/Kolkata"})}  ${t.side} ${t.strike}  entry=₹${t.entryPx}  exit=₹${t.exitPx}  P&L=₹${round(t.pnl)}  (${t.reason})`
      );
    }
    console.log(`  ──`);
    console.log(`  Gross P&L: ₹${round(gross)}   Wins: ${wins}   Losses: ${losses}   Hit-rate: ${round(wins/trades.length*100,1)}%`);
  } else {
    console.log("  (no qualified signals fired during the window)");
  }
  process.exit(0);
})().catch((e) => {
  console.error("FATAL:", e.message);
  if (e.raw) console.error("raw:", JSON.stringify(e.raw, null, 2));
  process.exit(1);
});
