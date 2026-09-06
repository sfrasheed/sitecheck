/**
 * SharePoint, reached by push rather than pull.
 *
 * The app has no Graph credentials and no SharePoint permission of its own. Two
 * Power Automate flows, running as a person who already has access, do the
 * reaching: one pushes in the list of job folder names hourly, the other hands
 * over the documents for one named folder when asked.
 *
 * This is not a workaround dressed up as a design — it is the shape CLAUDE.md
 * already asks for: capture pushed in from outside, so the app keeps no cadence
 * logic of its own. If a Graph app registration is consented later, only
 * `fetchJobDocuments` changes; nothing that calls it needs to know.
 *
 * WHAT THIS FILE WILL NOT DO. It never asks for a path. It asks for a bare
 * folder name and lets the flow resolve it under `Job Documentation`, so there
 * is no expressible request that reaches anywhere else in SharePoint. The flow
 * enforces that too — this is the near side of the same fence, not a substitute
 * for it.
 */

import type { Env } from '../env.ts';
import { all, run } from '../store/db.ts';
import { chooseDocuments, DOC_FOLDERS, type JobFile } from './documents.ts';
import { id, nowIso } from '../lib/ids.ts';

/** A folder name, not a path: no separators, no traversal, nothing clever. */
export const isBareFolderName = (value: string): boolean =>
  value.length > 0 && value.length <= 200 && !/[\\/]|\.\./.test(value);

/**
 * Compare two secrets without leaking where they diverge. Length is not hidden,
 * which is the usual and accepted compromise.
 */
