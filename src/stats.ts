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
  direction?: 'entry' | 'exit';
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

export function statusSnapshot() {
  const now = Date.now();
  return {
    ok: true,
    service: 'gantner-gc7-backend',
    startedAt: serverStartedAt,
    activeConnections: connections.size,
    connections: [...connections.values()].map((c) => ({
      ...c,
      idleSeconds: Math.round((now - Date.parse(c.lastSeen)) / 1000),
    })),
    totals,
    lastSeen,
  };
}
