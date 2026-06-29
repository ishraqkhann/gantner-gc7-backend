# Gantner GC7.3000 — Production WebSocket Backend

> 🤖 **Running Claude Code on the gym PC?** Read **[ONSITE-CLAUDE-BRIEF.md](ONSITE-CLAUDE-BRIEF.md)** first — it's the full context + on-site test plan.

Express + WebSocket backend (Node.js + TypeScript) for **Gantner GC7.3000** access
controllers using the **External Webserver** JSON protocol.

Target production endpoint (Render):

```
wss://gantner-gc7-backend.onrender.com/gantner   (WebSocket — GC7 connects here)
https://gantner-gc7-backend.onrender.com/health  (health check → { "ok": true })
```

Decisions are delegated to **Clap House** (`https://app.claphouse.co`), the source
of truth for access.

> Replaces the controller's current External Webserver target
> `wss://7backend2026.sevenwellness.club`.

---

## What it does

| # | Behaviour |
|---|-----------|
| 1 | Express HTTP server |
| 2 | `GET /health` → `{ "ok": true }` |
| 3 | WebSocket endpoint at `/gantner` (server accepts any path, so a bare host works too) |
| 4 | Accepts GC7 WebSocket connections; logs connection IP + headers |
| 5 | Logs **every** inbound message — raw **and** parsed (pino → stdout + file) |
| 6 | Responds to `Heartbeat` (exact required format) |
| 7 | Responds to `Login` with `State: 0`, `Data: {}` |
| 8 | Detects access/scan messages by `Cmd`/`Data` containing: `Tag`, `Barcode`, `Identification`, `Reader`, `Card`, `Access`, `CheckIn`, `FIU`, `IO.TagInReader`, `IO.InvalidTagInReader` |
| 9 | **Decides access via Clap House** (source of truth): forwards the raw scanned QR token to `POST {CLAPHOUSE_VALIDATE_URL}` and opens only on `{ result: "granted" }`. No local allow-list. **Fails closed** on any timeout/error. |
| 10 | On a grant, opens the gate with the relay command `IO.SetRelayState` `Data:{ Id, State:true }` (relay pulsed, then auto-closed after `GANTNER_UNLOCK_PULSE_MS`). Gated by `GANTNER_SEND_UNLOCK` (false = shadow mode: validate + record, do not open). |
| 11 | Writes logs to `./logs/gantner-events.log` (token logged only as a SHA-256 fingerprint, never raw) |
| 12 | `GET /status` — live connection/heartbeat/access counters + per-connection `serial`/`gateName`/`idleSeconds` (no identifiers) |
| 13 | `GET /recent` — access **decision feed** `{ at, gateName, decision, denialReason? }` (no token/PII). `?raw=1` returns raw captured packets instead (bring-up; `&all=1` includes heartbeats) |

