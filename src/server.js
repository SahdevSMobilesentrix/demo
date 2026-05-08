// Express server for Angel One login.
//
// NOTE: The /api/oi/* endpoints (start / stop / state / history / params)
// were removed in this version. The OI bot now runs entirely on-device in
// the OiBotMobile React Native app, which talks to Angel One SmartAPI
// directly. The web UI at /oi.html will return 404 for those endpoints
// and is no longer functional. Login + static file hosting remain.

import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { loginAngelOne } from "./brokers/angelone.js";
import { nowIST } from "./dateUtils.js";

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

const port = process.env.PORT || 3000;
app.listen(port, () =>
  log.info({ port, now: nowIST().toISOString() }, "angel-one server listening")
);
