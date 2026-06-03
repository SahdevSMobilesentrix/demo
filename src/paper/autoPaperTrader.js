// autoPaperTrader.js — fully automatic paper trading driven by the LIVE OI bias
// from oiRunner (not the 5-min signalEngine, which rarely triggers).
//
// Self-contained: own journal, own capital, reuses only the cost model. It runs
// TWO parallel books on every confirmed signal so their P&L can be compared:
//
//   FOLLOW — trade WITH the option sellers   (Strong Bullish -> buy CE, Bearish -> buy PE)
//   FADE   — trade AGAINST the sellers        (Strong Bullish -> buy PE, Bearish -> buy CE)
//
// One lot each, at most one open trade per book at a time. After a week of live
// ticks, getAutoPaperState() shows both books side by side — that settles
// "should I follow or fade?" with data, not feel.
//
// All state persists to data/paper/auto_state.json and survives restarts.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LOT_SIZE } from "../signal/node-engine/utils.js";
import { computeLegCosts } from "./costs.js";
import { marketStatus as getMarketStatus } from "../marketClock.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const DATA_ROOT = process.env.FNO_DATA_ROOT || path.join(PROJECT_ROOT, "data", "fno");
const PAPER_DIR = path.join(path.dirname(DATA_ROOT), "paper");
const STATE_PATH = path.join(PAPER_DIR, "auto_state.json");

const BOOKS = ["FOLLOW", "FADE"];

const DEFAULT_CONFIG = {
  symbol: "NIFTY",
  initialCapital: 20000,   // ₹ per book
  lots: 1,                 // one lot
  slippagePct: 0.5,        // worsens both entry and exit fills
  strongNet: 1.5,          // |net| score that counts as a "Strong" signal
  confirmTicks: 3,         // consecutive same-direction strong ticks before entry (was 2 — more confirmation)
  targetAmt: 700,          // book profit at ₹700 flat per trade
  stopAmt: 500,            // stop loss at ₹500 flat per trade (risk ₹500 to make ₹700 ≈ 1:1.4 R:R)
  premiumMin: 50,          // skip strikes with premium below ₹50 (too cheap, bad liquidity)
  premiumMax: 300,         // skip strikes with premium above ₹300 (too expensive for capital)
  entryStart: "09:30",     // no entries before this (IST)
  entryEnd: "14:45",       // no new entries after this (IST)
  squareOff: "15:15",      // hard square-off (IST)
  maxTradesPerDay: 0,      // per book; 0 = no limit (only capital stops trading)
  reentryCooldownSec: 120, // wait after an exit before the same book re-enters
};

// ---------------- time / format helpers ----------------

const istNow = () =>
  new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
const round2 = (v) => Math.round(v * 100) / 100;

function istDateKey(d = istNow()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function minsOf(hhmm, now = istNow()) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return { now: now.getHours() * 60 + now.getMinutes(), at: h * 60 + (m || 0) };
}
function inEntryWindow(cfg, now = istNow()) {
  const s = minsOf(cfg.entryStart, now);
  const e = minsOf(cfg.entryEnd, now);
  return s.now >= s.at && e.now <= e.at;
}
function pastSquareOff(cfg, now = istNow()) {
  const t = minsOf(cfg.squareOff, now);
  return t.now >= t.at;
}

// ---------------- persistence ----------------

function ensureDir() { fs.mkdirSync(PAPER_DIR, { recursive: true }); }
function atomicWrite(p, content) {
  ensureDir();
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, p);
}
function loadState() {
  ensureDir();
  if (!fs.existsSync(STATE_PATH)) {
    const s = { config: { ...DEFAULT_CONFIG }, trades: [], createdAt: new Date().toISOString() };
    atomicWrite(STATE_PATH, JSON.stringify(s, null, 2));
    return s;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    return {
      config: { ...DEFAULT_CONFIG, ...(parsed.config || {}) },
      trades: Array.isArray(parsed.trades) ? parsed.trades : [],
      createdAt: parsed.createdAt || new Date().toISOString(),
    };
  } catch {
    return { config: { ...DEFAULT_CONFIG }, trades: [], createdAt: new Date().toISOString() };
  }
}
function saveState(s) { atomicWrite(STATE_PATH, JSON.stringify(s, null, 2)); }

