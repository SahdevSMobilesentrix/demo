// Live OI tracker — no paper trading, no history, no persistence.
// Polls the NIFTY option chain every minute and surfaces a rolling
// in-memory list of today's ticks via getOiState().

import { loadInstruments, fetchQuotes } from "./brokers/angelMarketData.js";
import { appendSnapshot } from "./signal/oiSnapshotWriter.js";
import { monitorOpenTrade as paperMonitor } from "./paper/paperTrader.js";
import { marketStatus as getMarketStatus } from "./marketClock.js";

const POLL_SEC = 180;
const LOOKBACK_MIN = 15;
const STRIKE_STEP = 50;

const istNow = () =>
  new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
const fmtIST = (d = istNow()) => d.toTimeString().slice(0, 8);
const istDateKey = () => {
  const d = istNow();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
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
  // 21 strikes: 10 below ATM, ATM, 10 above ATM.
  const offsets = [];
  for (let k = -10; k <= 10; k++) offsets.push(k);
  const wanted = offsets.map((k) => atm + k * STRIKE_STEP);
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

function computeBias(history, latest) {
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
  if (Math.abs(netFlow) > 10000) {
    if (net > 1.5)        bias = "Strong Bullish";
    else if (net > 0.5)   bias = "Bullish";
    else if (net < -1.5)  bias = "Strong Bearish";
    else if (net < -0.5)  bias = "Bearish";
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

function freshState() {
  return {
    status: "starting",
    startedAt: Date.now(),
    day: istDateKey(),
    ticks: [],   // newest-first, today's ticks only
    error: null,
    atm: null,
    expiry: null,
    spotOpen: null,
    ohlc: null,  // { open, high, low, close, ltp, ts }
    strikes: [], // [{ strike, ceOI, peOI, ceLtp, peLtp, ceDelta, peDelta, atm }]
  };
}

export function getOiState() {
  if (!state) return { status: "idle", ticks: [] };
  // Drop any ticks not from today (defensive — loop already resets at IST rollover).
  const today = istDateKey();
  const ticksToday = state.ticks.filter(t => t.day === today);
  return {
    status: state.status,
    startedAt: state.startedAt,
    atm: state.atm,
    expiry: state.expiry,
    spotOpen: state.spotOpen,
    error: state.error,
    ohlc: state.ohlc,
    strikes: state.strikes || [],
    ticks: ticksToday.slice(0, 1000),
  };
}

export function stopOiTest() {
  if (!state) return { ok: true, message: "not running" };
  state.status = "stopping";
  return { ok: true };
}

// Kept as a no-op for backward compatibility with any cached frontend.
export function updateOiParams() {
  return { ok: true };
}

export async function startOiTest({ jwtToken, apiKey }) {
  if (state && (state.status === "running" || state.status === "starting")) {
    throw new Error("OI tracker already running. Stop it first.");
  }
  if (!jwtToken || !apiKey) throw new Error("jwtToken and apiKey required");
  state = freshState();

  (async () => {
    try {
      const instruments = await loadInstruments();
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

      let optTokens = pickStrikes(instruments, expiry.str, atm);
      if (optTokens.length === 0) throw new Error("No option tokens resolved around ATM");

      // In-memory only — never persisted.
      let history = [];
      state.status = "running";

      while (state.status === "running" || state.status === "paused-market-closed") {
        try {
          // Market-hours gate — skip polling Angel when market is closed.
          const ms = getMarketStatus();
          if (!ms.trading) {
            state.status = "paused-market-closed";
            state.marketReason = ms.status + (ms.holiday ? ` (${ms.holiday})` : "");
            // sleep 30 sec, re-check (don't burn API quota)
            for (let i = 0; i < 30 && state.status === "paused-market-closed"; i++) {
              await new Promise(r => setTimeout(r, 1000));
            }
            continue;
          } else if (state.status === "paused-market-closed") {
            state.status = "running";
            state.marketReason = null;
          }

          // IST day rollover: reset ticks + bias history so the table shows today only.
          const curDay = istDateKey();
          if (curDay !== state.day) {
            state.day = curDay;
            state.ticks = [];
            history = [];
          }

          const tokens = [
            { exchange: niftyIdx.exchange, token: niftyIdx.token, symbol: "NIFTY50" },
            ...optTokens.map(t => ({ exchange: t.exchange, token: t.token, symbol: t.symbol })),
          ];
          const q = await fetchQuotes(jwtToken, apiKey, tokens);
          const idx = q.NIFTY50 || {};
          const curSpot = idx.ltp ?? spot;

          // Dynamic ATM: follow live spot. If the strike has moved, rebuild
          // the option-token window so next poll covers the new ATM ±10.
          const newAtm = Math.round(curSpot / STRIKE_STEP) * STRIKE_STEP;
          if (newAtm !== state.atm) {
            state.atm = newAtm;
            const rebuilt = pickStrikes(instruments, expiry.str, newAtm);
            if (rebuilt.length > 0) optTokens = rebuilt;
          }
          state.ohlc = {
            ltp: idx.ltp ?? null,
            open: idx.open ?? null,
            high: idx.high ?? null,
            low: idx.low ?? null,
            close: idx.close ?? null,
            ts: Date.now(),
          };

          let ceTotal = 0, peTotal = 0;
          // strike -> { ce: { oi, ltp }, pe: { oi, ltp } }
          const byStrike = {};
          for (const t of optTokens) {
            const row = q[t.symbol];
            if (!row) continue;
            if (!byStrike[t.strike]) byStrike[t.strike] = { ce: null, pe: null };
            const cell = { oi: row.opnInterest ?? null, ltp: row.ltp ?? null, volume: row.tradeVolume ?? null };
            if (t.side === "CE") byStrike[t.strike].ce = cell;
            else                 byStrike[t.strike].pe = cell;
            if (row.opnInterest != null) {
              if (t.side === "CE") ceTotal += row.opnInterest;
              else                 peTotal += row.opnInterest;
            }
          }

          const latest = { ts: Date.now(), ceTotal, peTotal, spot: curSpot, byStrike };

          // Build per-strike chain view with delta vs LOOKBACK_MIN ago.
          const cutoff = latest.ts - LOOKBACK_MIN * 60 * 1000;
          let refTick = null;
          for (const h of history) { if (h.ts <= cutoff) refTick = h; else break; }
          const strikes = Object.keys(byStrike)
            .map(s => +s)
            .sort((a, b) => a - b)
            .map(strike => {
              const cur = byStrike[strike] || {};
              const ref = refTick?.byStrike?.[strike] || {};
              const ceCur = cur.ce?.oi ?? null;
              const peCur = cur.pe?.oi ?? null;
              const ceRef = ref.ce?.oi ?? null;
              const peRef = ref.pe?.oi ?? null;
              return {
                strike,
                ceOI: ceCur,
                peOI: peCur,
                ceLtp: cur.ce?.ltp ?? null,
                peLtp: cur.pe?.ltp ?? null,
                ceDelta: (ceCur != null && ceRef != null) ? ceCur - ceRef : null,
                peDelta: (peCur != null && peRef != null) ? peCur - peRef : null,
                atm: strike === state.atm,
              };
            });
          state.strikes = strikes;

          // Persist canonical snapshot for the signal engine.
          try {
            appendSnapshot({
              symbol: "NIFTY",
              expiryStr: state.expiry,
              spot: curSpot,
              vix: null,
              byStrike,
            });
          } catch {}

          // Paper trader: check stop/target/time on open trade after fresh data.
          try { paperMonitor(); } catch {}

          history.push(latest);
          if (history.length > 240) history.splice(0, history.length - 240);
          const r = computeBias(history, latest);

          state.ticks.unshift({
            ts: latest.ts,
            tsIST: fmtIST(),
            day: curDay,
            spot: curSpot,
            ceTotal, peTotal,
            ceDelta: r.ceDelta ?? null,
            peDelta: r.peDelta ?? null,
            netFlow: r.netFlow ?? null,
            pcrOI: r.pcrOI ?? null,
            net: r.net ?? null,
            bias: r.ready ? r.bias : "WARMUP",
            strength: r.strength ?? null,
          });
          if (state.ticks.length > 1000) state.ticks.length = 1000;
        } catch (e) {
          // Swallow transient poll errors; loop continues.
        }

        for (let i = 0; i < POLL_SEC && state.status === "running"; i++) {
          await new Promise(r => setTimeout(r, 1000));
        }
      }

      state.status = "finished";
    } catch (e) {
      if (state) {
        state.status = "error";
        state.error = e.message;
      }
    }
  })();

  return { ok: true, status: state.status };
}
