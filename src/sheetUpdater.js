// XLSX updater for WEEKLY.xlsx.
//
// Sheet layout (verified):
//   A: DATE (Excel serial — pre-populated for future days, including weekends)
//   B: Close/LTP price
//   C: ATP (VWAP from exchange — exact for today; approximated as (O+H+L+C)/4 for historical backfill)
//   D..V: 2DATP..20DATP — average of last N filled ATPs (chained)
//   W onwards (e.g. SIGNAL/DAY/TRADE) — left untouched.
//
// Workflow:
//   1. Determine target date (today after market close, or previous trading day).
//   2. For each sheet, find missing trading dates between (lastFilled+1, target).
//   3. Cap missing range to last 5 trading days (else only fill target).
//   4. Fill rows chronologically — each day's ATP feeds into the next day's nDATP.

import XLSX from "xlsx";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  dateToSerial,
  serialToDate,
  fmtISO,
  tradingDaysBetween,
  isTradingDay,
} from "./dateUtils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const XLSX_PATH = path.join(DATA_DIR, "WEEKLY.xlsx");

const MAX_BACKFILL_DAYS = 5;

export function getXlsxPath() {
  return XLSX_PATH;
}

export function loadOverrides() {
  const overridePath = path.join(DATA_DIR, "symbol_overrides.json");
  if (fs.existsSync(overridePath)) {
    return JSON.parse(fs.readFileSync(overridePath, "utf8"));
  }
  return {};
}

/** Resolve a sheet name to its Angel One trading symbol. Returns null if sheet should be skipped. */
export function resolveSheetSymbol(sheetName, overrides) {
  if (sheetName in overrides) {
    return overrides[sheetName]; // may be null (skip) or a string
  }
  return sheetName;
}

/**
 * For each sheet, compute:
 *   - lastFilledDate (most recent row with a Close value)
 *   - missingDates (trading days between lastFilled+1 and targetDate, inclusive of target)
 *   - cappedDates  (missingDates if length <= MAX_BACKFILL_DAYS, else just [targetDate])
 *
 * Returns an array of plan entries, one per sheet.
 */
export function planUpdates(targetDate) {
  const wb = XLSX.readFile(XLSX_PATH, { cellStyles: true, cellNF: true });
  const overrides = loadOverrides();
  const targetSerial = dateToSerial(targetDate);
  const plans = [];

  for (const sheetName of wb.SheetNames) {
    const tradingSymbol = resolveSheetSymbol(sheetName, overrides);
    if (tradingSymbol === null) {
      plans.push({ sheetName, tradingSymbol: null, status: "skipped-override" });
      continue;
    }

    const ws = wb.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });

    // Find last filled row (has Close in col B)
    let lastFilledRow = -1;
    let lastFilledDate = null;
    for (let i = 1; i < data.length; i++) {
      const hasDate = typeof data[i][0] === "number";
      const hasClose =
        data[i][1] !== "" && data[i][1] !== undefined && data[i][1] !== null;
      if (hasDate && hasClose) {
        lastFilledRow = i;
        lastFilledDate = serialToDate(data[i][0]);
      }
    }

    // Determine date range to fill
    let datesToFill;
    if (lastFilledDate === null) {
      // No filled rows yet — only fill target
      datesToFill = [targetDate];
    } else if (lastFilledDate.getTime() >= targetDate.getTime()) {
      // Already up-to-date or ahead
      datesToFill = [];
    } else {
      const fromDate = new Date(lastFilledDate.getTime());
      fromDate.setUTCDate(fromDate.getUTCDate() + 1);
      const allMissing = tradingDaysBetween(fromDate, targetDate);
      if (allMissing.length > MAX_BACKFILL_DAYS) {
        // Gap too large — only fill the target date
        datesToFill = [targetDate];
      } else {
        datesToFill = allMissing;
      }
    }

    // Verify each date has a corresponding row in the sheet (column A)
    const dateRows = []; // { date, rowIndex }
    for (const d of datesToFill) {
      const serial = dateToSerial(d);
      let rowIndex = -1;
      for (let i = 1; i < data.length; i++) {
        if (data[i][0] === serial) {
          rowIndex = i;
          break;
        }
      }
      dateRows.push({ date: d, serial, rowIndex });
    }

    plans.push({
      sheetName,
      tradingSymbol,
      lastFilledDate: lastFilledDate ? fmtISO(lastFilledDate) : null,
      lastFilledRow,
      datesToFill: dateRows,
      status: "planned",
    });
  }

  return { plans, targetDate, targetSerial };
}

/**
 * Apply updates to the XLSX. Processes each sheet's missing dates chronologically
 * so that nDATP rolling averages chain correctly (today's ATP feeds tomorrow's 2DATP).
 *
 * @param {Array} plans — output of planUpdates
 * @param {Object} dataBySymbolDate — { [tradingSymbol]: { [YYYY-MM-DD]: { close, atp } } }
 * @returns {{ updatedSheets, alreadyFilled, skippedSheets, missingData, targetDate }}
 */
