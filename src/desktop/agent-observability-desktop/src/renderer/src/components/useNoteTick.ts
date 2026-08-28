import { useEffect, useState } from 'react';
import { NOTE_ROTATION_MS } from './loadingNotes';

/**
 * The tick and shuffle seed behind a rotating loading note (see
 * `./loadingNotes.ts`).
 *
 * Restarts from tick 0 — and rolls a fresh seed — whenever `resetKey` changes,
 * so a new surface (a different session, a new startup stage) opens on its
 * honest lead line and then plays the fun pool in a fresh order, not the same
 * sequence every launch. `active` pauses the timer once the surface has
 * loaded — a mounted-but-idle component should not keep an interval alive for
 * a note nobody can see.
 */
export function useNoteTick(resetKey: unknown, active = true): { tick: number; seed: number } {
  const [tick, setTick] = useState(0);
  const [seed, setSeed] = useState(rollSeed);
  useEffect(() => {
    setTick(0);
    setSeed(rollSeed());
    if (!active) {
      return;
    }
    const timer = setInterval(() => setTick((current) => current + 1), NOTE_ROTATION_MS);
    return () => clearInterval(timer);
  }, [resetKey, active]);
  return { tick, seed };
}

function rollSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}
