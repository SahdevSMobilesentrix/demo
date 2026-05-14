// signalEngine.js — main evaluate(). Returns a Signal object or null.

import {
  STRIKE_STEP,
  atmStrike,
  inSignalWindow,
} from "./utils.js";
import {
  REL_OI_THRESHOLD,
  VOL_OI_THRESHOLD,
  computeStrikeFeatures,
  cumOiDeltaSeries,
  cumTrend,
  heaviestWriteStrike,
  maxPain,
} from "./features.js";
import { loadToday, groupSnapshots } from "./snapshotReader.js";
import { loadBaseline } from "./historyManager.js";

export const ATM_BAND_SIGNAL = 5;
export const MAX_VIX_CHANGE_PCT = 4.0;

function vixIntradayChangePct(snaps) {
  if (!snaps.length) return 0;
  const first = snaps[0].rows[0]?.vix ?? 0;
  const last = snaps[snaps.length - 1].rows[0]?.vix ?? 0;
  if (first <= 0) return 0;
  return ((last - first) / first) * 100;
}

function scan(features, side, trend) {
  if (!features.length) return null;
  const expected = side === "BULL" ? "bullish" : "bearish";
  let best = null;
  for (const f of features) {
    const c1 = f.rel_oi_delta >= REL_OI_THRESHOLD;
    const c2 = f.vol_oi_ratio < VOL_OI_THRESHOLD;
    const c3 = !!f.is_writing;
    const c4 = trend === expected;
    const score = (c1 ? 1 : 0) + (c2 ? 1 : 0) + (c3 ? 1 : 0) + (c4 ? 1 : 0);
    if (score < 3) continue;
    const breakdown = {
      relOIdelta_ge_1_6: c1,
      vol_oi_lt_0_6: c2,
      is_writing: c3,
      cum_trend_aligned: c4,
    };
    const cand = { side, score, row: f, breakdown };
    if (!best
        || cand.score > best.score
        || (cand.score === best.score && cand.row.abs_oi_delta > best.row.abs_oi_delta)) {
      best = cand;
    }
  }
  return best;
}

/**
 * Main evaluation. Either pass `snaps` directly, or rely on dataRoot+symbol to load today.
 *
 * @param {object} args
 * @param {string} args.symbol
 * @param {Array}  [args.snaps]      already grouped snapshots
 * @param {Array}  [args.baseline]   baseline rows
 * @param {string} [args.dataRoot]   if snaps not provided, loads from disk
 * @param {boolean}[args.skipDay]    event-calendar gate
 * @param {Date}   [args.now]        override "now" for the time gate
 */
export function evaluate({ symbol, snaps, baseline, dataRoot, skipDay = false, now }) {
  const sym = symbol.toUpperCase();

  if (!snaps) {
    if (!dataRoot) return { signal: null, reason: "no_data_root" };
    const rows = loadToday(dataRoot, sym, now);
    if (!rows.length) return { signal: null, reason: "no_snapshot_on_disk" };
    snaps = groupSnapshots(rows);
  }
  if (snaps.length < 2) return { signal: null, reason: "need_at_least_2_snapshots" };

  if (!baseline) baseline = dataRoot ? loadBaseline(dataRoot, sym) : [];

  const lastSnap = snaps[snaps.length - 1];
  const snapTs = lastSnap.ts;
  const evalNow = now || new Date(snapTs);

  // ---- gates ----
  if (skipDay) return { signal: null, reason: "skip_day" };
  if (!inSignalWindow(evalNow)) return { signal: null, reason: "outside_window" };
  const vixChange = vixIntradayChangePct(snaps);
  if (Math.abs(vixChange) >= MAX_VIX_CHANGE_PCT) {
    return { signal: null, reason: `vix_change_${vixChange.toFixed(2)}` };
  }

  // ---- features ----
  let feats = computeStrikeFeatures(snaps, baseline, sym);
  if (!feats.length) return { signal: null, reason: "no_features" };

  const spot = feats[0].spot;
  const vix = feats[0].vix;
  const expiry = feats[0].expiry;
  const atm = atmStrike(spot, sym);
  const step = STRIKE_STEP[sym];

  feats = feats.filter(f => Math.abs(f.offset) <= ATM_BAND_SIGNAL);
  if (!feats.length) return { signal: null, reason: "no_features_in_band" };

  const cumSeries = cumOiDeltaSeries(snaps, sym);
  const trend = cumTrend(cumSeries);
  const mp = maxPain(lastSnap.rows);

  const bull = scan(
    feats.filter(f => f.opt_type === "PE" && f.strike <= spot),
    "BULL", trend
  );
  const bear = scan(
    feats.filter(f => f.opt_type === "CE" && f.strike >= spot),
    "BEAR", trend
  );

  const candidates = [bull, bear].filter(Boolean);
  if (!candidates.length) return { signal: null, reason: "no_trigger" };

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.row.abs_oi_delta - a.row.abs_oi_delta;
  });
  const chosen = candidates[0];

  const invalidation = heaviestWriteStrike(feats, chosen.side) || chosen.row.strike;
  const targetPct = chosen.side === "BULL" ? 0.006 : -0.006;
  const legs = chosen.side === "BULL"
    ? [
        { opt_type: "CE", strike: atm,              action: "BUY"  },
        { opt_type: "CE", strike: atm + 2 * step,   action: "SELL" },
      ]
    : [
        { opt_type: "PE", strike: atm,              action: "BUY"  },
        { opt_type: "PE", strike: atm - 2 * step,   action: "SELL" },
      ];

  const notes = [];
  if (!baseline || baseline.length === 0) {
    notes.push("baseline_empty_using_in_session_fallback");
  } else if ((chosen.row.baseline_n || 0) < 5) {
    notes.push(`thin_baseline_n=${chosen.row.baseline_n}`);
  }

  return {
    signal: {
      ts: snapTs,
      symbol: sym,
      side: chosen.side,
      score: chosen.score,
      score_breakdown: chosen.breakdown,
      trigger_strike: Math.round(chosen.row.strike),
      atm: Math.round(atm),
      spot: Number(spot),
      vix: Number(vix),
      invalidation_strike: Math.round(invalidation),
      target_pct: targetPct,
      legs,
      expiry,
      max_pain: mp != null ? Math.round(mp) : null,
      cum_trend: trend,
      notes,
    },
  };
}
