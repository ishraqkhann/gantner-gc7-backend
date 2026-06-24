import express from 'express';
import http from 'http';
import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'url';

import { config } from './config';
import { log, LOG_FILE_PATH } from './logger';
import { GantnerMessage, handleMessage } from './gantner';
import { connections, totals, lastSeen, statusSnapshot, capture, recentMessages } from './stats';

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

  // (2) Log connection IP + headers (Authorization redacted to its length).
  log('info', 'ws.connected', { connId, remote, clientIp, tokenFp, headers: redactHeaders(req.headers), authPresent });

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
  });

  ws.on('close', (code, reason) => {
    connections.delete(connId);
    log('info', 'ws.closed', { connId, code, reason: reason.toString() });
  });

  ws.on('error', (err) => {
    log('error', 'ws.error', { connId, error: err.message });
  });
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
