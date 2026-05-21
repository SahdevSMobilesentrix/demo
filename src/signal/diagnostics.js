// diagnostics.js — OBSERVE-ONLY analysis of every engine evaluation.
//
// This file does NOT change the strategy. It re-walks the same feature pipeline
// the engine uses (computeStrikeFeatures + cumTrend) and records, for every
// evaluation tick, the top near-miss strike on each side (BULL/BEAR) with all
// four per-strike gates' actual values. Output goes to a daily CSV the user
// can download for offline analysis.
//
// The engine in signalEngine.js is the sole source of trade decisions.

import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import {
  REL_OI_THRESHOLD,
  VOL_OI_THRESHOLD,
  computeStrikeFeatures,
  cumOiDeltaSeries,
  cumTrend,
} from "./node-engine/features.js";
import { loadToday, groupSnapshots } from "./node-engine/snapshotReader.js";
import { ATM_BAND_SIGNAL } from "./node-engine/signalEngine.js";

const log = pino({ level: process.env.LOG_LEVEL || "info", name: "diagnostics" });

const DIAG_ROOT = process.env.FNO_DIAG_ROOT
  || path.join(process.env.FNO_DATA_ROOT || path.join(process.cwd(), "data", "fno"), "diagnostics");

fs.mkdirSync(DIAG_ROOT, { recursive: true });

const COLUMNS = [
  "ts_iso", "symbol", "reason", "fired", "fired_side",
  "spot", "vix", "vix_change_pct", "cum_trend", "atm",
  "bull_strike", "bull_score", "bull_rel_oi_delta", "bull_vol_oi_ratio",
  "bull_is_writing", "bull_trend_ok",
  "bear_strike", "bear_score", "bear_rel_oi_delta", "bear_vol_oi_ratio",
  "bear_is_writing", "bear_trend_ok",
];

function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

export function csvFileFor(symbol, date = new Date()) {
  return path.join(DIAG_ROOT, `${symbol.toUpperCase()}_${dayKey(date)}.csv`);
}

