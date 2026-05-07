// ============================================================
// OI Guards — risk / integrity / scheduling / state layer
// ------------------------------------------------------------
// Strategy logic (computeBias, thresholds, bias-driven entry)
// is NOT modified. This module wraps it with vetoes, integrity
// checks, candle-aligned scheduling and crash-safe state.
// ============================================================

import fs from "fs";
import path from "path";

// -------------------- tunables --------------------
export const GUARDS = {
  // session window (IST minutes since midnight)
  sessionStartMin: 9 * 60 + 30,   // 09:30 — start of allowed trading
  sessionEndMin:   14 * 60 + 30,  // 14:30 — end of allowed trading
  // Pre-session  (NSE open 09:15 → our start 09:30): opening-auction volatility, OI not yet stable
  // Post-session (our end 14:30 → NSE close 15:30): theta cliff, expiry chaos, wide spreads
  preSessionBlockMin:  9 * 60 + 15,   // 09:15
  postSessionBlockMin: 15 * 60 + 30,  // 15:30
  blockedWindows: [],

  // re-entry / hold
  minHoldSec: 180,
  cooldownAfterExitSec: 180,

  // daily caps — loss limit is a % of CURRENT capital at start of day, not a fixed rupee figure
  maxDailyLossPct:       10,     // 10% of capital → halt for the rest of the IST day
  maxConsecLosses:       2,
  maxTradesPerDay:       4,

  // wrapper-level signal hygiene (does NOT change strategy thresholds)
  minNetFlowAbs:         100000,
  spreadMaxPct:          3,        // (ask-bid)/mid in %; if bid/ask absent, skipped
  minOptionOI:           50000,

  // option premium-based exits (additive; bias-flip exit still works)
  // SL = -10% of entry premium · hard TP = +15% · trail engages at +10% so
  // profits land in the 10–15% band even if the move stalls.
  premiumStopPct:         -10,
  premiumTargetPct:        15,
  premiumTrailTriggerPct:  10,
  premiumTrailGivebackPct:  3,    // give back ≤3% of peak once past the +10% trigger
  timeStopMin:             45,

  // VWAP replacement
  emaPeriod:             20,

  // history retention
  historyMaxLen:         120,

  // quote freshness
  maxTickAgeMs:          90 * 1000,
};

// -------------------- IST helpers --------------------
export const istNow = () =>
  new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));

export function istMinutes(d = istNow()) {
  return d.getHours() * 60 + d.getMinutes();
}

export function sessionPhase(d = istNow()) {
  const m = istMinutes(d);
  if (m < GUARDS.preSessionBlockMin)   return "closed";          // before NSE open
  if (m < GUARDS.sessionStartMin)      return "pre_session";     // 09:15 – 09:30
  if (m > GUARDS.postSessionBlockMin)  return "closed";          // after NSE close
  if (m > GUARDS.sessionEndMin)        return "post_session";    // 14:30 – 15:30
  for (const [a, b] of GUARDS.blockedWindows) if (m >= a && m < b) return "blocked";
  return "open";
}

export function inSession(d = istNow()) {
  return sessionPhase(d) === "open";
}

// -------------------- EMA (replaces cumulative-mean "VWAP") --------------------
export class Ema {
  constructor(period = GUARDS.emaPeriod) {
    this.k = 2 / (period + 1);
    this.value = null;
  }
  push(x) {
    if (x == null || !isFinite(x)) return this.value;
    this.value = this.value == null ? x : x * this.k + this.value * (1 - this.k);
    return this.value;
  }
}

// -------------------- Quote integrity --------------------
export function validateTick({ q, expectedSymbols, prevCeTotal, prevPeTotal }) {
  // require every expected option symbol to be present with OI
  for (const sym of expectedSymbols) {
    const row = q[sym];
    if (!row || row.opnInterest == null) {
      return { ok: false, reason: `partial_quote:${sym}` };
    }
  }
  return { ok: true };
}

// -------------------- Risk guard --------------------
function istDateKey(d = istNow()) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

export class RiskGuard {
  constructor(opts = {}) {
    this.cfg = { ...GUARDS, ...opts };
    this.capital = opts.startingCapital ?? 15000;   // running balance, persisted
    this.dailyPnl = 0;
    this.tradesToday = 0;
    this.consecLosses = 0;
    this.lastExitTs = 0;
    this.halted = false;
    this.haltReason = null;
    this.dayKey = istDateKey();
    // Capital snapshot at start of the current IST day — daily-loss % is
    // measured against this so the limit doesn't drift mid-day.
    this.dayStartCapital = this.capital;
  }

  // call before every entry/exit decision so daily counters reset on a new IST day
  rolloverIfNewDay() {
    const k = istDateKey();
    if (k !== this.dayKey) {
      this.dayKey = k;
      this.dailyPnl = 0;
      this.tradesToday = 0;
      this.consecLosses = 0;
      this.halted = false;
      this.haltReason = null;
      this.dayStartCapital = this.capital;
    }
  }

  dailyLossLimitRupees() {
    return (this.dayStartCapital * this.cfg.maxDailyLossPct) / 100;
  }

  recordExit(pnl) {
    this.rolloverIfNewDay();
    this.capital += pnl;          // running balance moves with every trade
    this.dailyPnl += pnl;
    this.tradesToday += 1;
    this.lastExitTs = Date.now();
    if (pnl < 0) this.consecLosses += 1;
    else this.consecLosses = 0;

    const lossLimit = this.dailyLossLimitRupees();
    if (this.dailyPnl <= -lossLimit) {
      this.halted = true;
      this.haltReason = `daily_loss:${Math.round(this.dailyPnl)}_of_${Math.round(lossLimit)}_(${this.cfg.maxDailyLossPct}%)`;
    } else if (this.consecLosses >= this.cfg.maxConsecLosses) {
      this.halted = true;
      this.haltReason = `consec_losses:${this.consecLosses}`;
    } else if (this.tradesToday >= this.cfg.maxTradesPerDay) {
      this.halted = true;
      this.haltReason = `max_trades:${this.tradesToday}`;
    }
  }

