// Express server for Angel One login + WEEKLY.xlsx generation.

import "dotenv/config";
import express from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";
import pino from "pino";
import { loginAngelOne } from "./brokers/angelone.js";
import {
  loadInstruments,
  resolveToken,
  fetchQuotes,
  fetchHistoricalDaily,
} from "./brokers/angelMarketData.js";
import {
  planUpdates,
  applyUpdates,
  getXlsxPath,
  getSheetSummary,
} from "./sheetUpdater.js";
import {
  resolveTargetDate,
  fmtISO,
  todayDateIST,
  isAfterMarketSettle,
  nowIST,
} from "./dateUtils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = pino({ level: process.env.LOG_LEVEL || "info" });

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/api/angel/defaults", (_req, res) => {
  res.json({
    apiKey: process.env.ANGEL_API_KEY || "",
    clientCode: process.env.ANGEL_CLIENT_CODE || "",
    hasPin: Boolean(process.env.ANGEL_PIN),
  });
});

app.post("/api/angel/login", async (req, res) => {
  const apiKey = req.body.apiKey || process.env.ANGEL_API_KEY;
  const clientCode = req.body.clientCode || process.env.ANGEL_CLIENT_CODE;
  const pin = req.body.pin || process.env.ANGEL_PIN;
  const totp = req.body.totp;

  try {
    const out = await loginAngelOne({ apiKey, clientCode, pin, totp });
    log.info({ clientCode }, "angel login ok");
    res.json({ ok: true, ...out });
  } catch (err) {
    log.warn({ err: err.message }, "angel login failed");
    res
      .status(401)
      .json({ ok: false, error: err.message, raw: err.raw || null });
  }
});

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({ ok: false, error: "No token provided" });
  }
  const token = auth.slice(7);
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64").toString()
    );
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      return res.status(401).json({ ok: false, error: "Token expired" });
    }
    req.jwtToken = token;
    next();
  } catch {
    return res.status(401).json({ ok: false, error: "Invalid token" });
  }
}

// ---------- Sheet endpoints ----------

