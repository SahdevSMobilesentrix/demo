// exceljs append-row + copy-down-formulas.
//
// Each instrument sheet has a header row + N data rows. The data columns are:
//   A=DATE, B=PRICE, C=ATP, D..=2DATP..20DATP, then optionally SIGNAL/DAY/TRADE.
// We append today's row with [date, price, atp] in A:C, and for every column
// >= D that had a formula in the previous row, we copy the formula with all
// relative cell references shifted by +1 row.

import ExcelJS from "exceljs";
import fs from "node:fs";

// Bump every relative cell ref in a formula by `dRow` rows.
// Refs that use $row (absolute) are left untouched.
function shiftFormula(formula, dRow) {
  if (!formula) return formula;
  return formula.replace(
    /(\$?[A-Z]{1,3})(\$?)(\d+)/g,
    (_, col, dollar, row) => {
      if (dollar === "$") return `${col}${dollar}${row}`;
      return `${col}${Number(row) + dRow}`;
    },
  );
}

function lastDataRow(ws) {
  // Walk back from the bottom to find the last row with a value in col A.
  for (let r = ws.rowCount; r >= 2; r--) {
    const v = ws.getRow(r).getCell(1).value;
    if (v !== null && v !== undefined && v !== "") return r;
  }
  return 1; // header only
}

export async function loadWorkbook(filePath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  return wb;
}

export async function saveWorkbook(wb, filePath) {
  await wb.xlsx.writeFile(filePath);
}

// quotes: Map<sheetName, { close: number, atp: number }>
// dateValue: a JS Date (will be written as a real Excel date)
// Returns { updated: [..sheetNames], skipped: [..{sheet, reason}] }
export function appendDailyRow(wb, quotes, dateValue, { log }) {
  const updated = [];
  const skipped = [];

  for (const ws of wb.worksheets) {
    const name = ws.name;
    const q = quotes.get(name);
    if (!q) {
      skipped.push({ sheet: name, reason: "no quote" });
      continue;
    }

    const prevR = lastDataRow(ws);
    const newR = prevR + 1;
    const prevRow = ws.getRow(prevR);
    const newRow = ws.getRow(newR);

    // Detect already-written today: if prevRow's date equals our date, overwrite.
    const prevDate = prevRow.getCell(1).value;
    const sameDay =
      prevDate instanceof Date &&
      prevDate.toISOString().slice(0, 10) ===
        dateValue.toISOString().slice(0, 10);
    const targetRow = sameDay ? prevRow : newRow;
    const targetR = sameDay ? prevR : newR;
    const dRow = sameDay ? 0 : 1;

    targetRow.getCell(1).value = dateValue;
    targetRow.getCell(1).numFmt = "yyyy-mm-dd";
    targetRow.getCell(2).value = q.close;
    targetRow.getCell(3).value = q.atp;

    // Copy-down formulas for columns >= 4 (D..).
    const lastCol = ws.actualColumnCount || prevRow.cellCount;
    for (let c = 4; c <= lastCol; c++) {
      const srcCell = prevRow.getCell(c);
      const srcVal = srcCell.value;
      // exceljs represents formula cells as { formula, result } or { sharedFormula } objects.
      let formula = null;
      if (srcVal && typeof srcVal === "object") {
        if (srcVal.formula) formula = srcVal.formula;
        else if (srcVal.sharedFormula) formula = srcVal.sharedFormula;
      }
      if (!formula) continue;
      const shifted = shiftFormula(formula, dRow);
      targetRow.getCell(c).value = { formula: shifted };
    }

    targetRow.commit();
    updated.push(name);
  }

  log.info({ updated: updated.length, skipped: skipped.length }, "sheet append done");
  return { updated, skipped };
}

export function copyFile(src, dst) {
  fs.copyFileSync(src, dst);
}