function fmt(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number") return Number.isFinite(v) ? String(Math.round(v * 10000) / 10000) : "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function appendRow(file, row) {
  const fresh = !fs.existsSync(file);
  const line = COLUMNS.map(c => fmt(row[c])).join(",") + "\n";
  if (fresh) fs.writeFileSync(file, COLUMNS.join(",") + "\n");
  fs.appendFileSync(file, line);
}

/**
 * Top near-miss on a side: same scoring rule as signalEngine.scan(),
 * but we keep the top candidate regardless of score (1, 2, 3, or 4).
 * If no features on this side, returns null.
 */
function topNearMiss(features, side, trend) {
  if (!features.length) return null;
  const expected = side === "BULL" ? "bullish" : "bearish";
  let best = null;
  for (const f of features) {
    const c1 = f.rel_oi_delta >= REL_OI_THRESHOLD;
    const c2 = f.vol_oi_ratio < VOL_OI_THRESHOLD;
    const c3 = !!f.is_writing;
    const c4 = trend === expected;
    const score = (c1 ? 1 : 0) + (c2 ? 1 : 0) + (c3 ? 1 : 0) + (c4 ? 1 : 0);
    const cand = {
      side,
      score,
      strike: f.strike,
      rel_oi_delta: f.rel_oi_delta,
      vol_oi_ratio: f.vol_oi_ratio,
      is_writing: c3,
      trend_ok: c4,
      abs_oi_delta: f.abs_oi_delta,
    };
    if (!best
        || cand.score > best.score
        || (cand.score === best.score && Math.abs(cand.abs_oi_delta) > Math.abs(best.abs_oi_delta))) {
      best = cand;
    }
  }
  return best;
}

function vixIntradayChangePct(snaps) {
  if (!snaps.length) return 0;
  const first = snaps[0].rows[0]?.vix ?? 0;
  const last  = snaps[snaps.length - 1].rows[0]?.vix ?? 0;
  if (first <= 0) return 0;
  return ((last - first) / first) * 100;
}

/**
 * Compute & write one diagnostics row for the current evaluation tick.
 * `payload` is the runOnce() payload (already contains fired side + reason).
 * Safe to call regardless of whether a signal fired.
 */
export function writeDiagnosticsRow({ symbol, dataRoot, payload, now = new Date() }) {
  const sym = symbol.toUpperCase();
  const baseRow = {
    ts_iso: new Date(now).toISOString(),
    symbol: sym,
    reason: payload?.signal ? "fired" : (payload?.reason || ""),
    fired: !!payload?.signal,
    fired_side: payload?.signal?.side || "",
    spot: payload?.signal?.spot ?? null,
    vix: payload?.signal?.vix ?? null,
    vix_change_pct: null,
    cum_trend: payload?.signal?.cum_trend ?? "",
    atm: payload?.signal?.atm ?? null,
  };

  try {
    const rows = loadToday(dataRoot, sym, now);
    if (rows.length) {
      const snaps = groupSnapshots(rows);
      baseRow.vix_change_pct = vixIntradayChangePct(snaps);

      if (snaps.length >= 2) {
        // NOTE: passing baseline=[] gives an in-session-fallback denom; that's
        // identical to what the engine does when baseline is empty — and the
        // engine itself loads baseline only when dataRoot is supplied, so
        // this matches at least for the no-baseline path. For full parity we
        // could load baseline here too — keeping it simple and observe-only.
        let feats = computeStrikeFeatures(snaps, [], sym);
        if (feats.length) {
          const spot = feats[0].spot;
          baseRow.spot = baseRow.spot ?? spot;
          feats = feats.filter(f => Math.abs(f.offset) <= ATM_BAND_SIGNAL);
          const trend = cumTrend(cumOiDeltaSeries(snaps, sym));
          if (!baseRow.cum_trend) baseRow.cum_trend = trend;

          const bull = topNearMiss(
            feats.filter(f => f.opt_type === "PE" && f.strike <= spot),
            "BULL", trend,
          );
          const bear = topNearMiss(
            feats.filter(f => f.opt_type === "CE" && f.strike >= spot),
            "BEAR", trend,
          );

          if (bull) {
            baseRow.bull_strike        = bull.strike;
            baseRow.bull_score         = bull.score;
            baseRow.bull_rel_oi_delta  = bull.rel_oi_delta;
            baseRow.bull_vol_oi_ratio  = bull.vol_oi_ratio;
            baseRow.bull_is_writing    = bull.is_writing;
            baseRow.bull_trend_ok      = bull.trend_ok;
          }
          if (bear) {
            baseRow.bear_strike        = bear.strike;
            baseRow.bear_score         = bear.score;
            baseRow.bear_rel_oi_delta  = bear.rel_oi_delta;
            baseRow.bear_vol_oi_ratio  = bear.vol_oi_ratio;
            baseRow.bear_is_writing    = bear.is_writing;
            baseRow.bear_trend_ok      = bear.trend_ok;
          }
        }
      }
    }
  } catch (e) {
    log.warn({ err: e.message }, "diagnostics analysis failed; writing partial row");
  }

  try {
    appendRow(csvFileFor(sym, now), baseRow);
  } catch (e) {
    log.warn({ err: e.message }, "diagnostics CSV write failed");
  }
}

/** List available daily CSVs for a symbol (newest first). */
export function listDiagnosticsDays(symbol) {
  const sym = symbol.toUpperCase();
  if (!fs.existsSync(DIAG_ROOT)) return [];
  const re = new RegExp(`^${sym}_(\\d{8})\\.csv$`);
  return fs.readdirSync(DIAG_ROOT)
    .map(f => { const m = f.match(re); return m ? m[1] : null; })
    .filter(Boolean)
    .sort()
    .reverse();
}

export const DIAGNOSTICS_PATHS = { DIAG_ROOT };
