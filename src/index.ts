import express from 'express';
import http from 'http';
import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'url';

import { config } from './config';
import { log, LOG_FILE_PATH } from './logger';
import { GantnerMessage, handleMessage, collectStringValues } from './gantner';
import { connections, totals, lastSeen, statusSnapshot, capture, recentMessages } from './stats';
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

// Captured raw packets (newest first). Heartbeats hidden unless ?all=1.
// Bring-up tool to SEE exactly what the GC7 sends.
app.get('/recent', (req, res) => {
  const all = String(req.query.all ?? '') === '1';
  const items = [...recentMessages].reverse().filter((m) => all || m.cmd !== 'Heartbeat');
  res.json({ count: items.length, messages: items.slice(0, 60) });
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
 * opening just the scanning controller using the reader-derived relay.
 */
function unlockTargets(scanConnId: number, fallback: GantnerMessage | null): UnlockTarget[] {
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
    const r = fallback ? Number((fallback.Data as Record<string, unknown>)?.Id) : 1;
    out.push({ connId: scanConnId, ws: me.ws, relay: Number.isFinite(r) ? r : 1, label: 'unidentified-self' });
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

  ws.on('message', (raw: Buffer, isBinary: boolean) => {
    const rawText = isBinary ? `<binary ${raw.length} bytes>` : raw.toString('utf8');

    // (5) Log every inbound message — raw first.
    log('info', 'ws.message_raw', { connId, raw: rawText });

    let msg: GantnerMessage;
    try {
      msg = JSON.parse(rawText);
    } catch (err) {
      log('error', 'ws.parse_error', { connId, raw: rawText, error: (err as Error).message });
      return;
    }

    // (5) ...then the parsed form.
    log('info', 'ws.message_parsed', { connId, parsed: msg });

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
      raw: rawText,
      parsed: msg,
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
      case 'access':
        totals.accessEvents += 1;
        lastSeen.accessAt = seenAt;
        lastSeen.accessDecision = result.decision ?? null;
        if (result.decision === 'GRANTED') totals.accessGranted += 1;
        else totals.accessDenied += 1;
        break;
    }

    if (result.response) {
      ws.send(JSON.stringify(result.response));
      log('info', 'ws.message_sent', { connId, sent: result.response });
    }

    // LIVE unlock: on a granted scan, open BOTH barriers in the scanning
    // controller's DIRECTION (entry or exit). Gated by GANTNER_SEND_UNLOCK.
    if (config.sendUnlock && result.kind === 'access' && result.decision === 'GRANTED') {
      const targets = unlockTargets(connId, result.wouldSend ?? null);
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
        t.ws.send(JSON.stringify(unlock));
        capture({ ts: new Date().toISOString(), connId: t.connId, dir: 'out', cmd: 'IO.SetRelayState', mt: 'Req', isAccess: false, raw: JSON.stringify(unlock), parsed: unlock });
        log('warn', 'ws.unlock_sent', { fromConn: connId, targetConn: t.connId, gate: t.label, relay: t.relay, tid: unlock.TID });
        // PULSE: close the relay after the unlock time so the barrier doesn't
        // latch open. State:true latches on this firmware — we must reset it.
        scheduleRelayClose(t.ws, t.connId, t.relay, t.label);
      }
    }
  });

  ws.on('close', (code, reason) => {
    connections.delete(connId);
    liveConns.delete(connId);
    log('info', 'ws.closed', { connId, code, reason: reason.toString() });
  });

  ws.on('error', (err) => {
    log('error', 'ws.error', { connId, error: err.message });
  });
});

// RECOVERY: force-close door relays on every connected controller. Use to clear
// barriers that got latched open. Closes relays 1 & 2 (the door relays in play)
// on all connections, or a specific relay via ?id=N.
app.get('/relay/close-all', (req, res) => {
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
// opens which physical door. e.g. /relay/pulse?conn=1&id=2
// (NOTE: no auth — commissioning tool. Protect or remove before production.)
app.get('/relay/pulse', (req, res) => {
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

server.listen(config.port, () => {
  log('info', 'server.listening', {
    port: config.port,
    wsPath: WS_PATH,
    health: '/health',
    logFile: LOG_FILE_PATH,
    tokenEnforced: Boolean(config.accessToken),
  });
});

const shutdown = (signal: string) => {
  log('warn', 'server.shutdown', { signal });
  wss.clients.forEach((c) => c.close(1001, 'server shutting down'));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
