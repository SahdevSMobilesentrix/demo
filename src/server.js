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
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { loginAngelOne } from "./brokers/angelone.js";
import { nowIST } from "./dateUtils.js";
import {
  startOiTest,
  stopOiTest,
  getOiState,
  updateOiParams,
} from "./oiRunner.js";
import { getDayWiseHistory } from "./oiHistory.js";

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
    const { lots, maxRupees, tradesPerDay, minutes } = req.body || {};
    const out = await startOiTest({
      jwtToken: req.jwtToken,
      apiKey,
      lots,
      maxRupees,
      tradesPerDay,
      ...(minutes != null ? { minutes } : {}),
    });
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

app.post("/api/oi/params", requireAuth, (req, res) => {
  res.json(updateOiParams(req.body || {}));
});

app.get("/api/oi/history", requireAuth, (_req, res) => {
  try {
    res.json({ ok: true, days: getDayWiseHistory() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () =>
  log.info({ port, now: nowIST().toISOString() }, "angel-one server listening")
);
