// Sheet-name -> NSE tradingsymbol -> broker security IDs.
//
// The sheet names in WEEKLY_FNO.xlsx are mostly NSE tradingsymbols already.
// Where they differ, data/symbol_overrides.json supplies a mapping.
// A null value in the overrides means "skip this sheet".

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const overridesPath = path.join(__dirname, "..", "data", "symbol_overrides.json");

const overrides = JSON.parse(fs.readFileSync(overridesPath, "utf8"));

export function sheetToTradingSymbol(sheetName) {
  if (Object.prototype.hasOwnProperty.call(overrides, sheetName)) {
    return overrides[sheetName]; // may be null → skip
  }
  return sheetName;
}

export function isIndexSheet(sheetName) {
  return sheetName === "NIFTY-50" || sheetName === "BANKNIFTY";
}
