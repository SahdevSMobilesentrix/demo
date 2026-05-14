// signalRunner.js — pure-Node scheduler + cache for the signal engine.
// No Python, no child_process. The engine lives entirely in JS now.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate } from "./signal/node-engine/signalEngine.js";
import { buildBaseline, refreshAtEod } from "./signal/node-engine/historyManager.js";
import { onEnginePayload, monitorOpenTrade } from "./paper/paperTrader.js";
import { inSignalWindow as marketInSignalWindow, marketStatus as getMarketStatus } from "./marketClock.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

const DATA_ROOT = process.env.FNO_DATA_ROOT
  || path.join(PROJECT_ROOT, "data", "fno");
const TICK_INTERVAL_MS = 5 * 60 * 1000;
const MAX_HISTORY = 50;

let state = {
  autoRun: false,
  status: "idle",
  lastRunAt: null,
  lastError: null,
  latest: null,
  history: [],
  timer: null,
};

function istNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
}

// Delegate to marketClock — weekends + holidays + 09:45-14:00 IST gate.
function inMarketHours() {
  return marketInSignalWindow();
}

export async function runOnce({ symbol = "NIFTY", skipDay = false } = {}) {
  state.status = "running";
  try {
    const result = evaluate({ symbol, dataRoot: DATA_ROOT, skipDay });
    const payload = {
      status: "ok",
      symbol,
      ts: new Date().toISOString(),
      signal: result.signal || null,
      reason: result.signal ? undefined : result.reason,
    };
    state.lastRunAt = Date.now();
    state.lastError = null;
    state.latest = payload;
    if (payload.signal) {
      state.history.unshift({
        receivedAt: state.lastRunAt,
        symbol: payload.symbol,
        ...payload.signal,
      });
      if (state.history.length > MAX_HISTORY) state.history.length = MAX_HISTORY;
    }

    // Paper trader: monitor any open trade, then react to BULL signal (if any)
    try {
      onEnginePayload(payload);
    } catch (e) {
      // Never let a paper-trader bug kill the signal pipeline
      state.lastError = `paper: ${e.message}`;
    }

    state.status = "idle";
    return { ok: true, payload };
  } catch (err) {
    state.status = "error";
    state.lastError = err.message;
    state.lastRunAt = Date.now();
    return { ok: false, error: err.message };
  }
}

export function startAutoRun({ symbol = "NIFTY" } = {}) {
  if (state.timer) return { ok: true, message: "already running" };
  state.autoRun = true;
  const tick = async () => {
    if (!state.autoRun) return;
    if (inMarketHours()) await runOnce({ symbol });
  };
  state.timer = setInterval(tick, TICK_INTERVAL_MS);
  tick();
  return { ok: true };
}

export function stopAutoRun() {
  state.autoRun = false;
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
  return { ok: true };
}

export function getSignalState() {
  return {
    autoRun: state.autoRun,
    status: state.status,
    lastRunAt: state.lastRunAt,
    lastError: state.lastError,
    inMarketHours: inMarketHours(),
    market: getMarketStatus(),
    latest: state.latest,
    history: state.history,
  };
}

// Admin helpers (callable from server if needed)
export function buildBaselineNow({ symbol = "NIFTY", days = 20 } = {}) {
  const rows = buildBaseline(DATA_ROOT, symbol, days);
  return { ok: true, baseline_rows: rows.length };
}

export function refreshBaselineEod({ symbol = "NIFTY" } = {}) {
  const rows = refreshAtEod(DATA_ROOT, symbol);
  return { ok: true, baseline_rows: rows.length };
}
