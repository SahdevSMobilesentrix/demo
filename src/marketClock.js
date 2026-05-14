// marketClock.js — single source of truth for NSE market hours.
// Used by oiRunner, signalRunner, paperTrader. Reads holiday list from disk.
//
// Status values returned by marketStatus():
//   "open"           - regular session, polling/signals allowed
//   "preopen"        - 09:00–09:15 IST
//   "closed_premarket" - weekday before 09:00
//   "closed_postmarket"- weekday after 15:30
//   "weekend"        - Sat/Sun
//   "holiday"        - NSE holiday (looked up from data/calendar/holidays.json)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const HOLIDAYS_PATH = path.join(PROJECT_ROOT, "data", "calendar", "holidays.json");

// regular session
const REG_OPEN  = [9, 15];
const REG_CLOSE = [15, 30];
// signal-generation window (tighter)
const SIG_OPEN  = [9, 45];
const SIG_CLOSE = [14, 0];

let _holidaysCache = null;
let _holidaysMtime = 0;

function loadHolidays() {
  try {
    const stat = fs.statSync(HOLIDAYS_PATH);
    if (_holidaysCache && stat.mtimeMs === _holidaysMtime) return _holidaysCache;
    const parsed = JSON.parse(fs.readFileSync(HOLIDAYS_PATH, "utf8"));
    const arr = Array.isArray(parsed?.holidays) ? parsed.holidays : [];
    _holidaysCache = new Map(arr.map(h => [h.date, h.name || "holiday"]));
    _holidaysMtime = stat.mtimeMs;
    return _holidaysCache;
  } catch {
    return new Map();
  }
}

function istDate(d = new Date()) {
  return new Date(d.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
}

function istIsoDate(d = new Date()) {
  const ist = istDate(d);
  const y = ist.getFullYear();
  const m = String(ist.getMonth() + 1).padStart(2, "0");
  const dd = String(ist.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export function isWeekend(d = new Date()) {
  const wd = istDate(d).getDay();
  return wd === 0 || wd === 6;
}

export function isHoliday(d = new Date()) {
  const key = istIsoDate(d);
  const hl = loadHolidays();
  return hl.has(key);
}

export function holidayName(d = new Date()) {
  return loadHolidays().get(istIsoDate(d)) || null;
}

function minsOfDay(d) {
  const ist = istDate(d);
  return ist.getHours() * 60 + ist.getMinutes();
}
function asMins([h, m]) { return h * 60 + m; }

export function inRegularSession(d = new Date()) {
  if (isWeekend(d) || isHoliday(d)) return false;
  const m = minsOfDay(d);
  return m >= asMins(REG_OPEN) && m <= asMins(REG_CLOSE);
}

export function inSignalWindow(d = new Date()) {
  if (isWeekend(d) || isHoliday(d)) return false;
  const m = minsOfDay(d);
  return m >= asMins(SIG_OPEN) && m <= asMins(SIG_CLOSE);
}

export function marketStatus(d = new Date()) {
  if (isWeekend(d)) return { status: "weekend", trading: false };
  if (isHoliday(d)) return { status: "holiday", trading: false, holiday: holidayName(d) };
  const m = minsOfDay(d);
  if (m < asMins(REG_OPEN))  return { status: "closed_premarket", trading: false };
  if (m > asMins(REG_CLOSE)) return { status: "closed_postmarket", trading: false };
  return { status: "open", trading: true };
}

export function marketSnapshot(d = new Date()) {
  const ms = marketStatus(d);
  return {
    ...ms,
    nowIST: istIsoDate(d) + " " + istDate(d).toTimeString().slice(0, 8),
    inSignalWindow: inSignalWindow(d),
    isWeekend: isWeekend(d),
    isHoliday: isHoliday(d),
    holidayName: holidayName(d),
  };
}
