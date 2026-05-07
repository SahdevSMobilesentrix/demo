// Express server for Angel One login + OI Writing paper-test runner.

import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { loginAngelOne } from "./brokers/angelone.js";
import { nowIST } from "./dateUtils.js";
import { startOiTest, getOiState, stopOiTest } from "./oiRunner.js";
import { getDayWiseHistory, migrateLegacyJson } from "./oiHistory.js";

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

// ---------- OI Writing Test endpoints ----------
// Browser-driven version of src/oiWritingTest.js. Runs in-process; one run
// at a time. Frontend polls /api/oi/state for newest-first ticks/trades.

app.post("/api/oi/start", authMiddleware, async (req, res) => {
  const apiKey = req.body.apiKey;
  if (!apiKey) {
    return res.status(400).json({ ok: false, error: "apiKey is required" });
  }
  try {
    const out = await startOiTest({
      jwtToken: req.jwtToken,
      apiKey,
      minutes: req.body.minutes,
      lots: req.body.lots,
      maxRupees: req.body.maxRupees,
      tradesPerDay: req.body.tradesPerDay,
    });
    res.json(out);
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get("/api/oi/state", authMiddleware, (_req, res) => {
  res.json({ ok: true, ...getOiState() });
});

app.post("/api/oi/stop", authMiddleware, (_req, res) => {
  res.json(stopOiTest());
});

app.get("/api/oi/history", authMiddleware, (_req, res) => {
  try {
    res.json({ ok: true, ...getDayWiseHistory() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// One-time import of any pre-existing JSON history into the new txt DB.
try {
  const m = migrateLegacyJson();
  if (m.migrated > 0) log.info({ count: m.migrated }, "migrated legacy oi_trades.json -> oi_trades.txt");
} catch (err) {
  log.warn({ err: err.message }, "oi history migration skipped");
}

const port = process.env.PORT || 3000;
app.listen(port, () =>
  log.info({ port, now: nowIST().toISOString() }, "angel-one server listening")
);
