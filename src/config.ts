import dotenv from 'dotenv';

dotenv.config();

/**
 * Central runtime configuration, sourced from environment / .env.
 */
export const config = {
  /** HTTP + WebSocket listen port. Railway/Render inject PORT automatically. */
  port: parseInt(process.env.PORT ?? '3000', 10),

  /**
   * Optional shared secret. Reserved for when we start *enforcing* GC7 Login
   * credentials. Empty string => not enforced yet (current bring-up phase).
   */
  accessToken: process.env.GANTNER_ACCESS_TOKEN ?? '',

  /** Heartbeat interval (seconds) advertised back to the controller (HBI). */
  heartbeatInterval: parseInt(process.env.HEARTBEAT_INTERVAL ?? '30', 10),

  /**
   * Send a `RegisterEvent` subscription on connect. OFF by default (capture
   * phase). Flip to true only if scans don't arrive — it asks the controller to
   * push events. Filter is configurable (some firmwares need a namespace).
   */
  registerEvents: (process.env.GANTNER_REGISTER_EVENTS ?? 'true').toLowerCase() === 'true',
  registerEventFilter: process.env.GANTNER_REGISTER_FILTER ?? '*',

  /**
   * LIVE DECISION SWITCH. When false (default), an access GRANT only LOGS the
   * unlock it WOULD send (safe capture phase). When true, the backend actually
   * transmits `IO.SetRelayState {Id:1,State:true}` to open the Entry door on a
   * granted scan. Only allow-listed identifiers ever grant, so flipping this on
   * can at most OPEN a door for a known test QR — it can never lock anyone out.
   * Flip on (GANTNER_SEND_UNLOCK=true) only to run the live end-to-end test.
   */
  sendUnlock: (process.env.GANTNER_SEND_UNLOCK ?? 'false').toLowerCase() === 'true',

  /**
   * How long (ms) a door relay stays energized before the backend sends
   * State:false to close it. IO.SetRelayState{State:true} LATCHES on this
   * firmware (it does not auto-reset), so we must close it ourselves — otherwise
   * the barrier stays open. Matches the controller's 3000 ms unlock time.
   */
  unlockPulseMs: parseInt(process.env.GANTNER_UNLOCK_PULSE_MS ?? '3000', 10),

  /* ----------------------------- Clap House ------------------------------ *
   * Clap House (https://claphouse.co) is the SOURCE OF TRUTH for access.
   * On every scan we forward the raw QR token to its validate endpoint and only
   * open the gate when it replies { result: "granted" }. We never parse or trust
   * the token ourselves — Clap House verifies signature/expiry/single-use/hours.
   */

  /** Clap House access-decision endpoint. POST { token, gateId } → { result }. */
  claphouseValidateUrl:
    process.env.CLAPHOUSE_VALIDATE_URL ?? 'https://claphouse.co/api/access/validate',

  /**
   * Shared gate key sent as the `x-gate-key` header. Empty = not yet set (the
   * endpoint is open until the key is configured on BOTH sides — see the brief's
   * §7). Set GATE_API_KEY here AND in Clap House's Vercel env at the same time.
   */
  gateApiKey: process.env.GATE_API_KEY ?? '',

  /**
   * Timeout (ms) for the Clap House validate call. On timeout / any error we
   * FAIL CLOSED (deny) — a gate must never open on uncertainty.
   */
  validateTimeoutMs: parseInt(process.env.CLAPHOUSE_TIMEOUT_MS ?? '5000', 10),

  /**
   * Admin secret for the destructive relay-control endpoints (/relay/pulse,
   * /relay/close-all). These bypass Clap House and open/close barriers directly,
   * so they are DISABLED unless this is set AND the caller presents a matching
   * `x-admin-key` header. Empty (default) => the endpoints return 403.
   */
  adminKey: process.env.ADMIN_API_KEY ?? '',

  /**
   * Relay to pulse when a granted scan arrives on a controller we have NOT yet
   * identified (GetDeviceInfo still in flight, or unknown serial). All four live
   * gates at this site use relay 2, so default to 2 rather than the reader-derived
   * number (which could be 1 and open nothing).
   */
  fallbackRelay: parseInt(process.env.GANTNER_FALLBACK_RELAY ?? '2', 10),

  /**
   * Log full raw/parsed frames even for access scans. OFF in production: a scan
   * frame contains the live single-use token, so by default we redact the
   * token-bearing fields before logging/capturing. Turn on only for local debug.
   */
  logRawFrames: (process.env.GANTNER_LOG_RAW_FRAMES ?? 'false').toLowerCase() === 'true',
};
