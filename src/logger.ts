import fs from 'fs';
import path from 'path';
import pino from 'pino';

const LOG_DIR = path.resolve(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'gantner-events.log');

// Ensure the log directory exists before opening the append stream.
fs.mkdirSync(LOG_DIR, { recursive: true });

const fileStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

// pino, fanned out to BOTH stdout (captured by Render/Railway log viewers) and
// ./logs/gantner-events.log. One JSON object per line; level as a label; ISO time.
const logger = pino(
  {
    level: 'debug',
    base: undefined, // drop pid/hostname noise
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  },
  pino.multistream([
    { stream: process.stdout, level: 'debug' },
    { stream: fileStream, level: 'debug' },
  ]),
);

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

/** Structured log: { time, level, event, ...data } to stdout + the log file. */
export function log(level: LogLevel, event: string, data: Record<string, unknown> = {}): void {
  logger[level]({ event, ...data });
}

export const LOG_FILE_PATH = LOG_FILE;
