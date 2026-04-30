// XLSX updater for WEEKLY.xlsx.
//
// Sheet layout (verified against existing data):
//   A: DATE (Excel serial — pre-populated for future days)
//   B: Close/LTP price
//   C: ATP (VWAP / avgPrice from Angel One — exchange-published Average Traded Price)
//   D: 2DATP  = average of last 2  ATPs (today + yesterday)
//   E: 3DATP  = average of last 3  ATPs
//   …
//   V: 20DATP = average of last 20 ATPs
//   W onwards (e.g. SIGNAL, DAY, TRADE on RELIANCE) — left untouched
//
// Workflow: find the row whose DATE matches today, fill columns B..V.
// Future date rows are already pre-populated in the file.

import XLSX from "xlsx";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const XLSX_PATH = path.join(DATA_DIR, "WEEKLY.xlsx");

function loadOverrides() {
  const overridePath = path.join(DATA_DIR, "symbol_overrides.json");
  if (fs.existsSync(overridePath)) {
    return JSON.parse(fs.readFileSync(overridePath, "utf8"));
  }
  return {};
}

function dateToSerial(d) {
  const epoch = new Date(Date.UTC(1899, 11, 30));
  const diff = d.getTime() - epoch.getTime();
  return Math.floor(diff / (24 * 60 * 60 * 1000));
}

function serialToDate(serial) {
  return new Date((serial - 25569) * 86400 * 1000);
}

function todayIST() {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  return new Date(
    Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate())
  );
}

function isWeekend(d) {
  const dow = d.getUTCDay();
  return dow === 0 || dow === 6;
}

/**
 * Calculate nDATP: average of the last N ATP values (including today's).
 * Walks back through filled ATP cells, skipping empty (e.g. weekend) rows.
 */
function calcNDayAtp(atpHistory, n) {
  if (atpHistory.length < n) return null;
  const slice = atpHistory.slice(-n);
  const sum = slice.reduce((a, b) => a + b, 0);
  return sum / n;
}

/**
 * Update WEEKLY.xlsx by filling today's row in each sheet.
 *
 * @param {Object} quotes — map of tradingSymbol -> { ltp, close, avgPrice }
 * @param {Date} [forDate] — date to fill (defaults to today IST)
 */
export function updateXlsx(quotes, forDate) {
  const targetDate = forDate || todayIST();
  const targetSerial = dateToSerial(targetDate);
  const dateStr = targetDate.toISOString().split("T")[0];

  if (isWeekend(targetDate)) {
    return {
      updatedSheets: [],
      skippedSheets: [],
      alreadyFilled: [],
      noRowForDate: [],
      date: dateStr,
      warning: "Today is a weekend — nothing to fill.",
    };
  }

  const overrides = loadOverrides();
  const wb = XLSX.readFile(XLSX_PATH);

  const updatedSheets = [];
  const skippedSheets = [];
  const alreadyFilled = [];
  const noRowForDate = [];

  for (const sheetName of wb.SheetNames) {
    let tradingSymbol;
    if (sheetName in overrides) {
      if (overrides[sheetName] === null) {
        skippedSheets.push(sheetName);
        continue;
      }
      tradingSymbol = overrides[sheetName];
    } else {
      tradingSymbol = sheetName;
    }

    const quote = quotes[tradingSymbol];
    if (!quote) {
      skippedSheets.push(sheetName);
      continue;
    }
    if (quote.avgPrice == null || isNaN(quote.avgPrice)) {
      skippedSheets.push(sheetName);
      continue;
    }

    const ws = wb.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });

    // Find the row matching today's date in column A
    let targetRow = -1;
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === targetSerial) {
        targetRow = i;
        break;
      }
    }

    if (targetRow === -1) {
      noRowForDate.push(sheetName);
      continue;
    }

    // If today's row is already filled (has close), mark as alreadyFilled
    if (
      data[targetRow][1] !== "" &&
      data[targetRow][1] !== undefined &&
      data[targetRow][1] !== null
    ) {
      alreadyFilled.push(sheetName);
      continue;
    }

    // Build ATP history from rows BEFORE today that have a numeric ATP
    const atpHistory = [];
    for (let i = 1; i < targetRow; i++) {
      const atp = data[i][2];
      if (typeof atp === "number" && !isNaN(atp)) {
        atpHistory.push(atp);
      }
    }

    const closePrice = quote.close || quote.ltp;
    const todayAtp = quote.avgPrice;
    atpHistory.push(todayAtp);

    // Build values for cols B..V (indexes 1..21)
    const values = {
      1: closePrice, // B: Close
      2: todayAtp,   // C: ATP
    };
    // D..V = 2DATP..20DATP
    for (let n = 2; n <= 20; n++) {
      const ndatp = calcNDayAtp(atpHistory, n);
      const colIdx = n + 1; // 2DATP at index 3 (col D), 20DATP at index 21 (col V)
      values[colIdx] = ndatp;
    }

    // Write cells
    for (const [colStr, val] of Object.entries(values)) {
      const col = parseInt(colStr, 10);
      const cellRef = XLSX.utils.encode_cell({ r: targetRow, c: col });
      if (val == null || isNaN(val)) {
        delete ws[cellRef];
      } else {
        ws[cellRef] = { t: "n", v: val };
      }
    }

    updatedSheets.push(sheetName);
  }

  XLSX.writeFile(wb, XLSX_PATH);

  return {
    updatedSheets,
    skippedSheets,
    alreadyFilled,
    noRowForDate,
    date: dateStr,
  };
}

export function getXlsxPath() {
  return XLSX_PATH;
}

/**
 * Per-sheet summary: last filled date + values, total filled rows.
 */
export function getSheetSummary() {
  const wb = XLSX.readFile(XLSX_PATH);
  const summary = [];

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });

    // Find last row with both DATE and Close filled
    let lastFilled = -1;
    let filledCount = 0;
    for (let i = 1; i < data.length; i++) {
      const hasDate = data[i][0] !== "" && data[i][0] !== undefined;
      const hasClose = data[i][1] !== "" && data[i][1] !== undefined;
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
    const lastDate =
      typeof lastSerial === "number"
        ? serialToDate(lastSerial).toISOString().split("T")[0]
        : null;

    summary.push({
      sheet: sheetName,
      lastDate,
      lastClose: data[lastFilled][1],
      lastAtp: data[lastFilled][2],
      rows: filledCount,
    });
  }

  return summary;
}
