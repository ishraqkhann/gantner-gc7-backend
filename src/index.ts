import express from 'express';
import http from 'http';
import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'url';

import { config } from './config';
import { log, LOG_FILE_PATH } from './logger';
import {
  GantnerMessage,
  handleMessage,
  collectStringValues,
  validateWithClapHouse,
  isAccessMessage,
  redactScanFields,
  readerKey,
  tokenFingerprint,
} from './gantner';
import {
  connections,
  totals,
  lastSeen,
  statusSnapshot,
  capture,
  recentMessages,
  recordDecision,
  recentDecisions,
} from './stats';
import { Gate, gateForSerial, gatesInDoor, serialFromValues } from './topology';

const WS_PATH = '/gantner';

/** Copy headers for logging, masking the Authorization secret to just its length. */
function redactHeaders(h: http.IncomingHttpHeaders): Record<string, unknown> {
  const out: Record<string, unknown> = { ...h };
  if (out.authorization) out.authorization = `***redacted(len=${String(out.authorization).length})`;
  return out;
}

/* ----------------------------- HTTP ------------------------------ */

const app = express();
app.disable('x-powered-by');

// (2) Health check
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// Live runtime stats — confirm the controller is connected & heartbeating.
app.get('/status', (_req, res) => {
  res.json(statusSnapshot());
});

// Access DECISION feed (newest first) — read live by the Clap House admin's
// Access log. Each item: { at, gateName, gate, decision, result, denialReason? }.
// Contains NO raw token / NO PII. Both `decisions` and `messages` hold the same
// array so a reader keyed on either wrapper works.
//   /recent?raw=1   → instead returns the raw captured GC7 packets (bring-up
//                     tool); add &all=1 to include heartbeats.
app.get('/recent', (req, res) => {
  if (String(req.query.raw ?? '') === '1') {
    const all = String(req.query.all ?? '') === '1';
    const items = [...recentMessages].reverse().filter((m) => all || m.cmd !== 'Heartbeat');
    return res.json({ count: items.length, messages: items.slice(0, 60) });
  }
  const items = [...recentDecisions].reverse().slice(0, 100);
  res.json({ count: items.length, decisions: items, messages: items });
});

// Friendly root
app.get('/', (_req, res) => {
  res.json({ service: 'gantner-gc7-backend', ws: WS_PATH, health: '/health', status: '/status', recent: '/recent' });
});

const server = http.createServer(app);

/* --------------------------- WebSocket --------------------------- */

// noServer mode so we can route ONLY /gantner to the WS handler and
// leave the HTTP routes (e.g. /health) untouched.
const wss = new WebSocketServer({ noServer: true });

let connectionSeq = 0;
let outboundTid = 9000; // TID for server-originated requests (e.g. RegisterEvent)

// A single physical scan emits BOTH IO.BarcodeRead and IO.TagInReader (often
// repeated). Collapse them to one relay pulse per (target connection + relay)
// within this window. Keyed "<connId>:<relay>" so a group-open that pulses the
// same relay number on two different controllers is NOT deduped against itself.
const UNLOCK_DEDUP_MS = 3000;
const lastUnlockByRelay = new Map<string, number>();

// Dedup the access decision per PHYSICAL scan. One scan emits BOTH IO.BarcodeRead
// and IO.TagInReader; Clap House single-uses the token's jti, so deciding twice
// would waste a round-trip AND get a spurious `replay` denial on the second. We
// key on the READER (not the token), so the two events collapse even if they
// encode the token differently, and unreadable scans dedup too. The window must
// exceed the validate timeout so a retry can't slip through while a call is still
// in flight. Keyed "<connId>:<readerKey|tokenFp>"; pruned lazily.
// TOKEN window — long (must exceed the validate timeout): suppresses the SAME
// token being re-emitted/retried while a validate is still in flight. Distinct
// members carry distinct tokens, so this never drops a different person.
const DEDUP_WINDOW_MS = Math.max(UNLOCK_DEDUP_MS, config.validateTimeoutMs + 2000);
// READER pair window — TIGHT: only to collapse the two events ONE physical scan
// emits at the same reader (they arrive within ~milliseconds) in the case they
// encode the token differently. Kept far below human inter-arrival at a single
// turnstile lane so it can NEVER drop a genuinely distinct member.
const PAIR_WINDOW_MS = 600;
const recentScans = new Map<string, number>();

