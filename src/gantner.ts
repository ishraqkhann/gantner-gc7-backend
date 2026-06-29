import crypto from 'crypto';
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

// NOTE: there is deliberately NO local allow-list. Access is decided ONLY by
// Clap House via validateWithClapHouse() — the backend forwards the scanned token
// and obeys the verdict. (The old TEST123456 commissioning allow-list was removed
// when Clap House became the source of truth.)

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

/**
 * Reader/device label noise that turns up as string leaves in scan events but is
 * NEVER the scanned token (e.g. "READER1", "BARCODE2", "BARCODE_DATA", "UNKNOWN").
 * Used by extractScanToken's fallback so we never forward a device name as the QR.
 */
const TOKEN_NOISE = /^(READER\d*|BARCODE\d*|BARCODE_DATA|UNKNOWN|TAG|CARD)$/i;

/** Direct fields that may carry the scanned token (in Data or at the top level). */
const TOKEN_FIELDS = ['Barcode', 'Tag', 'Identification', 'Card'] as const;

/**
 * Extract the ONE raw scanned string to forward to Clap House as `token`.
 *
 * Clap House is the source of truth and treats the token as opaque (it's a
 * short-lived signed JWT) — so we forward the scan VERBATIM and never parse it.
 * We only need to pick the right leaf out of the GC7 scan envelope:
 *
 *   IO.BarcodeRead     → Data.Barcode
 *   IO.TagInReader     → Data.Tag  | Data.Segments[].Data (SegmentType BARCODE_DATA)
 *   FIU.Identification → Data.Identification
 *
 * Falls back to the longest non-noise string anywhere in Data (a JWT is long and
 * contains dots, so it wins) — covers QR-mode=API framings we haven't seen yet.
 * Returns null when there's nothing scannable (e.g. IO.InvalidTagInReader).
 */
