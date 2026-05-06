// Custom flat-file DB for closed paper-trades.
//
// Format: pipe-delimited text at data/oi_trades.txt
//   - Line 1 is a header row (column names, fixed order).
//   - One trade per line, fields in the same order as the header.
//   - Append-only writes. Reads parse all non-blank, non-header lines.
//   - Pipe (|) chosen over comma so we don't have to escape numeric strings,
//     and over TSV so the file is easy to read in any editor / `cat`.
//
// Charges are computed once at write time using the Indian
// options-intraday discount-broker model and stored as discrete columns
// (so we can re-aggregate without re-deriving math from prices later).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "data", "oi_trades.txt");
const SEP = "|";

// IMPORTANT: append-only — never reorder or rename. Add new columns at the end
// and bump readers to default missing trailing fields to "".
const COLUMNS = [
  "writeTs", "dayKey", "side", "strike", "symbol",
  "entryTs", "exitTs", "entryPx", "exitPx",
  "lots", "lotSize", "qty",
  "capital", "grossPnl",
  "brokerage", "stt", "exchangeTxn", "sebi", "stamp", "gst", "chargesTotal",
  "netPnl", "reason",
];
const HEADER_LINE = COLUMNS.join(SEP);

const NUMERIC_COLS = new Set([
  "strike","entryTs","exitTs","entryPx","exitPx","lots","lotSize","qty",
  "capital","grossPnl",
  "brokerage","stt","exchangeTxn","sebi","stamp","gst","chargesTotal",
  "netPnl",
]);

const r = (v) => Math.round(v * 100) / 100;

// Discount-broker charges for NIFTY options intraday. See PR notes for source.
export function computeCharges({ entryPx, exitPx, qty }) {
  const buyTurnover  = entryPx * qty;
  const sellTurnover = exitPx * qty;
  const totalTurnover = buyTurnover + sellTurnover;

  const brokerage   = 40;                              // ₹20 buy + ₹20 sell
  const stt         = sellTurnover * 0.000625;          // 0.0625% on sell
  const exchangeTxn = totalTurnover * 0.0003503;        // 0.03503%
  const sebi        = totalTurnover * 0.000001;         // ₹10/cr
  const stamp       = buyTurnover  * 0.00003;           // 0.003% on buy
  const gst         = (brokerage + exchangeTxn + sebi) * 0.18;
  const total       = brokerage + stt + exchangeTxn + sebi + stamp + gst;

  return {
    brokerage: r(brokerage), stt: r(stt), exchangeTxn: r(exchangeTxn),
    sebi: r(sebi), stamp: r(stamp), gst: r(gst), total: r(total),
  };
}

// ----- low-level file ops ------------------------------------------------

function ensureFile() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, HEADER_LINE + "\n");
  } else {
    // If file exists but is empty / missing header, repair by prepending.
    const head = fs.readFileSync(DB_PATH, "utf8").split(/\r?\n/, 1)[0] || "";
    if (head !== HEADER_LINE) {
      const body = fs.readFileSync(DB_PATH, "utf8");
      fs.writeFileSync(DB_PATH, HEADER_LINE + "\n" + body);
    }
  }
}

function escapeField(v) {
  if (v == null) return "";
  // Strip newlines + pipes — both would corrupt the row layout. Reason text
  // is the only free-form field; replace defensively.
  return String(v).replace(/[|\r\n]+/g, " ").trim();
}

function appendRow(rowObj) {
  ensureFile();
  const line = COLUMNS.map((c) => escapeField(rowObj[c])).join(SEP);
  fs.appendFileSync(DB_PATH, line + "\n");
}

function parseRow(line) {
  const parts = line.split(SEP);
  const obj = {};
  for (let i = 0; i < COLUMNS.length; i++) {
    const col = COLUMNS[i];
    let v = parts[i] ?? "";
    if (NUMERIC_COLS.has(col)) {
      if (v === "") { obj[col] = null; continue; }
      const n = Number(v);
      obj[col] = Number.isFinite(n) ? n : null;
    } else {
      obj[col] = v;
    }
  }
  // Re-build the nested charges block the UI tooltip expects.
  obj.charges = {
    brokerage: obj.brokerage, stt: obj.stt, exchangeTxn: obj.exchangeTxn,
    sebi: obj.sebi, stamp: obj.stamp, gst: obj.gst, total: obj.chargesTotal,
  };
  // Backwards-compat alias for existing tick/state code that reads `pnl`.
  obj.pnl = obj.netPnl;
  return obj;
}

function loadAll() {
  if (!fs.existsSync(DB_PATH)) return [];
  const raw = fs.readFileSync(DB_PATH, "utf8");
  const lines = raw.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (i === 0 && line === HEADER_LINE) continue;
    if (line.startsWith("writeTs|")) continue; // safety: skip stray header
    try {
      out.push(parseRow(line));
    } catch {
      // ignore unparseable line — keep history resilient
    }
  }
  return out;
}

