// Express server for Angel One login + the web OI bot.
//
// Two clients use the Angel One login flow independently:
//   - Web UI (public/oi.html) — runs the OI bot server-side via /api/oi/*.
//   - OiBotMobile (React Native) — talks to Angel One SmartAPI directly and
//     does NOT use the /api/oi/* endpoints. It only needs /api/angel/login.
//
// The web UI no longer ships the SmartAPI apiKey on each request. Instead,
// the server keeps a short-lived in-memory map of jwtToken → apiKey, set at
// login time, so /api/oi/start can rehydrate it from the bearer token.

import "dotenv/config";
import express from "express";
import nodeFs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { loginAngelOne } from "./brokers/angelone.js";
import { nowIST } from "./dateUtils.js";
import {
  startOiTest,
  stopOiTest,
  getOiState,
} from "./oiRunner.js";
import {
  runOnce as runSignalOnce,
  startAutoRun as startSignalAuto,
  stopAutoRun as stopSignalAuto,
  getSignalState,
} from "./signalRunner.js";
import {
  getPaperState,
  updateSettings as updatePaperSettings,
  resetCapital as resetPaperCapital,
  exportCsv as exportPaperCsv,
  manualExit as paperManualExit,
} from "./paper/paperTrader.js";
import { marketSnapshot } from "./marketClock.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = pino({ level: process.env.LOG_LEVEL || "info" });

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

// jwtToken → { apiKey, savedAt }. Cleared on logout / TTL.
const apiKeyByJwt = new Map();
const API_KEY_TTL_MS = 24 * 60 * 60 * 1000;
function rememberApiKey(jwt, apiKey) {
  if (!jwt || !apiKey) return;
  apiKeyByJwt.set(jwt, { apiKey, savedAt: Date.now() });
}
function lookupApiKey(jwt) {
  const e = apiKeyByJwt.get(jwt);
  if (!e) return null;
  if (Date.now() - e.savedAt > API_KEY_TTL_MS) {
    apiKeyByJwt.delete(jwt);
    return null;
  }
  return e.apiKey;
}

function bearerToken(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/);
  return m ? m[1].trim() : null;
}

function requireAuth(req, res, next) {
  const jwt = bearerToken(req);
  if (!jwt) return res.status(401).json({ ok: false, error: "missing bearer token" });
  req.jwtToken = jwt;
  next();
}

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
    rememberApiKey(out.jwtToken, apiKey);
    log.info({ clientCode }, "angel login ok");

    // Auto-start OI tracker — no manual Start/Stop needed.
    // The runner self-gates on market hours / weekends / holidays.
    startOiTest({ jwtToken: out.jwtToken, apiKey })
      .then(r => log.info({ status: r.status }, "oi tracker auto-started"))
      .catch(e => log.warn({ err: e.message }, "oi tracker auto-start failed"));

    // Auto-start signal engine auto-run too (already gated on market clock).
    try { startSignalAuto({ symbol: "NIFTY" }); } catch {}

    res.json({ ok: true, ...out });
  } catch (err) {
    log.warn({ err: err.message }, "angel login failed");
    res
      .status(401)
      .json({ ok: false, error: err.message, raw: err.raw || null });
  }
});

// ---- OI bot endpoints (web UI only) ----

app.post("/api/oi/start", requireAuth, async (req, res) => {
  const apiKey = lookupApiKey(req.jwtToken) || process.env.ANGEL_API_KEY;
  if (!apiKey) {
    return res
      .status(401)
      .json({ ok: false, error: "apiKey not found for this session — please log in again" });
  }
  try {
    const out = await startOiTest({ jwtToken: req.jwtToken, apiKey });
    res.json(out);
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post("/api/oi/stop", requireAuth, (_req, res) => {
  res.json(stopOiTest());
});

app.get("/api/oi/state", requireAuth, (_req, res) => {
  res.json(getOiState());
});

// List how many days of OI snapshots are preserved on disk (no auth needed).
app.get("/api/oi/history-days", (_req, res) => {
  try {
    const root = process.env.FNO_DATA_ROOT
      || path.join(process.cwd(), "data", "fno");
    const dir = path.join(root, "snapshots", "NIFTY");
    if (!nodeFs.existsSync(dir)) return res.json({ days: [], count: 0 });
    const files = nodeFs.readdirSync(dir).filter(f => /^\d{8}\.jsonl$/.test(f));
    const days = files.map(f => f.slice(0, 8)).sort().reverse();
    res.json({ days, count: days.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Smart Money Signal endpoints (Python engine bridge) ----

app.get("/api/signal/state", requireAuth, (_req, res) => {
  res.json(getSignalState());
});

app.post("/api/signal/run-now", requireAuth, async (req, res) => {
  const symbol = (req.body?.symbol || "NIFTY").toUpperCase();
  const skipDay = !!req.body?.skipDay;
  const out = await runSignalOnce({ symbol, skipDay });
  res.json(out);
});

app.post("/api/signal/start", requireAuth, (req, res) => {
  const symbol = (req.body?.symbol || "NIFTY").toUpperCase();
  res.json(startSignalAuto({ symbol }));
});

app.post("/api/signal/stop", requireAuth, (_req, res) => {
  res.json(stopSignalAuto());
});

// ---- Paper Trading endpoints ----

app.get("/api/market/status", (_req, res) => {
  res.json(marketSnapshot());
});

app.get("/api/paper/state", requireAuth, (_req, res) => {
  res.json(getPaperState());
});

app.post("/api/paper/settings", requireAuth, (req, res) => {
  try {
    const out = updatePaperSettings(req.body || {});
    res.json({ ok: true, settings: out });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post("/api/paper/exit-now", requireAuth, (_req, res) => {
  res.json(paperManualExit());
});

app.post("/api/paper/reset", requireAuth, (_req, res) => {
  res.json(resetPaperCapital());
});

app.get("/api/paper/export.csv", requireAuth, (_req, res) => {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="paper_trades.csv"');
  res.send(exportPaperCsv());
});

const port = process.env.PORT || 3000;
app.listen(port, () =>
  log.info({ port, now: nowIST().toISOString() }, "angel-one server listening")
);