export function extractScanToken(msg: GantnerMessage): string | null {
  const d = (msg.Data ?? {}) as Record<string, unknown>;

  // 1) Known direct fields, in priority order — in Data, then at the top level
  //    (isAccessMessage accepts a token in either place, so extraction must too).
  for (const key of TOKEN_FIELDS) {
    const v = d[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  for (const key of TOKEN_FIELDS) {
    const v = (msg as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }

  // 2) IO.TagInReader rich form: Segments[].Data (prefer BARCODE_DATA).
  if (Array.isArray(d.Segments)) {
    const segs = d.Segments as Array<Record<string, unknown>>;
    const barcodeSeg = segs.find(
      (s) => typeof s?.Data === 'string' && (s as { Data: string }).Data.trim() &&
        String(s?.SegmentType ?? '').toUpperCase().includes('BARCODE'),
    );
    const anySeg = segs.find((s) => typeof s?.Data === 'string' && (s as { Data: string }).Data.trim());
    const seg = (barcodeSeg ?? anySeg) as { Data?: string } | undefined;
    if (seg?.Data) return seg.Data.trim();
  }

  // 3) Fallback: the longest non-noise, non-numeric string leaf in Data. A JWT
  //    token (header.payload.signature) is far longer than any reader/device
  //    label, and prefer one that is JWT-shaped (two dots) if several tie.
  //    This is best-effort for scan framings we haven't seen — log it so a wrong
  //    pick surfaces (a mis-forwarded leaf just gets denied by Clap House, which
  //    is otherwise indistinguishable from a normal denial).
  const leaves = collectStringValues(d).filter(
    (s) => s.length >= 4 && !TOKEN_NOISE.test(s) && !/^\d+$/.test(s),
  );
  if (!leaves.length) return null;
  const jwtish = leaves.filter((s) => (s.match(/\./g) ?? []).length >= 2);
  const pool = jwtish.length ? jwtish : leaves;
  const chosen = pool.reduce((a, b) => (b.length > a.length ? b : a));
  log('warn', 'gantner.token_fallback', {
    cmd: msg.Cmd,
    chosenLen: chosen.length,
    jwtShaped: jwtish.length > 0,
    note: 'no known token field matched — forwarding a heuristic leaf to Clap House.',
  });
  return chosen;
}

/** Short, stable, non-reversible fingerprint of a token — for dedup + logging. */
export function tokenFingerprint(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
}

/**
 * Return a copy of a scan message with the token-bearing leaves replaced by a
 * fingerprint, so a live single-use token is never written to logs / the capture
 * ring / the raw dump. Correlation is preserved via the `tok:<fp>` marker.
 */
export function redactScanFields(msg: GantnerMessage): GantnerMessage {
  const clone: GantnerMessage = { ...msg };
  // Top-level token fields (isAccessMessage accepts them there too).
  for (const f of TOKEN_FIELDS) {
    const v = (msg as Record<string, unknown>)[f];
    if (typeof v === 'string' && v.trim()) (clone as Record<string, unknown>)[f] = `tok:${tokenFingerprint(v.trim())}`;
  }
  if (msg.Data && typeof msg.Data === 'object' && !Array.isArray(msg.Data)) {
    const d: Record<string, unknown> = { ...(msg.Data as Record<string, unknown>) };
    for (const f of TOKEN_FIELDS) {
      const v = d[f];
      if (typeof v === 'string' && v.trim()) d[f] = `tok:${tokenFingerprint(v.trim())}`;
    }
    if (Array.isArray(d.Segments)) {
      d.Segments = (d.Segments as Array<unknown>).map((s) => {
        if (s && typeof s === 'object' && typeof (s as { Data?: unknown }).Data === 'string') {
          const seg = s as Record<string, unknown>;
          const data = (seg.Data as string).trim();
          return data ? { ...seg, Data: `tok:${tokenFingerprint(data)}` } : seg;
        }
        return s;
      });
    }
    clone.Data = d;
  }
  return clone;
}

/**
 * Stable key for the physical reader that produced a scan, used to collapse the
 * TWO events one physical scan emits (IO.BarcodeRead + IO.TagInReader) into ONE
 * decision — independent of how each event encodes the token. Null if unknown.
 */
export function readerKey(msg: GantnerMessage): string | null {
  const d = (msg.Data ?? {}) as Record<string, unknown>;
  if (typeof d.ReaderId === 'number') return `r${d.ReaderId}`;
  if (typeof d.Reader === 'number') return `r${d.Reader}`;
  if (typeof d.ReaderID === 'string' && d.ReaderID.trim()) {
    const m = d.ReaderID.match(/(\d+)\s*$/);
    return m ? `r${m[1]}` : `rid:${d.ReaderID.trim()}`;
  }
  // Some framings (e.g. FIU.Identification) carry only Data.Device = "READER1".
  if (typeof d.Device === 'string' && d.Device.trim()) {
    const m = d.Device.match(/(\d+)\s*$/);
    return m ? `r${m[1]}` : `dev:${d.Device.trim()}`;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Clap House access decision (source of truth)
 * ------------------------------------------------------------------ */

export interface ValidateResult {
  result: 'granted' | 'denied';
  /** Present on a denial. Clap House values + our local fail-closed reasons. */
  denialReason?: string;
}

/**
 * Ask Clap House whether to open the gate for this scan. POSTs the raw token and
 * gate id to /api/access/validate and returns its verdict. Treats EVERYTHING
 * that isn't an explicit { result: "granted" } as a denial:
 *
 *   - HTTP 400/401/5xx, malformed JSON, network error, timeout → DENIED.
 *
 * This is the FAIL-CLOSED guarantee: if Clap House is unreachable or slow, the
 * gate stays shut. A gate must never open on uncertainty.
 */
export async function validateWithClapHouse(token: string, gateId: string): Promise<ValidateResult> {
  try {
    const res = await fetch(config.claphouseValidateUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Sent verbatim per the contract; empty until GATE_API_KEY is set on
        // both sides, at which point Clap House starts enforcing it.
        'x-gate-key': config.gateApiKey,
      },
      body: JSON.stringify({ token, gateId }),
      signal: AbortSignal.timeout(config.validateTimeoutMs),
    });

    if (!res.ok) {
      // 400 (no token / bad JSON) or 401 (bad x-gate-key) → keep closed.
      const denialReason = res.status === 401 ? 'unauthorized' : res.status === 400 ? 'bad_request' : `http_${res.status}`;
      log('warn', 'claphouse.http_error', { status: res.status, gateId, denialReason });
      return { result: 'denied', denialReason };
    }

    const body = (await res.json().catch(() => null)) as { result?: string; denialReason?: string } | null;
    if (body?.result === 'granted') return { result: 'granted' };
    return { result: 'denied', denialReason: body?.denialReason ?? 'denied' };
  } catch (err) {
    // Unreachable / timed out / DNS / TLS — FAIL CLOSED.
    const denialReason = (err as Error)?.name === 'TimeoutError' ? 'timeout' : 'unreachable';
    log('error', 'claphouse.unreachable', { gateId, denialReason, error: (err as Error)?.message });
    return { result: 'denied', denialReason };
  }
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
 * Door-open command, for reference — CONFIRMED from the controller's own G7 web UI
 * bundle (wss://<controller>/api): the door is a RELAY, opened with
 *   { Cmd:"IO.SetRelayState", MT:"Req", Data:{ Id, State:true } }
 * (Id 1 = Entry relay, 2 = Exit; controller pulses then the backend closes it).
 * `App.StartUnlockProcess` does NOT exist on this firmware (3.9.1). index.ts builds
 * and transmits this frame directly using the gate's topology relay — see
 * unlockTargets()/sendRelay() there.
 */

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
  /** Classification for stats/monitoring. */
  kind?: 'heartbeat' | 'login' | 'access' | 'rsp' | 'other';
  /**
   * Raw scanned token to forward to Clap House, when kind === 'access'. Null when
   * the scan carried nothing readable (e.g. IO.InvalidTagInReader).
   */
  token?: string | null;
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

  // (8) Access / scan / identification. The DECISION is no longer made here —
  // Clap House (https://claphouse.co) is the source of truth. We only pull
  // out the raw scanned token and the candidate relay frame; index.ts then calls
  // validateWithClapHouse() and pulses the relay on a grant. Forward the token
  // VERBATIM — never parse, cache, or second-guess it.
  if (isAccessMessage(msg)) {
    const token = extractScanToken(msg);
    log('info', 'gantner.scan', {
      cmd,
      tid: msg.TID,
      hasToken: Boolean(token),
      tokenLen: token?.length ?? 0,
      note: token ? undefined : 'no readable token in scan — will be denied locally (no Clap House call).',
    });
    return { response: null, kind: 'access', token };
  }

  // Anything else (GetDeviceInfo, IO.*, Addon.*, Config.*, Evt notifications):
  // capture-log it. Log only the Data KEYS, not values — an unforeseen framing
  // could carry a token in a non-standard field, and this path isn't redacted.
  log('info', 'gantner.unhandled', { cmd, mt, tid: msg.TID, dataKeys: msg.Data ? Object.keys(msg.Data) : [] });
  return { response: null, kind: 'other' };
}