export function applyUpdates(plans, dataBySymbolDate, targetDate) {
  const wb = XLSX.readFile(XLSX_PATH, { cellStyles: true, cellNF: true });

  const updatedSheets = []; // { sheet, datesFilled }
  const alreadyFilled = []; // sheets fully up-to-date
  const skippedSheets = []; // { sheet, reason }
  const missingData = []; // { sheet, date, reason }

  for (const plan of plans) {
    if (plan.status === "skipped-override" || plan.tradingSymbol === null) {
      skippedSheets.push({ sheet: plan.sheetName, reason: "override-skip" });
      continue;
    }

    if (plan.datesToFill.length === 0) {
      alreadyFilled.push(plan.sheetName);
      continue;
    }

    const ws = wb.Sheets[plan.sheetName];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });

    const symData = dataBySymbolDate[plan.tradingSymbol] || {};
    const datesFilled = [];

    // Process chronologically — already in order from tradingDaysBetween()
    for (const { date, serial, rowIndex } of plan.datesToFill) {
      const isoDate = fmtISO(date);

      if (rowIndex === -1) {
        missingData.push({
          sheet: plan.sheetName,
          date: isoDate,
          reason: "no row in sheet for this date",
        });
        continue;
      }

      // Skip non-trading days (paranoia — should never happen since planner filters)
      if (!isTradingDay(date)) continue;

      // If row already has close, skip it
      const existingClose = data[rowIndex][1];
      if (
        existingClose !== "" &&
        existingClose !== undefined &&
        existingClose !== null
      ) {
        continue;
      }

      const dayData = symData[isoDate];
      if (!dayData || dayData.close == null || dayData.atp == null) {
        missingData.push({
          sheet: plan.sheetName,
          date: isoDate,
          reason: "no quote data returned",
        });
        continue;
      }

      // Build ATP history from rows BEFORE this rowIndex with numeric ATP
      const atpHistory = [];
      for (let i = 1; i < rowIndex; i++) {
        const atp = data[i][2];
        if (typeof atp === "number" && !isNaN(atp)) {
          atpHistory.push(atp);
        }
      }
      atpHistory.push(dayData.atp);

      // Write Close (col B), ATP (col C)
      writeCell(ws, rowIndex, 1, dayData.close);
      writeCell(ws, rowIndex, 2, dayData.atp);

      // Update in-memory data array so later iterations see the new ATP
      data[rowIndex][1] = dayData.close;
      data[rowIndex][2] = dayData.atp;

      // Compute and write 2DATP..20DATP (cols D..V, indexes 3..21)
      for (let n = 2; n <= 20; n++) {
        const colIdx = n + 1;
        if (atpHistory.length < n) {
          // Not enough history — leave blank
          deleteCell(ws, rowIndex, colIdx);
          data[rowIndex][colIdx] = "";
        } else {
          const slice = atpHistory.slice(-n);
          const avg = slice.reduce((a, b) => a + b, 0) / n;
          writeCell(ws, rowIndex, colIdx, avg);
          data[rowIndex][colIdx] = avg;
        }
      }

      datesFilled.push(isoDate);
    }

    if (datesFilled.length > 0) {
      updatedSheets.push({ sheet: plan.sheetName, dates: datesFilled });
    } else {
      // Had datesToFill but couldn't fill any
      skippedSheets.push({
        sheet: plan.sheetName,
        reason: "no data for any planned date",
      });
    }
  }

  XLSX.writeFile(wb, XLSX_PATH, { cellStyles: true });

  return {
    updatedSheets,
    alreadyFilled,
    skippedSheets,
    missingData,
    targetDate: fmtISO(targetDate),
  };
}

/** Find an existing cell in the same column to copy formatting from. */
function findStyleSourceInColumn(ws, col) {
  const range = XLSX.utils.decode_range(ws["!ref"]);
  // Look at row 1 (first data row, just below header) downward — first cell with z/s wins
  for (let r = 1; r <= range.e.r; r++) {
    const ref = XLSX.utils.encode_cell({ r, c: col });
    const c = ws[ref];
    if (c && (c.z || c.s)) return { z: c.z, s: c.s };
  }
  return null;
}

function writeCell(ws, row, col, value) {
  if (value == null || isNaN(value)) {
    deleteCell(ws, row, col);
    return;
  }
  const ref = XLSX.utils.encode_cell({ r: row, c: col });
  // Inherit number format / style from an existing cell in the same column so
  // new rows render consistently with the rest of the sheet (e.g. "#,##0.00").
  const style = findStyleSourceInColumn(ws, col);
  const cell = { t: "n", v: value };
  if (style) {
    if (style.z) cell.z = style.z;
    if (style.s) cell.s = style.s;
  }
  ws[ref] = cell;
  // Extend range if needed
  const range = XLSX.utils.decode_range(ws["!ref"]);
  if (row > range.e.r) range.e.r = row;
  if (col > range.e.c) range.e.c = col;
  ws["!ref"] = XLSX.utils.encode_range(range);
}

function deleteCell(ws, row, col) {
  const ref = XLSX.utils.encode_cell({ r: row, c: col });
  delete ws[ref];
}

/** Per-sheet summary for the dashboard. */
export function getSheetSummary() {
  const wb = XLSX.readFile(XLSX_PATH, { cellStyles: true, cellNF: true });
  const summary = [];

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });

    let lastFilled = -1;
    let filledCount = 0;
    for (let i = 1; i < data.length; i++) {
      const hasDate = typeof data[i][0] === "number";
      const hasClose =
        data[i][1] !== "" && data[i][1] !== undefined && data[i][1] !== null;
      if (hasDate && hasClose) {
        lastFilled = i;
        filledCount++;
      }
    }

    if (lastFilled === -1) {
      summary.push({ sheet: sheetName, lastDate: null, rows: 0 });
      continue;
    }

    const lastSerial = data[lastFilled][0];
    summary.push({
      sheet: sheetName,
      lastDate: fmtISO(serialToDate(lastSerial)),
      lastClose: data[lastFilled][1],
      lastAtp: data[lastFilled][2],
      rows: filledCount,
    });
  }

  return summary;
}
