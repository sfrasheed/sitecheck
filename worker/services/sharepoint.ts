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
import { nowIso } from '../lib/ids.ts';

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
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    await run(
      env.DB,
      `INSERT INTO job_folders (name, first_seen_at, last_seen_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      name,
      at,
      at,
    );
  }
  return seen.size;
}

export async function knownFolders(env: Env): Promise<string[]> {
  const rows = await all<{ name: string }>(env.DB, `SELECT name FROM job_folders ORDER BY name`);
  return rows.map((r) => r.name);
}

/** When the index was last refreshed, and how big it is. */
export async function indexState(env: Env): Promise<{ count: number; refreshedAt: string | null }> {
  const rows = await all<{ count: number; refreshed: string | null }>(
    env.DB,
    `SELECT COUNT(*) AS count, MAX(last_seen_at) AS refreshed FROM job_folders`,
  );
  const row = rows[0];
  return { count: row?.count ?? 0, refreshedAt: row?.refreshed ?? null };
}

export type FetchedDocument = { name: string; bytes: Uint8Array };

export type FetchResult =
  | { ok: true; documents: FetchedDocument[]; considered: number }
  | { ok: false; error: string };

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function callFlow(env: Env, body: Record<string, string>): Promise<
  { ok: true; data: Record<string, unknown> } | { ok: false; error: string }
> {
  if (!env.FLOW_FETCH_URL || !env.FLOW_FETCH_TOKEN) {
    return { ok: false, error: 'no document fetch flow is configured' };
  }
  let response: Response;
  try {
    response = await fetch(env.FLOW_FETCH_URL, {
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

  const listed = await callFlow(env, { folder });
  if (!listed.ok) return listed;

  const rows = Array.isArray(listed.data['files']) ? (listed.data['files'] as unknown[]) : [];
  const files: JobFile[] = [];
  for (const row of rows) {
    const record = row as Record<string, unknown> | null;
    if (!record) continue;
    const name = record['{Name}'] ?? record['Name'] ?? record['name'];
    const sub = record['subfolder'] ?? record['folder'];
    if (typeof name !== 'string') continue;
    const inFolder = DOC_FOLDERS.find((f) => f === sub);
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
    const got = await callFlow(env, { folder, subfolder: file.folder, file: file.name });
    if (!got.ok) continue;
    const content = got.data['contentBase64'] ?? got.data['$content'];
    if (typeof content !== 'string') continue;
    try {
      documents.push({ name: `${file.folder}/${file.name}`, bytes: decodeBase64(content) });
    } catch {
      continue;
    }
  }

  return { ok: true, documents, considered: files.length };
}
