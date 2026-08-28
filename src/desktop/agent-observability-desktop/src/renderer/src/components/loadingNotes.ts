/**
 * The shared pool of playful loading notes, and the rotation rule every
 * loading surface uses (startup overlay, session detail, …).
 *
 * The rule, everywhere: a surface's own HONEST lead lines come first — a fast
 * load shows only those, and a machine that flashes "Herding tokens…" for
 * 200ms tells the user nothing — and once the wait has been long enough to
 * earn it, the rotation drifts into this pool. The pool is deliberately NOT
 * aligned to any particular stage: it exists to make a long wait feel like the
 * tool is in good spirits, not to report status. The audience is developers;
 * the jokes are theirs.
 *
 * Pure module (no react, no window) so the rotation is unit-testable in this
 * package's node-only vitest setup.
 */

export const FUN_NOTES: readonly string[] = [
  'Herding tokens…',
  'Consulting the rubber duck.',
  'Negotiating with the event loop.',
  'Moseying…',
  'Warming caches and hearts.',
  'Definitely not mining bitcoin.',
  'Counting context windows before they close.',
  'Asking the linter to be nice, just this once.',
  'Percolating…',
  'It works on this machine. That is the whole point.',
  'Rebasing vibes onto main.',
  'Pondering…',
  'Reading the logs so you do not have to.',
  'Blaming the cache. Statistically safe.',
  'Off by one, back in two.',
  'Resolving promises. All of them.',
  'Escaping the escape characters.',
  'Quietly judging tabs versus spaces.',
  'Garbage collecting. The polite kind.',
  'Bribing the scheduler with idle time.',
  'Counting to 2^53 − 1, safely.',
  'Sharpening the parsers.',
  'Zero-indexing the day.',
  'This message intentionally left rotating.',
];

/** How often a rotating note advances. */
export const NOTE_ROTATION_MS = 6_000;

/**
 * The note for one tick: the surface's own leads first — in order, tick 0 is
 * always the first lead — then the shared pool in a SEED-SHUFFLED order,
 * wrapping around. The shuffle is what keeps a daily user from memorizing the
 * sequence: each surface rolls a fresh seed when it (re)starts, so the pool
 * plays in a different order every launch, while a fixed seed keeps the
 * function pure and the tests deterministic.
 */
export function rotatedNote(leads: readonly string[], tick: number, seed = 0): string {
  const cycle = [...leads, ...shuffled(FUN_NOTES, seed)];
  return cycle[tick % cycle.length];
}

/** Fisher-Yates over a copy, driven by a seeded PRNG so it is repeatable. */
function shuffled(notes: readonly string[], seed: number): string[] {
  const random = mulberry32(seed);
  const copy = [...notes];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** Tiny deterministic PRNG — plenty for shuffling jokes. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