app.get("/api/angel/summary", authMiddleware, async (_req, res) => {
  try {
    const summary = getSheetSummary();
    const target = resolveTargetDate();
    res.json({
      ok: true,
      data: summary,
      targetDate: fmtISO(target.target),
      targetReason: target.reason,
      isToday: target.isToday,
      marketSettled: isAfterMarketSettle(),
    });
  } catch (err) {
    log.warn({ err: err.message }, "summary failed");
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * Generate today/backfill data and update WEEKLY.xlsx.
 *
 * Logic:
 *   1. Resolve targetDate (today after market close, else previous trading day).
 *   2. For each sheet, plan missing trading dates (capped to last 5).
 *   3. Group dates per symbol — fetch all needed data:
 *      - Today's data (target == today): FULL quote API → exact ATP (avgPrice)
 *      - Past dates: historical candle API → ATP ≈ (O+H+L+C)/4
 *   4. Apply updates chronologically so nDATP rolling averages chain correctly.
 */
app.post("/api/angel/generate", authMiddleware, async (req, res) => {
  const apiKey = req.body.apiKey || process.env.ANGEL_API_KEY;
  if (!apiKey) {
    return res.status(400).json({ ok: false, error: "apiKey is required" });
  }

  try {
    // Step 1 — resolve target date
    const targetInfo = resolveTargetDate();
    const targetDate = targetInfo.target;
    const todayDate = todayDateIST();
    const targetIsToday = targetDate.getTime() === todayDate.getTime();

    log.info(
      {
        target: fmtISO(targetDate),
        isToday: targetIsToday,
        reason: targetInfo.reason,
      },
      "target date resolved"
    );

    // Step 2 — plan per-sheet
    const { plans } = planUpdates(targetDate);

    // Collect unique (symbol, dates) pairs
    const symbolToDates = new Map(); // tradingSymbol -> Set<isoDate>
    for (const p of plans) {
      if (!p.tradingSymbol || p.datesToFill.length === 0) continue;
      if (!symbolToDates.has(p.tradingSymbol)) {
        symbolToDates.set(p.tradingSymbol, new Set());
      }
      const set = symbolToDates.get(p.tradingSymbol);
      for (const { date } of p.datesToFill) set.add(fmtISO(date));
    }

    if (symbolToDates.size === 0) {
      return res.json({
        ok: true,
        targetDate: fmtISO(targetDate),
        targetReason: targetInfo.reason,
        updatedSheets: [],
        alreadyFilled: plans.filter(p => p.datesToFill && p.datesToFill.length === 0).map(p => p.sheetName),
        skippedSheets: [],
        missingData: [],
        message: "All sheets already up-to-date.",
      });
    }

    // Step 3 — load instrument master, resolve tokens
    log.info("loading Angel One instrument master...");
    const instruments = await loadInstruments();

    const symbolInstruments = {}; // tradingSymbol -> { exchange, token }
    const unresolved = [];
    for (const sym of symbolToDates.keys()) {
      const inst = resolveToken(instruments, sym);
      if (inst) symbolInstruments[sym] = inst;
      else unresolved.push(sym);
    }
    if (unresolved.length) log.warn({ unresolved }, "tokens unresolved");

    // Step 4 — fetch data
    // dataBySymbolDate: { tradingSymbol: { 'YYYY-MM-DD': { close, atp } } }
    const dataBySymbolDate = {};
    const todayISO = fmtISO(todayDate);

    // 4a — Today's data via FULL quote (exact VWAP), only when target is today
    const symbolsNeedingToday = [];
    for (const [sym, dates] of symbolToDates) {
      if (dates.has(todayISO) && targetIsToday) symbolsNeedingToday.push(sym);
    }
    // Track which symbols still need today's data (e.g. indices where avgPrice
    // is 0 / unavailable from the quote API — fallback to historical below).
    const symbolsNeedingTodayHistorical = new Set();

    if (symbolsNeedingToday.length > 0) {
      const tokens = symbolsNeedingToday
        .filter((s) => symbolInstruments[s])
        .map((s) => ({
          exchange: symbolInstruments[s].exchange,
          token: symbolInstruments[s].token,
          symbol: s,
        }));
      log.info({ count: tokens.length }, "fetching today's quotes (FULL mode)");
      const quotes = await fetchQuotes(req.jwtToken, apiKey, tokens);
      for (const sym of symbolsNeedingToday) {
        const q = quotes[sym];
        // Use LTP as today's Close — Angel One's q.close is the PREVIOUS day's
        // close (verified empirically: q.close on 2026-04-30 returned 04-29's close).
        const closeVal = q && (q.ltp ?? q.close);
        // For indices, q.avgPrice comes back as 0 (not null) — treat <= 0 as
        // unavailable so we fall back to historical OHLC.
        const validAtp =
          q && q.avgPrice != null && !isNaN(q.avgPrice) && q.avgPrice > 0;
        if (!q || !closeVal || !validAtp) {
          // Fall back to historical candle for today's data
          symbolsNeedingTodayHistorical.add(sym);
          continue;
        }
        if (!dataBySymbolDate[sym]) dataBySymbolDate[sym] = {};
        dataBySymbolDate[sym][todayISO] = {
          close: closeVal,
          atp: q.avgPrice,
        };
      }
    }

    // 4b — Historical data via candle API (ATP approximated as (O+H+L+C)/4).
    // For each symbol: include past dates ALWAYS, plus today if quote API
    // didn't supply a usable avgPrice (indices fall here).
    for (const [sym, datesSet] of symbolToDates) {
      const dates = [...datesSet].filter((d) => {
        if (d !== todayISO) return true; // past dates always
        // Today: include if it wasn't satisfied by quote API
        return symbolsNeedingTodayHistorical.has(sym) || !targetIsToday;
      });
      if (dates.length === 0) continue;
      const inst = symbolInstruments[sym];
      if (!inst) continue;

      const sortedDates = dates.sort();
      const fromDate = new Date(sortedDates[0] + "T00:00:00Z");
      const toDate = new Date(sortedDates[sortedDates.length - 1] + "T00:00:00Z");

      try {
        const candles = await fetchHistoricalDaily(
          req.jwtToken,
          apiKey,
          inst,
          fromDate,
          toDate
        );
        if (!dataBySymbolDate[sym]) dataBySymbolDate[sym] = {};
        for (const c of candles) {
          if (!datesSet.has(c.date)) continue;
          // Don't overwrite a value already set from FULL quote (more accurate ATP)
          if (dataBySymbolDate[sym][c.date]) continue;
          // ATP ≈ (O+H+L+C) / 4 — historical proxy for VWAP since candle API
          // doesn't return avgPrice
          const atp = (c.open + c.high + c.low + c.close) / 4;
          dataBySymbolDate[sym][c.date] = {
            close: c.close,
            atp: Math.round(atp * 100) / 100,
          };
        }
      } catch (err) {
        log.warn(
          { sym, err: err.message },
          "historical fetch failed for symbol"
        );
      }

      // Rate-limit: small delay between historical calls
      await new Promise((r) => setTimeout(r, 350));
    }

    // Step 5 — apply updates
    log.info("applying XLSX updates...");
    const result = applyUpdates(plans, dataBySymbolDate, targetDate);

    res.json({
      ok: true,
      targetDate: fmtISO(targetDate),
      targetReason: targetInfo.reason,
      isToday: targetIsToday,
      ...result,
      unresolvedSymbols: unresolved,
    });
  } catch (err) {
    log.error({ err: err.message, raw: err.raw }, "generate failed");
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/angel/upload — replace WEEKLY.xlsx with a user-uploaded file.
// Used when the user has filled many missed days locally and wants to upload
// the catch-up version, so the next /generate only needs to fill recent days.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB cap
});

app.post(
  "/api/angel/upload",
  authMiddleware,
  upload.single("file"),
  (req, res) => {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ ok: false, error: "No file uploaded" });
    }

    // Validate it's a real XLSX with the expected sheet structure
    let wb;
    try {
      wb = XLSX.read(req.file.buffer, { type: "buffer" });
    } catch (err) {
      return res
        .status(400)
        .json({ ok: false, error: "Not a valid XLSX file: " + err.message });
    }

    if (!wb.SheetNames || wb.SheetNames.length === 0) {
      return res
        .status(400)
        .json({ ok: false, error: "Uploaded XLSX has no sheets" });
    }

    // Sanity check: at least NIFTY-50 sheet should exist
    if (!wb.SheetNames.includes("NIFTY-50")) {
      return res.status(400).json({
        ok: false,
        error:
          "Uploaded XLSX is missing the 'NIFTY-50' sheet — doesn't look like a WEEKLY.xlsx",
      });
    }

    const xlsxPath = getXlsxPath();

    // Backup current file before overwrite (timestamped, in same dir)
    try {
      if (fs.existsSync(xlsxPath)) {
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const backupPath = xlsxPath.replace(/\.xlsx$/, `.backup-${ts}.xlsx`);
        fs.copyFileSync(xlsxPath, backupPath);
      }
      fs.writeFileSync(xlsxPath, req.file.buffer);
    } catch (err) {
      log.error({ err: err.message }, "upload write failed");
      return res
        .status(500)
        .json({ ok: false, error: "Could not save file: " + err.message });
    }

    log.info(
      { sheets: wb.SheetNames.length, size: req.file.buffer.length },
      "WEEKLY.xlsx replaced from upload"
    );

    res.json({
      ok: true,
      sheetsInUpload: wb.SheetNames.length,
      message: "WEEKLY.xlsx replaced. Click Generate to fill remaining days.",
    });
  }
);

app.get("/api/angel/download", authMiddleware, (_req, res) => {
  const xlsxPath = getXlsxPath();
  res.download(xlsxPath, "WEEKLY.xlsx", (err) => {
    if (err) {
      log.warn({ err: err.message }, "download failed");
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: "Download failed" });
      }
    }
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () =>
  log.info({ port, now: nowIST().toISOString() }, "angel-one server listening")
);
