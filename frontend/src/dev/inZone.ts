// For unit tests of time-zone conversion: Vitest runs in whatever zone the
// machine is in (often UTC, where local and UTC time agree and a conversion
// bug can't show), so a test that means a zone names one.

import { afterAll, beforeAll } from "vitest";

/** Runs the enclosing `describe` block's tests with the process in time zone
 * `zone` (an IANA name), and puts the machine's own back after. Node re-reads
 * `process.env.TZ` whenever it's assigned, so `Date`'s local getters follow. */
export function inZone(zone: string): void {
  let before: string | undefined;
  beforeAll(() => {
    before = process.env.TZ;
    process.env.TZ = zone;
  });
  afterAll(() => {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  });
}
