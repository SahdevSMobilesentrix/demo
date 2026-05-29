// Live OI tracker — no paper trading, no history, no persistence.
// Polls the NIFTY option chain every 30 seconds and surfaces a rolling
// in-memory list of today's ticks via getOiState().

import { loadInstruments, fetchQuotes } from "./brokers/angelMarketData.js";
import { appendSnapshot } from "./signal/oiSnapshotWriter.js";
import { onOiTick as autoPaperTick } from "./paper/autoPaperTrader.js";
import { marketStatus as getMarketStatus } from "./marketClock.js";
import { impliedVolatility, yearsToExpiry } from "./signal/iv.js";

const POLL_SEC = 30;
const LOOKBACK_MIN = 15;
// Strike chain uses a longer window so build-up vs short-covering is readable.
// 15 min is too noisy for per-strike classification.
const STRIKE_LOOKBACK_MIN = 60;
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

// Sum OI change only over strikes present in BOTH snapshots. A strike entering
// or leaving the window (when the ATM re-centers) contributes nothing, so a
// total taken over a shifting strike set can no longer fake OI "flow".
function matchedOiDelta(refByStrike, curByStrike) {
  let ceDelta = 0, peDelta = 0;
  if (!refByStrike || !curByStrike) return { ceDelta, peDelta };
  for (const k of Object.keys(curByStrike)) {
    const cur = curByStrike[k];
    const ref = refByStrike[k];
    if (!ref) continue;
    if (cur.ce?.oi != null && ref.ce?.oi != null) ceDelta += cur.ce.oi - ref.ce.oi;
    if (cur.pe?.oi != null && ref.pe?.oi != null) peDelta += cur.pe.oi - ref.pe.oi;
  }
  return { ceDelta, peDelta };
}