// ---------------- book queries ----------------

function bookClosed(trades, book) { return trades.filter(t => t.book === book && t.status === "CLOSED"); }
function bookOpen(trades, book) { return trades.find(t => t.book === book && t.status === "OPEN") || null; }
function bookCapital(trades, book, initial) {
  return round2(initial + bookClosed(trades, book).reduce((a, t) => a + (t.netPnl || 0), 0));
}
function lastExitTs(trades, book) {
  let m = 0;
  for (const t of bookClosed(trades, book)) { const e = t.exit?.ts || 0; if (e > m) m = e; }
  return m;
}
function nextId(book, date, trades) {
  const prefix = `AP-${book[0]}-${date.replace(/-/g, "")}-`;
  const n = trades.filter(t => t.id?.startsWith(prefix)).length + 1;
  return prefix + String(n).padStart(3, "0");
}

// Look up an option's live LTP for a given strike from the oiRunner byStrike map.
function optLtp(byStrike, strike, optType) {
  if (!byStrike) return null;
  const cell = byStrike[strike] ?? byStrike[String(strike)];
  const leg = optType === "CE" ? cell?.ce : cell?.pe;
  const v = leg?.ltp;
  return (v != null && Number.isFinite(v) && v > 0) ? v : null;
}

// FOLLOW trades with the signal; FADE trades against it.
function optTypeFor(book, sigDir) {
  if (book === "FOLLOW") return sigDir === "BULL" ? "CE" : "PE";
  return sigDir === "BULL" ? "PE" : "CE"; // FADE
}

// ---------------- signal confirmation (in-memory, per process) ----------------
// Tracks consecutive strong OI ticks in the same direction.
// Entry requires ALL of:
//   1. N consecutive strong ticks in the same direction (confirmTicks, default 3)
//   2. OI strength score ≥ 60% (the signal is actually building, not just flickering)
//   3. |net| must be INCREASING or stable across the confirmation window (trend strengthening)

let confirm = { dir: null, count: 0, nets: [] };
function confirmedDir(cfg) {
  if (confirm.count < cfg.confirmTicks) return null;

  // Gate: strength must be building — last |net| ≥ first |net| in the window
  const nets = confirm.nets.slice(-(cfg.confirmTicks || 3));
  if (nets.length >= 2) {
    const first = Math.abs(nets[0]);
    const last  = Math.abs(nets[nets.length - 1]);
    if (last < first * 0.9) return null; // signal weakening → don't enter
  }
  return confirm.dir;
}

// ---------------- core: entry / monitor / close ----------------

function tryOpen(state, book, sigDir, bias, net, tick) {
  const cfg = state.config;
  if (bookOpen(state.trades, book)) return;

  const today = istDateKey();
  const todays = state.trades.filter(t => t.book === book && t.date === today).length;
  // maxTradesPerDay <= 0 means no daily cap — capital (below) is the only stop.
  if (cfg.maxTradesPerDay > 0 && todays >= cfg.maxTradesPerDay) return;
  if (tick.ts - lastExitTs(state.trades, book) < cfg.reentryCooldownSec * 1000) return;

  const optType = optTypeFor(book, sigDir);
  const ltp = optLtp(tick.byStrike, tick.atm, optType);
  if (ltp == null) return;

  // Premium range filter — skip too-cheap or too-expensive strikes
  if (ltp < (cfg.premiumMin || 0) || ltp > (cfg.premiumMax || Infinity)) return;

  const lotSize = LOT_SIZE[cfg.symbol] || 75;
  const qty = lotSize * cfg.lots;
  const entryPremium = round2(ltp * (1 + cfg.slippagePct / 100));
  const premiumCost = entryPremium * qty;
  const cap = bookCapital(state.trades, book, cfg.initialCapital);
  if (premiumCost > cap) return; // can't afford one lot — skip

  // Fixed ₹ target / stop instead of percentage
  const targetMove = round2((cfg.targetAmt || 700) / qty);  // premium change needed for target
  const stopMove   = round2((cfg.stopAmt   || 700) / qty);  // premium change for stop

  const entryCosts = computeLegCosts(entryPremium, qty, "BUY").total;
  state.trades.push({
    id: nextId(book, today, state.trades),
    book, date: today, status: "OPEN",
    symbol: cfg.symbol, atmStrike: tick.atm, optType,
    sigDir, signalBias: bias, signalNet: net,
    lots: cfg.lots, lotSize,
    entry: {
      ts: tick.ts, tsIST: tick.tsIST, spot: round2(tick.spot),
      premium: entryPremium, ltpRaw: round2(ltp),
      targetPremium: round2(entryPremium + targetMove),
      stopPremium:   round2(entryPremium - stopMove),
      targetAmt: cfg.targetAmt || 700,
      stopAmt:   cfg.stopAmt   || 700,
      costs: entryCosts,
    },
    mark: { ts: tick.ts, tsIST: tick.tsIST, premium: round2(ltp), spot: round2(tick.spot), mtmNet: round2(-entryCosts) },
    exit: null,
    grossPnl: 0, costs: entryCosts, netPnl: -entryCosts, capitalAfter: null,
  });
}

