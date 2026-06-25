// Black-box probe of the live OLD backend's Gantner External Webserver channel.
// Connects, captures the HTTP upgrade response, then sends Heartbeat / Login /
// a fake scan and logs every reply. Read-only: it never sends a door command.
import { WebSocket } from 'ws';

const URL = process.argv[2] || 'wss://7backend2026.sevenwellness.club/gantner';
const TOKEN = process.argv[3] || ''; // optional Authorization header value

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
log('CONNECT', URL, TOKEN ? '(with Authorization header)' : '(no auth)');

const ws = new WebSocket(URL, {
  headers: TOKEN ? { Authorization: TOKEN } : {},
  handshakeTimeout: 12000,
});

let tid = 1000;
const send = (obj) => {
  const s = JSON.stringify(obj);
  log('-> SEND', s);
  ws.send(s);
};

ws.on('upgrade', (res) => {
  log('UPGRADE HTTP', res.statusCode, res.statusMessage);
  log('UPGRADE HEADERS', JSON.stringify(res.headers));
});

ws.on('unexpected-response', (_req, res) => {
  log('UNEXPECTED-RESPONSE', res.statusCode, res.statusMessage);
  log('HEADERS', JSON.stringify(res.headers));
  let body = '';
  res.on('data', (d) => (body += d));
  res.on('end', () => { log('BODY', body.slice(0, 400)); process.exit(0); });
});

ws.on('open', () => {
  log('OPEN — sending Heartbeat');
  send({ Cmd: 'Heartbeat', MT: 'Req', TID: ++tid, Data: {} });
  setTimeout(() => send({ Cmd: 'Login', MT: 'Req', TID: ++tid, Data: { User: 'probe', Token: TOKEN || 'none' } }), 1500);
  // Fake scan to see if the old backend decides access / sends an unlock back.
  setTimeout(() => send({ Cmd: 'IO.TagInReader', MT: 'Evt', TID: ++tid, Data: { Barcode: 'TEST123456', ReaderId: 1, CardType: 'BARCODE' } }), 3000);
  setTimeout(() => send({ Cmd: 'GetDeviceInfo', MT: 'Req', TID: ++tid, Data: {} }), 4500);
});

ws.on('message', (raw, isBinary) => {
  log('<- RECV', isBinary ? `<binary ${raw.length}b>` : raw.toString());
});

ws.on('close', (code, reason) => { log('CLOSE', code, reason.toString()); process.exit(0); });
ws.on('error', (err) => log('ERROR', err.message));

// Hard stop so the probe never hangs.
setTimeout(() => { log('DONE (timeout) — closing'); try { ws.close(); } catch {} process.exit(0); }, 9000);
