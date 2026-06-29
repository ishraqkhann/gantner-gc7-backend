// Site topology — the 4 Gantner GC7 controllers grouped by PHYSICAL DOOR.
//
// Each doorway has two leaves (left + right), each driven by its own controller.
// A valid scan must open BOTH leaves of the same doorway together:
//   Door 1 = DL1 + DR1
//   Door 2 = DL2 + DR2
//
// CRITICAL: the controller *names* (Entry/Exit/Left/Right) do NOT match the
// physical doors — they were mislabeled by the installer. The real grouping
// below was established on 2026-06-25 by scanning each leaf's reader and reading
// the serial straight from the backend log (deterministic), not by the names.
//
//   Door 1: DL1 = R1_Exit_Right (…243, scan),  DR1 = R4_Entry_Left (…171, elim)
//   Door 2: DL2 = R2_Exit_Left  (…167, the .42 bench unit), DR2 = R3_Entry_Right (…447, scan)
//
// Identity is resolved per connection from GetDeviceInfo (all 4 share one access
// token, so the serial is the only reliable discriminator).

export interface Gate {
  serial: string;
  name: string; // GAT manager name — informational only; does NOT match the door
  door: 1 | 2; // which physical doorway this leaf belongs to
  side: 'L' | 'R'; // informational
  doorRelay: number; // relay that opens this leaf's barrier
}

// PRAGMATIC COMMISSIONING GROUPING (2026-06-25): pair the two leaves that
// physically work NOW so a scan opens two at once, and park the two dead leaves.
//   Group 1 (LIVE):    R1_Exit_Right + R3_Entry_Right — both open on Relay 2 (confirmed)
//   Group 2 (PARKED):  R4_Entry_Left (stuck leaf) + R2_Exit_Left (.42, offline)
// Once R4's leaf is un-stuck and .42 is connected, restore the true physical
// doorway pairing (a scan at each leaf maps its serial — see git history).
// doorRelay = 2 for all (R1/R3 confirmed; reader 2 is the active path).
export const GATES: Record<string, Gate> = {
  // Group 1 — the working pair
  '2417030243': { serial: '2417030243', name: 'R1_Exit_Right', door: 1, side: 'L', doorRelay: 2 },
  '2326030447': { serial: '2326030447', name: 'R3_Entry_Right', door: 1, side: 'R', doorRelay: 2 },
  // Group 2 — parked (dead hardware)
  '2326030171': { serial: '2326030171', name: 'R4_Entry_Left', door: 2, side: 'L', doorRelay: 2 }, // stuck leaf
  // Named R1_Exit_Left per the Clap House handoff §4 (its gateName for this serial).
  // The installer's GAT-manager name for this unit was "R2_Exit_Left" (.42 bench
  // unit) — kept aligned to the integration contract; Clap House matches by serial.
  '2326030167': { serial: '2326030167', name: 'R1_Exit_Left', door: 2, side: 'R', doorRelay: 2 }, // .42 offline
};

export const KNOWN_SERIALS = Object.keys(GATES);

export function gateForSerial(serial: string | undefined): Gate | null {
  return serial ? GATES[serial] ?? null : null;
}

/** Both leaves of the given physical doorway. */
export function gatesInDoor(door: 1 | 2): Gate[] {
  return Object.values(GATES).filter((g) => g.door === door);
}

/**
 * Pull a known controller serial out of an arbitrary GetDeviceInfo payload.
 * Format-agnostic: matches any string value equal to a known serial.
 */
export function serialFromValues(values: string[]): string | null {
  for (const v of values) {
    if (KNOWN_SERIALS.includes(v)) return v;
  }
  return null;
}
