// Fly region codes, indexed by array position. The index is encoded into the
// top 5 bits of every room code, so don't reorder — instances on the old and
// new code talk to each other during a deploy, and a shifted index would
// route in-flight rooms to the wrong region. Append new Fly regions at the
// end. 5 bits caps us at 32 entries.

export const REGIONS = [
  "ams", "arn", "bom", "cdg", "dfw", "ewr", "fra", "gru", "iad",
  "jnb", "lax", "lhr", "nrt", "ord", "sin", "sjc", "syd", "yyz",
];

export const REGION_BITS = 5;

export function encodeRegion(region: string): number | null {
  const idx = REGIONS.indexOf(region);
  return idx === -1 ? null : idx;
}

export function decodeRegion(idx: number): string | null {
  return REGIONS[idx] ?? null;
}