// ----- public API --------------------------------------------------------

// Append one closed trade. Returns the enriched record (same shape the UI got
// before, so downstream code keeps working).
export function recordTrade(trade) {
  const lots    = trade.lots    || 1;
  const lotSize = trade.lotSize || 75;
  const qty     = lots * lotSize;
  const charges = computeCharges({
    entryPx: trade.entryPx, exitPx: trade.exitPx, qty,
  });
  const grossPnl = r((trade.exitPx - trade.entryPx) * qty);
  const netPnl   = r(grossPnl - charges.total);
  const capital  = r(trade.entryPx * qty);

  const row = {
    writeTs: new Date().toISOString(),
    dayKey: trade.dayKey || "",
    side: trade.side || "",
    strike: trade.strike ?? "",
    symbol: trade.symbol || "",
    entryTs: trade.entryTs ?? "",
    exitTs: trade.exitTs ?? "",
    entryPx: trade.entryPx ?? "",
    exitPx: trade.exitPx ?? "",
    lots, lotSize, qty,
    capital, grossPnl,
    brokerage: charges.brokerage, stt: charges.stt,
    exchangeTxn: charges.exchangeTxn, sebi: charges.sebi,
    stamp: charges.stamp, gst: charges.gst,
    chargesTotal: charges.total,
    netPnl,
    reason: trade.reason || "",
  };
  appendRow(row);

  return {
    ...trade,
    qty, capital, grossPnl, charges, netPnl,
  };
}

// Aggregate by IST day (newest day first).
export function getDayWiseHistory() {
  const all = loadAll();
  const byDay = new Map();
  for (const t of all) {
    const day = t.dayKey || "unknown";
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(t);
  }

  const days = [...byDay.entries()]
    .map(([day, trades]) => {
      const wins   = trades.filter((t) => (t.netPnl ?? 0) > 0).length;
      const losses = trades.filter((t) => (t.netPnl ?? 0) <= 0).length;
      const grossPnl     = r(trades.reduce((a, t) => a + (t.grossPnl || 0), 0));
      const totalCharges = r(trades.reduce((a, t) => a + (t.chargesTotal || 0), 0));
      const netPnl       = r(grossPnl - totalCharges);
      const capital      = r(trades.reduce((a, t) => a + (t.capital || 0), 0));
      return {
        day, trades, count: trades.length,
        wins, losses,
        grossPnl, totalCharges, netPnl, capital,
      };
    })
    .sort((a, b) => b.day.localeCompare(a.day));

  const totals = days.reduce(
    (acc, d) => ({
      count:        acc.count + d.count,
      wins:         acc.wins + d.wins,
      losses:       acc.losses + d.losses,
      grossPnl:     r(acc.grossPnl + d.grossPnl),
      totalCharges: r(acc.totalCharges + d.totalCharges),
      netPnl:       r(acc.netPnl + d.netPnl),
      capital:      r(acc.capital + d.capital),
    }),
    { count: 0, wins: 0, losses: 0, grossPnl: 0, totalCharges: 0, netPnl: 0, capital: 0 },
  );

  return { days, totals, dbPath: DB_PATH };
}

// One-time migration: pulls existing JSON history (if any) into the txt DB.
export function migrateLegacyJson() {
  const legacy = path.join(path.dirname(DB_PATH), "oi_trades.json");
  if (!fs.existsSync(legacy)) return { migrated: 0 };
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(legacy, "utf8")); } catch { return { migrated: 0 }; }
  if (!Array.isArray(arr) || arr.length === 0) return { migrated: 0 };
  ensureFile();
  for (const t of arr) {
    appendRow({
      writeTs: new Date().toISOString(),
      dayKey: t.dayKey || "",
      side: t.side || "", strike: t.strike ?? "", symbol: t.symbol || "",
      entryTs: t.entryTs ?? "", exitTs: t.exitTs ?? "",
      entryPx: t.entryPx ?? "", exitPx: t.exitPx ?? "",
      lots: t.lots || 1, lotSize: t.lotSize || 75, qty: t.qty || ((t.lots||1)*(t.lotSize||75)),
      capital: t.capital ?? "", grossPnl: t.grossPnl ?? "",
      brokerage:   t.charges?.brokerage   ?? "",
      stt:         t.charges?.stt         ?? "",
      exchangeTxn: t.charges?.exchangeTxn ?? "",
      sebi:        t.charges?.sebi        ?? "",
      stamp:       t.charges?.stamp       ?? "",
      gst:         t.charges?.gst         ?? "",
      chargesTotal:t.charges?.total       ?? "",
      netPnl: t.netPnl ?? t.pnl ?? "",
      reason: t.reason || "",
    });
  }
  // Rename legacy out of the way so we don't double-import on next boot.
  try { fs.renameSync(legacy, legacy + ".migrated"); } catch {}
  return { migrated: arr.length };
}
