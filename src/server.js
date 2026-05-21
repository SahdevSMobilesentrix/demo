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
import nodeCrypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { loginAngelOne, refreshAngelSession } from "./brokers/angelone.js";
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
import { csvFileFor, listDiagnosticsDays } from "./signal/diagnostics.js";
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
app.use("/learning", express.static(path.join(__dirname, "..", "learning")));

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

// Shared session: once one user logs in, anyone visiting the site uses the
// same active session (no re-login) until the JWT expires.
//
// Stored encrypted on disk (AES-256-GCM, binary blob). The filename and
// contents are intentionally opaque so a casual extractor can't read or
// reuse the tokens directly. Key is derived from SESSION_SECRET (env) plus
// a per-machine fingerprint; rotating the env var invalidates old blobs.
const SESSION_FILE = path.join(process.cwd(), "data", ".rt.cache");
// Internal secret used to derive the AES key for the on-disk session blob.
// Kept as a module-local constant (no env var needed). Change this string
// to invalidate any previously cached session.
const SESSION_SECRET = "oi-bot-9f3c4d2a-7b1e-48d0-9c6f-2a5b8e1d0f74";
const SESSION_KEY = nodeCrypto.scryptSync(
  SESSION_SECRET + "|" + os.hostname() + "|" + os.platform(),
  "oi-session-salt-v1",
  32
);
function jwtExpMs(jwt) {
  try {
    const payload = JSON.parse(
      Buffer.from(jwt.split(".")[1], "base64").toString("utf8")
    );
    return payload.exp ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}
function encryptSession(obj) {
  const iv = nodeCrypto.randomBytes(12);
  const cipher = nodeCrypto.createCipheriv("aes-256-gcm", SESSION_KEY, iv);
  const pt = Buffer.from(JSON.stringify(obj), "utf8");
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  // layout: magic(4) | iv(12) | tag(16) | ciphertext
  return Buffer.concat([Buffer.from([0x4f, 0x49, 0x01, 0x00]), iv, tag, ct]);
}
function decryptSession(buf) {
  if (!buf || buf.length < 4 + 12 + 16) return null;
  if (buf[0] !== 0x4f || buf[1] !== 0x49) return null;
  const iv = buf.subarray(4, 16);
  const tag = buf.subarray(16, 32);
  const ct = buf.subarray(32);
  try {
    const decipher = nodeCrypto.createDecipheriv("aes-256-gcm", SESSION_KEY, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return JSON.parse(pt.toString("utf8"));
  } catch {
    return null;
  }
}
function saveSharedSession(s) {
  try {
    nodeFs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    nodeFs.writeFileSync(SESSION_FILE, encryptSession(s));
  } catch (e) {
    log.warn({ err: e.message }, "failed to persist shared session");
  }
}
function loadSharedSession() {
  try {
    if (!nodeFs.existsSync(SESSION_FILE)) return null;
    const s = decryptSession(nodeFs.readFileSync(SESSION_FILE));
    if (!s?.jwtToken) return null;
    if (jwtExpMs(s.jwtToken) <= Date.now()) return null;
    return s;
  } catch {
    return null;
  }
}

function clearSharedSession() {
  try { if (nodeFs.existsSync(SESSION_FILE)) nodeFs.unlinkSync(SESSION_FILE); } catch {}
}

// Restart the OI runner with a freshly-rotated JWT. The runner closes over
// its jwtToken, so we stop it, wait for it to wind down, then start again.
async function restartOiWithToken(jwtToken, apiKey) {
  try {
    stopOiTest();
    // Wait up to ~6s for the runner loop to actually exit.
    for (let i = 0; i < 60; i++) {
      const s = getOiState();
      if (!s || s.status === "finished" || s.status === "error" || s.status === "stopped") break;
      await new Promise(r => setTimeout(r, 100));
    }
    await startOiTest({ jwtToken, apiKey });
  } catch (e) {
    log.warn({ err: e.message }, "oi tracker restart after refresh failed");
  }
}

// Try to rotate the saved session using its refreshToken. Returns the new
// session on success, or null if Angel refused (session is dead → re-login).
async function tryRefreshSharedSession() {
  const cur = loadSharedSessionRaw();
  if (!cur?.refreshToken || !cur?.apiKey) return null;
  try {
    const out = await refreshAngelSession({
      apiKey: cur.apiKey,
      refreshToken: cur.refreshToken,
    });
    const next = {
      jwtToken: out.jwtToken,
      refreshToken: out.refreshToken || cur.refreshToken,
      feedToken: out.feedToken || cur.feedToken,
      apiKey: cur.apiKey,
      savedAt: Date.now(),
    };
    saveSharedSession(next);
    // Migrate in-memory apiKey mapping to the new jwt.
    apiKeyByJwt.delete(cur.jwtToken);
    rememberApiKey(next.jwtToken, next.apiKey);
    log.info("angel session refreshed (new jwt issued)");
    // Restart runner so it uses the new jwt; signal engine is fine to leave.
    restartOiWithToken(next.jwtToken, next.apiKey);
    return next;
  } catch (e) {
    log.warn({ err: e.message }, "angel session refresh failed — forcing re-login");
    clearSharedSession();
    apiKeyByJwt.delete(cur.jwtToken);
    stopOiTest();
    return null;
  }
}

// Variant of loadSharedSession() that returns the blob even if its jwt
// already expired (so we can still grab the refreshToken).
function loadSharedSessionRaw() {
  try {
    if (!nodeFs.existsSync(SESSION_FILE)) return null;
    return decryptSession(nodeFs.readFileSync(SESSION_FILE));
  } catch { return null; }
}

// Scenario 1: proactive refresh. Every minute, if the saved JWT expires in
// under 5 minutes (or is already expired but a refreshToken exists), rotate.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
let refreshing = false;
async function refreshTick() {
  if (refreshing) return;
  const cur = loadSharedSessionRaw();
  if (!cur?.jwtToken || !cur?.refreshToken) return;
  const exp = jwtExpMs(cur.jwtToken);
  if (exp - Date.now() > REFRESH_MARGIN_MS) return;
  refreshing = true;
  try { await tryRefreshSharedSession(); }
  finally { refreshing = false; }
}
setInterval(() => { refreshTick().catch(() => {}); }, 60 * 1000).unref?.();

// Rehydrate apiKey cache + auto-start runners from any saved session. If the
// boot-time JWT is already close to expiring, refresh once before starting.
async function bootFromSession() {
  let s = loadSharedSession();
  if (!s) {
    // Maybe expired but refreshable — try one refresh.
    const raw = loadSharedSessionRaw();
    if (raw?.refreshToken && raw?.apiKey) {
      s = await tryRefreshSharedSession();
    }
  }
  if (!s) return;
  rememberApiKey(s.jwtToken, s.apiKey);
  try {
    const r = await startOiTest({ jwtToken: s.jwtToken, apiKey: s.apiKey });
    log.info({ status: r.status }, "oi tracker resumed from saved session");
  } catch (e) {
    log.warn({ err: e.message }, "oi tracker resume failed");
  }
  try { startSignalAuto({ symbol: "NIFTY" }); } catch {}
}
bootFromSession().catch(() => {});

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

// Shared session endpoint: returns the most recent valid login so any visitor
// can use the app without their own credentials. If the saved JWT is expired
// but a refreshToken is available, transparently rotate it before responding.
app.get("/api/angel/session", async (_req, res) => {
  let s = loadSharedSession();
  if (!s) {
    const raw = loadSharedSessionRaw();
    if (raw?.refreshToken && raw?.apiKey) {
      s = await tryRefreshSharedSession();
    }
  }
  if (!s) return res.json({ ok: false });
  res.json({
    ok: true,
    jwtToken: s.jwtToken,
    refreshToken: s.refreshToken,
    feedToken: s.feedToken,
  });
});

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
    saveSharedSession({
      jwtToken: out.jwtToken,
      refreshToken: out.refreshToken,
      feedToken: out.feedToken,
      apiKey,
      savedAt: Date.now(),
    });
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

// ---- Diagnostics CSV: list available days + download a specific day ----

app.get("/api/signal/diagnostics/days", requireAuth, (req, res) => {
  const symbol = (req.query.symbol || "NIFTY").toString().toUpperCase();
  const days = listDiagnosticsDays(symbol);
  res.json({ symbol, days, count: days.length });
});

app.get("/api/signal/diagnostics.csv", requireAuth, (req, res) => {
  const symbol = (req.query.symbol || "NIFTY").toString().toUpperCase();
  // Accept "YYYY-MM-DD" or "YYYYMMDD"; default = today (IST).
  const rawDate = (req.query.date || "").toString().replace(/-/g, "");
  let date = new Date();
  if (/^\d{8}$/.test(rawDate)) {
    const y = +rawDate.slice(0, 4), m = +rawDate.slice(4, 6) - 1, d = +rawDate.slice(6, 8);
    date = new Date(Date.UTC(y, m, d, 6, 0, 0)); // 06:00 UTC ≈ 11:30 IST — keeps inside day
  }
  const file = csvFileFor(symbol, date);
  if (!nodeFs.existsSync(file)) {
    return res.status(404).json({ ok: false, error: "no_diagnostics_for_date" });
  }
  const dayKey = rawDate || new Date().toISOString().slice(0, 10).replace(/-/g, "");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition",
    `attachment; filename="${symbol}_diagnostics_${dayKey}.csv"`);
  nodeFs.createReadStream(file).pipe(res);
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
