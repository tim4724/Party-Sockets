// Bitcoin base58 alphabet — excludes 0, O, I, l to avoid visual ambiguity.
// Case-sensitive. 5.858 bits per char, so 6 chars holds up to 35.15 bits.

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const CHAR_TO_IDX: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < ALPHABET.length; i++) m[ALPHABET[i]] = i;
  return m;
})();

export function encode(value: number, chars: number): string {
  let n = BigInt(value);
  const base = 58n;
  let out = "";
  for (let i = 0; i < chars; i++) {
    out = ALPHABET[Number(n % base)] + out;
    n = n / base;
  }
  return out;
}

export function decode(code: string): number | null {
  let n = 0n;
  for (let i = 0; i < code.length; i++) {
    const v = CHAR_TO_IDX[code[i]];
    if (v === undefined) return null;
    n = n * 58n + BigInt(v);
  }
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(n);
}