  // returns null if entry allowed, else string reason for veto
  vetoEntry({ now = Date.now(), netFlowAbs, optionOI, optionPx, bidAskPct, tradeCost } = {}) {
    this.rolloverIfNewDay();
    if (this.halted) return `halted:${this.haltReason}`;
    const phase = sessionPhase();
    if (phase !== "open") return `blocked_${phase}`;
    if (now - this.lastExitTs < this.cfg.cooldownAfterExitSec * 1000) return "cooldown";
    if (tradeCost != null && tradeCost > this.capital) return `insufficient_capital:bal=${Math.round(this.capital)}_cost=${Math.round(tradeCost)}`;
    if (netFlowAbs != null && netFlowAbs < this.cfg.minNetFlowAbs) return `weak_netflow:${netFlowAbs}`;
    if (optionOI != null && optionOI < this.cfg.minOptionOI) return `low_option_oi:${optionOI}`;
    if (bidAskPct != null && bidAskPct > this.cfg.spreadMaxPct) return `wide_spread:${bidAskPct.toFixed(2)}%`;
    if (optionPx != null && (!isFinite(optionPx) || optionPx <= 0)) return `bad_premium:${optionPx}`;
    return null;
  }

  snapshot() {
    return {
      capital: this.capital,
      dayStartCapital: this.dayStartCapital,
      dailyPnl: this.dailyPnl,
      dailyLossLimit: this.dailyLossLimitRupees(),
      dailyLossPct: this.cfg.maxDailyLossPct,
      tradesToday: this.tradesToday,
      consecLosses: this.consecLosses,
      lastExitTs: this.lastExitTs,
      halted: this.halted,
      haltReason: this.haltReason,
      dayKey: this.dayKey,
    };
  }

  restore(s) {
    if (!s) return;
    if (typeof s.capital === "number") this.capital = s.capital;
    if (typeof s.dayStartCapital === "number") this.dayStartCapital = s.dayStartCapital;
    if (typeof s.dailyPnl === "number") this.dailyPnl = s.dailyPnl;
    if (typeof s.tradesToday === "number") this.tradesToday = s.tradesToday;
    if (typeof s.consecLosses === "number") this.consecLosses = s.consecLosses;
    if (typeof s.lastExitTs === "number") this.lastExitTs = s.lastExitTs;
    if (typeof s.halted === "boolean") this.halted = s.halted;
    if (typeof s.haltReason === "string") this.haltReason = s.haltReason;
    if (typeof s.dayKey === "string") this.dayKey = s.dayKey;
    this.rolloverIfNewDay();    // if loaded state is from a previous day, reset dailies
  }
}

// -------------------- Premium-based exit decisions --------------------
// returns reason string if exit should fire, else null. Trade object
// gets `peakPx` mutated so trailing works across calls.
export function premiumExitReason(openTrade, currentPx, now = Date.now()) {
  if (!openTrade || currentPx == null) return null;
  const entry = openTrade.entryPx;
  if (!entry) return null;

  const pctMove = ((currentPx - entry) / entry) * 100;
  if (pctMove <= GUARDS.premiumStopPct) return `PREMIUM_STOP:${pctMove.toFixed(1)}%`;
  if (pctMove >= GUARDS.premiumTargetPct) return `PREMIUM_TARGET:${pctMove.toFixed(1)}%`;

  if (!openTrade.peakPx || currentPx > openTrade.peakPx) openTrade.peakPx = currentPx;
  const peakPct = ((openTrade.peakPx - entry) / entry) * 100;
  if (peakPct >= GUARDS.premiumTrailTriggerPct) {
    const giveback = ((openTrade.peakPx - currentPx) / openTrade.peakPx) * 100;
    if (giveback >= GUARDS.premiumTrailGivebackPct) {
      return `TRAIL_STOP:peak${peakPct.toFixed(1)}%_back${giveback.toFixed(1)}%`;
    }
  }

  const ageMin = (now - openTrade.entryTs) / 60000;
  if (ageMin >= GUARDS.timeStopMin) return `TIME_STOP:${ageMin.toFixed(0)}m`;

  return null;
}

// -------------------- Candle-aligned scheduler --------------------
// returns ms to wait until 5s past the next minute boundary
export function msUntilNextCandle(now = Date.now(), offsetMs = 5000) {
  const next = Math.ceil(now / 60000) * 60000 + offsetMs;
  return Math.max(1000, next - now);
}

// -------------------- State persistence --------------------
export class StateStore {
  constructor(filePath) {
    this.filePath = filePath || path.join(process.cwd(), "oi_state.json");
  }
  load() {
    try {
      if (!fs.existsSync(this.filePath)) return null;
      const raw = fs.readFileSync(this.filePath, "utf8");
      return JSON.parse(raw);
    } catch (e) {
      console.error("StateStore.load failed:", e.message);
      return null;
    }
  }
  save(state) {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(state, null, 2));
    } catch (e) {
      console.error("StateStore.save failed:", e.message);
    }
  }
  clear() {
    try { if (fs.existsSync(this.filePath)) fs.unlinkSync(this.filePath); } catch {}
  }
}

// -------------------- history trim --------------------
export function trimHistory(history, maxLen = GUARDS.historyMaxLen) {
  if (history.length > maxLen) history.splice(0, history.length - maxLen);
}
