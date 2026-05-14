// features.js — per-strike features.

import { STRIKE_STEP, atmStrike, timeBucket, safeDiv, median } from "./utils.js";

export const VOL_OI_THRESHOLD = 0.6;
export const REL_OI_THRESHOLD = 1.6;
export const CUM_LOOKBACK = 5;
export const CUM_CONFIRM = 4;
export const ATM_BAND_CUM = 3;
export const LTP_LOOKBACK_SNAPS = 4;

/**
 * Compute per-strike features for the LATEST snapshot.
 *
 * @param {Array<{ts:string, rows:Array}>} snaps   today's snapshots, ascending
 * @param {Array<{bucket,offset,opt_type,median_absOIdelta,n_samples}>} baseline
 * @param {string} symbol
 * @returns Array of feature rows or [] if not enough data.
 */
export function computeStrikeFeatures(snaps, baseline, symbol) {
  if (!snaps || snaps.length < 2) return [];
  const sym = symbol.toUpperCase();
  const step = STRIKE_STEP[sym];

  const cur = snaps[snaps.length - 1];
  const prev = snaps[snaps.length - 2];

  const lookbackIdx = snaps.length - 1 - LTP_LOOKBACK_SNAPS;
  const lookback = lookbackIdx >= 0 ? snaps[lookbackIdx] : prev;

  const spot = cur.rows[0]?.spot ?? 0;
  const atm = atmStrike(spot, sym);
  const bucket = timeBucket(cur.ts);

  // index prev + lookback by (strike, opt_type)
  const prevMap = new Map();
  for (const r of prev.rows) prevMap.set(`${r.strike}|${r.opt_type}`, r);
  const lkMap = new Map();
  for (const r of lookback.rows) lkMap.set(`${r.strike}|${r.opt_type}`, r);

  // baseline index: bucket -> (offset, opt_type) -> { median_absOIdelta, n_samples }
  const baseMap = new Map();
  if (baseline) {
    for (const b of baseline) {
      if (b.bucket !== bucket) continue;
      baseMap.set(`${b.offset}|${b.opt_type}`, b);
    }
  }

  // First pass: compute abs_oi_delta to derive in-session fallback median
  const enriched = [];
  for (const r of cur.rows) {
    const offset = Math.round((r.strike - atm) / step);
    const p = prevMap.get(`${r.strike}|${r.opt_type}`);
    const lk = lkMap.get(`${r.strike}|${r.opt_type}`);
    const oiPrev = p ? p.oi : r.oi;
    const ltpPrev = p ? p.ltp : r.ltp;
    const ltpLookback = lk ? lk.ltp : ltpPrev;
    enriched.push({
      ...r,
      offset,
      bucket,
      oi_prev: oiPrev,
      ltp_prev: ltpPrev,
      ltp_lookback: ltpLookback,
      abs_oi_delta: r.oi - oiPrev,
      ltp_delta_20m: r.ltp - ltpLookback,
    });
  }

  const fallbackDenom = (() => {
    const abs = enriched.map(e => Math.abs(e.abs_oi_delta)).filter(v => v > 0);
    const m = median(abs);
    return m > 0 ? m : 1.0;
  })();

  // Second pass: rel_oi_delta, vol_oi_ratio, is_writing
  for (const e of enriched) {
    const b = baseMap.get(`${e.offset}|${e.opt_type}`);
    const baselineN = b ? Number(b.n_samples || 0) : 0;
    let denom = b ? Number(b.median_absOIdelta) : 0;
    if (!denom || !Number.isFinite(denom)) denom = fallbackDenom;
    e.median_absOIdelta = b ? Number(b.median_absOIdelta) : null;
    e.baseline_n = baselineN;
    e.rel_oi_delta = safeDiv(e.abs_oi_delta, denom, 0);
    e.vol_oi_ratio = safeDiv(e.volume, e.oi, 0);
    e.is_writing =
      e.abs_oi_delta > 0 &&
      e.ltp_delta_20m <= 0 &&
      e.vol_oi_ratio < VOL_OI_THRESHOLD;
  }

  return enriched;
}

/**
 * Series of snapshot-over-snapshot changes in (sum CE_OI - sum PE_OI) across ATM±3.
 * Returns the last `lookback` diffs.
 */
export function cumOiDeltaSeries(snaps, symbol, lookback = CUM_LOOKBACK) {
  if (!snaps || snaps.length < 2) return [];
  const step = STRIKE_STEP[symbol.toUpperCase()];
  const perSnap = [];
  for (const s of snaps) {
    const spot = s.rows[0]?.spot ?? 0;
    const atm = atmStrike(spot, symbol);
    const lo = atm - ATM_BAND_CUM * step;
    const hi = atm + ATM_BAND_CUM * step;
    let ce = 0, pe = 0;
    for (const r of s.rows) {
      if (r.strike < lo || r.strike > hi) continue;
      if (r.opt_type === "CE") ce += r.oi;
      else if (r.opt_type === "PE") pe += r.oi;
    }
    perSnap.push(ce - pe);
  }
  const diffs = [];
  for (let i = 1; i < perSnap.length; i++) diffs.push(perSnap[i] - perSnap[i - 1]);
  return diffs.slice(-lookback);
}

export function cumTrend(diffs) {
  if (!diffs || diffs.length < CUM_LOOKBACK) return "mixed";
  let neg = 0, pos = 0;
  for (const x of diffs) {
    if (x < 0) neg++;
    else if (x > 0) pos++;
  }
  if (neg >= CUM_CONFIRM) return "bullish";   // PE writing dominates
  if (pos >= CUM_CONFIRM) return "bearish";   // CE writing dominates
  return "mixed";
}

/**
 * Strike that minimizes total writer payout at the given snapshot rows.
 * For each candidate K:
 *   payout = sum_CE( max(strike - K, 0) * oi ) + sum_PE( max(K - strike, 0) * oi )
 */
export function maxPain(rows) {
  if (!rows || rows.length === 0) return null;
  const strikes = Array.from(new Set(rows.map(r => r.strike))).sort((a, b) => a - b);
  const ce = rows.filter(r => r.opt_type === "CE");
  const pe = rows.filter(r => r.opt_type === "PE");
  let bestK = null, bestPain = Infinity;
  for (const K of strikes) {
    let pain = 0;
    for (const r of ce) pain += Math.max(r.strike - K, 0) * r.oi;
    for (const r of pe) pain += Math.max(K - r.strike, 0) * r.oi;
    if (pain < bestPain) { bestPain = pain; bestK = K; }
  }
  return bestK;
}

/**
 * For BULL: heaviest PE write strike at/below spot among is_writing rows.
 * For BEAR: heaviest CE write strike at/above spot.
 */
export function heaviestWriteStrike(features, side) {
  if (!features || features.length === 0) return null;
  const spot = features[0].spot;
  let pool;
  if (side === "BULL") {
    pool = features.filter(f => f.opt_type === "PE" && f.strike <= spot && f.is_writing);
  } else {
    pool = features.filter(f => f.opt_type === "CE" && f.strike >= spot && f.is_writing);
  }
  if (pool.length === 0) return null;
  let best = pool[0];
  for (const f of pool) if (f.abs_oi_delta > best.abs_oi_delta) best = f;
  return best.strike;
}
