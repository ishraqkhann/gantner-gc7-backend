// Lightweight in-memory runtime stats so we can confirm controller activity
// over HTTP (GET /status) without needing the platform's log API.
// NOTE: deliberately holds NO member identifiers / card values — only counts
// and connection metadata — so /status is safe to expose during bring-up.

export interface ConnInfo {
  connId: number;
  remote?: string;
  /** Real client IP from x-forwarded-for (the site's public IP behind NAT). */
  clientIp?: string;
  /** Stable fingerprint of the Authorization token — distinguishes the 4 gates. */
  tokenFp?: string;
  connectedAt: string;
  lastSeen: string;
  messages: number;
  authPresent: boolean;
  lastCmd?: string;
  /** Controller identity, resolved from GetDeviceInfo on connect. */
  serial?: string;
  gateName?: string;
  door?: 1 | 2;
  side?: 'L' | 'R';
}

export const serverStartedAt = new Date().toISOString();

export const totals = {
  connectionsOpened: 0,
  messages: 0,
  heartbeats: 0,
  logins: 0,
  accessEvents: 0,
  accessGranted: 0,
  accessDenied: 0,
};

export const lastSeen = {
  heartbeatAt: null as string | null,
  loginAt: null as string | null,
  accessAt: null as string | null,
  accessDecision: null as string | null, // 'GRANTED' | 'DENIED' (no identifier)
};

export const connections = new Map<number, ConnInfo>();

/* ------------------------------------------------------------------ *
 * Packet capture ring buffer (for GET /recent)
 * ------------------------------------------------------------------ *
 * Holds the last N inbound frames so we can inspect exactly what the GC7 sends
 * over HTTP, without the platform log API. Bring-up tool — may contain
 * identifiers; protect or remove before long-term production exposure.
 */
export interface CapturedMessage {
  ts: string;
  connId: number;
  dir?: 'in' | 'out';
  cmd?: string;
  mt?: string;
  isAccess: boolean;
  raw: string;
  parsed?: unknown;
}

const MAX_CAPTURE = 120;
export const recentMessages: CapturedMessage[] = [];

export function capture(m: CapturedMessage): void {
  recentMessages.push(m);
  if (recentMessages.length > MAX_CAPTURE) {
    recentMessages.splice(0, recentMessages.length - MAX_CAPTURE);
  }
}

/* ------------------------------------------------------------------ *
 * Access decision feed (for GET /recent — read live by the Clap House admin)
 * ------------------------------------------------------------------ *
 * One entry per access decision. Contains NO raw token / NO PII — only gate,
 * decision and denial reason. Field names are doubled (decision+result,
 * gateName+gate) because the Clap House reader is defensive about field names.
 */
export interface AccessDecision {
  at: string; // ISO timestamp of the decision
  gateName: string;
  gate: string; // alias of gateName
  serial?: string;
  decision: 'granted' | 'denied';
  result: 'granted' | 'denied'; // alias of decision
  denialReason?: string;
}

const MAX_DECISIONS = 120;
export const recentDecisions: AccessDecision[] = [];

export function recordDecision(d: {
  at: string;
  gateName: string;
  serial?: string;
  decision: 'granted' | 'denied';
  denialReason?: string;
}): void {
  const entry: AccessDecision = {
    at: d.at,
    gateName: d.gateName,
    gate: d.gateName,
    serial: d.serial,
    decision: d.decision,
    result: d.decision,
    denialReason: d.denialReason,
  };
  recentDecisions.push(entry);
  if (recentDecisions.length > MAX_DECISIONS) {
    recentDecisions.splice(0, recentDecisions.length - MAX_DECISIONS);
  }
}

export function statusSnapshot() {
  const now = Date.now();
  return {
    ok: true,
    service: 'gantner-gc7-backend',
    startedAt: serverStartedAt,
    activeConnections: connections.size,
    // Whitelist only the fields the Clap House admin needs. Deliberately OMIT
    // clientIp / remote / tokenFp — this endpoint is unauthenticated, and the
    // site's public IP + controller auth-token fingerprints are recon material.
    connections: [...connections.values()].map((c) => ({
      connId: c.connId,
      serial: c.serial,
      gateName: c.gateName,
      door: c.door,
      side: c.side,
      connectedAt: c.connectedAt,
      lastSeen: c.lastSeen,
      idleSeconds: Math.round((now - Date.parse(c.lastSeen)) / 1000),
      messages: c.messages,
      lastCmd: c.lastCmd,
      authPresent: c.authPresent,
    })),
    totals,
    lastSeen,
  };
}
