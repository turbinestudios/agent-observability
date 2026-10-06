/**
 * The text of a count badge on a rail entry. Nothing for zero (no badge at
 * all), and capped so a busy day cannot widen the collapsed rail.
 */
export function railBadgeText(count: number | undefined): string | undefined {
  if (count === undefined || !Number.isFinite(count) || count <= 0) {
    return undefined;
  }
  return count > 9 ? '9+' : String(Math.floor(count));
}

/** The accessible name of a rail entry with a badge: "Workspace, 3 new". */
export function railBadgeLabel(label: string, count: number | undefined): string {
  const text = railBadgeText(count);
  return text === undefined ? label : `${label}, ${text} new`;
}
