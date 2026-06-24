import fs from 'fs';
import path from 'path';

const LOG_DIR = path.resolve(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'gantner-events.log');

// Ensure the log directory exists before we open the append stream.
fs.mkdirSync(LOG_DIR, { recursive: true });

const stream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

/**
 * Append one structured JSON line to ./logs/gantner-events.log AND mirror a
 * human-readable line to stdout/stderr (so Railway/Render log viewers show it too).
 */
export function log(level: LogLevel, event: string, data: Record<string, unknown> = {}): void {
  const ts = new Date().toISOString();
  const entry = { ts, level, event, ...data };

  // Persistent structured log: one JSON object per line (easy to grep / tail / parse).
  stream.write(JSON.stringify(entry) + '\n');

  // Human-readable mirror to the console / platform log stream.
  const payload = Object.keys(data).length ? ' ' + JSON.stringify(data) : '';
  const line = `[${ts}] ${level.toUpperCase()} ${event}${payload}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const LOG_FILE_PATH = LOG_FILE;