function computeBias(history, latest) {
  const cutoff = latest.ts - LOOKBACK_MIN * 60 * 1000;
  let ref = null;
  for (const h of history) { if (h.ts <= cutoff) ref = h; else break; }
  if (!ref) return { ready: false };

  // Per-strike matched deltas — robust to the ATM window shifting between ref and now.
  const { ceDelta, peDelta } = matchedOiDelta(ref.byStrike, latest.byStrike);
  const netFlow = peDelta - ceDelta;
  const pcrOI = latest.peTotal / Math.max(latest.ceTotal, 1);

  // Normalize against the recent distribution of matched deltas vs the window base.
  const recent = history.slice(-60);
  const base = recent[0];
  const ceDeltas = recent.map(h => matchedOiDelta(base.byStrike, h.byStrike).ceDelta);
  const peDeltas = recent.map(h => matchedOiDelta(base.byStrike, h.byStrike).peDelta);
  const std = (xs) => {
    const m = xs.reduce((a,b)=>a+b,0)/Math.max(xs.length,1);
    return Math.sqrt(xs.reduce((a,b)=>a+(b-m)**2,0)/Math.max(xs.length,1)) || 1;
  };
  const ceN = ceDelta / std(ceDeltas);
  const peN = peDelta / std(peDeltas);
  const net = peN - ceN;

  // Bias polarity — option-WRITER (seller) view, the standard OI-writing read:
  //   net > 0  => puts written faster than calls => support building => BULLISH
  //   net < 0  => calls written faster => resistance building => BEARISH
  // Do NOT invert this to "trade as a buyer". To trade against the signal use the
  // FADE book in paper/autoPaperTrader.js — that keeps this label correct while
  // still letting you test fading. See memory: auto-paper-follow-vs-fade.
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

          // Dynamic ATM with hysteresis. Only re-center the strike window once
          // spot has drifted a clear ¾-strike past the current ATM. Without this
          // deadband, spot jittering across a half-strike boundary (e.g. ~23975,
          // between the 23950 and 24000 strikes) flips the ATM every poll, which
          // swaps a deep strike in/out of the ±10 window and injects phantom
          // 60L–1.5Cr jumps into total OI — the cause of the flip-flopping signal.
          if (Math.abs(curSpot - state.atm) > STRIKE_STEP * 0.75) {
            const newAtm = Math.round(curSpot / STRIKE_STEP) * STRIKE_STEP;
            if (newAtm !== state.atm) {
              state.atm = newAtm;
              const rebuilt = pickStrikes(instruments, expiry.str, newAtm);
              if (rebuilt.length > 0) optTokens = rebuilt;
            }
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
          // strike -> { ce: { oi, ltp, volume, iv }, pe: { oi, ltp, volume, iv } }
          const byStrike = {};
          const expDate = parseExpiry(state.expiry);
          const T = yearsToExpiry(expDate);
          for (const t of optTokens) {
            const row = q[t.symbol];
            if (!row) continue;
            if (!byStrike[t.strike]) byStrike[t.strike] = { ce: null, pe: null };
            const isCall = t.side === "CE";
            const iv = (row.ltp != null && curSpot != null && T != null)
              ? impliedVolatility(row.ltp, curSpot, t.strike, T, isCall)
              : null;
            const cell = {
              oi: row.opnInterest ?? null,
              ltp: row.ltp ?? null,
              volume: row.tradeVolume ?? null,
              iv,
            };
            if (isCall) byStrike[t.strike].ce = cell;
            else        byStrike[t.strike].pe = cell;
            if (row.opnInterest != null) {
              if (isCall) ceTotal += row.opnInterest;
              else        peTotal += row.opnInterest;
            }
          }

          const latest = { ts: Date.now(), ceTotal, peTotal, spot: curSpot, byStrike };

          // Build per-strike chain view with delta vs STRIKE_LOOKBACK_MIN ago.
          const cutoff = latest.ts - STRIKE_LOOKBACK_MIN * 60 * 1000;
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
              const ceLtpCur = cur.ce?.ltp ?? null;
              const peLtpCur = cur.pe?.ltp ?? null;
              const ceLtpRef = ref.ce?.ltp ?? null;
              const peLtpRef = ref.pe?.ltp ?? null;
              const ceIvCur  = cur.ce?.iv ?? null;
              const peIvCur  = cur.pe?.iv ?? null;
              const ceIvRef  = ref.ce?.iv ?? null;
              const peIvRef  = ref.pe?.iv ?? null;
              const ceVolCur = cur.ce?.volume ?? null;
              const peVolCur = cur.pe?.volume ?? null;
              const pcrOiCur = (peCur != null && ceCur)   ? peCur / ceCur : null;
              const pcrOiRef = (peRef != null && ceRef)   ? peRef / ceRef : null;
              const pcrVol   = (peVolCur != null && ceVolCur) ? peVolCur / ceVolCur : null;
              return {
                strike,
                ceOI: ceCur,
                peOI: peCur,
                ceLtp: ceLtpCur,
                peLtp: peLtpCur,
                ceVol: ceVolCur,
                peVol: peVolCur,
                ceIv: ceIvCur,
                peIv: peIvCur,
                ceIvDelta: (ceIvCur != null && ceIvRef != null) ? ceIvCur - ceIvRef : null,
                peIvDelta: (peIvCur != null && peIvRef != null) ? peIvCur - peIvRef : null,
                ceDelta: (ceCur != null && ceRef != null) ? ceCur - ceRef : null,
                peDelta: (peCur != null && peRef != null) ? peCur - peRef : null,
                ceLtpDelta: (ceLtpCur != null && ceLtpRef != null) ? ceLtpCur - ceLtpRef : null,
                peLtpDelta: (peLtpCur != null && peLtpRef != null) ? peLtpCur - peLtpRef : null,
                pcrOi: pcrOiCur,
                pcrOiDelta: (pcrOiCur != null && pcrOiRef != null) ? pcrOiCur - pcrOiRef : null,
                pcrVol,
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

          // Auto paper trader (FOLLOW vs FADE books) reacts to the live bias.
          // Self-guarded; never throws into the poll loop.
          autoPaperTick({
            ts: latest.ts,
            tsIST: fmtIST(),
            day: curDay,
            spot: curSpot,
            atm: state.atm,
            bias: r.ready ? r.bias : null,
            net: r.net ?? null,
            strength: r.strength ?? null,
            byStrike,
          });
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
