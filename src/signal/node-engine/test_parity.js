// test_parity.js — exercise the Node engine on synthetic scenarios.
// Run:  node src/signal/node-engine/test_parity.js
//
// Expected:
//   TEST 1 -> BULL signal, score 3
//   TEST 2 -> null

import { evaluate } from "./signalEngine.js";

function makeSnap(tsIso, spot, vix, overrides = {}) {
  const atm = Math.round(spot / 50) * 50;
  const rows = [];
  for (let off = -5; off <= 5; off++) {
    const K = atm + off * 50;
    for (const typ of ["CE", "PE"]) {
      const baseOi = 500000 + Math.abs(off) * 30000;
      const baseVol = 80000;
      const isItm = (typ === "CE" && K < spot) || (typ === "PE" && K > spot);
      const ltp = isItm ? 200 - Math.abs(spot - K) : Math.max(5, Math.abs(spot - K));
      rows.push({
        ts: tsIso,
        symbol: "NIFTY",
        expiry: "2025-05-22",
        strike: K,
        opt_type: typ,
        oi: baseOi,
        volume: baseVol,
        ltp: Number(ltp),
        spot,
        vix,
      });
    }
  }
  // apply OI overrides
  for (const [key, oi] of Object.entries(overrides.oi || {})) {
    const [Kstr, t] = key.split(":");
    const K = Number(Kstr);
    const r = rows.find(x => x.strike === K && x.opt_type === t);
    if (r) r.oi = oi;
  }
  for (const [key, ltp] of Object.entries(overrides.ltp || {})) {
    const [Kstr, t] = key.split(":");
    const K = Number(Kstr);
    const r = rows.find(x => x.strike === K && x.opt_type === t);
    if (r) r.ltp = ltp;
  }
  return { ts: tsIso, rows };
}

function bullScenario() {
  const baseMs = new Date("2025-05-14T10:35:00+05:30").getTime();
  const snaps = [];
  let spot = 22580;
  for (let i = 0; i < 6; i++) {
    const ts = new Date(baseMs + i * 5 * 60 * 1000).toISOString();
    snaps.push(makeSnap(ts, spot, 13.2, {
      oi: {
        "22500:PE": 500000 + 250000 * (i + 1),
        "22450:PE": 530000 + 180000 * (i + 1),
      },
      ltp: {
        "22500:PE": 95 - i * 8,
        "22450:PE": 70 - i * 5,
      },
    }));
    spot += 5;
  }
  return snaps;
}

function neutralScenario() {
  const baseMs = new Date("2025-05-14T10:35:00+05:30").getTime();
  const snaps = [];
  let spot = 22580;
  for (let i = 0; i < 6; i++) {
    const ts = new Date(baseMs + i * 5 * 60 * 1000).toISOString();
    snaps.push(makeSnap(ts, spot, 13.2));
    spot += (i % 2 ? -2 : 3);
  }
  return snaps;
}

function run() {
  console.log("=".repeat(70));
  console.log("TEST 1 — BULLISH synthetic (Node engine)");
  console.log("=".repeat(70));
  const bullSnaps = bullScenario();
  const last = bullSnaps[bullSnaps.length - 1];
  const r1 = evaluate({
    symbol: "NIFTY",
    snaps: bullSnaps,
    baseline: [],
    now: new Date(last.ts),
  });
  console.log(JSON.stringify(r1, null, 2));

  console.log();
  console.log("=".repeat(70));
  console.log("TEST 2 — NEUTRAL synthetic (Node engine)");
  console.log("=".repeat(70));
  const neuSnaps = neutralScenario();
  const last2 = neuSnaps[neuSnaps.length - 1];
  const r2 = evaluate({
    symbol: "NIFTY",
    snaps: neuSnaps,
    baseline: [],
    now: new Date(last2.ts),
  });
  console.log(JSON.stringify(r2, null, 2));
}

run();
