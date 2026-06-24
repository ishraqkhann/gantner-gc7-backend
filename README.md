# Gantner GC7.3000 — Production WebSocket Backend

Express + WebSocket backend (Node.js + TypeScript) for **Gantner GC7.3000** access
controllers using the **External Webserver** JSON protocol.

Target production endpoint:

```
wss://api.claphouse.club/gantner      (WebSocket — GC7 connects here)
https://api.claphouse.club/health     (health check → { "ok": true })
```

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
| 9 | Grants only these identifiers (temporary allow-list): `TEST123456`, `HELLO_WORLD`, `12345678` |
| 10 | Does **not** send an unlock command yet — `placeholderUnlock()` **logs what it would send** (`App.StartUnlockProcess` grant / `App.StartDenyProcess` deny, echoing `Device`) |
| 11 | Writes logs to `./logs/gantner-events.log` |
| 12 | `GET /status` — live connection/heartbeat/access counters (no identifiers) |
| 13 | `GET /recent` — last ~120 captured raw packets (newest first; `?all=1` includes heartbeats) |

> **Capture phase:** only `Heartbeat` and `Login` get responses. Access/scan
> events and everything else (`IO.*`, `FIU.*`, `Addon.*`, `Config.*`) are
> **logged & captured but not answered** — so we can observe the real GC7
> traffic before committing to the online grant/unlock flow. Real scan events
> seen on GC7 v3.9.1 / G7 Advanced Access App: `IO.TagInReader`,
> `IO.InvalidTagInReader`, `FIU.Identification`.

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

### Access decision (current bring-up behaviour)

* Identifier in the allow-list → logs `decision: GRANTED` **and** logs the
  placeholder unlock command under event `gantner.unlock_would_send`
  (⚠️ **not sent** — the real GC7 door-open command is unconfirmed).
* Identifier not in the list → logs `decision: DENIED`.
* Either way the event is acknowledged with a generic `Rsp` (`State: 0`) so the
  controller doesn't retry. **No door is ever opened yet.**

### QR template

The controller's **QR code** config (Mode: Template) is set to:

```
GANTNER#@Id#@Timestamp#@Challenge      →  GANTNER#<Id>#<Timestamp>#<Challenge>
```

`#` is the field separator; `@Name` are substituted values. So a scanned QR
arrives as e.g. `GANTNER#TEST123456#1719230400#a1b2c3d4`. The backend:

* deep-scans the whole message (the value may sit in `Data.Barcode`,
  `Data.IdValue`, or `Data.Segments[].Data`),
* parses the template and matches the **`<Id>`** field against the allow-list,
* logs `<Timestamp>` and `<Challenge>` as **unverified** (`gantner.qr_unverified`).

> ⚠️ The `Challenge` is an anti-forgery token. Until it's cryptographically
> validated (secret/algorithm TBD), a forged `GANTNER#TEST123456#…#…` would pass.
> Fine for bring-up; **must** be enforced before go-live.

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
| `GANTNER_ACCESS_TOKEN` | _(empty)_ | Reserved shared secret for Login. Empty = not enforced during bring-up. |
| `HEARTBEAT_INTERVAL` | `30` | `HBI` value advertised back to the controller. |

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

The allow-list values are plain strings, so any QR/barcode encoding one of these
will be treated as **GRANTED**:

```
TEST123456
HELLO_WORLD
12345678
```

1. Generate a QR for `TEST123456` (any QR generator).
2. Present it to a reader wired to the GC7.
3. Watch the logs: you'll see `ws.message_raw` → `ws.message_parsed` →
   `gantner.access` `decision: GRANTED` → `gantner.unlock_would_send`.

No physical reader handy? Simulate the exact scan frame:

```bash
node scripts/test-client.mjs wss://api.claphouse.club/gantner TEST123456
# or against local:
node scripts/test-client.mjs ws://localhost:3000/gantner 12345678
```

---

## Next step (intentionally not done yet)

The real GC7.3000 door-open / relay command is **not** confirmed, so it is only
logged (`gantner.unlock_would_send`), never sent. The current placeholder uses
`App.StartUnlockProcess` (a **low-confidence** guess from a reverse-engineered
reference implementation — door grant may instead be `App.StartGrantProcess`,
`IO.SetRelayState`, or for lockers the wire-confirmed `App.SetLockState`).

Confirm the real command from the login-gated Gantner DirectConnect spec
(`doc.gantner.com/DirectConnectDocumentation/`) or a packet capture of the
existing `7backend2026.sevenwellness.club` session, then replace the placeholder
in `src/gantner.ts` (the `granted` branch) and send it instead of the generic ack.

> Note: real scan events may also require a one-time `RegisterEvent`
> subscription (`{"Cmd":"RegisterEvent","Data":{"Event":"App.*"}}`) right after
> connect, and `App.PersonIdent` / `App.CardIdent` as the event `Cmd`s. These are
> medium-confidence and should be confirmed against the live controller.
