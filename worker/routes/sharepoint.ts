/**
 * The two ends of the SharePoint bridge.
 *
 * `receiveFolders` is what the hourly index flow posts to. `previewResolution`
 * is for people: it answers "which folder would this address find?" without
 * fetching anything, running a screen or writing to monday, so the matcher can
 * be tried against real submissions before it is trusted with any of them.
 */

import type { Env } from '../env.ts';
import { badRequest, ok } from '../lib/http.ts';
import { resolveFolder } from '../services/folders.ts';
import {
  indexState,
  knownFolders,
  recordFolders,
  secretsMatch,
} from '../services/sharepoint.ts';

/**
 * A shared secret, checked before anything is read from the body.
 *
 * An unset secret refuses everything. The alternative — accepting pushes while
 * unconfigured — would mean the index could be poisoned by anyone who found the
 * URL, and a poisoned index sends reviews at the wrong job's documents.
 */
function authorised(request: Request, env: Env): boolean {
  const expected = env.PUSH_TOKEN;
  if (!expected) return false;
  return secretsMatch(request.headers.get('X-Push-Token') ?? '', expected);
}

/**
 * Pull folder names out of whatever the flow sent.
 *
 * Deliberately generous, because the alternative is an expression in the Power
 * Automate designer — and mapping an array there needs a whole extra action,
 * which fails silently to an empty list when an action gets renamed. Sorting
 * this out here means the flow is two actions with no expression in it: fetch
 * from SharePoint, post the response body verbatim.
 *
 * Accepts:
 *   { "folders": ["a", "b"] }                  — already mapped
 *   { "folders": [{ "Name": "a" }] }           — half mapped
 *   { "value": [{ "Name": "a" }] }             — SharePoint's raw REST response
 *   [{ "Name": "a" }]                          — a bare array
 */
function namesFrom(payload: unknown): string[] | null {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { folders?: unknown })?.folders)
      ? (payload as { folders: unknown[] }).folders
      : Array.isArray((payload as { value?: unknown })?.value)
        ? (payload as { value: unknown[] }).value
        : null;

  if (rows === null) return null;

  const names: string[] = [];
  for (const row of rows) {
    if (typeof row === 'string') {
      names.push(row);
      continue;
    }
    // SharePoint returns `Name`; be forgiving about casing rather than making
    // the flow's odata mode load-bearing.
    const candidate = (row as Record<string, unknown> | null)?.['Name']
      ?? (row as Record<string, unknown> | null)?.['name'];
    if (typeof candidate === 'string') names.push(candidate);
  }
  return names;
}

export async function receiveFolders(request: Request, env: Env): Promise<Response> {
  if (!authorised(request, env)) {
    return ok({ error: 'not authorised' }, 401);
  }

  const payload = await request.json().catch(() => null);
  const names = namesFrom(payload);
  if (names === null) {
    throw badRequest(
      'send the SharePoint response body, or { "folders": ["..."] }',
      'expected an array of folder names, or of objects carrying a Name',
    );
  }
  const before = await indexState(env);
  const accepted = await recordFolders(env, names);
  const after = await indexState(env);

  // Report the shape of the change, not just success. A push that suddenly
  // carries a fraction of the usual folders is the signature of a flow whose
  // permissions narrowed, and it should be visible in the flow's own run
  // history rather than discovered weeks later through failed matches.
  return ok({
    accepted,
    known: after.count,
    added: after.count - before.count,
    refreshedAt: after.refreshedAt,
  });
}

export async function previewResolution(env: Env, url: URL): Promise<Response> {
  const address = (url.searchParams.get('address') ?? '').trim();
  const reference = (url.searchParams.get('reference') ?? '').trim();
  if (address === '') throw badRequest('give an address to resolve');

  const folders = await knownFolders(env);
  const state = await indexState(env);
  if (folders.length === 0) {
    return ok({
      resolution: { status: 'unresolved', candidates: [] },
      index: state,
      note: 'the folder index is empty — the hourly flow has never pushed to this Worker',
    });
  }

  return ok({ resolution: resolveFolder({ address, reference }, folders), index: state });
}