function pruneScans(now: number): void {
  if (recentScans.size <= 512) return;
  for (const [k, t] of recentScans) if (now - t > DEDUP_WINDOW_MS) recentScans.delete(k);
}

/**
 * TOKEN dedup — slides (refreshes) on every sighting: a token re-emitted within
 * the window is a duplicate. Safe to slide because a different member = different
 * token, so this can only ever collapse the SAME scan, never a distinct person.
 */
function tokenSeen(key: string): boolean {
  const now = Date.now();
  const prev = recentScans.get(key);
  recentScans.set(key, now);
  pruneScans(now);
  return prev !== undefined && now - prev < DEDUP_WINDOW_MS;
}

/**
 * READER-pair dedup — does NOT slide: the window is measured from the FIRST event,
 * so a repeat hit never extends it. That bounds suppression to PAIR_WINDOW_MS from
 * the first event and guarantees a later, genuinely distinct member (always
 * seconds away at one lane) is validated normally.
 */
function readerPairSeen(key: string): boolean {
  const now = Date.now();
  const prev = recentScans.get(key);
  if (prev !== undefined && now - prev < PAIR_WINDOW_MS) return true; // dup — do NOT refresh
  recentScans.set(key, now);
  pruneScans(now);
  return false;
}

// Live connection registry: connId -> { ws, identity }. Lets a scan on one
// controller push IO.SetRelayState down OTHER controllers' connections (the
// by-direction group). Identity is resolved from GetDeviceInfo on connect.
interface LiveConn {
  ws: WebSocket;
  serial?: string;
  gate?: Gate | null;
}
const liveConns = new Map<number, LiveConn>();

interface UnlockTarget {
  connId: number;
  ws: WebSocket;
  relay: number;
  label: string;
}

/**
 * Which barriers to open for a granted scan on `scanConnId`. If we've identified
 * the scanning controller, open the door relay on every connected controller in
 * the SAME direction (entry/exit) — that's the by-direction group. If it isn't
 * identified yet (GetDeviceInfo still in flight, or unknown serial), fall back to
 * opening just the scanning controller on the site's confirmed door relay.
 */
function unlockTargets(scanConnId: number): UnlockTarget[] {
  const me = liveConns.get(scanConnId);
  const out: UnlockTarget[] = [];
  if (me?.gate) {
    for (const g of gatesInDoor(me.gate.door)) {
      for (const [cid, lc] of liveConns) {
        if (lc.serial === g.serial && lc.ws.readyState === WebSocket.OPEN) {
          out.push({ connId: cid, ws: lc.ws, relay: g.doorRelay, label: g.name });
        }
      }
    }
    if (out.length) return out;
  }
  if (me) {
    // Unidentified controller: open it on the site's confirmed door relay rather
    // than a reader-derived number (which could be 1 and open nothing here).
    out.push({ connId: scanConnId, ws: me.ws, relay: config.fallbackRelay, label: 'unidentified-self' });
  }
  return out;
}

/** Send a raw IO.SetRelayState to one connection. */
function sendRelay(ws: WebSocket, connId: number, relayId: number, state: boolean): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  const frame = { Cmd: 'IO.SetRelayState', MT: 'Req', Data: { Id: relayId, State: state }, TID: ++outboundTid };
  ws.send(JSON.stringify(frame));
  capture({ ts: new Date().toISOString(), connId, dir: 'out', cmd: 'IO.SetRelayState', mt: 'Req', isAccess: false, raw: JSON.stringify(frame), parsed: frame });
}

