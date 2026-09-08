import { describe, expect, it } from 'vitest';
import { timeBucket } from './timeBucket';

describe('timeBucket', () => {
  it('matches the original linear attribution including duplicate timestamps', () => {
    const times = [10, 20, 20, 35, 90];
    for (const time of [-1, 10, 19, 20, 21, 35, 89, 90, 999, NaN]) {
      let expected = 0;
      for (let i = 0; i < times.length; i++) {
        if (times[i] <= time) { expected = i; } else { break; }
      }
      expect(timeBucket(times, time, (point) => point)).toBe(expected);
    }
  });

  it('uses logarithmic probes on a large series, not a scan per write', () => {
    const times = Array.from({ length: 65_536 }, (_, i) => i);
    let probes = 0;
    expect(timeBucket(times, 60_000, (point) => { probes++; return point; })).toBe(60_000);
    expect(probes).toBeLessThanOrEqual(17);
  });
});