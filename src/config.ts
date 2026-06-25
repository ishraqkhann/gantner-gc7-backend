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
};