/** After the unlock time, close the relay so the barrier doesn't latch open. */
function scheduleRelayClose(ws: WebSocket, connId: number, relayId: number, label: string): void {
  setTimeout(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    sendRelay(ws, connId, relayId, false);
    log('info', 'ws.relay_auto_close', { targetConn: connId, gate: label, relay: relayId });
  }, config.unlockPulseMs);
}

// CONFIRMED from probing the live controller: RegisterEvent accepts
// Data:{Event:'<namespace>.*'} — a single Event field with ONE namespace
// wildcard. {Event:'IO.*'} returned State:0; '*', arrays, {}, Filter/Mask/Name
// all returned State:1. Subscribe to each namespace with its own request.
const REGISTER_EVENT_SUBSCRIPTIONS = ['IO.*', 'FIU.*', 'Addon.*'];

server.on('upgrade', (req, socket, head) => {
  let pathname = '/';
  try {
    pathname = new URL(req.url ?? '/', `http://${req.headers.host}`).pathname;
  } catch {
    /* keep default */
  }

  // Optional auth: the GC7 presents its access token in the Authorization
  // header on the upgrade request. Enforced ONLY when GANTNER_ACCESS_TOKEN is
  // set — empty (bring-up default) means accept any connection.
  if (config.accessToken) {
    const auth = (req.headers['authorization'] ?? '').toString();
    if (!auth.includes(config.accessToken)) {
      log('warn', 'ws.auth_rejected', { path: pathname, hasAuth: Boolean(auth) });
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
  }

  // (3)(4) Accept the WS upgrade on /gantner (canonical) OR any path. The GC7
  // External Webserver field may be a bare host with no path — exactly like the
  // previous wss://7backend2026.sevenwellness.club target — so we do NOT reject
  // on path; we just note when it isn't the canonical /gantner.
  if (pathname !== WS_PATH) {
    log('info', 'ws.upgrade_nonstandard_path', { path: pathname });
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws: WebSocket, req) => {
  const connId = ++connectionSeq;
  const remote = req.socket.remoteAddress;
  const xff = (req.headers['x-forwarded-for'] ?? '').toString();
  const clientIp = xff.split(',')[0]?.trim() || remote; // site public IP behind Render's proxy
  const auth = (req.headers['authorization'] ?? '').toString();
  const authPresent = Boolean(auth);
  // Stable per-controller fingerprint so the 4 gates are distinguishable in /status
  // without ever logging the secret token itself.
  const tokenFp = auth ? crypto.createHash('sha256').update(auth).digest('hex').slice(0, 8) : undefined;
  const openedAt = new Date().toISOString();

  totals.connectionsOpened += 1;
  connections.set(connId, {
    connId,
    remote,
    clientIp,
    tokenFp,
    connectedAt: openedAt,
    lastSeen: openedAt,
    messages: 0,
    authPresent,
  });

  liveConns.set(connId, { ws });

  // (2) Log connection IP + headers (Authorization redacted to its length).
  log('info', 'ws.connected', { connId, remote, clientIp, tokenFp, headers: redactHeaders(req.headers), authPresent });

  // Identify which physical controller this is (entry/exit + serial) so a scan
  // here can open the whole direction group. The GetDeviceInfo Rsp carries the
  // serial; we match it against the known gates in topology.ts.
  {
    const tid = ++outboundTid;
    const frame = { Cmd: 'GetDeviceInfo', MT: 'Req', TID: tid, Data: {} };
    ws.send(JSON.stringify(frame));
    capture({ ts: new Date().toISOString(), connId, dir: 'out', cmd: 'GetDeviceInfo', mt: 'Req', isAccess: false, raw: JSON.stringify(frame), parsed: frame });
    log('info', 'ws.get_device_info_sent', { connId, tid });
  }

  // Optional: ask the controller to push events. OFF by default (capture phase);
  // flip GANTNER_REGISTER_EVENTS=true only if scans don't arrive on their own.
  if (config.registerEvents) {
    for (const ev of REGISTER_EVENT_SUBSCRIPTIONS) {
      const tid = ++outboundTid;
      const frame = { Cmd: 'RegisterEvent', MT: 'Req', TID: tid, Data: { Event: ev } };
      ws.send(JSON.stringify(frame));
      capture({
        ts: new Date().toISOString(),
        connId,
        dir: 'out',
        cmd: 'RegisterEvent',
        mt: 'Req',
        isAccess: false,
        raw: JSON.stringify(frame),
        parsed: frame,
      });
      log('info', 'ws.register_event_sent', { connId, tid, event: ev });
    }
  }

  // Defined as a function (not inlined) so the listener can attach a single
  // .catch — an async listener's rejection is NOT routed to ws.on('error'), and
  // an unhandled one would crash the whole access-control process.
  const handleFrame = async (raw: Buffer, isBinary: boolean) => {
    const rawText = isBinary ? `<binary ${raw.length} bytes>` : raw.toString('utf8');

    let msg: GantnerMessage;
    try {
      msg = JSON.parse(rawText);
    } catch (err) {
      // A malformed frame may still embed a token — don't echo raw bytes by default.
      log('error', 'ws.parse_error', { connId, len: rawText.length, raw: config.logRawFrames ? rawText : undefined, error: (err as Error).message });
      return;
    }

    // (5) Log every inbound frame raw + parsed. For SCAN frames, redact the
    // token-bearing leaves so a live single-use token is never written to stdout
    // / the on-disk log / the capture ring (override with GANTNER_LOG_RAW_FRAMES).
    const access = isAccessMessage(msg);
    const safeMsg = access && !config.logRawFrames ? redactScanFields(msg) : msg;
    const safeRaw = access && !config.logRawFrames ? JSON.stringify(safeMsg) : rawText;
    log('info', 'ws.message_raw', { connId, raw: safeRaw });
    log('info', 'ws.message_parsed', { connId, parsed: safeMsg });

    // Controller identification: the GetDeviceInfo response carries the serial.
    // Match it to a known gate so scans here open the right direction group.
    if (msg.Cmd === 'GetDeviceInfo' && msg.MT === 'Rsp') {
      const serial = serialFromValues(collectStringValues(msg.Data ?? {}));
      const gate = gateForSerial(serial ?? undefined);
      const lc = liveConns.get(connId);
      if (lc) {
        lc.serial = serial ?? undefined;
        lc.gate = gate;
      }
      const ci = connections.get(connId);
      if (ci) {
        ci.serial = serial ?? undefined;
        ci.gateName = gate?.name;
        ci.door = gate?.door;
        ci.side = gate?.side;
      }
      log(gate ? 'info' : 'warn', 'ws.identified', {
        connId,
        serial: serial ?? null,
        gate: gate?.name ?? null,
        door: gate?.door ?? null,
        side: gate?.side ?? null,
        note: gate ? undefined : 'serial not in known gate list — group-open will fall back to this controller only',
      });
    }

    const result = handleMessage(msg);

    // ---- stats + capture ----
    const seenAt = new Date().toISOString();
    totals.messages += 1;
    capture({
      ts: seenAt,
      connId,
      dir: 'in',
      cmd: typeof msg.Cmd === 'string' ? msg.Cmd : undefined,
      mt: typeof msg.MT === 'string' ? msg.MT : undefined,
      isAccess: result.kind === 'access',
      // Redacted for scans so the ring buffer (and /recent?raw=1) never holds a token.
      raw: safeRaw,
      parsed: safeMsg,
    });
    const conn = connections.get(connId);
    if (conn) {
      conn.messages += 1;
      conn.lastSeen = seenAt;
      conn.lastCmd = typeof msg.Cmd === 'string' ? msg.Cmd : undefined;
    }
    switch (result.kind) {
      case 'heartbeat':
        totals.heartbeats += 1;
        lastSeen.heartbeatAt = seenAt;
        break;
      case 'login':
        totals.logins += 1;
        lastSeen.loginAt = seenAt;
        break;
    }

    if (result.response) {
      ws.send(JSON.stringify(result.response));
      log('info', 'ws.message_sent', { connId, sent: result.response });
    }

    // ---- access decision (Clap House is the source of truth) ----
    if (result.kind === 'access') {
      const lc = liveConns.get(connId);
      const gateId = lc?.gate?.name ?? conn?.serial ?? 'unidentified';
      const serial = conn?.serial;
      const token = result.token ?? null;
      const tokenFp = token ? tokenFingerprint(token) : undefined; // hash only — never the token
      const rk = readerKey(msg);

      // Dedup per PHYSICAL scan BEFORE counting.
      if (token) {
        //  • TOKEN window (long) suppresses the controller RE-emitting the same scan
        //    while a validate is in flight (would burn the jti → spurious `replay`).
        //  • READER-pair window (tight, non-sliding) collapses the BarcodeRead +
        //    TagInReader pair even if they encode the token differently.
        //  Different members carry different tokens AND scan a single lane seconds
        //  apart, so neither window can drop a distinct person.
        const tokenDup = tokenSeen(`${connId}:t:${tokenFp}`);
        const readerDup = rk ? readerPairSeen(`${connId}:r:${rk}`) : false;
        if (tokenDup || readerDup) {
          log('info', 'access.dedup_skip', { connId, gate: gateId, tokenFp, by: tokenDup ? 'token' : 'reader' });
          return;
        }
      } else if (rk && readerPairSeen(`${connId}:i:${rk}`)) {
        // Unreadable scan (e.g. IO.InvalidTagInReader). Dedup its own pair in a
        // SEPARATE namespace (`i:`) so it can never gate a readable scan, nor be
        // gated by one. Then fall through to the local deny below.
        log('info', 'access.dedup_skip', { connId, gate: gateId, by: 'invalid-reader' });
        return;
      }

      totals.accessEvents += 1;
      lastSeen.accessAt = seenAt;

      // No readable token (e.g. IO.InvalidTagInReader) → deny locally; there is
      // nothing to validate, so we never call Clap House.
      if (!token) {
        totals.accessDenied += 1;
        lastSeen.accessDecision = 'DENIED';
        recordDecision({ at: seenAt, gateName: gateId, serial, decision: 'denied', denialReason: 'invalid_read' });
        log('warn', 'access.denied', { connId, gate: gateId, denialReason: 'invalid_read', note: 'no readable token in scan' });
        return;
      }

      // Ask Clap House. validateWithClapHouse FAILS CLOSED on any error/timeout.
      const decision = await validateWithClapHouse(token, gateId);
      // Keep the TOKEN entry warm across the (possibly slow) call so the same scan
      // re-emitted during/just after the round-trip can't trigger a second validate.
      // (Deliberately NOT the reader window — that must stay non-sliding.)
      if (tokenFp) recentScans.set(`${connId}:t:${tokenFp}`, Date.now());
      const granted = decision.result === 'granted';

      lastSeen.accessDecision = granted ? 'GRANTED' : 'DENIED';
      if (granted) totals.accessGranted += 1;
      else totals.accessDenied += 1;

      recordDecision({ at: seenAt, gateName: gateId, serial, decision: decision.result, denialReason: decision.denialReason });
      log(granted ? 'warn' : 'info', granted ? 'access.granted' : 'access.denied', {
        connId,
        gate: gateId,
        tokenFp,
        decision: decision.result,
        denialReason: decision.denialReason,
      });

      // Open the barrier(s) ONLY on a grant AND only when live. With
      // GANTNER_SEND_UNLOCK=false the decision is still recorded (shadow mode) but
      // no door opens — safe to deploy before flipping the live switch.
      if (granted && config.sendUnlock) {
        const targets = unlockTargets(connId);
        if (!targets.length) {
          // Granted but nothing to pulse — e.g. the connection dropped during the
          // validate. Recorded as granted, but be explicit no door opened.
          log('warn', 'access.granted_no_target', {
            connId,
            gate: gateId,
            note: 'granted but no open controller to pulse — door NOT opened.',
          });
        }
        const now = Date.now();
        for (const t of targets) {
          const key = `${t.connId}:${t.relay}`;
          const prev = lastUnlockByRelay.get(key) ?? 0;
          if (now - prev < UNLOCK_DEDUP_MS) {
            log('info', 'ws.unlock_skipped_dedup', { fromConn: connId, target: t.label, relay: t.relay, sinceMs: now - prev });
            continue;
          }
          lastUnlockByRelay.set(key, now);
          const unlock = { Cmd: 'IO.SetRelayState', MT: 'Req', Data: { Id: t.relay, State: true }, TID: ++outboundTid };
          if (t.ws.readyState !== WebSocket.OPEN) continue;
          t.ws.send(JSON.stringify(unlock));
          capture({ ts: new Date().toISOString(), connId: t.connId, dir: 'out', cmd: 'IO.SetRelayState', mt: 'Req', isAccess: false, raw: JSON.stringify(unlock), parsed: unlock });
          log('warn', 'ws.unlock_sent', { fromConn: connId, targetConn: t.connId, gate: t.label, relay: t.relay, tid: unlock.TID });
          // PULSE: close the relay after the unlock time so the barrier doesn't
          // latch open. State:true latches on this firmware — we must reset it.
          scheduleRelayClose(t.ws, t.connId, t.relay, t.label);
        }
      } else if (granted) {
        log('warn', 'access.granted_capture_only', {
          connId,
          gate: gateId,
          note: 'GANTNER_SEND_UNLOCK=false — decision recorded but door NOT opened. Set true to go live.',
        });
      }
    }
  };

  ws.on('message', (raw: Buffer, isBinary: boolean) => {
    handleFrame(raw, isBinary).catch((err) =>
      log('error', 'ws.handler_error', { connId, error: (err as Error)?.message }),
    );
  });

  ws.on('close', (code, reason) => {
    connections.delete(connId);
    liveConns.delete(connId);
    // Drop this connection's relay-dedup entries so the map can't grow unbounded
    // across the controllers' frequent reconnects (connId is monotonic).
    for (const key of lastUnlockByRelay.keys()) {
      if (key.startsWith(`${connId}:`)) lastUnlockByRelay.delete(key);
    }
    log('info', 'ws.closed', { connId, code, reason: reason.toString() });
  });

  ws.on('error', (err) => {
    log('error', 'ws.error', { connId, error: err.message });
  });
});

/**
 * Guard for the destructive relay-control endpoints. They open/close physical
 * barriers directly, bypassing Clap House and the GANTNER_SEND_UNLOCK switch, so
 * they are DISABLED unless ADMIN_API_KEY is set AND the caller presents a matching
 * `x-admin-key` header (constant-time compare). Returns true if allowed.
 */
function requireAdmin(req: express.Request, res: express.Response): boolean {
  if (!config.adminKey) {
    res.status(403).json({ ok: false, error: 'relay control disabled — set ADMIN_API_KEY to enable' });
    return false;
  }
  const provided = Buffer.from((req.headers['x-admin-key'] ?? '').toString());
  const expected = Buffer.from(config.adminKey);
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    log('warn', 'http.relay_auth_rejected', { path: req.path, ip: (req.headers['x-forwarded-for'] ?? '').toString() || req.ip });
    res.status(401).json({ ok: false, error: 'missing/invalid x-admin-key' });
    return false;
  }
  return true;
}

// RECOVERY: force-close door relays on every connected controller. Use to clear
// barriers that got latched open. Closes relays 1 & 2 (the door relays in play)
// on all connections, or a specific relay via ?id=N. ADMIN-ONLY.
app.get('/relay/close-all', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const only = req.query.id ? [parseInt(String(req.query.id), 10)] : [1, 2];
  let sent = 0;
  const targets: Array<{ connId: number; gate: string; relays: number[] }> = [];
  for (const [cid, lc] of liveConns) {
    if (lc.ws.readyState !== WebSocket.OPEN) continue;
    for (const relayId of only) {
      sendRelay(lc.ws, cid, relayId, false);
      sent += 1;
    }
    targets.push({ connId: cid, gate: lc.gate?.name ?? '(unidentified)', relays: only });
  }
  log('warn', 'http.relay_close_all', { sent, relays: only, targets });
  res.json({ ok: true, closed: sent, relays: only, targets });
});

