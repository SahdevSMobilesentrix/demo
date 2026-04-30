// Express server for Angel One login + WEEKLY_FNO sheet management.

import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { loginAngelOne } from "./brokers/angelone.js";
import {
  loadInstruments,
  resolveToken,
  fetchQuotes,
} from "./brokers/angelMarketData.js";
import {
  updateXlsx,
  getXlsxPath,
  getSheetSummary,
} from "./sheetUpdater.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = pino({ level: process.env.LOG_LEVEL || "info" });

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/health", (_req, res) => res.json({ ok: true }));

// Prefill the form from .env so the user only has to type the TOTP.
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
    res.status(401).json({ ok: false, error: err.message, raw: err.raw || null });
  }
});

// Auth middleware — checks JWT expiry
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
    req.tokenPayload = payload;
    next();
  } catch {
    return res.status(401).json({ ok: false, error: "Invalid token" });
  }
}

// ---------- Sheet endpoints ----------

// GET /api/angel/summary — returns per-sheet last date, close, ATP
app.get("/api/angel/summary", authMiddleware, async (_req, res) => {
  try {
    const summary = getSheetSummary();
    res.json({ ok: true, data: summary });
  } catch (err) {
    log.warn({ err: err.message }, "summary failed");
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/angel/generate — fetch quotes, calculate ATP, update XLSX
app.post("/api/angel/generate", authMiddleware, async (req, res) => {
  const apiKey = req.body.apiKey || process.env.ANGEL_API_KEY;
  if (!apiKey) {
    return res.status(400).json({ ok: false, error: "apiKey is required" });
  }

  try {
    log.info("loading instrument master...");
    const instruments = await loadInstruments();

    // Read the sheet summary to know which symbols we need
    const summary = getSheetSummary();
    const overrides = (
      await import("fs")
    ).default.existsSync(
      path.join(__dirname, "..", "data", "symbol_overrides.json")
    )
      ? JSON.parse(
          (await import("fs")).default.readFileSync(
            path.join(__dirname, "..", "data", "symbol_overrides.json"),
            "utf8"
          )
        )
      : {};

    // Resolve all symbols to Angel One tokens
    const tokenList = [];
    const symbolMap = {}; // sheetName -> tradingSymbol

    for (const s of summary) {
      let tradingSymbol;
      if (s.sheet in overrides) {
        if (overrides[s.sheet] === null) continue;
        tradingSymbol = overrides[s.sheet];
      } else {
        tradingSymbol = s.sheet;
      }
      symbolMap[s.sheet] = tradingSymbol;

      const inst = resolveToken(instruments, tradingSymbol);
      if (inst) {
        tokenList.push({
          exchange: inst.exchange,
          token: inst.token,
          symbol: tradingSymbol,
        });
      } else {
        log.warn({ tradingSymbol, sheet: s.sheet }, "could not resolve token");
      }
    }

    log.info({ count: tokenList.length }, "fetching quotes from Angel One...");
    const quotes = await fetchQuotes(req.jwtToken, apiKey, tokenList);
    log.info(
      { fetched: Object.keys(quotes).length },
      "quotes fetched, updating XLSX..."
    );

    const result = updateXlsx(quotes);
    log.info(result, "XLSX updated");

    res.json({ ok: true, ...result });
  } catch (err) {
    log.error({ err: err.message, raw: err.raw }, "generate failed");
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/angel/download — download the WEEKLY_FNO.xlsx file
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
app.listen(port, () => log.info({ port }, "angel-one server listening"));