// Refresh an open trade's live mark-to-market (premium / MTM) from the latest
// LTP. Pure display update — no exit logic. Returns { curLtp, exitPrem } (or
// null when no fresh LTP) so callers that also run exits can reuse the values.
function markOpen(open, cfg, tick) {
  const curLtp = optLtp(tick.byStrike, open.atmStrike, open.optType);
  if (curLtp == null) return null;
  const qty = open.lotSize * open.lots;
  const exitPrem = round2(curLtp * (1 - cfg.slippagePct / 100));
  const gross = (exitPrem - open.entry.premium) * qty;
  const exitCost = computeLegCosts(exitPrem, qty, "SELL").total;
  open.mark = {
    ts: tick.ts, tsIST: tick.tsIST, premium: round2(curLtp), exitPrem,
    spot: round2(tick.spot), mtmNet: round2(gross - open.entry.costs - exitCost),
  };
  return { curLtp, exitPrem };
}

// Price- and time-based exits only. These must fire promptly (on every 1s
// LTP refresh) so a trade squares off the moment it crosses its ±₹ target/stop
// or the square-off / market-close time — otherwise loss/profit can overshoot
// the configured caps while waiting for the slow 30s tick.
function priceTimeExitReason(cfg, open, exitPrem) {
  const ms = getMarketStatus();
  if (exitPrem != null && exitPrem >= open.entry.targetPremium) return "TARGET";
  if (exitPrem != null && exitPrem <= open.entry.stopPremium)   return "STOP";
  if (pastSquareOff(cfg))                                       return "SQUAREOFF";
  if (!ms.trading && ms.status !== "closed_premarket")          return "MARKET_CLOSE";
  return null;
}

function tryMonitor(state, book, tick) {
  const open = bookOpen(state.trades, book);
  if (!open) return;
  const cfg = state.config;
  const m = markOpen(open, cfg, tick);
  const curLtp = m?.curLtp ?? null;
  const exitPrem = m?.exitPrem ?? null;

  // Signal-based REVERSAL is evaluated only here (slow 30s tick) because the
  // confirmation tracker only changes on the bias cadence; price/time exits are
  // shared with the fast path.
  const confDir = confirmedDir(cfg);
  let reason = priceTimeExitReason(cfg, open, exitPrem);
  if (!reason && confDir && confDir !== open.sigDir) reason = "REVERSAL";
  if (!reason) return;

  closeBookTrade(state, open, reason, curLtp, tick);
}

