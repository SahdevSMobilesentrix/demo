// Date utilities — IST timezone, NSE trading day logic, Excel serial conversion.
//
// IMPORTANT: We treat all dates as midnight UTC representations of IST dates
// to avoid timezone drift. e.g. 2026-04-30 IST is stored as Date.UTC(2026,3,30).

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// NSE market hours (IST): 09:15 to 15:30. We use 15:45 as "data settled" cutoff
// so we don't try to use today's data while the close cross-trade is still
// being finalized.
const MARKET_CLOSE_HOUR = 15;
const MARKET_CLOSE_MINUTE = 45;

/** Current moment as a Date object adjusted to represent IST wall-clock time. */
export function nowIST() {
  return new Date(Date.now() + IST_OFFSET_MS);
}

/** Today's date in IST as midnight-UTC (date-only). */
export function todayDateIST() {
  const ist = nowIST();
  return new Date(
    Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate())
  );
}

/** True if date (date-only midnight UTC) is Sat or Sun. */
export function isWeekend(d) {
  const dow = d.getUTCDay();
  return dow === 0 || dow === 6;
}

/** True if the given date represents a NSE trading day (weekday only — holidays not tracked). */
export function isTradingDay(d) {
  return !isWeekend(d);
}

/**
 * True if `now` (an IST-wall-clock Date) is after the daily settle cutoff
 * AND today is a trading day. After this point today's data is considered "final".
 */
export function isAfterMarketSettle(istWallClock = nowIST()) {
  if (isWeekend(istWallClock)) return false;
  const h = istWallClock.getUTCHours();
  const m = istWallClock.getUTCMinutes();
  if (h > MARKET_CLOSE_HOUR) return true;
  if (h === MARKET_CLOSE_HOUR && m >= MARKET_CLOSE_MINUTE) return true;
  return false;
}

/** Given a date-only Date, return the prior trading day (skip Sat/Sun). */
export function previousTradingDay(d) {
  const r = new Date(d.getTime());
  do {
    r.setUTCDate(r.getUTCDate() - 1);
  } while (isWeekend(r));
  return r;
}

/** Given a date-only Date, return the next trading day. */
export function nextTradingDay(d) {
  const r = new Date(d.getTime());
  do {
    r.setUTCDate(r.getUTCDate() + 1);
  } while (isWeekend(r));
  return r;
}

/**
 * List of trading days in [from, to] inclusive, both as date-only Dates.
 * Returns chronological order.
 */
export function tradingDaysBetween(from, to) {
  const days = [];
  const cur = new Date(from.getTime());
  while (cur.getTime() <= to.getTime()) {
    if (isTradingDay(cur)) days.push(new Date(cur.getTime()));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

/**
 * Determine the target trading date for "what data should we fill right now".
 *
 *  - During market hours / weekend → most recent completed trading day.
 *  - After market settle on a trading day → today.
 */
export function resolveTargetDate() {
  const today = todayDateIST();
  const wall = nowIST();

  if (isTradingDay(today) && isAfterMarketSettle(wall)) {
    return { target: today, isToday: true, reason: "after market close" };
  }
  // Otherwise use the previous completed trading day
  return {
    target: previousTradingDay(today),
    isToday: false,
    reason: isWeekend(today)
      ? "weekend — using last Friday"
      : "before market close — using previous trading day",
  };
}

/** Convert a date-only Date to Excel serial number. */
export function dateToSerial(d) {
  const epoch = Date.UTC(1899, 11, 30);
  return Math.floor((d.getTime() - epoch) / (24 * 60 * 60 * 1000));
}

/** Convert Excel serial number to a date-only Date. */
export function serialToDate(serial) {
  return new Date(Date.UTC(1899, 11, 30) + serial * 24 * 60 * 60 * 1000);
}

/** YYYY-MM-DD format. */
export function fmtISO(d) {
  return d.toISOString().split("T")[0];
}
