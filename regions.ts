// Append-only mapping of Fly region codes to 5-bit indices used in room codes.
// NEVER reuse an index for a different region — old codes still in flight
// would decode wrong and route to the wrong place. Add new regions to the
// next free index. 5 bits caps us at 32 entries.

export const REGION_TO_IDX: Record<string, number> = {
  fra: 0,
  iad: 1,
  nrt: 2,
  lax: 3,
  gru: 4,
  syd: 5,
  sin: 6,
};

const IDX_TO_REGION: string[] = (() => {
  const out: string[] = [];
  for (const [region, idx] of Object.entries(REGION_TO_IDX)) {
    out[idx] = region;
  }
  return out;
})();

export const REGION_BITS = 5;
export const MAX_REGIONS = 1 << REGION_BITS;

export function encodeRegion(region: string): number | null {
  const idx = REGION_TO_IDX[region];
  return idx === undefined ? null : idx;
}

export function decodeRegion(idx: number): string | null {
  return IDX_TO_REGION[idx] ?? null;
}
