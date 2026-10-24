/**
 * Deterministic pseudo-random utilities. Every algorithm that needs "randomness"
 * (tie-breaking, shuffles) takes a seed so results are reproducible and auditable.
 */

/** FNV-1a 32-bit hash of a string. */
export function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 PRNG. Returns a function producing floats in [0, 1). */
export function createRng(seed: number | string): () => number {
  let a = typeof seed === 'string' ? hashString(seed) : seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle (returns a new array). */
export function seededShuffle<T>(items: readonly T[], seed: number | string): T[] {
  const rng = createRng(seed);
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** murmur3 finaliser: spreads small input differences over all 32 bits. */
export function mix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Stable deterministic tie-break key for an id under a seed. FNV alone barely changes when only the
 * last character differs (p01, p02, ...), which made "random" tie-breaks follow id order; the
 * finaliser fixes that.
 */
export function tieKey(id: string, seed: number | string): number {
  return mix32(hashString(`${seed}::${id}`));
}
