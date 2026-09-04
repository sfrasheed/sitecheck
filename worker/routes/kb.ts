/**
 * The knowledge base — what makes a site ready to measure.
 *
 * Site Check keeps a copy so it can prove which words a review was given. It
 * holds no opinion of its own: replacing a file here changes reviewing, and
 * changing this repository does not.
 *
 * Replacing supersedes rather than edits. A review from last month still
 * resolves to the exact text it read, which is the only reason keeping a copy
 * is worth anything.
 */

import type { Env } from '../env.ts';
import { badRequest, notFound, ok } from '../lib/http.ts';
import { sha256Text } from '../lib/hash.ts';
import { id, nowIso } from '../lib/ids.ts';
import { all, one, run } from '../store/db.ts';
import { secretsMatch } from '../services/sharepoint.ts';

export type KbFile = { id: string; name: string; body: string; sha256: string };

/** The current set, in reading order. */
export async function currentKb(env: Env): Promise<KbFile[]> {
  return all<KbFile>(
    env.DB,
    `SELECT id, name, body, sha256 FROM kb_files
      WHERE superseded_at IS NULL ORDER BY ordinal, name`,
  );
}

/** One hash standing for the whole set, so a review can be matched to it later. */
export async function fingerprint(files: { sha256: string }[]): Promise<string> {
  return sha256Text(files.map((f) => f.sha256).join('\n'));
}

/**
 * Who is doing this, and are they allowed to.
 *
 * Site Check sits outside Cloudflare Access by design, so there is no signed
 * identity to read. A shared secret says the caller is allowed; `X-Actor` says
 * who they are. The name is recorded rather than verified, and the schema
 * insists it is at least three characters — a change to the rules that nobody
 * is named for is worse than no record at all.
 */
function actorFrom(request: Request, env: Env): string {
  const expected = env.PUSH_TOKEN;
  const given = request.headers.get('X-Push-Token') ?? '';
  if (!expected || !secretsMatch(given, expected)) {
    throw badRequest('not authorised', 'this endpoint needs the X-Push-Token header');
  }
  const actor = (request.headers.get('X-Actor') ?? '').trim();
  if (actor.length < 3) {
    throw badRequest('say who you are', 'send X-Actor, e.g. you@steedform.com');
  }
  return actor;
}

export async function listKb(env: Env): Promise<Response> {
  const files = await all(
    env.DB,
    `SELECT id, name, ordinal, sha256, byte_length, uploaded_by, uploaded_at,
            superseded_at, superseded_by
       FROM kb_files ORDER BY ordinal, name, uploaded_at DESC`,
  );
  const current = files.filter(
    (f) => (f as { superseded_at: string | null }).superseded_at === null,
  );
  return ok({
    files,
    fingerprint: await fingerprint(current as { sha256: string }[]),
    currentCount: current.length,
    // Said out loud because it is the difference between a Worker that can
    // review and one that will refuse to.
    readable: current.length > 0,
  });
}

export async function getKbFile(env: Env, fileId: string): Promise<Response> {
  const file = await one(env.DB, `SELECT * FROM kb_files WHERE id = ?`, fileId);
  if (!file) throw notFound('no such knowledge base file');
  return ok({ file });
}

/**
 * Add a file, or replace one.
 *
 * A name that already exists is a replacement: the old row is superseded and
 * points at the new one, so the history stays whole and nothing is lost.
 */
export async function putKbFile(request: Request, env: Env): Promise<Response> {
  const actor = actorFrom(request, env);

  const form = await request.formData().catch(() => null);
  if (!form) throw badRequest('send the file as multipart form data');

  const file = form.get('file');
  if (!(file instanceof File)) throw badRequest('attach the file as "file"');

  const name = String(form.get('name') ?? file.name).trim();
  if (name === '') throw badRequest('the file needs a name');

  const ordinalRaw = form.get('ordinal');
  const ordinal = ordinalRaw === null ? 100 : Number(ordinalRaw);
  if (!Number.isFinite(ordinal)) throw badRequest('ordinal must be a number');

  const body = await file.text();
  if (body.trim() === '') throw badRequest('that file is empty');

  const digest = await sha256Text(body);
  const at = nowIso();
  const fileId = id('kb');

  const previous = await one<{ id: string; sha256: string }>(
    env.DB,
    `SELECT id, sha256 FROM kb_files WHERE name = ? AND superseded_at IS NULL`,
    name,
  );

  // Uploading identical bytes is not a change, and recording it as one would
  // make the history lie about when the rules last moved.
  if (previous && previous.sha256 === digest) {
    return ok({ unchanged: true, id: previous.id, name, sha256: digest });
  }

  await run(
    env.DB,
    `INSERT INTO kb_files
       (id, name, body, sha256, byte_length, ordinal, uploaded_by, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    fileId,
    name,
    body,
    digest,
    new TextEncoder().encode(body).byteLength,
    ordinal,
    actor,
    at,
  );

  if (previous) {
    await run(
      env.DB,
      `UPDATE kb_files SET superseded_at = ?, superseded_by = ? WHERE id = ?`,
      at,
      fileId,
      previous.id,
    );
  }

  const current = await currentKb(env);
  return ok({
    id: fileId,
    name,
    sha256: digest,
    replaced: previous?.id ?? null,
    currentCount: current.length,
    fingerprint: await fingerprint(current),
  });
}

/** Retire a file without deleting it. A review that read it must keep resolving. */
export async function retireKbFile(request: Request, env: Env, fileId: string): Promise<Response> {
  actorFrom(request, env);
  const file = await one<{ id: string }>(
    env.DB,
    `SELECT id FROM kb_files WHERE id = ? AND superseded_at IS NULL`,
    fileId,
  );
  if (!file) throw notFound('no such current knowledge base file');
  await run(env.DB, `UPDATE kb_files SET superseded_at = ? WHERE id = ?`, nowIso(), fileId);
  return ok({ retired: fileId });
}
