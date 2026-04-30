# weekly-fno-bot

Manual daily updater for `WEEKLY_FNO.xlsx`. Open the page, type the
WhatsApp number (and an AngelOne TOTP if you want the fallback), click
**Send**. The server fetches close + ATP for every sheet via Dhan
(with AngelOne fallback if a TOTP was supplied), appends a new row
preserving all existing Excel formulas, and delivers the dated
workbook on WhatsApp via Meta Cloud API.

No cron — AngelOne TOTPs expire in 30 s, so the trigger is always
human-in-the-loop.

## Local run

```bash
cp .env.example .env       # fill in Dhan + WhatsApp creds + RUN_TOKEN
npm ci
DATA_DIR=./tmp-data RUN_DRY=1 npm start
# open http://localhost:3000 in a browser
```

`RUN_DRY=1` skips the WhatsApp send. Inspect
`./tmp-data/WEEKLY_FNO.xlsx` afterwards to confirm a new row was
appended to every sheet.

## Render deployment

1. Push this folder to a GitHub repo.
2. In Render, **New → Blueprint** and point it at the repo. The
   [render.yaml](render.yaml) sets up:
   - Web service on Node 20 (Starter plan; free tier sleeps and would
     miss the 19:00 IST cron tick).
   - 1 GB persistent disk mounted at `/data`.
3. Fill the secret env vars in the Render dashboard:
   `RUN_TOKEN`, `DHAN_*`, `ANGELONE_*`, `WHATSAPP_*`. See
   [.env.example](.env.example) for the full list.
4. First boot copies [seed/WEEKLY_FNO.xlsx](seed/WEEKLY_FNO.xlsx) to
   `/data/WEEKLY_FNO.xlsx`. After that, the live workbook is the disk
   copy and the seed is ignored.
5. Hit `POST /run` with the Bearer token to confirm end-to-end
   delivery before relying on the schedule.

## Required credentials

### Dhan (primary data source)
- Log in at <https://web.dhan.co>, go to **My Profile → DhanHQ Trading APIs → Access DhanHQ APIs**.
- Generate `client_id` (your Dhan ID) and `access_token` (30-day token).
- Set `DHAN_CLIENT_ID` and `DHAN_ACCESS_TOKEN`.

### AngelOne SmartAPI (fallback)
- Log in at <https://smartapi.angelbroking.com>, create a "Trading" or "Market Feed" app.
- Copy the API key (`ANGELONE_API_KEY`).
- Use your client code (`ANGELONE_CLIENT_CODE`) and trading PIN (`ANGELONE_PIN`).
- Enable TOTP in your Angel account; save the 32-char base32 secret as `ANGELONE_TOTP_SECRET`.

### Meta WhatsApp Cloud API
- Create a Meta Business app at <https://developers.facebook.com>.
- Add the **WhatsApp** product. Note the **Phone number ID**
  (`WHATSAPP_PHONE_NUMBER_ID`).
- Generate a **System User permanent token** with `whatsapp_business_messaging`
  scope. Save as `WHATSAPP_TOKEN`.
- Register your personal WhatsApp number under "To" recipients (or
  send yourself a message from WhatsApp first to open the 24-hour
  customer-care window). Save in E.164 form as `WHATSAPP_TO`,
  e.g. `+9198xxxxxxxx`.

## Endpoints

- `GET  /`         — HTML form (number + optional TOTP + access-token field).
- `GET  /health`   — liveness.
- `GET  /last-run` — last job status JSON.
- `POST /send`     — body `{ to, totp?, token }`. `to` must be E.164 (`+91…`),
  `token` must equal `RUN_TOKEN` env var. `totp` is optional; only needed if
  Dhan misses a symbol and you want the AngelOne fallback to log in.

## Open questions

- The `Vaswani` sheet is currently set to `null` in
  [data/symbol_overrides.json](data/symbol_overrides.json) (skipped).
  If it should track a real listed symbol, change the value to the
  exchange tradingsymbol.

## Notes on formulas

`exceljs` does not evaluate formulas server-side — it preserves them.
The cached values stay stale until the file is opened in Excel /
Google Sheets / LibreOffice, which recomputes on open. This is
intentional: you receive the file on WhatsApp and your spreadsheet
app refreshes the SIGNAL / DAY / TRADE columns automatically.

If you ever want server-side recalculation (e.g. to render a text
summary), add a one-shot LibreOffice headless step before sending:
`soffice --headless --calc --convert-to xlsx /data/WEEKLY_FNO.xlsx`.
