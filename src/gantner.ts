import { config } from './config';
import { log } from './logger';

/**
 * Generic Gantner GC7 "External Webserver" message envelope.
 *
 *   { "Cmd": "Heartbeat", "MT": "Req", "TID": 123, "Data": {} }
 *
 * - Cmd:  command name (Heartbeat, Login, Identification, ...)
 * - MT:   message type — "Req" (request) or "Rsp" (response)
 * - TID:  transaction id — echo it back on the matching Rsp
 * - State: status code (0 = OK) on responses
 * - Data: command-specific payload
 */
export interface GantnerMessage {
  Cmd?: string;
  MT?: 'Req' | 'Rsp' | string;
  TID?: number;
  State?: number;
  Data?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Keys that, when present in a message (or its Data), mark it as an
 * access / scan / identification event coming from the controller.
 */
export const ACCESS_KEYS = [
  'Tag',
  'Barcode',
  'Identification',
  'Reader',
  'Card',
  'Access',
  'CheckIn',
] as const;

/**
 * TEMPORARY allow-list. Only these identifiers are treated as "access granted"
 * during bring-up. Replace with a real membership lookup later.
 */
export const ALLOWED_IDENTIFIERS = new Set<string>(['TEST123456', 'HELLO_WORLD', '12345678']);

const nowIso = (): string => new Date().toISOString();

/**
 * Cmd substrings that mark an access / scan / identification event. Includes the
 * REAL command names observed in GC7 v3.9.1 / G7 Advanced Access App v1.9.0 logs
 * (FIU.Identification, IO.TagInReader, IO.InvalidTagInReader) plus the generic
 * semantic keys.
 */
export const ACCESS_CMD_HINTS = [
  ...ACCESS_KEYS,
  'FIU',
  'IO.TagInReader',
  'IO.InvalidTagInReader',
] as const;

/** True if this looks like an access / scan / identification message. */
export function isAccessMessage(msg: GantnerMessage): boolean {
  const cmd = (msg.Cmd ?? '').toString().toLowerCase();
  if (ACCESS_CMD_HINTS.some((k) => cmd.includes(k.toLowerCase()))) return true;

  const data = msg.Data ?? {};
  return ACCESS_KEYS.some((k) => k in data) || ACCESS_KEYS.some((k) => k in msg);
}

/** Pull every plausible identifier value out of an access message. */
export function extractIdentifiers(msg: GantnerMessage): string[] {
  const out: string[] = [];
  const sources: Record<string, unknown>[] = [msg.Data ?? {}, msg as Record<string, unknown>];

  for (const src of sources) {
    for (const key of ACCESS_KEYS) {
      const v = src[key];
      if (typeof v === 'string' && v.trim()) out.push(v.trim());
      else if (typeof v === 'number') out.push(String(v));
    }
  }
  // de-dupe while preserving order
  return [...new Set(out)];
}

/* ------------------------------------------------------------------ *
 * GC7 QR template
 * ------------------------------------------------------------------ *
 * The controller's "QR code" config (Mode: Template) is set to:
 *     GANTNER#@Id#@Timestamp#@Challenge
 * '#' is the field separator and @Name are substituted values, so a scanned
 * QR arrives as:
 *     GANTNER#<Id>#<Timestamp>#<Challenge>
 * We must extract <Id> and match THAT against the allow-list — not the whole
 * string. <Timestamp> and <Challenge> are anti-replay / signature material.
 * ------------------------------------------------------------------ */

export const QR_PREFIX = 'GANTNER';

export interface GantnerQr {
  raw: string;
  prefix: string;
  id: string;
  timestamp: string;
  challenge: string;
}

/** Parse a `GANTNER#<Id>#<Timestamp>#<Challenge>` payload, or null if it isn't one. */
export function parseGantnerQr(value: string): GantnerQr | null {
  if (typeof value !== 'string') return null;
  const parts = value.split('#');
  if (parts.length < 4 || parts[0] !== QR_PREFIX) return null;
  return {
    raw: value,
    prefix: parts[0],
    id: parts[1],
    timestamp: parts[2],
    challenge: parts.slice(3).join('#'), // tolerate stray '#' inside the challenge
  };
}

/**
 * Recursively collect every string / number leaf value from a message payload.
 * Real GC7 scan events bury the identifier in places like Data.IdValue or
 * Data.Segments[].Data, so we scan the whole object rather than guessing paths.
 */
export function collectStringValues(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 6 || value === null || value === undefined) return out;
  if (typeof value === 'string') {
    if (value.trim()) out.push(value.trim());
  } else if (typeof value === 'number') {
    out.push(String(value));
  } else if (Array.isArray(value)) {
    for (const v of value) collectStringValues(v, out, depth + 1);
  } else if (typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectStringValues(v, out, depth + 1);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Response builders
 * ------------------------------------------------------------------ */

/** Heartbeat response — exact format required by the GC7. */
export function buildHeartbeatResponse(msg: GantnerMessage): GantnerMessage {
  return {
    Cmd: 'Heartbeat',
    MT: 'Rsp',
    TID: msg.TID,
    State: 0,
    Data: {
      HBI: config.heartbeatInterval,
      RT: nowIso(),
    },
  };
}

/** Login response — per spec, empty Data. We accept the login during bring-up. */
export function buildLoginResponse(msg: GantnerMessage): GantnerMessage {
  return {
    Cmd: 'Login',
    MT: 'Rsp',
    TID: msg.TID,
    State: 0,
    Data: {},
  };
}

/**
 * Relay map — confirmed from the controller config and the G7 web UI:
 *   Relay 1 = reader 1 / door 1 (Entry),  Relay 2 = reader 2 / door 2 (Exit).
 * The controller pulses the relay for its configured unlock time (3000 ms) and
 * auto-resets it; the web UI exposes this as a relay "pulse".
 */
export const ENTRY_RELAY_ID = 1;
export const EXIT_RELAY_ID = 2;

/**
 * (10) Build the door-open command for a GRANTED scan.
 *
 * CONFIRMED from the controller's own G7 web UI bundle (wss://<controller>/api).
 * The web UI opens a door with:
 *
 *   { Cmd:"IO.SetRelayState", MT:"Req", Data:{ Id, State, Device } }
 *
 * Id 1 = Entry door relay, Id 2 = Exit; the controller pulses the relay for its
 * configured unlock time (3000 ms) and auto-resets it. There is NO command named
 * `App.StartUnlockProcess` / `App.StartDenyProcess` anywhere in this firmware
 * (3.9.1 / G7 Advanced Access App v1.9.0) — that earlier reverse-engineered guess
 * was WRONG. The door is a relay.
 *
 *   GRANTED → set the Entry relay on (controller pulses + auto-resets).
 *   DENIED  → null; nothing is sent, the door simply isn't opened. (Negative
 *             reader feedback would be IO.SetStatusLED {ColorOn} / IO.PlaySound,
 *             but the ColorOn value isn't confirmed, so we don't fabricate one.)
 *
 * Whether this is actually transmitted is gated by `config.sendUnlock` in the
 * caller — default OFF (capture-only). The STILL-OPEN question is whether the
 * External Webserver channel honours an outbound IO.SetRelayState Req the same
 * way the authenticated local /api WS does; the live scan test settles it.
 */
export function buildUnlock(
  msg: GantnerMessage,
  decision: 'GRANTED' | 'DENIED',
): GantnerMessage | null {
  if (decision !== 'GRANTED') return null;
  const device = (msg.Data as Record<string, unknown> | undefined)?.Device ?? null;
  return {
    Cmd: 'IO.SetRelayState',
    MT: 'Req',
    Data: { Id: ENTRY_RELAY_ID, State: true, Device: device },
  };
}

/** Generic positive acknowledgement for messages we observe but don't yet act on. */
export function buildAck(msg: GantnerMessage): GantnerMessage {
  return {
    Cmd: msg.Cmd ?? 'Ack',
    MT: 'Rsp',
    TID: msg.TID,
    State: 0,
    Data: { RT: nowIso() },
  };
}

/* ------------------------------------------------------------------ *
 * Dispatch
 * ------------------------------------------------------------------ */

export interface HandleResult {
  /** Message to send back to the controller, or null to stay silent. */
  response: GantnerMessage | null;
  /** The unlock command we WOULD have sent (logged only, never sent yet). Null on DENIED. */
  wouldSend?: GantnerMessage | null;
  /** Classification for stats/monitoring. */
  kind?: 'heartbeat' | 'login' | 'access' | 'rsp' | 'other';
  /** Access decision, when kind === 'access'. */
  decision?: 'GRANTED' | 'DENIED';
}

export function handleMessage(msg: GantnerMessage): HandleResult {
  const cmd = (msg.Cmd ?? '').toString();
  const mt = (msg.MT ?? '').toString();

  // The controller is replying to something WE sent. Just observe it.
  if (mt === 'Rsp') {
    log('info', 'gantner.rsp_received', { cmd, tid: msg.TID, state: msg.State });
    return { response: null, kind: 'rsp' };
  }

  // (6) Heartbeat
  if (cmd === 'Heartbeat') {
    const response = buildHeartbeatResponse(msg);
    log('info', 'gantner.heartbeat', { tid: msg.TID, response });
    return { response, kind: 'heartbeat' };
  }

  // (7) Login
  if (cmd === 'Login') {
    const response = buildLoginResponse(msg);
    log('info', 'gantner.login', { tid: msg.TID, data: msg.Data, response });
    return { response, kind: 'login' };
  }

  // (8) Access / scan / identification
  if (isAccessMessage(msg)) {
    // The identifier can hide anywhere (Data.Barcode, Data.IdValue,
    // Data.Segments[].Data, ...), so scan the whole payload.
    const keyed = extractIdentifiers(msg);
    const deep = [...new Set(collectStringValues(msg.Data ?? {}))];

    // (QR) Expand any GANTNER#<Id>#<Timestamp>#<Challenge> payloads.
    const qrs = deep.map(parseGantnerQr).filter((q): q is GantnerQr => q !== null);

    const candidates = [...new Set([...keyed, ...deep, ...qrs.map((q) => q.id)])];
    const matched = candidates.find((id) => ALLOWED_IDENTIFIERS.has(id));
    const granted = Boolean(matched);

    log(granted ? 'info' : 'warn', 'gantner.access', {
      cmd,
      tid: msg.TID,
      keyed,
      qr: qrs.length ? qrs : undefined,
      decision: granted ? 'GRANTED' : 'DENIED',
      matched: matched ?? null,
    });

    // A QR carries a Challenge + Timestamp for anti-replay/signing. We can't
    // validate them yet (no secret/algorithm) — surface them as UNVERIFIED so
    // nobody mistakes "matched the Id" for "the QR is authentic".
    for (const q of qrs) {
      log('warn', 'gantner.qr_unverified', {
        id: q.id,
        timestamp: q.timestamp,
        challenge: q.challenge,
        note: 'QR Challenge signature and Timestamp freshness are NOT validated yet.',
      });
    }

    // (10) Build the unlock for a GRANT. Whether it's actually transmitted is
    // decided by config.sendUnlock in the caller (index.ts).
    const decision: 'GRANTED' | 'DENIED' = granted ? 'GRANTED' : 'DENIED';
    const wouldSend = buildUnlock(msg, decision);
    log(config.sendUnlock ? 'info' : 'warn', 'gantner.unlock', {
      decision,
      identifier: matched ?? null,
      willSend: config.sendUnlock && Boolean(wouldSend),
      note: !wouldSend
        ? 'DENIED — no door command.'
        : config.sendUnlock
          ? 'LIVE — transmitting IO.SetRelayState to open the Entry door.'
          : 'CAPTURE — not sent (set GANTNER_SEND_UNLOCK=true to go live).',
      wouldSend,
    });

    return { response: null, wouldSend, kind: 'access', decision };
  }

  // Anything else (GetDeviceInfo, IO.*, Addon.*, Config.*, Evt notifications):
  // capture-log it. Only Heartbeat and Login receive responses for now.
  log('info', 'gantner.unhandled', { cmd, mt, tid: msg.TID, data: msg.Data });
  return { response: null, kind: 'other' };
}
