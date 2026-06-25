// READ-ONLY observer of the live OLD backend's Gantner External Webserver channel.
// Connects AS A CONTROLLER (Authorization header = device token), then:
//   phase 1: passive — log the HTTP upgrade + every frame the backend sends unprompted
//   phase 2: send ONE Heartbeat Req (normal controller keepalive) and log the reply
// It NEVER sends a scan, login, relay, config, or any door-affecting command.
// Token is read from env GANTNER_WS_TOKEN and redacted from all output.
import { WebSocket } from 'ws';

const URL = process.argv[2] || 'wss://7backend2026.sevenwellness.club';
const TOKEN = process.env.GANTNER_WS_TOKEN || '';
if (!TOKEN) { console.error('Set GANTNER_WS_TOKEN'); process.exit(1); }

const redact = (s) =>
  String(s)
    .split(TOKEN).join('***TOKEN***')
    .replace(/(eyJ[A-Za-z0-9_-]{4,})\.[A-Za-z0-9_.-]+/g, '$1.<JWT>');
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a.map(redact));

log('CONNECT', URL, '(Authorization: device token, len=' + TOKEN.length + ')');

const ws = new WebSocket(URL, {
  headers: { Authorization: TOKEN },
  handshakeTimeout: 12000,
});

let done = false;
const finish = (why) => { if (done) return; done = true; log('CLOSING —', why); try { ws.close(); } catch {} setTimeout(() => process.exit(0), 500); };

ws.on('upgrade', (res) => {
  log('UPGRADE HTTP', res.statusCode, res.statusMessage);
  log('UPGRADE HEADERS', JSON.stringify(res.headers));
});

ws.on('unexpected-response', (_req, res) => {
  log('UNEXPECTED-RESPONSE', res.statusCode, res.statusMessage);
  log('HEADERS', JSON.stringify(res.headers));
  let body = '';
  res.on('data', (d) => (body += d));
  res.on('end', () => { log('BODY', body.slice(0, 500)); finish('http rejection'); });
});

ws.on('open', () => {
  log('OPEN — passive observation for 6s (sending nothing)…');
  // Phase 2: after 6s of pure listening, send ONE benign Heartbeat Req.
  setTimeout(() => {
    if (done) return;
    const hb = { Cmd: 'Heartbeat', MT: 'Req', TID: 7001, Data: {} };
    log('-> SEND (benign keepalive)', JSON.stringify(hb));
    try { ws.send(JSON.stringify(hb)); } catch (e) { log('send err', e.message); }
  }, 6000);
  setTimeout(() => finish('observation window elapsed'), 12000);
});

ws.on('message', (raw, isBinary) => log('<- RECV', isBinary ? `<binary ${raw.length}b>` : raw.toString()));
ws.on('ping', (d) => log('<- WS PING', d?.length ? `(${d.length}b)` : ''));
ws.on('pong', () => log('<- WS PONG'));
ws.on('close', (code, reason) => { log('CLOSE', code, reason.toString()); process.exit(0); });
ws.on('error', (err) => { log('ERROR', err.message); });

setTimeout(() => finish('hard timeout'), 15000);
