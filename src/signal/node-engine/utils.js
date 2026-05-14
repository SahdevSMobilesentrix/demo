// utils.js — pure helpers, no I/O.

export const STRIKE_STEP = {
  NIFTY: 50,
  BANKNIFTY: 100,
  FINNIFTY: 50,
  MIDCPNIFTY: 25,
  SENSEX: 100,
};

export const LOT_SIZE = {
  NIFTY: 75,
  BANKNIFTY: 30,
  FINNIFTY: 65,
  MIDCPNIFTY: 120,
  SENSEX: 20,
};

export function istNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
}

// IST-equivalent Date from any input (ISO string or Date). The returned Date's
// getHours/getMinutes match IST wall-clock.
export function toIST(input) {
  const d = input instanceof Date ? input : new Date(input);
  return new Date(d.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
}

export function atmStrike(spot, symbol) {
  const step = STRIKE_STEP[symbol.toUpperCase()];
  if (!step) throw new Error(`Unknown symbol: ${symbol}`);
  return Math.round(spot / step) * step;
}

export function strikeOffset(strike, atm, symbol) {
  const step = STRIKE_STEP[symbol.toUpperCase()];
  return Math.round((strike - atm) / step);
}

// "HHMM" bucket id in 5-min slots, IST-based
export function timeBucket(ts, bucketMin = 5) {
  const ist = toIST(ts);
  const h = String(ist.getHours()).padStart(2, "0");
  const m = String(Math.floor(ist.getMinutes() / bucketMin) * bucketMin).padStart(2, "0");
  return `${h}${m}`;
}

export function inSignalWindow(ts, start = [9, 45], end = [14, 0]) {
  const ist = toIST(ts || new Date());
  const wd = ist.getDay();
  if (wd === 0 || wd === 6) return false;
  const minutes = ist.getHours() * 60 + ist.getMinutes();
  return minutes >= start[0] * 60 + start[1] && minutes <= end[0] * 60 + end[1];
}

export function marketOpen(ts) {
  const ist = toIST(ts || new Date());
  if (ist.getDay() === 0 || ist.getDay() === 6) return false;
  const m = ist.getHours() * 60 + ist.getMinutes();
  return m >= 9 * 60 + 15 && m <= 15 * 60 + 30;
}

export function safeDiv(num, den, def = 0) {
  if (num == null || den == null) return def;
  if (Math.abs(den) < 1e-9) return def;
  return num / den;
}

export function pctChange(now, old) {
  return safeDiv(now - old, old, 0) * 100;
}

export function median(values) {
  const vs = values.filter(v => v != null && Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (vs.length === 0) return 0;
  const mid = Math.floor(vs.length / 2);
  return vs.length % 2 === 1 ? vs[mid] : (vs[mid - 1] + vs[mid]) / 2;
}

// IST ISO date "YYYY-MM-DD" from a timestamp/Date
export function istDateKey(ts) {
  const ist = toIST(ts || new Date());
  const y = ist.getFullYear();
  const m = String(ist.getMonth() + 1).padStart(2, "0");
  const d = String(ist.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}
