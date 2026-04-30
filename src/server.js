// Express server. Open access — no token. The user clicks "Generate" on
// a small HTML page; quotes come from NSE's free EOD CSVs.

import "dotenv/config";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { runDailyJob, readLastRun } from "./job/daily.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = pino({ level: process.env.LOG_LEVEL || "info" });
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/health", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.get("/last-run", (_req, res) => {
  const r = readLastRun();
  if (!r) return res.status(404).json({ error: "no run yet" });
  res.json(r);
});

app.post("/send", async (_req, res) => {
  log.info("manual /send triggered");
  const out = await runDailyJob();
  res.status(out.ok ? 200 : 500).json(out);
});

// Serves the dated xlsx written by the last successful run.
app.get("/download/:name", (req, res) => {
  const name = req.params.name;
  if (!/^WEEKLY_FNO_\d{4}-\d{2}-\d{2}\.xlsx$/.test(name)) {
    return res.status(400).json({ error: "bad filename" });
  }
  const file = path.join("/tmp", name);
  if (!fs.existsSync(file)) {
    return res.status(404).json({ error: "file not found — run /send first" });
  }
  res.download(file, name);
});

// Convenience: download whichever file the most recent run produced.
app.get("/download", (_req, res) => {
  const r = readLastRun();
  if (!r || !r.datedName) {
    return res.status(404).json({ error: "no run yet" });
  }
  const file = path.join("/tmp", r.datedName);
  if (!fs.existsSync(file)) {
    return res.status(404).json({ error: "file gone (tmp cleared); re-run /send" });
  }
  res.download(file, r.datedName);
});

const port = process.env.PORT || 3000;
app.listen(port, () => log.info({ port }, "weekly-fno-bot listening"));
