// paperStore.js — atomic JSON read/write for paper trading.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const DATA_ROOT = process.env.FNO_DATA_ROOT
  || path.join(PROJECT_ROOT, "data", "fno");
const PAPER_DIR = path.join(path.dirname(DATA_ROOT), "paper");

const SETTINGS_PATH = path.join(PAPER_DIR, "settings.json");
const TRADES_PATH   = path.join(PAPER_DIR, "trades.json");
const ARCHIVE_DIR   = path.join(PAPER_DIR, "archive");

const DEFAULT_SETTINGS = {
  initialCapital: 15000,
  defaultLotSize: 1,
  maxTradesPerDay: 1,
  longOnly: true,
  slippagePct: 0.5,
  createdAt: null,
};

function ensureDirs() {
  fs.mkdirSync(PAPER_DIR, { recursive: true });
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
}

function atomicWrite(p, content) {
  ensureDirs();
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, p);
}

// ---------------- settings ----------------

export function loadSettings() {
  ensureDirs();
  if (!fs.existsSync(SETTINGS_PATH)) {
    const s = { ...DEFAULT_SETTINGS, createdAt: new Date().toISOString() };
    atomicWrite(SETTINGS_PATH, JSON.stringify(s, null, 2));
    return s;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS, createdAt: new Date().toISOString() };
  }
}

export function saveSettings(patch) {
  const cur = loadSettings();
  const next = {
    ...cur,
    ...patch,
    initialCapital:  Math.max(1000, Number(patch.initialCapital ?? cur.initialCapital)),
    defaultLotSize:  Math.max(1,    Math.floor(Number(patch.defaultLotSize  ?? cur.defaultLotSize))),
    maxTradesPerDay: Math.max(1,    Math.floor(Number(patch.maxTradesPerDay ?? cur.maxTradesPerDay))),
    slippagePct:     Math.max(0,    Number(patch.slippagePct ?? cur.slippagePct)),
  };
  atomicWrite(SETTINGS_PATH, JSON.stringify(next, null, 2));
  return next;
}

// ---------------- trades ----------------

export function loadTrades() {
  ensureDirs();
  if (!fs.existsSync(TRADES_PATH)) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(TRADES_PATH, "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function saveTrades(trades) {
  atomicWrite(TRADES_PATH, JSON.stringify(trades, null, 2));
}

export function appendTrade(trade) {
  const all = loadTrades();
  all.push(trade);
  saveTrades(all);
  return trade;
}

export function updateTrade(id, patch) {
  const all = loadTrades();
  const idx = all.findIndex(t => t.id === id);
  if (idx < 0) throw new Error(`trade ${id} not found`);
  all[idx] = { ...all[idx], ...patch };
  saveTrades(all);
  return all[idx];
}

export function archiveAndReset() {
  ensureDirs();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  if (fs.existsSync(TRADES_PATH)) {
    fs.renameSync(TRADES_PATH, path.join(ARCHIVE_DIR, `trades.archive.${stamp}.json`));
  }
  saveTrades([]);
}

// ---------------- retention ----------------
// Keep last 90 days in trades.json; older trades move to monthly archive files.

export function rollOldTradesToArchive(retainDays = 90) {
  const all = loadTrades();
  if (!all.length) return { kept: 0, archived: 0 };
  const cutoff = Date.now() - retainDays * 24 * 3600 * 1000;
  const keep = [];
  const old  = [];
  for (const t of all) {
    const ts = new Date(t.date || t.entry?.ts || 0).getTime();
    if (Number.isFinite(ts) && ts >= cutoff) keep.push(t);
    else old.push(t);
  }
  if (old.length === 0) return { kept: keep.length, archived: 0 };

  // group archive by YYYYMM
  const byMonth = new Map();
  for (const t of old) {
    const d = (t.date || t.entry?.ts || "").slice(0, 7);   // YYYY-MM
    if (!byMonth.has(d)) byMonth.set(d, []);
    byMonth.get(d).push(t);
  }
  for (const [month, arr] of byMonth) {
    const p = path.join(ARCHIVE_DIR, `trades.${month}.json`);
    const existing = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : [];
    atomicWrite(p, JSON.stringify(existing.concat(arr), null, 2));
  }
  saveTrades(keep);
  return { kept: keep.length, archived: old.length };
}

export const PAPER_PATHS = { PAPER_DIR, SETTINGS_PATH, TRADES_PATH, ARCHIVE_DIR };
