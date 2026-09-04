/** SHA-256, hex encoded. Document identity and knowledge-base identity both
 *  rest on this, so it lives in exactly one place. */

export async function sha256(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const source = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest('SHA-256', source);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const sha256Text = (text: string): Promise<string> =>
  sha256(new TextEncoder().encode(text));
