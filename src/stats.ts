// Lightweight in-memory runtime stats so we can confirm controller activity
// over HTTP (GET /status) without needing the platform's log API.
// NOTE: deliberately holds NO member identifiers / card values — only counts
// and connection metadata — so /status is safe to expose during bring-up.

export interface ConnInfo {
  connId: number;
  remote?: string;
  connectedAt: string;
  lastSeen: string;
  messages: number;
  authPresent: boolean;
  lastCmd?: string;
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