> **Decision flow:** `Heartbeat` and `Login` get responses. Each scan is
> validated against Clap House and the verdict recorded; the gate opens only on a
> grant and only when `GANTNER_SEND_UNLOCK=true`. A single physical scan emits two
> events (`IO.BarcodeRead` + `IO.TagInReader`) with the same token — the backend
> validates **once** per scan (Clap House single-uses the token's `jti`).

### Message envelope

```jsonc
{ "Cmd": "Heartbeat", "MT": "Req", "TID": 123, "Data": {} }
```

* `Cmd` — command (`Heartbeat`, `Login`, `Identification`, …)
* `MT` — `"Req"` (request) or `"Rsp"` (response)
* `TID` — transaction id, echoed back on the matching `Rsp`
* `State` — status code on responses (`0` = OK)
* `Data` — command-specific payload

### Heartbeat response (exactly)

```jsonc
{
  "Cmd": "Heartbeat",
  "MT": "Rsp",
  "TID": 123,              // echoes incoming.TID
  "State": 0,
  "Data": { "HBI": 30, "RT": "2026-06-24T12:00:00.000Z" }  // RT = current ISO timestamp
}
```

### Access decision (Clap House is the source of truth)

On each scan the backend:

1. extracts the **raw scanned token** (`extractScanToken` — `Data.Barcode` /
   `Data.Tag` / `Data.Identification` / `Data.Segments[].Data`; forwarded verbatim,
   never parsed),
2. `POST`s `{ token, gateId }` to `CLAPHOUSE_VALIDATE_URL` with the `x-gate-key`
   header (`validateWithClapHouse`),
3. opens the gate **only** on `{ "result": "granted" }`; every denial / HTTP
   400 / 401 / timeout / network error → **deny** (fail closed),
4. records the decision (`/recent`) and counters (`/status`).

`denialReason` values come straight from Clap House (`invalid_token`, `expired`,
`pending`, `blocked`, `outside_hours`, `replay`, `unknown_qr`), plus local
fail-closed reasons (`timeout`, `unreachable`, `unauthorized`, `bad_request`,
`invalid_read` for an unreadable scan).

> The token is an opaque short-lived (≈35 s) single-use JWT. The backend never
> validates the signature itself — Clap House verifies signature, expiry,
> single-use, approval status and club hours. So **don't cache, queue, or retry**
> tokens; a `denied: invalid_token` is a stale/screenshotted code, not a transient
> error.

### Authentication

The GC7 presents its access token in the **`Authorization` header on the WS
upgrade** (not a JSON Login). Set `GANTNER_ACCESS_TOKEN` to the value configured
on the controller's External Webserver page and the server will reject upgrades
whose header doesn't contain it. Empty (default) = **not enforced** (bring-up).

---

## Project layout

```
src/
  index.ts     Express + HTTP + WebSocket wiring, /gantner routing
  gantner.ts   Message types, access detection, response builders, dispatch
  logger.ts    Structured JSON file log + console mirror
  config.ts    Env / .env loading
scripts/
  test-client.mjs   GC7 simulator (Heartbeat / Login / scan)
Dockerfile          Multi-stage production image
railway.json        Railway deploy config
render.yaml         Render blueprint
.env / .env.example
logs/gantner-events.log   (created at runtime)
```

---

## Run locally

```bash
npm install
npm run build
npm start            # listens on PORT (default 3000)

# in another terminal — simulate a GC7:
npm run test:client                                   # local, scans TEST123456
node scripts/test-client.mjs ws://localhost:3000/gantner HELLO_WORLD
```

Dev mode with reload:

```bash
npm run dev
```

Health check:

```bash
curl http://localhost:3000/health      # {"ok":true}
```

---

## Environment variables

| Var | Default | Notes |
|-----|---------|-------|
| `PORT` | `3000` | Railway/Render inject their own — don't hardcode in prod. |
| `GANTNER_ACCESS_TOKEN` | _(empty)_ | Shared secret the GC7 sends in the `Authorization` header on the WS upgrade. Empty = not enforced. |
| `HEARTBEAT_INTERVAL` | `30` | `HBI` value advertised back to the controller. |
| `CLAPHOUSE_VALIDATE_URL` | `https://app.claphouse.co/api/access/validate` | Clap House access-decision endpoint. |
| `GATE_API_KEY` | _(empty)_ | Sent as `x-gate-key`. Set the **same** value here and in Clap House's Vercel env at the same time (Clap House auto-enforces once set). |
| `CLAPHOUSE_TIMEOUT_MS` | `5000` | Validate-call timeout. On timeout → **deny** (fail closed). |
| `GANTNER_SEND_UNLOCK` | `false` | `false` = shadow mode (validate + record, don't open). `true` = open the gate on a Clap-House grant. |
| `GANTNER_UNLOCK_PULSE_MS` | `3000` | How long the relay stays energized before the backend closes it. |
| `ADMIN_API_KEY` | _(empty)_ | Enables the destructive `/relay/pulse` & `/relay/close-all` endpoints; callers must send it as `x-admin-key`. Empty = those endpoints return `403`. |
| `GANTNER_FALLBACK_RELAY` | `2` | Relay to pulse for a grant on a not-yet-identified controller (all live gates here use relay 2). |
| `GANTNER_LOG_RAW_FRAMES` | `false` | `true` logs full scan frames incl. the live token — **local debug only**. Default redacts token fields. |

`.env` (committed for local dev convenience):

```
PORT=3000
GANTNER_ACCESS_TOKEN=
```

---

## Deploy

The image is platform-agnostic; it binds to `process.env.PORT` and exposes
`/health` for health checks. **Railway is the fastest path** and gives you a
TLS `wss://` URL immediately.

### Option A — Railway (recommended, fastest)

```bash
npm i -g @railway/cli
railway login                 # opens browser
railway init                  # create a new project
railway up                    # build the Dockerfile & deploy
railway domain                # generate a public https/wss domain
railway variables --set GANTNER_ACCESS_TOKEN=...   # optional
```

`railway.json` already pins the Dockerfile builder, the `/health` healthcheck,
and a restart policy.

Railway gives you something like `https://<name>.up.railway.app`. That already
works as `wss://<name>.up.railway.app/gantner`. To use **`api.claphouse.club`**:

1. Railway → service → **Settings → Networking → Custom Domain** → add
   `api.claphouse.club`.
2. Railway shows a **CNAME target**. In the DNS for `claphouse.club`, add:
   `api` **CNAME** → `<the target Railway shows>`.
3. Wait for DNS + automatic TLS (usually a few minutes). Then
   `wss://api.claphouse.club/gantner` is live.

### Option B — Render

1. Push this repo to GitHub.
2. Render → **New → Blueprint** → pick the repo. `render.yaml` provisions a
   Docker web service with the `/health` check.
3. Render → service → **Settings → Custom Domains** → add `api.claphouse.club`,
   then add the **CNAME** it shows to the `claphouse.club` DNS.

> Either platform terminates TLS for you, so the controller connects over
> `wss://` even though the app speaks plain `ws://` internally.

---

## GC7 External Webserver settings

In the controller web UI → **External Webserver** (replacing the current
`wss://7backend2026.sevenwellness.club`):

| Setting | Value |
|---------|-------|
| Protocol | `wss` (TLS) |
| Host / URL | `wss://gantner-gc7-backend.onrender.com` (bare host works; `/gantner` optional) |
| Port | `443` (implicit for `wss`) |
| Path | `/gantner` canonical — server accepts **any** path, so path-less is fine |
| Heartbeat interval | `30` s (server also advertises `HBI: 30`) |
| Token / credential | sent as the `Authorization` header on connect; set `GANTNER_ACCESS_TOKEN` to enforce it (leave empty during bring-up) |

Save and reboot the External Webserver connection. You should immediately see a
`ws.connected` then `Heartbeat` entries in the logs.

---

## View logs

**File (full structured history)** — one JSON object per line:

```bash
tail -f logs/gantner-events.log
```

**Railway:** `railway logs` (CLI) or the **Deployments → Logs** tab. The console
mirror of every event shows up here.

**Render:** service **Logs** tab, or `render logs` via their CLI.

> Note: container filesystems are ephemeral. `logs/gantner-events.log` is the
> source of truth locally; on Railway/Render rely on the platform log stream
> (every event is mirrored to stdout). For durable file logs in prod, mount a
> volume or ship logs to an external sink.

Key events to grep for:

```
ws.message_raw          every raw inbound frame
ws.message_parsed       parsed JSON
gantner.heartbeat       heartbeat answered
gantner.login           login answered
gantner.access          decision: GRANTED | DENIED
gantner.unlock_would_send   the unlock we WOULD send (not sent yet)
```

---

## Test with a QR / scan

Access is now decided by Clap House, so grants depend on a real (approved) member
token, not a fixed string:

1. **Clap House admin → Turnstiles → "Test a scan"** — type a member number; it
   runs the real decision (approved → `granted`; pending → `denied`).
2. A member's live app QR **is** a valid token — present it to a reader wired to a
   GC7 and watch the logs: `ws.message_raw` → `gantner.scan` → `access.granted` /
   `access.denied` (with `denialReason`), then `ws.unlock_sent` on a grant (if
   `GANTNER_SEND_UNLOCK=true`).

No physical reader handy? Simulate a scan frame (the decision will be whatever
Clap House returns for that token — a random string is denied `invalid_token`):

```bash
node scripts/test-client.mjs ws://localhost:3000/gantner "<a real Clap House token>"
```

Watch the decision feed: `curl http://localhost:3000/recent` (or `/recent?raw=1`
for raw packets, `/status` for counters).

---

## Go-live checklist

The Clap House decision flow and the relay door-open are both implemented. To go
live:

1. Deploy with `GANTNER_SEND_UNLOCK=false` first — **shadow mode**: every scan is
   validated against Clap House and recorded to `/recent`/`/status`, but no door
   opens. Confirm grants/denials look right.
2. **The one thing to confirm on the hardware:** that the **External Webserver**
   connection (where this backend lives) actually honours an outbound
   `IO.SetRelayState` Req. The authenticated local `/api` WS does (it's the web
   UI's manual door-open), but the on-site brief never confirmed the External
   Webserver channel does — and it earlier observed scans being decided *locally*,
   not mirrored to this channel. Verify on a **non-production** door first.
3. Set `GATE_API_KEY` to the same 32+ char random value here **and** in Clap
   House's Vercel env at the same time (Clap House auto-enforces it once set).
4. Flip `GANTNER_SEND_UNLOCK=true`.

> Door-open command (confirmed from the controller's own G7 web UI bundle): the
> door is a **relay** — `{ "Cmd":"IO.SetRelayState", "MT":"Req", "Data":{ "Id":<relay>, "State":true } }`.
> The backend pulses it then sends `State:false` after `GANTNER_UNLOCK_PULSE_MS`.
> `App.StartUnlockProcess` does **not** exist on this firmware (3.9.1).
