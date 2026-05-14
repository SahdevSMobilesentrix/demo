// snapshotReader.js — load JSONL snapshots written by oiSnapshotWriter.js.
// Returns flat array of rows: { ts, symbol, expiry, strike, opt_type, oi, volume, ltp, spot, vix }

import fs from "node:fs";
import path from "node:path";
import { istDateKey } from "./utils.js";

function snapshotDir(dataRoot, symbol) {
  return path.join(dataRoot, "snapshots", symbol.toUpperCase());
}

export function dayPath(dataRoot, symbol, dateKey) {
  return path.join(snapshotDir(dataRoot, symbol), `${dateKey}.jsonl`);
}

export function loadDay(dataRoot, symbol, dateKey) {
  const file = dayPath(dataRoot, symbol, dateKey);
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8");
  const rows = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      // numeric coercion
      r.strike = Number(r.strike);
      r.oi = Number(r.oi) || 0;
      r.volume = Number(r.volume) || 0;
      r.ltp = Number(r.ltp) || 0;
      r.spot = Number(r.spot) || 0;
      r.vix = Number(r.vix) || 0;
      rows.push(r);
    } catch {
      // skip malformed line
    }
  }
  // de-dupe on (ts, strike, opt_type) — keep last
  const seen = new Map();
  for (const r of rows) {
    seen.set(`${r.ts}|${r.strike}|${r.opt_type}`, r);
  }
  return Array.from(seen.values());
}

export function loadToday(dataRoot, symbol, now) {
  return loadDay(dataRoot, symbol, istDateKey(now));
}

// Walk back over the last N days that exist on disk (skips weekends/holidays).
export function loadRecentDays(dataRoot, symbol, nDays, endDate) {
  const out = [];
  let d = endDate ? new Date(endDate) : new Date();
  let kept = 0;
  let scanned = 0;
  while (kept < nDays && scanned < nDays * 2 + 10) {
    const key = istDateKey(d);
    const rows = loadDay(dataRoot, symbol, key);
    if (rows.length) {
      out.push(...rows);
      kept++;
    }
    d.setDate(d.getDate() - 1);
    scanned++;
  }
  return out;
}

// Group rows into snapshots keyed by ts; returns ordered array of
// { ts, rows: [...] } sorted ascending.
export function groupSnapshots(rows) {
  const byTs = new Map();
  for (const r of rows) {
    if (!byTs.has(r.ts)) byTs.set(r.ts, []);
    byTs.get(r.ts).push(r);
  }
  const tsList = Array.from(byTs.keys()).sort();
  return tsList.map(ts => ({ ts, rows: byTs.get(ts) }));
}
