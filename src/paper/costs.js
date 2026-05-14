// costs.js — realistic Indian retail brokerage + tax math for options.
// Calibrated to discount brokers (Zerodha/Angel) ~Q4 2025 rates.
// Apply once per leg (entry = BUY side, exit = SELL side).

const BROKERAGE_FLAT     = 20;        // ₹ per executed order
const STT_SELL_PCT        = 0.000625;  // 0.0625% on sell premium turnover (options)
const TXN_PCT             = 0.000503;  // 0.0503% on premium turnover (both sides, NSE)
const SEBI_PER_CR         = 10;        // ₹10 per crore of turnover
const STAMP_BUY_PCT       = 0.00003;   // 0.003% on buy premium turnover
const GST_PCT             = 0.18;      // 18% on (brokerage + txn + sebi)

/**
 * Compute total costs for ONE leg of an options trade.
 * @param {number} premium  per-share premium in ₹
 * @param {number} qty      total contracts (= lots × lotSize)
 * @param {"BUY"|"SELL"} side
 * @returns {{ total:number, breakdown:object }}
 */
export function computeLegCosts(premium, qty, side) {
  const turnover = Math.max(0, premium * qty);
  const brokerage = BROKERAGE_FLAT;
  const txn = turnover * TXN_PCT;
  const sebi = (turnover / 1e7) * SEBI_PER_CR;
  const stt = side === "SELL" ? turnover * STT_SELL_PCT : 0;
  const stamp = side === "BUY" ? turnover * STAMP_BUY_PCT : 0;
  const gst = (brokerage + txn + sebi) * GST_PCT;
  const total = brokerage + txn + sebi + stt + stamp + gst;
  return {
    total: round2(total),
    breakdown: {
      brokerage: round2(brokerage),
      txn: round2(txn),
      sebi: round2(sebi),
      stt: round2(stt),
      stamp: round2(stamp),
      gst: round2(gst),
    },
  };
}

/**
 * Round-trip costs for a complete BUY → SELL options trade.
 * @returns {{ total:number, entry:object, exit:object }}
 */
export function computeRoundTripCosts(entryPremium, exitPremium, qty) {
  const entry = computeLegCosts(entryPremium, qty, "BUY");
  const exit  = computeLegCosts(exitPremium, qty, "SELL");
  return {
    total: round2(entry.total + exit.total),
    entry,
    exit,
  };
}

function round2(v) { return Math.round(v * 100) / 100; }
