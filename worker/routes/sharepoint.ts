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
  recordPush,
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
 *   [{ "{Name}": "a", "{IsFolder}": true }]    — the SharePoint CONNECTOR's output
 *
 * That last shape is not a typo. The Power Automate SharePoint connector emits
 * property names wrapped in literal braces — `{Name}`, `{IsFolder}`, `{Path}`.
 * It is the output of "Get files (properties only)", which is the action worth
 * using: it has a folder picker instead of an OData path, so there is no Uri to
 * get wrong.
 *
 * Rows that say they are files are dropped. That action returns folders and
 * files together, and a job folder index containing `order confirmation.pdf`
 * would match addresses against filenames.
 */
function namesFrom(payload: unknown): { received: number; names: string[] } | null {
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
    const record = row as Record<string, unknown> | null;
    if (record === null) continue;

    // The connector marks each row as folder or file. When it says file, skip:
    // an index holding `order confirmation.pdf` would match addresses against
    // filenames. A row that does not say either way is kept, because the REST
    // shapes above only ever return folders.
    const isFolder = record['{IsFolder}'] ?? record['IsFolder'];
    if (isFolder === false) continue;

    // `Name` from REST, `{Name}` from the connector. Casing is forgiven rather
    // than making the flow's odata mode load-bearing.
    const candidate =
      record['{Name}'] ?? record['Name'] ?? record['name'] ?? record['{FilenameWithExtension}'];
    if (typeof candidate === 'string' && candidate.trim() !== '') names.push(candidate);
  }
  // `received` counts rows before any of the above dropped anything. That is
  // the number the flow's paging settings cap, so it is the one worth keeping.
  return { received: rows.length, names };
}

/**
 * What arrived, for a caller that failed to authenticate.
 *
 * Header NAMES only, plus the length of the token that was presented. Never a
 * value. A bare 401 from inside the Power Automate designer is close to
 * undebuggable — you cannot see what the action actually sent — and the two
 * real causes look identical from outside: the header never arrived, or it
 * arrived with a stray newline. The length tells those apart without printing
 * a secret into a flow's run history, which is retained.
 */
function whatArrived(request: Request): Record<string, unknown> {
  const names = [...request.headers.keys()].sort();
  const presented = request.headers.get('X-Push-Token');
  return {
    headersReceived: names,
    tokenHeaderPresent: presented !== null,
    tokenLength: presented === null ? 0 : presented.length,
    tokenHasWhitespace: presented === null ? false : presented !== presented.trim(),
  };
}

export async function receiveFolders(request: Request, env: Env): Promise<Response> {
  if (!authorised(request, env)) {
    return ok(
      {
        error: 'not authorised',
        expectedTokenLength: (env.PUSH_TOKEN ?? '').length,
        ...whatArrived(request),
      },
      401,
    );
  }

  const payload = await request.json().catch(() => null);
  const parsed = namesFrom(payload);
  if (parsed === null) {
    throw badRequest(
      'send the SharePoint response body, or { "folders": ["..."] }',
      'expected an array of folder names, or of objects carrying a Name',
    );
  }
  const before = await indexState(env);
  const accepted = await recordFolders(env, parsed.names);
  const added = (await indexState(env)).count - before.count;

  // Written down before the state is read back, so `concern` is judged against
  // this push rather than the one before it.
  await recordPush(env, {
    rowsReceived: parsed.received,
    namesKept: accepted,
    namesAdded: added,
  });
  const after = await indexState(env);

  // Report the shape of the change, not just success — and say plainly when the
  // shape is wrong. A push that carries a fraction of the folders, or the same
  // folders forever, is the signature of a capped or narrowed flow, and it
  // should be visible in the flow's own run history rather than discovered
  // weeks later through a submission that could not be matched.
  return ok({
    rowsReceived: parsed.received,
    accepted,
    known: after.count,
    added,
    refreshedAt: after.refreshedAt,
    concern: after.concern,
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
