// NSE trading-day calendar.
// Holiday list must be refreshed each year from
// https://www.nseindia.com/resources/exchange-communication-holidays
//
// Dates are IST (Asia/Kolkata) calendar days expressed as YYYY-MM-DD.

const NSE_HOLIDAYS = new Set([
  // 2026 — confirm against the official NSE list before each year flips
  "2026-01-26", // Republic Day
  "2026-02-17", // Mahashivratri
  "2026-03-03", // Holi
  "2026-03-21", // Eid-ul-Fitr (tentative)
  "2026-04-03", // Good Friday
  "2026-04-14", // Dr Ambedkar Jayanti
  "2026-05-01", // Maharashtra Day
  "2026-05-27", // Eid-ul-Adha (tentative)
  "2026-08-15", // Independence Day (Saturday — confirm)
  "2026-08-26", // Ganesh Chaturthi (tentative)
  "2026-10-02", // Gandhi Jayanti
  "2026-11-09", // Diwali Laxmi Pujan (Muhurat tentative)
  "2026-11-25", // Guru Nanak Jayanti
  "2026-12-25", // Christmas
]);

export function istDateString(d = new Date()) {
  // Convert any Date to IST calendar day YYYY-MM-DD.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d);
}

export function istWeekday(d = new Date()) {
  // 0=Sun..6=Sat in IST
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
  });
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[fmt.format(d)];
}

export function isTradingDay(d = new Date()) {
  const wd = istWeekday(d);
  if (wd === 0 || wd === 6) return false;
  return !NSE_HOLIDAYS.has(istDateString(d));
}
