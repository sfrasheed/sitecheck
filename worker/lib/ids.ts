/** Sortable, prefixed ids, and one place that decides what "now" looks like. */

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

export function id(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let suffix = '';
  for (const byte of bytes) suffix += ALPHABET[byte % ALPHABET.length];
  return `${prefix}_${Date.now().toString(36)}${suffix}`;
}

export const nowIso = (): string => new Date().toISOString();