function closeBookTrade(state, open, reason, curLtp, tick) {
  const cfg = state.config;
  const qty = open.lotSize * open.lots;
  const have = curLtp != null && Number.isFinite(curLtp) && curLtp > 0;
  const ltp = have ? curLtp : open.entry.ltpRaw; // stale fallback (no fresh LTP)
  const exitPremium = round2(ltp * (1 - cfg.slippagePct / 100));
  const gross = round2((exitPremium - open.entry.premium) * qty);
  const exitCosts = computeLegCosts(exitPremium, qty, "SELL").total;
  const totalCosts = round2(open.entry.costs + exitCosts);
  const net = round2(gross - totalCosts);

  open.status = "CLOSED";
  open.exit = {
    ts: tick.ts, tsIST: tick.tsIST, spot: round2(tick.spot),
    premium: exitPremium, ltpRaw: round2(ltp), reason, stale: !have,
  };
  open.grossPnl = gross;
  open.costs = totalCosts;
  open.netPnl = net;
  // bookCapital sums CLOSED netPnl, which now includes this trade.
  open.capitalAfter = bookCapital(state.trades, open.book, cfg.initialCapital);
}

// ---------------- public: fast LTP-only refresh (display only) ----------------

/**
 * The option legs currently open across both books, so the caller (oiRunner)
 * knows which quote tokens to fetch on the fast 1s tick. Returns [] when flat.
 * @returns {Array<{strike:number, optType:string}>}
 */
export function openTradeLegs() {
  const state = loadState();
  const legs = [];
  for (const book of BOOKS) {
    const open = bookOpen(state.trades, book);
    if (open) legs.push({ strike: open.atmStrike, optType: open.optType });
  }
  return legs;
}

/**
 * Refresh the live premium / MTM on open trades from fresh LTPs so the UI
 * updates every second, AND fire the price/time exits (TARGET / STOP /
 * SQUAREOFF / MARKET_CLOSE) immediately when crossed — so a position squares
 * off within ~1s instead of overshooting its ±₹ caps while waiting for the 30s
 * tick. Signal-based REVERSAL and new entries stay on the slower onOiTick
 * cadence. Self-guarded; never throws.
 *
 * @param {object} tick  ts(ms), tsIST(string), spot, byStrike
 */
export function refreshOpenMarks(tick) {
  try {
    const state = loadState();
    const cfg = state.config;
    let touched = false;
    for (const book of BOOKS) {
      const open = bookOpen(state.trades, book);
      if (!open) continue;
      const m = markOpen(open, cfg, tick);
      const reason = priceTimeExitReason(cfg, open, m?.exitPrem ?? null);
      if (reason) closeBookTrade(state, open, reason, m?.curLtp ?? null, tick);
      touched = true;
    }
    if (touched) saveState(state); // skip pointless writes when both books are flat
  } catch {
    // Never let a paper-trade bug disturb the OI poll loop.
  }
}

// ---------------- public: called every OI poll from oiRunner ----------------

/**
 * @param {object} tick
 *   ts(ms), tsIST(string), day, spot, atm, bias(string|null), net(number|null),
 *   strength, byStrike (oiRunner per-strike {ce:{ltp},pe:{ltp}} map)
 */
export function onOiTick(tick) {
  try {
    const state = loadState();
    const cfg = state.config;

    // 1) update the signal-confirmation tracker
    //    Only "Strong" signals qualify, AND strength must be ≥ 60%
    const strong = (tick.bias === "Strong Bullish" || tick.bias === "Strong Bearish"
      || (Number.isFinite(tick.net) && Math.abs(tick.net) >= cfg.strongNet))
      && (tick.strength == null || tick.strength >= 60);
    const sigDir = Number.isFinite(tick.net) ? (tick.net > 0 ? "BULL" : "BEAR") : null;
    if (strong && sigDir) {
      if (confirm.dir === sigDir) {
        confirm.count++;
        confirm.nets.push(tick.net);
      } else {
        confirm = { dir: sigDir, count: 1, nets: [tick.net] };
      }
    } else {
      confirm = { dir: null, count: 0, nets: [] };
    }

    // 2) monitor open trades first (an exit frees the slot this same tick)
    for (const book of BOOKS) tryMonitor(state, book, tick);

    // 3) attempt entries when a strong signal is confirmed and we're in-window
    const entryDir = confirmedDir(cfg);
    const ms = getMarketStatus();
    if (entryDir && ms.trading && inEntryWindow(cfg)) {
      for (const book of BOOKS) tryOpen(state, book, entryDir, tick.bias, tick.net, tick);
    }

    saveState(state);
  } catch {
    // Never let a paper-trade bug disturb the OI poll loop.
  }
}

