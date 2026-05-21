// paperTrader.js — paper trading state machine, both sides.
// BULL signal → buy 1 ATM CE. BEAR signal → buy 1 ATM PE.
// Monitors on every poll, closes on STOP / TARGET / TIME / INVALIDATION.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { LOT_SIZE } from "../signal/node-engine/utils.js";
import {
  loadDay as loadDaySnapshots,
  groupSnapshots,
} from "../signal/node-engine/snapshotReader.js";
import {
  marketStatus as getMarketStatus,
  inSignalWindow as marketInSignalWindow,
} from "../marketClock.js";
import { computeLegCosts, computeRoundTripCosts } from "./costs.js";
import {
  loadSettings, saveSettings,
  loadTrades, appendTrade, updateTrade, archiveAndReset,
  rollOldTradesToArchive,
} from "./paperStore.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const DATA_ROOT = process.env.FNO_DATA_ROOT
  || path.join(PROJECT_ROOT, "data", "fno");

// in-process score-decay counter for the currently open trade
let lowScoreBars = 0;

// ---------------- helpers ----------------

function istDateKey(d = new Date()) {
  const ist = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const y = ist.getFullYear();
  const m = String(ist.getMonth() + 1).padStart(2, "0");
  const dd = String(ist.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function istDateKeyCompact(d = new Date()) {
  return istDateKey(d).replace(/-/g, "");
}

function istNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
}

function isPast15IST(now = istNow()) {
  return now.getHours() > 15 || (now.getHours() === 15 && now.getMinutes() >= 0);
}

function round2(v) { return Math.round(v * 100) / 100; }

function nextTradeId(dateKey, allTrades) {
  const prefix = `PT-${dateKey.replace(/-/g, "")}-`;
  const todays = allTrades.filter(t => t.id?.startsWith(prefix));
  const n = String(todays.length + 1).padStart(3, "0");
  return prefix + n;
}

function findOpenTrade(allTrades) {
  return allTrades.find(t => t.status === "OPEN") || null;
}

function todaysTrades(allTrades, dateKey) {
  return allTrades.filter(t => t.date === dateKey);
}

// Look up CE LTP / spot from latest on-disk snapshot
function latestSnapshot(symbol) {
  const rows = loadDaySnapshots(DATA_ROOT, symbol, istDateKeyCompact());
  if (!rows.length) return null;
  const snaps = groupSnapshots(rows);
  return snaps[snaps.length - 1];
}

function optionLtpAt(snap, strike, optType) {
  if (!snap) return null;
  const r = snap.rows.find(x => x.strike === strike && x.opt_type === optType);
  return r ? Number(r.ltp) : null;
}

function spotFromSnap(snap) {
  return snap?.rows?.[0]?.spot ?? null;
}

// ---------------- public state ----------------

export function getCurrentCapital() {
  const settings = loadSettings();
  const closed = loadTrades().filter(t => t.status === "CLOSED");
  const realized = closed.reduce((acc, t) => acc + (t.netPnl || 0), 0);
  return round2(settings.initialCapital + realized);
}

export function getPaperState() {
  const settings = loadSettings();
  const all = loadTrades();
  const open = findOpenTrade(all);
  const closed = all.filter(t => t.status === "CLOSED");
  const today = istDateKey();
  const todays = closed.filter(t => t.date === today);

  const wins = closed.filter(t => (t.netPnl || 0) > 0).length;
  const losses = closed.filter(t => (t.netPnl || 0) <= 0).length;

  const todayPnl = todays.reduce((a, t) => a + (t.netPnl || 0), 0);
  const totalPnl = closed.reduce((a, t) => a + (t.netPnl || 0), 0);

  let openWithMtm = null;
  if (open) {
    const snap = latestSnapshot(open.symbol);
    const curSpot = spotFromSnap(snap);
    const curPrem = optionLtpAt(snap, open.atmStrike, open.optType);
    let mtmPnl = null;
    if (curPrem != null) {
      const qty = open.lotSize * open.lots;
      const grossMtm = (curPrem - open.entry.premium) * qty;
      // exit-side costs approx for MTM display
      const rt = computeRoundTripCosts(open.entry.premium, curPrem, qty);
      mtmPnl = round2(grossMtm - rt.total);
    }
    openWithMtm = { ...open, currentSpot: curSpot, currentPremium: curPrem, mtmPnl };
  }

  return {
    settings,
    currentCapital: getCurrentCapital(),
    todayPnl: round2(todayPnl),
    todayTrades: todays.length,
    totalPnl: round2(totalPnl),
    totalTrades: closed.length,
    wins,
    losses,
    openTrade: openWithMtm,
    history: closed.slice().reverse().slice(0, 200),   // newest first, last 200
  };
}

export function updateSettings(patch) {
  return saveSettings(patch);
}

export function resetCapital() {
  archiveAndReset();
  return { ok: true };
}

export function exportCsv() {
  const trades = loadTrades().filter(t => t.status === "CLOSED");
  const header = [
    "id","date","side","atmStrike","optType","lots","lotSize",
    "entryTs","entrySpot","entryPremium","invalidationStrike","targetSpot",
    "exitTs","exitSpot","exitPremium","exitReason",
    "grossPnl","costs","netPnl","capitalAfter",
  ];
  const lines = [header.join(",")];
  for (const t of trades) {
    lines.push([
      t.id, t.date, t.side, t.atmStrike, t.optType, t.lots, t.lotSize,
      t.entry?.ts, t.entry?.spot, t.entry?.premium,
      t.entry?.invalidationStrike, t.entry?.targetSpot,
      t.exit?.ts, t.exit?.spot, t.exit?.premium, t.exit?.reason,
      t.grossPnl, t.costs, t.netPnl, t.capitalAfter,
    ].map(csvCell).join(","));
  }
  return lines.join("\n");
}
function csvCell(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ---------------- core actions ----------------

/**
 * Called from signalRunner each time the engine emits a payload (with or
 * without a signal). BEAR signals + null payloads are ignored for entry,
 * but monitoring still runs for any open trade.
 */
export function onEnginePayload(payload) {
  // monitoring runs first so we can free a slot before checking daily limit
  monitorOpenTrade();

  if (!payload || !payload.signal) return { action: "monitored_only" };
  const sig = payload.signal;
  if (sig.side !== "BULL" && sig.side !== "BEAR") {
    return { action: "ignored_unknown_side", side: sig.side };
  }

  return openTradeFromSignal(sig);
}

function openTradeFromSignal(sig) {
  const settings = loadSettings();
  if (!settings.longOnly) {
    // We still only do long-only for now; if you flip the flag later, change here.
  }

  // Market-hours gate — never open paper trades on weekends/holidays/off-hours.
  if (!marketInSignalWindow()) {
    const ms = getMarketStatus();
    return { action: "skipped", reason: "market_" + ms.status };
  }

  const all = loadTrades();
  if (findOpenTrade(all)) {
    return { action: "skipped", reason: "trade_already_open" };
  }

  const today = istDateKey();
  const todays = todaysTrades(all, today);
  if (todays.length >= settings.maxTradesPerDay) {
    return { action: "skipped", reason: "max_trades_per_day" };
  }

  const symbol = (sig.symbol || "NIFTY").toUpperCase();
  const lotSize = LOT_SIZE[symbol] || 75;
  const lots = settings.defaultLotSize;
  const qty = lotSize * lots;

  const optType = sig.side === "BULL" ? "CE" : "PE";

  // pull entry premium from the latest snapshot at the signal's ATM strike
  const snap = latestSnapshot(symbol);
  if (!snap) return { action: "skipped", reason: "no_snapshot_for_entry" };

  const ltpAtm = optionLtpAt(snap, sig.atm, optType);
  if (ltpAtm == null || ltpAtm <= 0) {
    return { action: "skipped", reason: `no_atm_${optType.toLowerCase()}_ltp` };
  }

  // slippage worsens entry (we pay slightly more)
  const slipMul = 1 + (settings.slippagePct || 0) / 100;
  const entryPremium = round2(ltpAtm * slipMul);
  const premiumCost = entryPremium * qty;

  // capital check (must be able to afford the premium itself)
  const cap = getCurrentCapital();
  if (premiumCost > cap) {
    return { action: "skipped", reason: "insufficient_capital",
             needed: premiumCost, available: cap };
  }

  const entryCosts = computeLegCosts(entryPremium, qty, "BUY");
  // Engine gives target_pct (+0.006 for BULL, -0.006 for BEAR). Fall back if absent.
  const tgtPct = Number.isFinite(sig.target_pct)
    ? sig.target_pct
    : (sig.side === "BULL" ? 0.006 : -0.006);
  const targetSpot = round2(sig.spot * (1 + tgtPct));

  const trade = {
    id: nextTradeId(today, all),
    date: today,
    side: sig.side,
    status: "OPEN",
    symbol,
    atmStrike: sig.atm,
    optType,
    lotSize,
    lots,
    entry: {
      ts: snap.ts,
      spot: round2(sig.spot),
      premium: entryPremium,
      ltpRaw: round2(ltpAtm),
      slippagePct: settings.slippagePct,
      invalidationStrike: sig.invalidation_strike,
      targetSpot,
      signalScore: sig.score,
      triggerStrike: sig.trigger_strike,
      entryCosts: entryCosts.total,
    },
    exit: null,
    grossPnl: 0,
    costs: entryCosts.total,
    netPnl: -entryCosts.total,        // until closed, costs are sunk
    capitalAfter: null,
  };

  appendTrade(trade);
  lowScoreBars = 0;
  return { action: "opened", trade };
}

/**
 * Called on every engine tick and every OI poll. Reads latest snapshot,
 * checks stop / target / time exits. Also accepts an optional latestScore
 * argument to apply the "score < 3 for 2 polls" early-exit rule.
 */
export function monitorOpenTrade(latestScore = null) {
  const all = loadTrades();
  const open = findOpenTrade(all);
  if (!open) return { action: "none" };

  const snap = latestSnapshot(open.symbol);
  if (!snap) return { action: "no_snapshot" };

  const spot = spotFromSnap(snap);
  const premium = optionLtpAt(snap, open.atmStrike, open.optType);

  // Score decay tracking (only when we have a fresh score)
  if (latestScore != null) {
    if (latestScore < 3) lowScoreBars++;
    else lowScoreBars = 0;
  }

  let reason = null;
  const ms = getMarketStatus();
  const isBull = open.side === "BULL";
  // BULL/CE: stop when spot falls to invalidation, target when spot rises to targetSpot.
  // BEAR/PE: stop when spot rises to invalidation, target when spot falls to targetSpot.
  if (spot != null && (isBull
        ? spot <= open.entry.invalidationStrike
        : spot >= open.entry.invalidationStrike))             reason = "STOP";
  else if (spot != null && (isBull
        ? spot >= open.entry.targetSpot
        : spot <= open.entry.targetSpot))                     reason = "TARGET";
  else if (lowScoreBars >= 2)                                 reason = "INVALIDATION";
  else if (isPast15IST())                                     reason = "TIME";
  else if (!ms.trading && ms.status !== "closed_premarket")   reason = "TIME";   // weekend/holiday/post-close orphan

  if (!reason) return { action: "hold", spot, premium };

  return closeTrade(open, snap, premium, spot, reason);
}

/**
 * Manual exit triggered by the UI. Uses the latest snapshot's LTP.
 */
export function manualExit() {
  const all = loadTrades();
  const open = findOpenTrade(all);
  if (!open) return { action: "none", reason: "no_open_trade" };
  const snap = latestSnapshot(open.symbol);
  const spot = spotFromSnap(snap);
  const premium = optionLtpAt(snap, open.atmStrike, open.optType);
  return closeTrade(open, snap, premium, spot, "MANUAL");
}

function closeTrade(open, snap, premiumLtp, spot, reason) {
  const settings = loadSettings();
  const qty = open.lotSize * open.lots;

  // If premium unknown, fall back to entry premium (no-op exit) and tag stale
  const haveLtp = premiumLtp != null && Number.isFinite(premiumLtp) && premiumLtp > 0;
  const ltp = haveLtp ? premiumLtp : open.entry.premium;
  const slipMul = 1 - (settings.slippagePct || 0) / 100;    // SELL slippage hurts us
  const exitPremium = round2(ltp * slipMul);

  const gross = round2((exitPremium - open.entry.premium) * qty);
  const exitCosts = computeLegCosts(exitPremium, qty, "SELL");
  const totalCosts = round2(open.entry.entryCosts + exitCosts.total);
  const net = round2(gross - totalCosts);

  const newCap = round2(getCurrentCapital() + net + open.entry.entryCosts);
  // ^ getCurrentCapital() already excluded this OPEN trade's costs from accounting
  //   (we stored netPnl = -entryCosts but status=OPEN, so it's not summed in closed).
  //   Capital after = previous capital + net realized.

  const updated = updateTrade(open.id, {
    status: "CLOSED",
    exit: {
      ts: snap?.ts || new Date().toISOString(),
      spot: spot != null ? round2(spot) : null,
      premium: exitPremium,
      ltpRaw: round2(ltp),
      reason,
      stale: !haveLtp,
    },
    grossPnl: gross,
    costs: totalCosts,
    netPnl: net,
    capitalAfter: round2(getCurrentCapital() + net),    // recompute cleanly below
  });

  // Recompute capitalAfter authoritatively from journal
  const capAfter = getCurrentCapital();
  const final = updateTrade(open.id, { capitalAfter: capAfter });

  lowScoreBars = 0;
  return { action: "closed", reason, trade: final };
}

// ---------------- maintenance ----------------

export function rollRetention() {
  return rollOldTradesToArchive(90);
}
