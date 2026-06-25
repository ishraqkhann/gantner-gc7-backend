// Site topology — the 4 Gantner GC7 controllers and how they group.
//
// A valid scan opens both barriers in the SAME DIRECTION:
//   - a scan on either ENTRY controller opens both entry barriers
//   - a scan on either EXIT  controller opens both exit  barriers
//
// We identify which physical controller a WebSocket connection is by its SERIAL
// (read from GetDeviceInfo on connect) — all 4 share one access token, so the
// token can't tell them apart, but the serial can. Serials below are from the
// site's GAT device manager.

export type Direction = 'entry' | 'exit';

export interface Gate {
  serial: string;
  name: string;
  direction: Direction;
  /** Relay that opens this controller's barrier. */
  doorRelay: number;
}

// doorRelay = 1 per the site wiring (commissioning). NOTE: the first live test
// opened Relay 2 (the scan came in on reader 2); if a barrier doesn't move,
// flip the relevant doorRelay to 2 here — single source of truth.
export const GATES: Record<string, Gate> = {
  '2326030171': { serial: '2326030171', name: 'R4_Entry_Left', direction: 'entry', doorRelay: 1 },
  '2326030447': { serial: '2326030447', name: 'R3_Entry_Right', direction: 'entry', doorRelay: 1 },
  '2417030243': { serial: '2417030243', name: 'R1_Exit_Right', direction: 'exit', doorRelay: 1 },
  '2326030167': { serial: '2326030167', name: 'R2_Exit_Left', direction: 'exit', doorRelay: 1 },
};

export const KNOWN_SERIALS = Object.keys(GATES);

export function gateForSerial(serial: string | undefined): Gate | null {
  return serial ? GATES[serial] ?? null : null;
}

export function gatesInDirection(direction: Direction): Gate[] {
  return Object.values(GATES).filter((g) => g.direction === direction);
}

/**
 * Pull a known controller serial out of an arbitrary GetDeviceInfo payload.
 * Format-agnostic: we just look for any string value that equals one of our
 * known serials, so it works regardless of which field name the firmware uses.
 */
export function serialFromValues(values: string[]): string | null {
  for (const v of values) {
    if (KNOWN_SERIALS.includes(v)) return v;
  }
  return null;
}