// ---------------- public: read / config / export ----------------

export function getAutoPaperState() {
  const state = loadState();
  const cfg = state.config;
  const today = istDateKey();
  const books = {};
  for (const book of BOOKS) {
    const closed = bookClosed(state.trades, book);
    const todays = closed.filter(t => t.date === today);
    const wins = closed.filter(t => (t.netPnl || 0) > 0).length;
    const losses = closed.filter(t => (t.netPnl || 0) <= 0).length;
    books[book] = {
      currentCapital: bookCapital(state.trades, book, cfg.initialCapital),
      realizedPnl: round2(closed.reduce((a, t) => a + (t.netPnl || 0), 0)),
      todayPnl: round2(todays.reduce((a, t) => a + (t.netPnl || 0), 0)),
      todayTrades: todays.length,
      totalTrades: closed.length,
      wins, losses,
      winRate: closed.length ? Math.round((100 * wins) / closed.length) : null,
      openTrade: bookOpen(state.trades, book),
      history: closed.slice().reverse().slice(0, 200), // newest first
    };
  }
  return {
    config: cfg,
    confirm: { dir: confirm.dir, count: confirm.count, required: cfg.confirmTicks },
    market: getMarketStatus(),
    books,
  };
}

function sanitizeConfig(p = {}) {
  const out = {};
  const num = (k, min) => {
    if (p[k] != null && Number.isFinite(Number(p[k]))) out[k] = Math.max(min, Number(p[k]));
  };
  num("initialCapital", 1000); num("lots", 1); num("slippagePct", 0); num("strongNet", 0);
  num("confirmTicks", 1); num("targetAmt", 100); num("stopAmt", 100);
  num("premiumMin", 0); num("premiumMax", 1);
  num("maxTradesPerDay", 0); num("reentryCooldownSec", 0);
  for (const k of ["entryStart", "entryEnd", "squareOff"]) {
    if (typeof p[k] === "string" && /^\d{1,2}:\d{2}$/.test(p[k])) out[k] = p[k];
  }
  if (typeof p.symbol === "string") out.symbol = p.symbol.toUpperCase();
  return out;
}

export function updateAutoConfig(patch) {
  const state = loadState();
  state.config = { ...state.config, ...sanitizeConfig(patch) };
  saveState(state);
  return state.config;
}

export function resetAuto() {
  const state = loadState();
  if (state.trades.length) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    atomicWrite(path.join(PAPER_DIR, `auto_state.archive.${stamp}.json`), JSON.stringify(state, null, 2));
  }
  state.trades = [];
  saveState(state);
  confirm = { dir: null, count: 0, nets: [] };
  return { ok: true };
}

function csvCell(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function exportAutoCsv() {
  const { trades } = loadState();
  const header = [
    "id", "book", "date", "sigDir", "signalBias", "signalNet", "optType", "atmStrike",
    "lots", "lotSize", "entryTsIST", "entrySpot", "entryPremium", "targetPremium", "stopPremium",
    "exitTsIST", "exitSpot", "exitPremium", "exitReason", "grossPnl", "costs", "netPnl", "capitalAfter",
  ];
  const lines = [header.join(",")];
  for (const t of trades.filter(t => t.status === "CLOSED")) {
    lines.push([
      t.id, t.book, t.date, t.sigDir, t.signalBias, t.signalNet, t.optType, t.atmStrike,
      t.lots, t.lotSize, t.entry?.tsIST, t.entry?.spot, t.entry?.premium, t.entry?.targetPremium, t.entry?.stopPremium,
      t.exit?.tsIST, t.exit?.spot, t.exit?.premium, t.exit?.reason, t.grossPnl, t.costs, t.netPnl, t.capitalAfter,
    ].map(csvCell).join(","));
  }
  return lines.join("\n");
}
