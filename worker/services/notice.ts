/**
 * Telling somebody when a submission could not be judged.
 *
 * The board already carries a "No review" notice on the item. That is the
 * right place for it and it is not enough: nobody watches a board column, and
 * a key that had been refused for twenty-six days was found by someone asking
 * a question, not by anyone noticing. This is the part that reaches a person.
 *
 * Shaped after Deep Screen's internal notice, for the same reasons:
 *
 *   IT TAKES NO RECIPIENT. Who is told is configuration, so no caller — and
 *   nothing a builder typed — can address one of these anywhere. A customer
 *   address has no way in.
 *
 *   IT CARRIES NO VERDICT, which here is simple: there isn't one. That is the
 *   entire subject of the message. It says what could not be judged and why,
 *   and links to the item.
 *
 *   AN EMPTY LIST SENDS NOTHING and says so, rather than failing.
 *
 * Sending runs on the same Entra app registration Deep Screen uses, so there
 * is no second consent and no second credential to rotate — only the same
 * three secrets set on this Worker too. The mailbox is the one the tenant's
 * Application Access Policy already permits that app.
 */

import type { Env } from '../env.ts';

type Token = { value: string; expires: number };
let cached: Token | null = null;

async function accessToken(env: Env): Promise<string> {
  if (cached && cached.expires > Date.now() + 60_000) return cached.value;

  const tenant = env.GRAPH_TENANT_ID ?? '';
  const client = env.MAIL_CLIENT_ID ?? '';
  const secret = env.MAIL_CLIENT_SECRET ?? '';
  if (!tenant || !client || !secret) throw new Error('the mail app registration is not configured');

  const response = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client,
      client_secret: secret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  const body = (await response.json().catch(() => null)) as
    | { access_token?: string; expires_in?: number; error_description?: string }
    | null;
  if (!response.ok || !body?.access_token) {
    throw new Error(`Microsoft would not issue a token: ${body?.error_description ?? response.status}`);
  }
  cached = { value: body.access_token, expires: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return cached.value;
}

/** Who gets told. Configuration, never an argument. */
export const recipients = (env: Env): string[] =>
  (env.NOTICE_TO ?? '')
    .split(/[,;\s]+/)
    .map((a) => a.trim())
    .filter((a) => a.includes('@'));

/**
 * Send one notice.
 *
 * Throws on refusal so the caller can record that nobody was told. It is the
 * caller's job to swallow it: mail must never decide whether a review was
 * recorded, which is the same rule the board write already follows.
 */
export async function send(env: Env, subject: string, body: string): Promise<boolean> {
  const to = recipients(env);
  if (to.length === 0) return false;

  const from = env.NOTICE_FROM ?? 'sales@steedform.com';
  const token = await accessToken(env);
  const response = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: 'Text', content: body },
          toRecipients: to.map((address) => ({ emailAddress: { address } })),
        },
        saveToSentItems: false,
      }),
    },
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Microsoft refused the notice (${response.status}): ${detail.slice(0, 200)}`);
  }
  return true;
}

/**
 * The cause of a failure, reduced to something two failures can be compared on.
 *
 * Not the whole message: it carries a request id, a timestamp and a row count,
 * so twenty-five instances of one dead credential would each look unique and
 * each send an email. The status code or the error type is the part that says
 * whether this is the same fault still happening.
 */
export function causeOf(kind: 'REFUSED' | 'FAILED', reason: string): string {
  if (kind === 'REFUSED') return 'refusal';
  const status = /\b(4\d\d|5\d\d)\b/.exec(reason)?.[1];
  // The envelope's own `"type":"error"` says nothing; the one inside it names
  // the fault. Take the first that is not the generic wrapper, so a dead key
  // reads `401:authentication_error` rather than `401:error`.
  const named = [...reason.matchAll(/"type"\s*:\s*"([a-z_]+)"/g)]
    .map((m) => m[1])
    .find((t) => t !== 'error');
  if (status || named) return [status, named].filter(Boolean).join(':');
  // No code and no type — a message of our own. Trim it at a word so the
  // record reads as English rather than a severed sentence.
  const plain = reason.replace(/[0-9a-f]{8,}/gi, '').trim().toLowerCase();
  return plain.length <= 48 ? plain : plain.slice(0, plain.lastIndexOf(' ', 48) + 1 || 48).trim();
}