// COMMISSIONING: manually pulse one relay on one connection, to map which relay
// opens which physical door. e.g. /relay/pulse?conn=1&id=2  ADMIN-ONLY.
app.get('/relay/pulse', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const cid = parseInt(String(req.query.conn), 10);
  const id = parseInt(String(req.query.id), 10);
  const lc = liveConns.get(cid);
  if (!lc || lc.ws.readyState !== WebSocket.OPEN) {
    return res.status(404).json({ ok: false, error: 'connection not found / not open', conn: cid });
  }
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'id (relay number) required' });
  sendRelay(lc.ws, cid, id, true);
  scheduleRelayClose(lc.ws, cid, id, lc.gate?.name ?? `conn${cid}`);
  log('warn', 'http.relay_pulse', { conn: cid, relay: id, gate: lc.gate?.name ?? null });
  res.json({ ok: true, pulsed: { conn: cid, gate: lc.gate?.name ?? null, relay: id, closeAfterMs: config.unlockPulseMs } });
});

/* ----------------------------- boot ------------------------------ */

// Sanity-check the access source-of-truth URL — it decides who gets in, so a
// typo'd scheme/host would forward live tokens in cleartext or to the wrong host.
(() => {
  try {
    const u = new URL(config.claphouseValidateUrl);
    const localish = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !localish) {
      log('warn', 'config.insecure_validate_url', { url: config.claphouseValidateUrl, note: 'not https — tokens would be forwarded in cleartext' });
    }
    if (u.hostname !== 'app.claphouse.co' && !localish) {
      log('warn', 'config.unexpected_validate_host', { host: u.hostname, note: 'access decision host is not app.claphouse.co' });
    }
  } catch {
    log('error', 'config.bad_validate_url', { url: config.claphouseValidateUrl, note: 'unparseable — every scan will FAIL CLOSED (deny)' });
  }
})();

server.listen(config.port, () => {
  log('info', 'server.listening', {
    port: config.port,
    wsPath: WS_PATH,
    health: '/health',
    logFile: LOG_FILE_PATH,
    tokenEnforced: Boolean(config.accessToken),
    validateUrl: config.claphouseValidateUrl,
    gateKeySet: Boolean(config.gateApiKey),
    sendUnlock: config.sendUnlock,
    adminEnabled: Boolean(config.adminKey),
  });
});

// Last-resort safety nets: a single bad frame or stray rejection must NOT take
// the whole access-control process down (that would drop all controllers). The
// system fails closed (no door opens on its own), so staying up is correct.
process.on('unhandledRejection', (reason) => {
  log('error', 'process.unhandled_rejection', { error: reason instanceof Error ? reason.message : String(reason) });
});
process.on('uncaughtException', (err) => {
  log('error', 'process.uncaught_exception', { error: (err as Error)?.message, stack: (err as Error)?.stack });
});

const shutdown = (signal: string) => {
  log('warn', 'server.shutdown', { signal });
  wss.clients.forEach((c) => c.close(1001, 'server shutting down'));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
