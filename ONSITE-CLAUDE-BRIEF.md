# On-site Claude Code brief — READ THIS FIRST

You are Claude Code running on a PC **on the gym's LAN**, next to the Gantner
hardware. A prior remote session built and deployed the backend in this repo and
reverse-engineered most of the protocol but kept hitting walls because it could
only see the controllers through the user pasting screenshots. You can now talk
to the hardware directly. This file is your full context — read it, confirm the
network, then continue.

> ⚠️ **Production access control for a real gym.** Observe first. Do **not** change
> any controller config or restart anything on a production controller without
> confirming with the user. Do anything that could affect entry on a **spare/test
> reader or off-hours**. Never lock members out.

---

## TL;DR — where things stand

- A Node/TS Express + `ws` backend (this repo) is **deployed and live** on Render
  at `wss://gantner-gc7-backend.onrender.com/gantner`. One controller is connected
  to it and heartbeating fine.
- **Key finding:** on this hardware the **External Webserver is NOT the access-
  decision channel** — it only gets heartbeats + (if subscribed) event mirrors.
  Scans are decided **locally** by the controller's app using a permission list
  **synced from `gantner.cloud`**.
- **Goal:** the user wants their own backend to **decide who gets in.** Verdict:
  achievable, but via **Path B** (manage the permission/credential list through
  Gantner's management API), **not** by intercepting scans over the WebSocket.
- **Why you're on-site:** to (1) packet-capture real traffic and settle the
  protocol/unlock command for good, (2) identify the on-site management software,
  (3) iterate the backend locally without Render deploy cycles.

---

## Hardware & network

- **4× Gantner GC7.3000** controllers — firmware **3.9.1**, hardware 2.2,
  **G7 Advanced Access App v1.9.0**
- **8× Gantner Q300** QR/barcode readers = **Newland FM3080** modules, over
  **RS232 @ 9600** (this matters — see "host controlled" note below)
- **Controller IPs:** `10.20.20.35`, `10.20.20.36`, `10.20.20.38`, `10.20.20.39`
  (one test box was `192.168.0.42`)
- Relay map per controller: **Relay 1 = reader 1 / door 1 (Entry)**,
  **Relay 2 = reader 2 / door 2 (Exit)**; unlock time 3000 ms, relay active 200 ms
- **QR mode = API** (was Template `GANTNER#@Id#@Timestamp#@Challenge`)
- External Webserver config has an **Access token** (sent in the `Authorization`
  header on the WS upgrade), reconnection timeout 45 s
- `gantner.cloud` device id `68775ba50877e043244e5879`; cloud auth currently OK
- Old/target External Webserver being replaced: `wss://7backend2026.sevenwellness.club`

---

## What the backend already does (this repo)

- `GET /health` → `{ ok: true }`; WS endpoint `/gantner` (accepts any path)
- Logs every frame raw+parsed via **pino** → stdout + `./logs/gantner-events.log`
- Answers **Heartbeat** (`{HBI:30, RT:<iso>}`) and **Login** (`Data:{}`)
- Detects access/scan by Cmd/Data containing `Tag,Barcode,Identification,Reader,
  Card,Access,CheckIn,FIU,IO.TagInReader,IO.InvalidTagInReader`
- Temp allow-list `TEST123456 / HELLO_WORLD / 12345678`
- **Never sends an unlock** — `placeholderUnlock()` only LOGS what it would send
- On connect sends **RegisterEvent** subscriptions (see below)
- `GET /status` (live counters + per-connection `tokenFp`/`clientIp`),
  `GET /recent` (last 120 raw packets; `?all=1` includes heartbeats)
- `certs/gts-root-r4.pem` — the CA cert that must be installed in **each
  controller's** Certificate management → Add CA certificates, or it can't TLS to
  onrender (Render uses Google Trust Services; GC7 trust store lacked it)

Key files: `src/index.ts` (server/WS/routing/subscriptions), `src/gantner.ts`
(detection + response builders + `placeholderUnlock`), `src/stats.ts`,
`src/logger.ts`, `src/config.ts`, `scripts/test-client.mjs`.

---

## Confirmed protocol facts

Envelope: `{ "Cmd":string, "MT":"Req"|"Rsp"|"Evt", "TID":number, "Data":object }`,
`State` is a **sibling** of `Data` on responses (0 = OK). (Confirmed verbatim from
the web UI's base message class: `{Cmd, TID, MT, Data, State}`.)

**Local control plane (NEW, 2026-06-25, read-only):** the G7 web UI drives each
controller over **`wss://<controller-ip>/api`** — e.g. `wss://10.20.20.35/api`.
It's **login-gated** (`Login` + an `AuthorizationError` flow); all events mirror
to that socket. The controllers expose **only 80/443** (web UI) — no `:8241`
(Relaxx) / SSH / telnet, so the **Path B management server is NOT on the
controllers** (separate host if it exists; not yet located). `.35/.38/.39` up,
`.36` no ICMP.

**Door-open / relay (NEW, 2026-06-25, CONFIRMED from the web UI bundle):**
- Open a door: `{ "Cmd":"IO.SetRelayState", "MT":"Req", "Data":{ "Id":1, "State":true, "Device":<echo> } }`
  (`Id 1` = Entry, `2` = Exit; controller pulses for the 3000 ms unlock time, auto-resets).
- Reader feedback: `IO.SetStatusLED {ColorOn}`, `IO.PlaySound`, `IO.SetBarcodereaderFeedback`.
- Lockers (separate): `Addon.SetLockState`, `Addon.LockRequest`, `Addon.OpenAllLocks`.
- `RegisterEvent {Event}` / `UnregisterEvent {Event}` confirmed (matches this backend).
- **Channel caveat — the one thing still unproven:** the local `/api` WS clearly
  honours `IO.SetRelayState` Req (it's the UI's manual door-open). Whether the
  **External Webserver** channel (where THIS backend connects) also honours an
  outbound `IO.SetRelayState` Req is **NOT** yet confirmed — settle by capture or a
  test on a non-production door before `placeholderUnlock()` is ever flipped to send.

**Observed commands** (controller↔backends / browser UI): Heartbeat, Login,
GetDeviceInfo, RegisterEvent, Config.ReadSchema, IO.GetOptoState, IO.GetRelayState,
**IO.TagInReader, IO.TagLost, IO.InvalidTagInReader**, IO.FingerVerify,
IO.RelayStateChanged, IO.OptoStateChanged, **FIU.Identification**,
FIU.EnrollmentMessage, FIU.EnrollmentResult, Addon.SpecialCard,
Addon.LockStatusChanged, Addon.BusDevicesChanged.

**Scan flow on a QR (from live logs):**
1. `RS232 RX` = `STX + <barcode ascii> + ETX` (e.g. `02 54455354313233343536 03` = `TEST123456`)
2. `IO.BarcodeRead` → `{"Cmd":"IO.BarcodeRead","Data":{"Barcode":"TEST123456","ReaderId":1},"MT":"Evt"}`
3. `IO.TagInReader` → `{"Data":{"CardName":"Barcode","CardType":"BARCODE","CardTypeId":1,"ReaderID":"BARCODE1","RfStandard":"UNKNOWN","Segments":[{...}]}}`
4. **All routed to `127.0.0.1:45736` (local app) + `127.0.0.1:45394` (browser UI), NOT to the External Webserver.** Access decided locally.

**RegisterEvent (CONFIRMED):** `Data:{ "Event":"<namespace>.*" }`, **one namespace
per request**. `{Event:"IO.*"}` → `State:0`. Rejected (`State:1`): bare `"*"`,
`Events:[...]` arrays, `Filter`/`Mask`/`Name`. A `State:0` means you can now *see*
events (mirrored as `MT:"Evt"`) — it is **not** a blocking decision request.
(NB: even after subscribing, a prior 8-min watch saw no IO/FIU events mirror to
the External Webserver — confirm on-site whether they actually mirror.)

**"Barcode Interface → host controlled"** = the controller drives the *reader's*
LED/beeper (host = controller vs the dumb scanner). It is **not** online/server
decision. Setting it on the FM3080 throws `error setting LED Mode` (the GBS7.1xxx
init command the Newland rejects); reading still works.

---

## Feasibility verdict (researched + live-evidenced)

- **Path A — online decision over the External Webserver:** NOT confirmed, leaning
  false on this firmware. Gantner's handbook routes authorization-forwarding
  through the **Host SW link (Relaxx/G6 adapter)**, a different channel; the
  External Webserver is documented as a generic integration/event channel with no
  decision protocol. Only Gantner's login-gated DirectConnect spec could overturn
  this.
- **Path B — manage permissions (SUPPORTED, recommended):** the backend owns
  membership and pushes allowed credentials (UID / QR id / app token) +
  authorizations into the **Gantner management layer**, which syncs to the GC7s
  that decide locally. Same outcome ("backend decides"), supported, low-risk.
  Surfaces (pick by what the site licenses):
  1. **eLoxx Relaxx REST API** — on-prem, default **TCP 8241**, HTTP Basic Auth
     (Relaxx API Account)
  2. **eLoxx 365 cloud API** — api key + api secret + tenant secret (from Gantner),
     JWT
  3. **GAT Direct.Connect** adapters — prebuilt Virtuagym/MindBody/FIAS connectors
  - Do **NOT** target the internal cloud→device endpoints
    (`/api/Permission/v2/Device/...`, `/api/Update/Device/{id}`) directly.

---

## Your on-site test plan (high value → low)

0. **Confirm reach.** `ping 10.20.20.38` etc. Are you on the controller subnet? If
   not, get the PC onto that LAN/VLAN first.
1. **🔑 Packet-capture a real entry (the big one).** With Wireshark / `pktmon` on the
   PC (or a mirror port), capture the controller ↔ `7backend2026.sevenwellness.club`
   **and** controller ↔ `gantner.cloud` sessions while someone makes a **real
   member entry**. This settles Path A and very likely reveals the **real unlock /
   grant command**. (TLS — you may need the controller pointed at a local proxy you
   control, or capture the plaintext `ws://` to a local backend instead; see step 4.)
2. **Talk to a controller's own WebSocket directly.** The browser UI connects to the
   controller's local WS and receives *all* events. Find that endpoint (inspect the
   GC7 web UI's network traffic / config), connect, send the confirmed
   `RegisterEvent {Event:"IO.*"}` / `{Event:"FIU.*"}` / `{Event:"App.*"}`, then have
   someone scan — watch the live `MT:"Evt"` frames. This maps the event protocol
   fully, fast.
3. **Discover the management software.** Port-scan the LAN for **Relaxx `:8241`** and
   any eLoxx/GAT server: e.g. `nmap -p 8241,80,443,8080 10.20.20.0/24` (or per-IP
   `Test-NetConnection`). Identify which Path B surface exists on-site — this is the
   real door-control integration point.
4. **Run THIS backend locally, point a controller at it.** `npm install && npm run
   build && npm start` (listens on `:3000`). On **one** controller (ideally a test
   one), set External Webserver → `ws://<this-pc-lan-ip>:3000` (plain ws, no cert
   hassle). Now iterate in seconds — watch `./logs/gantner-events.log`, `/status`,
   `/recent`. Try sending `RegisterEvent`, `GetDeviceInfo`, etc. and read responses.
5. **Inspect all 4 controllers' configs** via their web UI/API for differences
   (reader modes, tokens, relay maps).

**Still needs a human:** physically scanning a QR at a reader; typing any
passwords / API keys (have the user enter secrets locally — don't put them in
chat or commit them).

---

## Decisive open questions (get any of these and we leap forward)

1. **Which Gantner management product is licensed on-site** — Relaxx (on-prem) /
   eLoxx 365 (cloud) / Direct.Connect? (The Gantner installer knows instantly.)
2. **The old `7backend2026.sevenwellness.club` code or a packet capture** of a real
   entry — settles whether the External Webserver ever decided access, and the real
   unlock command.
3. ~~**The real door-grant/relay command + Data schema**~~ **— RESOLVED (2026-06-25,
   read-only from the controller's own G7 web UI bundle).** Door-open is the relay
   command `IO.SetRelayState` `Data:{ Id, State, Device }` (`Id 1` = Entry relay,
   `2` = Exit; controller pulses it for the 3000 ms unlock time and auto-resets).
   `App.StartUnlockProcess` / `App.SetLockState`-for-doors **do not exist** on fw
   3.9.1. (Lockers use `Addon.SetLockState` / `Addon.LockRequest`.) Remaining
   unknown is the **channel**, not the command — see "Confirmed protocol facts".
4. **The QR Challenge anti-forgery secret/algorithm** (`GANTNER#<Id>#<Timestamp>#<Challenge>`)
   — needed before any QR grant can be trusted; currently unvalidated.

---

## First message to send the user when you start

"I'm on the gym PC. Confirm I'm on the controller LAN (I'll try to reach
10.20.20.38). Then I'd like to start read-only: identify the management software on
the network and connect to a controller's WebSocket to watch a scan live. I won't
change anything on a production controller without asking. Which controller (if
any) is a spare/test unit I can point at a local backend?"