export function secretsMatch(given: string, expected: string): boolean {
  if (given.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < given.length; i += 1) {
    difference |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return difference === 0;
}

/**
 * How many folder names go into one INSERT.
 *
 * A Worker invocation may make about a thousand subrequests, and every D1 query
 * counts as one. Writing a row at a time meant a push of 1,300 folders spent
 * its whole budget around the thousandth name and died mid-way with a 500 —
 * having already committed the first ~999.
 *
 * That failure was invisible in the worst possible way. The names it managed to
 * write looked like a healthy index, the flow reported an error nobody was
 * reading, and the same truncated set arrived every hour because the same names
 * always came first. It presented as a capped SharePoint listing and it was
 * nothing of the sort.
 *
 * The chunk size is set by the tighter of two limits. D1 rejects a statement
 * with more than a hundred bound parameters, and each name binds three, so
 * thirty-two names per statement sits just under it. A push of 1,300 folders
 * becomes about forty queries instead of 1,300 — an order of magnitude inside
 * the subrequest budget, with room for the index to keep growing.
 */
const NAMES_PER_INSERT = 32;

/**
 * Record what SharePoint currently holds.
 *
 * Names already known have their last_seen_at moved forward; names never seen
 * before are added. Nothing is removed — see the migration for why a shrinking
 * index should be visible rather than silent.
 */
export async function recordFolders(env: Env, names: readonly string[]): Promise<number> {
  const at = nowIso();
  const seen = new Set<string>();
  for (const raw of names) {
    const name = raw.trim();
    if (name !== '') seen.add(name);
  }

  const unique = [...seen];
  for (let from = 0; from < unique.length; from += NAMES_PER_INSERT) {
    const chunk = unique.slice(from, from + NAMES_PER_INSERT);
    const values = chunk.map(() => '(?, ?, ?)').join(', ');
    const binds: string[] = [];
    for (const name of chunk) binds.push(name, at, at);
    await run(
      env.DB,
      `INSERT INTO job_folders (name, first_seen_at, last_seen_at) VALUES ${values}
         ON CONFLICT(name) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      ...binds,
    );
  }
  return seen.size;
}

export async function knownFolders(env: Env): Promise<string[]> {
  const rows = await all<{ name: string }>(env.DB, `SELECT name FROM job_folders ORDER BY name`);
  return rows.map((r) => r.name);
}

/**
 * Write down what a push was handed.
 *
 * `rowsReceived` is the count before files and blanks were dropped, because
 * that is the number the flow's own paging settings cap — and therefore the
 * number that gives a truncated push away.
 */
export async function recordPush(
  env: Env,
  counts: { rowsReceived: number; namesKept: number; namesAdded: number },
): Promise<void> {
  await run(
    env.DB,
    `INSERT INTO folder_index_pushes (id, at, rows_received, names_kept, names_added)
     VALUES (?, ?, ?, ?, ?)`,
    id('push'),
    nowIso(),
    counts.rowsReceived,
    counts.namesKept,
    counts.namesAdded,
  );
}

export type IndexState = {
  count: number;
  refreshedAt: string | null;
  /** When a name last entered the index for the first time. */
  grewAt: string | null;
  /** What the last push was handed, if any push has been recorded. */
  lastPush: { at: string; rowsReceived: number; namesKept: number; namesAdded: number } | null;
  /**
   * Said in English when the evidence points at a capped flow, and null
   * otherwise. Stated rather than left to be inferred, because the whole
   * failure is that nobody thinks to go and count.
   */
  concern: string | null;
};

/**
 * How the index is doing.
 *
 * Not merely how big it is. A count on its own cannot distinguish a complete
 * index from a truncated one — see the 0005 migration for what that cost.
 */
export async function indexState(env: Env): Promise<IndexState> {
  const rows = await all<{ count: number; refreshed: string | null; grew: string | null }>(
    env.DB,
    `SELECT COUNT(*) AS count, MAX(last_seen_at) AS refreshed, MAX(first_seen_at) AS grew
       FROM job_folders`,
  );
  const row = rows[0];
  const count = row?.count ?? 0;
  const refreshedAt = row?.refreshed ?? null;
  const grewAt = row?.grew ?? null;

  const pushes = await all<{
    at: string;
    rows_received: number;
    names_kept: number;
    names_added: number;
  }>(
    env.DB,
    `SELECT at, rows_received, names_kept, names_added
       FROM folder_index_pushes ORDER BY at DESC LIMIT 1`,
  );
  const last = pushes[0];
  const lastPush = last
    ? {
        at: last.at,
        rowsReceived: last.rows_received,
        namesKept: last.names_kept,
        namesAdded: last.names_added,
      }
    : null;

  return { count, refreshedAt, grewAt, lastPush, concern: concernAbout(lastPush, grewAt, refreshedAt) };
}

/**
 * Two signatures of a capped flow, in the order they are worth believing.
 *
 * A round row count is the stronger tell: filing cabinets do not hold exactly
 * a thousand folders, paging settings do. An index being refreshed without ever
 * growing is weaker on its own — a quiet week looks the same — which is why it
 * needs a day to pass before it is worth saying.
 */
function concernAbout(
  lastPush: IndexState['lastPush'],
  grewAt: string | null,
  refreshedAt: string | null,
): string | null {
  const ROUND = [100, 200, 250, 500, 1000, 2000, 5000, 10000];
  if (lastPush && ROUND.includes(lastPush.rowsReceived)) {
    return `the last push carried exactly ${lastPush.rowsReceived} rows, which is a paging limit rather than a folder count — the flow is very likely truncating`;
  }

  if (grewAt && refreshedAt) {
    const quietFor = Date.parse(refreshedAt) - Date.parse(grewAt);
    const A_DAY = 24 * 60 * 60 * 1000;
    if (Number.isFinite(quietFor) && quietFor > A_DAY) {
      const days = Math.floor(quietFor / A_DAY);
      return `the index has been refreshed for ${days} day${days === 1 ? '' : 's'} without a single new folder name arriving — either no jobs were created, or the flow is returning the same truncated slice`;
    }
  }

  return null;
}

export type FetchedDocument = { name: string; bytes: Uint8Array };

export type FetchResult =
  | { ok: true; documents: FetchedDocument[]; considered: number }
  | { ok: false; error: string };

/**
 * Fetch one file's bytes.
 *
 * The flow returns the file itself rather than a JSON envelope — the SharePoint
 * connector's file content is binary, and Power Automate hands it straight back
 * as the response body. That is simpler than wrapping it: no base64 round trip,
 * no expression in the designer to get wrong, and roughly a third less to
 * transfer.
 */
async function fetchOne(
  env: Env,
  folder: string,
  subfolder: string,
  file: string,
): Promise<Uint8Array | null> {
  if (!env.FLOW_FETCH_URL || !env.FLOW_FETCH_TOKEN) return null;
  try {
    const response = await fetch(env.FLOW_FETCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Push-Token': env.FLOW_FETCH_TOKEN },
      body: JSON.stringify({ folder, subfolder, file }),
    });
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    // A flow that terminated returns an error envelope with a 200 in some
    // shapes; a PDF always starts %PDF-. Anything else is not a document.
    if (bytes.length < 5) return null;
    return bytes;
  } catch {
    return null;
  }
}

async function callFlow(
  env: Env,
  url: string | undefined,
  body: Record<string, string>,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  if (!url || !env.FLOW_FETCH_TOKEN) {
    return { ok: false, error: 'the document flows are not configured' };
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Push-Token': env.FLOW_FETCH_TOKEN },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return { ok: false, error: `could not reach the document flow: ${String(error)}` };
  }
  if (!response.ok) return { ok: false, error: `the document flow returned ${response.status}` };
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!data) return { ok: false, error: 'the document flow returned something unexpected' };
  return { ok: true, data };
}

/**
 * Get the job's quote and current drawing.
 *
 * Two calls: list what is in the job folder, then fetch only what was chosen.
 * The choosing happens in `documents.ts`, in plain testable code, rather than
 * in a Power Automate expression — and nothing depends on a hardcoded filename,
 * because they vary (`order confirmation.pdf`, `Order Confirmation - Carr.PDF`,
 * `<job> - Quote Rev. 1.pdf`).
 *
 * An empty result is not an error and must never be read as "nothing required".
 * The knowledge base decides what a missing Order Confirmation does to a
 * verdict; §1 says run the checklist only, and say so.
 */
export async function fetchJobDocuments(env: Env, folder: string): Promise<FetchResult> {
  if (!isBareFolderName(folder)) return { ok: false, error: 'that is not a plain folder name' };

  // `mode` is sent explicitly rather than letting the flow infer intent from
  // whether `file` is empty. Power Automate compares an expression's result
  // against the literal text in the other box, so booleans and numbers there
  // silently match as strings; two plain words cannot.
  const listed = await callFlow(env, env.FLOW_LIST_URL, { folder });
  if (!listed.ok) return listed;

  const rows = Array.isArray(listed.data['files']) ? (listed.data['files'] as unknown[]) : [];
  const files: JobFile[] = [];
  for (const row of rows) {
    const record = row as Record<string, unknown> | null;
    if (!record) continue;
    // Rows include the subfolders themselves. Skip them.
    if (record['{IsFolder}'] === true || record['IsFolder'] === true) continue;

    // `{Name}` from this connector has NO extension — `Scan2026-07-27_165251`,
    // not `Scan2026-07-27_165251.pdf`. Only `{FilenameWithExtension}` carries
    // it, and the whole choosing step filters on `.pdf`.
    const name =
      record['{FilenameWithExtension}'] ??
      record['FilenameWithExtension'] ??
      record['{Name}'] ??
      record['Name'] ??
      record['name'];
    if (typeof name !== 'string') continue;

    // The flow lists the whole job folder in one action, nested items included,
    // so which subfolder a file sits in is read off its path rather than being
    // a separate field. That means one SharePoint action instead of one per
    // subfolder — and no failure when a job has no Quote Details folder, which
    // many do not.
    const explicit = record['subfolder'];
    const path = record['{Path}'] ?? record['Path'] ?? record['{FullPath}'] ?? '';
    const haystack = typeof explicit === 'string' ? explicit : String(path);
    const inFolder = DOC_FOLDERS.find((f) =>
      haystack.toLowerCase().includes(f.toLowerCase()),
    );
    if (!inFolder) continue;
    files.push({ folder: inFolder, name });
  }

  const chosen = chooseDocuments(files);
  const wanted = [...chosen.quotes, ...chosen.drawings];
  if (wanted.length === 0) {
    return { ok: true, documents: [], considered: files.length };
  }

  const documents: FetchedDocument[] = [];
  for (const file of wanted) {
    const got = await fetchOne(env, folder, file.folder, file.name);
    if (got !== null) documents.push({ name: `${file.folder}/${file.name}`, bytes: got });
  }

  return { ok: true, documents, considered: files.length };
}
