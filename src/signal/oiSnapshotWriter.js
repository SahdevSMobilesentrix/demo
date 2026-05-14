// Bridge: writes each OI tick from oiRunner into a canonical JSONL file
// that the Python signal engine consumes via --no-fetch mode.
//
// Schema (one JSON object per line):
//   { ts, symbol, expiry, strike, opt_type, oi, volume, ltp, spot, vix }
//
// File path: ${FNO_DATA_ROOT}/snapshots/{SYMBOL}/{YYYYMMDD}.jsonl
// Appends only. Safe to call on every poll.

import fs from "node:fs";
import path from "node:path";

const DATA_ROOT = process.env.FNO_DATA_ROOT
  || path.join(process.cwd(), "data", "fno");

function parseExpiryToISO(s) {
  // "15MAY25" -> "2025-05-15"
  const m = String(s || "").match(/^(\d{2})([A-Z]{3})(\d{2})$/);
  if (!m) return null;
  const months = { JAN:"01",FEB:"02",MAR:"03",APR:"04",MAY:"05",JUN:"06",
                   JUL:"07",AUG:"08",SEP:"09",OCT:"10",NOV:"11",DEC:"12" };
  const mm = months[m[2]];
  if (!mm) return null;
  return `20${m[3]}-${mm}-${m[1]}`;
}

function istDateKey() {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function istIsoNow() {
  // 2026-05-14T11:59:00+05:30 — floored to current minute is fine; the engine
  // re-buckets to 5 minutes anyway.
  const now = new Date();
  const istMs = now.getTime() + 5.5 * 3600 * 1000;
  const ist = new Date(istMs);
  const pad = (n) => String(n).padStart(2, "0");
  return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}T`
    + `${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}:${pad(ist.getUTCSeconds())}+05:30`;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

/**
 * Append one snapshot (all strikes at one timestamp) to the JSONL file.
 *
 * @param {object} args
 * @param {string} args.symbol     e.g. "NIFTY"
 * @param {string} args.expiryStr  e.g. "15MAY25"
 * @param {number} args.spot       index LTP
 * @param {number|null} args.vix   India VIX LTP (null if not fetched)
 * @param {object} args.byStrike   { [strike]: { ce:{oi,ltp,volume}, pe:{oi,ltp,volume} } }
 */
export function appendSnapshot({ symbol, expiryStr, spot, vix, byStrike }) {
  try {
    const expiryISO = parseExpiryToISO(expiryStr);
    if (!expiryISO) return { ok: false, reason: "bad_expiry" };

    const dir = path.join(DATA_ROOT, "snapshots", symbol.toUpperCase());
    ensureDir(dir);
    const file = path.join(dir, `${istDateKey()}.jsonl`);
    const ts = istIsoNow();

    const lines = [];
    for (const [strikeStr, sides] of Object.entries(byStrike || {})) {
      const strike = Number(strikeStr);
      if (!Number.isFinite(strike)) continue;
      for (const sideKey of ["ce", "pe"]) {
        const cell = sides[sideKey];
        if (!cell) continue;
        const row = {
          ts,
          symbol: symbol.toUpperCase(),
          expiry: expiryISO,
          strike,
          opt_type: sideKey.toUpperCase(),
          oi: cell.oi != null ? Number(cell.oi) : 0,
          volume: cell.volume != null ? Number(cell.volume) : 0,
          ltp: cell.ltp != null ? Number(cell.ltp) : 0,
          spot: Number(spot) || 0,
          vix: vix != null ? Number(vix) : 0,
        };
        if (row.ltp === 0 && row.oi === 0) continue;  // drop empty rows
        lines.push(JSON.stringify(row));
      }
    }
    if (lines.length === 0) return { ok: false, reason: "no_rows" };

    fs.appendFileSync(file, lines.join("\n") + "\n", "utf8");
    return { ok: true, file, rows: lines.length };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

export const SNAPSHOT_DIR = path.join(DATA_ROOT, "snapshots");
