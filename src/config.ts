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
};
