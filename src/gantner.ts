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

/** True if this looks like an access / scan / identification message. */
export function isAccessMessage(msg: GantnerMessage): boolean {
  const cmd = (msg.Cmd ?? '').toString().toLowerCase();
  if (ACCESS_KEYS.some((k) => cmd.includes(k.toLowerCase()))) return true;

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

/** Login response. We accept the login during bring-up (State 0). */
export function buildLoginResponse(msg: GantnerMessage): GantnerMessage {
  return {
    Cmd: 'Login',
    MT: 'Rsp',
    TID: msg.TID,
    State: 0,
    Data: {
      HBI: config.heartbeatInterval,
      RT: nowIso(),
    },
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
  /** The unlock command we WOULD have sent (logged only, never sent yet). */
  wouldSend?: GantnerMessage;
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

    if (granted) {
      // (10) We do NOT yet know the real GC7.3000 unlock/door-open command.
      //      Best current guess (low confidence): App.StartUnlockProcess.
      //      Per spec: LOG what we would send, but do NOT send it.
      const wouldSend: GantnerMessage = {
        Cmd: 'App.StartUnlockProcess', // PLACEHOLDER (low confidence) — confirm before enabling
        MT: 'Req',
        TID: msg.TID,
        Data: {
          UnlockingTime_ms: 5000,
          Relays: [{ Id: 1, OnTime_ms: 5000 }],
          DisplayText: 'Access granted',
          Note: 'PLACEHOLDER unlock — NOT sent',
        },
      };
      log('warn', 'gantner.unlock_would_send', {
        note: 'Unlock command NOT sent — real GC7 command unconfirmed (App.StartUnlockProcess is a low-confidence guess).',
        identifier: matched,
        wouldSend,
      });

      // Acknowledge the event (so the controller does not retry) but do NOT unlock.
      return { response: buildAck(msg), wouldSend, kind: 'access', decision: 'GRANTED' };
    }

    return { response: buildAck(msg), kind: 'access', decision: 'DENIED' };
  }

  // Anything else: log and acknowledge.
  log('info', 'gantner.unhandled', { cmd, mt, tid: msg.TID, data: msg.Data });
  return { response: buildAck(msg), kind: 'other' };
}
