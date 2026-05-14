// historyManager.js — build/load 20-day median |absOIdelta| baseline.
// Baseline stored as JSON.

import fs from "node:fs";
import path from "node:path";
import { STRIKE_STEP, atmStrike, timeBucket, median } from "./utils.js";
import { loadRecentDays, groupSnapshots } from "./snapshotReader.js";

export const BASELINE_WINDOW = 20;
const ATM_BAND_BASELINE = 6;

function baselinePath(dataRoot, symbol) {
  return path.join(dataRoot, "baseline", `${symbol.toUpperCase()}.json`);
}

export function loadBaseline(dataRoot, symbol) {
  const p = baselinePath(dataRoot, symbol);
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return [];
  }
}

export function writeBaseline(dataRoot, symbol, rows) {
  const p = baselinePath(dataRoot, symbol);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(rows));
  fs.renameSync(tmp, p);
  return p;
}

/**
 * Build baseline from existing on-disk snapshots.
 * Output rows: { bucket, offset, opt_type, median_absOIdelta, n_samples }
 */
export function buildBaseline(dataRoot, symbol, nDays = BASELINE_WINDOW, endDate) {
  const rows = loadRecentDays(dataRoot, symbol, nDays, endDate);
  if (!rows.length) {
    writeBaseline(dataRoot, symbol, []);
    return [];
  }
  const sym = symbol.toUpperCase();
  const step = STRIKE_STEP[sym];

  // Group by IST date AND ts so we compute within-day OI diffs per series.
  const byDate = new Map();   // dateKey -> array of rows
  for (const r of rows) {
    const dk = r.ts.slice(0, 10);   // "YYYY-MM-DD"
    if (!byDate.has(dk)) byDate.set(dk, []);
    byDate.get(dk).push(r);
  }

  // bucket|offset|opt_type -> [absOIdelta, ...]
  const acc = new Map();

  for (const [, dayRows] of byDate) {
    const snaps = groupSnapshots(dayRows);
    if (snaps.length < 2) continue;

    // Per snapshot ATM
    const atmByTs = new Map();
    for (const s of snaps) {
      const spot = s.rows[0]?.spot ?? 0;
      atmByTs.set(s.ts, atmStrike(spot, sym));
    }

    // For each (strike, opt_type), iterate snapshots in order to compute diffs.
    const seriesMap = new Map();   // (strike|type) -> ordered array of {ts, oi}
    for (const s of snaps) {
      for (const r of s.rows) {
        const k = `${r.strike}|${r.opt_type}`;
        if (!seriesMap.has(k)) seriesMap.set(k, []);
        seriesMap.get(k).push({ ts: s.ts, oi: r.oi });
      }
    }

    for (const [key, series] of seriesMap) {
      const [strikeStr, opt_type] = key.split("|");
      const strike = Number(strikeStr);
      for (let i = 1; i < series.length; i++) {
        const delta = series[i].oi - series[i - 1].oi;
        if (delta === 0) continue;
        const atm = atmByTs.get(series[i].ts);
        const offset = Math.round((strike - atm) / step);
        if (Math.abs(offset) > ATM_BAND_BASELINE) continue;
        const bucket = timeBucket(series[i].ts);
        const aggKey = `${bucket}|${offset}|${opt_type}`;
        if (!acc.has(aggKey)) acc.set(aggKey, []);
        acc.get(aggKey).push(Math.abs(delta));
      }
    }
  }

  const out = [];
  for (const [key, arr] of acc) {
    const [bucket, offsetStr, opt_type] = key.split("|");
    const med = median(arr);
    out.push({
      bucket,
      offset: Number(offsetStr),
      opt_type,
      median_absOIdelta: Math.max(med, 1.0),   // floor so rel_oi doesn't blow up
      n_samples: arr.length,
    });
  }

  writeBaseline(dataRoot, symbol, out);
  return out;
}

export function refreshAtEod(dataRoot, symbol) {
  return buildBaseline(dataRoot, symbol, BASELINE_WINDOW);
}
