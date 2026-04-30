// Daily orchestrator with backfill.
//
// On each run we look at the last date already filled in the workbook and
// append a row for every missing trading day up to today. If the workbook
// is already current, nothing changes. (WhatsApp send and AngelOne fallback
// are temporarily disabled.)

import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import { isTradingDay, istDateString } from "../calendarIn.js";
import { sheetToTradingSymbol, isIndexSheet } from "../symbols.js";
import { fetchQuotes as fetchNse } from "../brokers/nse.js";
import {
  loadWorkbook,
  saveWorkbook,
  appendDailyRow,
  copyFile,
} from "../sheet.js";

const log = pino({ level: process.env.LOG_LEVEL || "info" });
const MAX_BACKFILL_DAYS = 30;

function dataDir() {
  return process.env.DATA_DIR || "/data";
}

function workbookPath() {
  return path.join(dataDir(), "WEEKLY_FNO.xlsx");
}

function lastRunPath() {
  return path.join(dataDir(), "last-run.json");
}

function ensureSeed() {
  fs.mkdirSync(dataDir(), { recursive: true });
  const wbPath = workbookPath();
  if (fs.existsSync(wbPath)) return;
  const seed = process.env.SEED_FILE || "./seed/WEEKLY_FNO.xlsx";
  if (!fs.existsSync(seed)) {
    throw new Error(`No workbook at ${wbPath} and no seed at ${seed}`);
  }
  fs.copyFileSync(seed, wbPath);
  log.info({ wbPath, seed }, "seeded workbook");
}

export function readLastRun() {
  try {
    return JSON.parse(fs.readFileSync(lastRunPath(), "utf8"));
  } catch {
    return null;
  }
}

function writeLastRun(payload) {
  fs.writeFileSync(lastRunPath(), JSON.stringify(payload, null, 2));
}

function buildItems(wb) {
  const items = [];
  for (const ws of wb.worksheets) {
    const sym = sheetToTradingSymbol(ws.name);
    if (sym === null) {
      log.warn({ sheet: ws.name }, "skipping sheet (override=null)");
      continue;
    }
    items.push({ sheet: ws.name, tradingSymbol: sym, isIndex: isIndexSheet(ws.name) });
  }
  return items;
}

// Walk every worksheet, find the most recent date in column A across all
// sheets. Returns YYYY-MM-DD or null if nothing is filled yet.
function maxFilledDate(wb) {
  let maxIso = null;
  for (const ws of wb.worksheets) {
    for (let r = ws.rowCount; r >= 2; r--) {
      const v = ws.getRow(r).getCell(1).value;
      if (v === null || v === undefined || v === "") continue;
      let d = null;
      if (v instanceof Date) d = v;
      else if (typeof v === "string" || typeof v === "number") {
        const parsed = new Date(v);
        if (!isNaN(parsed.getTime())) d = parsed;
      }
      if (d) {
        const iso = d.toISOString().slice(0, 10);
        if (!maxIso || iso > maxIso) maxIso = iso;
      }
      break; // only the bottom-most row per sheet
    }
  }
  return maxIso;
}

// Trading days strictly after `fromIso` and up to `toIso` (both YYYY-MM-DD).
// Capped at MAX_BACKFILL_DAYS to avoid runaway loops.
function tradingDaysBetween(fromIso, toIso) {
  const out = [];
  const end = new Date(`${toIso}T00:00:00.000Z`);
  let cur = new Date(`${fromIso}T00:00:00.000Z`);
  cur = new Date(cur.getTime() + 24 * 3600 * 1000);
  let safety = 0;
  while (cur.getTime() <= end.getTime() && safety < MAX_BACKFILL_DAYS * 2) {
    if (isTradingDay(cur)) out.push(cur.toISOString().slice(0, 10));
    cur = new Date(cur.getTime() + 24 * 3600 * 1000);
    safety++;
  }
  return out.slice(-MAX_BACKFILL_DAYS);
}

export async function runDailyJob() {
  const startedAt = new Date().toISOString();
  const todayIst = istDateString();
  const datedName = `WEEKLY_FNO_${todayIst}.xlsx`;
  fs.mkdirSync("/tmp", { recursive: true });
  const datedPath = path.join("/tmp", datedName);

  ensureSeed();

  const result = {
    startedAt,
    todayIst,
    datedName,
    datedPath,
    tradingDay: false,
    lastFilled: null,
    daysFilled: 0,
    filledDates: [],
    updatedSheets: 0,
    skippedSheets: 0,
    error: null,
  };

  try {
    const wb = await loadWorkbook(workbookPath());
    const items = buildItems(wb);

    const lastFilled = maxFilledDate(wb);
    result.lastFilled = lastFilled;

    // Build the list of dates to fill. If nothing is filled yet we just
    // fill today (when it's a trading day). Otherwise fill every missing
    // trading day up to today.
    let dates;
    if (!lastFilled) {
      dates = isTradingDay() ? [todayIst] : [];
    } else if (lastFilled >= todayIst) {
      dates = [];
    } else {
      dates = tradingDaysBetween(lastFilled, todayIst);
    }

    result.tradingDay = isTradingDay();

    if (dates.length === 0) {
      log.info({ lastFilled, todayIst }, "workbook already current; nothing to do");
      copyFile(workbookPath(), datedPath);
      writeLastRun({ ...result, ok: true, finishedAt: new Date().toISOString() });
      return { ...result, ok: true };
    }

    log.info({ from: lastFilled, to: todayIst, count: dates.length }, "backfilling");

    for (const iso of dates) {
      const dt = new Date(`${iso}T00:00:00.000Z`);
      const quotes = await fetchNse(items, { dataDir: dataDir(), log, date: dt }).catch(
        (err) => {
          log.error({ iso, err: err.message }, "nse fetch failed");
          return new Map();
        },
      );
      if (quotes.size === 0) {
        log.warn({ iso }, "no quotes; skipping date");
        continue;
      }
      const { updated, skipped } = appendDailyRow(wb, quotes, dt, { log });
      result.updatedSheets += updated.length;
      result.skippedSheets += skipped.length;
      result.filledDates.push(iso);
      result.daysFilled += 1;
    }

    if (result.daysFilled === 0) {
      log.warn("no quotes available yet (NSE EOD typically publishes ~6:30 PM IST)");
      copyFile(workbookPath(), datedPath);
      writeLastRun({ ...result, ok: true, finishedAt: new Date().toISOString() });
      return { ...result, ok: true };
    }

    await saveWorkbook(wb, workbookPath());
    copyFile(workbookPath(), datedPath);

    writeLastRun({ ...result, ok: true, finishedAt: new Date().toISOString() });
    return { ...result, ok: true };
  } catch (err) {
    log.error({ err: err.message, stack: err.stack }, "daily job failed");
    result.error = err.message;
    writeLastRun({ ...result, ok: false, finishedAt: new Date().toISOString() });
    return { ...result, ok: false };
  }
}
