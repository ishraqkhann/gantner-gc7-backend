import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'url';

import { config } from './config';
import { log, LOG_FILE_PATH } from './logger';
import { GantnerMessage, handleMessage } from './gantner';

const WS_PATH = '/gantner';

/* ----------------------------- HTTP ------------------------------ */

const app = express();
app.disable('x-powered-by');

// (2) Health check
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// Friendly root
app.get('/', (_req, res) => {
  res.json({ service: 'gantner-gc7-backend', ws: WS_PATH, health: '/health' });
});

const server = http.createServer(app);

/* --------------------------- WebSocket --------------------------- */

// noServer mode so we can route ONLY /gantner to the WS handler and
// leave the HTTP routes (e.g. /health) untouched.
const wss = new WebSocketServer({ noServer: true });

let connectionSeq = 0;

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
  log('info', 'ws.connected', {
    connId,
    remote,
    ua: req.headers['user-agent'],
    authPresent: Boolean(req.headers['authorization']),
  });

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

    const { response } = handleMessage(msg);
    if (response) {
      ws.send(JSON.stringify(response));
      log('info', 'ws.message_sent', { connId, sent: response });
    }
  });

  ws.on('close', (code, reason) => {
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
