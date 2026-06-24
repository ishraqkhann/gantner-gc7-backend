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
  // Observed real GC7 v3.9.1 / G7 Advanced Access App scan events (Q300 over RS232).
  // These are MT:'Evt' notifications — the server logs/captures them but (capture
  // phase) does NOT respond.
  send({ Cmd: 'IO.TagInReader', MT: 'Evt', Data: { Device: 'READER1', Reader: 1, Tag: scanValue } });
  send({ Cmd: 'FIU.Identification', MT: 'Evt', Data: { Device: 'READER1', Identification: scanValue } });
  // QR template form, identifier buried inside a value
  send({ Cmd: 'IO.TagInReader', MT: 'Evt', Data: { Device: 'READER2', Reader: 2, Barcode: `GANTNER#${scanValue}#1719230400#zz99` } });
  // unreadable scan + a non-allowed value
  send({ Cmd: 'IO.InvalidTagInReader', MT: 'Evt', Data: { Device: 'READER1', Reader: 1 } });
  send({ Cmd: 'FIU.Identification', MT: 'Evt', Data: { Device: 'READER1', Identification: 'NOT_ALLOWED_999' } });
  // other observed traffic (captured, not responded to)
  send({ Cmd: 'IO.RelayStateChanged', MT: 'Evt', Data: { Relay: 1, State: false } });

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
