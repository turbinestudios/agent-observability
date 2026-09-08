/**
 * Index of the last ordered point at/before time, including the LAST equal
 * timestamp. Times before the first point belong to bucket zero, matching the
 * detail rollups' historical attribution. Callers only use non-empty series.
 */
export function timeBucket<T>(points: readonly T[], time: number, timestamp: (point: T) => number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (timestamp(points[mid]) <= time) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return Math.max(0, lo - 1);
}