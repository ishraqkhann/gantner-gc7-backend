// Minimal GC7 simulator: connects to the backend and sends Heartbeat, Login,
// and a few access/scan messages, printing every response.
//
//   node scripts/test-client.mjs                         (defaults to local)
//   node scripts/test-client.mjs wss://api.claphouse.club/gantner
//   node scripts/test-client.mjs ws://localhost:3000/gantner TEST123456
//
import WebSocket from 'ws';

const url = process.argv[2] ?? 'ws://localhost:3000/gantner';
const scanValue = process.argv[3] ?? 'TEST123456';

const ws = new WebSocket(url);
let tid = 100;

const send = (obj) => {
  obj.TID = ++tid;
  ws.send(JSON.stringify(obj));
  console.log('>> SENT    ', JSON.stringify(obj));
};

ws.on('open', () => {
  console.log('connected to', url);
  send({ Cmd: 'Login', MT: 'Req', Data: { User: 'gc7', Token: '' } });
  send({ Cmd: 'Heartbeat', MT: 'Req', Data: {} });
  // plain scan
  send({ Cmd: 'Identification', MT: 'Req', Data: { Reader: 1, Barcode: scanValue } });
  // GC7 QR template: GANTNER#<Id>#<Timestamp>#<Challenge>
  send({ Cmd: 'Identification', MT: 'Req', Data: { Reader: 1, Barcode: `GANTNER#${scanValue}#1719230400#a1b2c3d4e5` } });
  // realistic App.CardIdent shape (identifier buried in Segments)
  send({ Cmd: 'App.CardIdent', MT: 'Evt', Data: { Segments: [{ SegmentType: 'BARCODE_DATA', Data: `GANTNER#${scanValue}#1719230400#zz99` }] } });
  // denied
  send({ Cmd: 'Identification', MT: 'Req', Data: { Reader: 1, Barcode: 'NOT_ALLOWED_999' } });

  // give the server a moment to respond, then exit
  setTimeout(() => ws.close(), 1500);
});

ws.on('message', (data) => console.log('<< RECEIVED', data.toString()));
ws.on('close', () => {
  console.log('closed');
  process.exit(0);
});
ws.on('error', (err) => {
  console.error('error:', err.message);
  process.exit(1);
});
