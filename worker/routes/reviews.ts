/**
 * Running a review, and posting it where the office will see it.
 *
 * The work happens on a queue rather than in the request. A review reads a
 * dozen photographs and a PDF against a knowledge base and takes minutes; work
 * started from a request is cut off after about thirty seconds.
 *
 * Four conditions refuse before a review is attempted. Each is a fact rather
 * than a judgement, which is why it is settled here and not by the reader.
 */

import type { Env } from '../env.ts';
import { badRequest, notFound, ok } from '../lib/http.ts';
import { id, nowIso } from '../lib/ids.ts';
import { all, one, run } from '../store/db.ts';
import { currentKb, fingerprint } from './kb.ts';
import { review, type ReviewResult } from '../services/review.ts';
import { refusalBody, updateBody, whySummary } from '../services/report.ts';
import { fetchJobDocuments } from '../services/sharepoint.ts';
import { fileVerdict, postUpdate } from '../services/monday.ts';

export type ReviewMessage = { reviewId: string };

type SubmissionRow = {
  id: string;
  monday_item_id: string;
  address: string | null;
  reference: string | null;
  company: string | null;
  resolution: string;
  folder: string | null;
  resolution_detail: string | null;
};

type PhotoRow = { name: string; sha256: string };

const MEDIA: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/jpeg',
  heif: 'image/jpeg',
};

const mediaTypeOf = (name: string): string =>
  MEDIA[(name.split('.').pop() ?? '').toLowerCase()] ?? 'image/jpeg';

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Queue a review. Returns immediately; the answer arrives on the monday item. */
export async function startReview(env: Env, actor: string, submissionId: string): Promise<Response> {
  const submission = await one<SubmissionRow>(
    env.DB,
    `SELECT * FROM submissions WHERE id = ? OR monday_item_id = ?`,
    submissionId,
    submissionId,
  );
  if (!submission) throw notFound('no such submission');
  if (actor.trim().length < 3) throw badRequest('say who you are', 'send X-Actor');

  const reviewId = id('rev');
  await run(
    env.DB,
    `INSERT INTO reviews (id, submission_id, status, requested_by, requested_at)
     VALUES (?, ?, 'QUEUED', ?, ?)`,
    reviewId,
    submission.id,
    actor,
    nowIso(),
  );

  await env.REVIEWS.send({ reviewId });
  return ok({ reviewId, status: 'QUEUED', itemId: submission.monday_item_id });
}

async function refuse(env: Env, reviewId: string, itemId: string, reason: string): Promise<void> {
  await run(
    env.DB,
    `UPDATE reviews SET status = 'REFUSED', refusal = ?, finished_at = ? WHERE id = ?`,
    reason,
    nowIso(),
    reviewId,
  );
  // Filed as a verdict of its own so a refused submission is visible in a board
  // view. Left blank it looks identical to one nobody has reviewed yet — and a
  // refusal is precisely the case that needs a person to notice it.
  await fileVerdict(env, itemId, 'NO REVIEW', reason);

  const posted = await postUpdate(env, itemId, refusalBody(reason));
  if (posted.ok) {
    await run(
      env.DB,
      `UPDATE reviews SET monday_update_id = ?, posted_at = ? WHERE id = ?`,
      posted.updateId,
      nowIso(),
      reviewId,
    );
  }
}

/**
 * Do the review.
 *
 * Called from the queue consumer, which is given minutes rather than seconds.
 */
export async function processReview(env: Env, reviewId: string): Promise<void> {
  const row = await one<{ id: string; submission_id: string; status: string }>(
    env.DB,
    `SELECT id, submission_id, status FROM reviews WHERE id = ?`,
    reviewId,
  );
  if (!row || row.status !== 'QUEUED') return;

  const submission = await one<SubmissionRow>(
    env.DB,
    `SELECT * FROM submissions WHERE id = ?`,
    row.submission_id,
  );
  if (!submission) return;

  const itemId = submission.monday_item_id;
  await run(env.DB, `UPDATE reviews SET status = 'RUNNING' WHERE id = ?`, reviewId);

  // 1 — the rules. Without them there is nothing to review against, and a
  // verdict invented in their absence is the failure this design exists to stop.
  const kb = await currentKb(env);
  if (kb.length === 0) {
    await refuse(env, reviewId, itemId, 'The review guidelines have not been loaded, so nothing was judged.');
    return;
  }

  // 2 — the right job. `ambiguous`, `conflict` and `unresolved` are real
  // outcomes; a review written against the wrong folder reads as authoritative.
  if (submission.resolution !== 'resolved' || !submission.folder) {
    await refuse(
      env,
      reviewId,
      itemId,
      `This submission could not be matched to a job folder — ${
        submission.resolution_detail ?? submission.resolution
      }. Nothing was reviewed, because a review against the wrong job is worse than none.`,
    );
    return;
  }

  // 3 — the photographs are this job's. Identical bytes against a different
  // address is one set re-submitted across lots, and it is a fact about the
  // files rather than a judgement about the site.
  const duplicates = await all<{ itemId: string; address: string; shared: number }>(
    env.DB,
    `SELECT s.monday_item_id AS itemId, s.address AS address, COUNT(*) AS shared
       FROM photos mine
       JOIN photos theirs ON theirs.sha256 = mine.sha256
       JOIN submissions s ON s.id = theirs.submission_id
      WHERE mine.submission_id = ? AND theirs.submission_id != ?
        AND LOWER(TRIM(COALESCE(s.address,''))) != LOWER(TRIM(COALESCE(?,'')))
      GROUP BY s.monday_item_id, s.address`,
    submission.id,
    submission.id,
    submission.address ?? '',
  );
  if (duplicates.length > 0) {
    const where = duplicates.map((d) => `${d.address} (${d.shared} photo(s))`).join(', ');
    await refuse(
      env,
      reviewId,
      itemId,
      `These photographs have already been submitted against a different address — ${where}. ` +
        'The same set appears to have been re-used across more than one job, so nothing was ' +
        'reviewed until someone confirms which site these are.',
    );
    return;
  }

  // 4 — something to look at.
  const photoRows = await all<PhotoRow>(
    env.DB,
    `SELECT name, sha256 FROM photos WHERE submission_id = ? ORDER BY name`,
    submission.id,
  );
  if (photoRows.length === 0) {
    await refuse(env, reviewId, itemId, 'No photographs were supplied with this submission.');
    return;
  }

  const photos: { name: string; mediaType: string; base64: string }[] = [];
  for (const p of photoRows) {
    const object = await env.PHOTOS.get(`photos/${p.sha256}`);
    if (!object) continue;
    photos.push({
      name: p.name,
      mediaType: mediaTypeOf(p.name),
      base64: toBase64(new Uint8Array(await object.arrayBuffer())),
    });
  }

  // The Order Confirmation and drawings, if the fetch flow can reach them. Not
  // having them is not a failure — §1 says run the checklist only and say so.
  const documents: { name: string; base64: string }[] = [];
  const fetched = await fetchJobDocuments(env, submission.folder);
  if (fetched.ok) {
    for (const doc of fetched.documents) {
      documents.push({ name: doc.name, base64: toBase64(doc.bytes) });
    }
  }

  const answer = await review(env, {
    kb,
    photos,
    documents,
    address: submission.address ?? '',
    reference: submission.reference ?? '',
    company: submission.company ?? '',
    folder: submission.folder,
  });

  if (!answer.ok) {
    await run(
      env.DB,
      `UPDATE reviews SET status = 'FAILED', refusal = ?, finished_at = ? WHERE id = ?`,
      answer.error,
      nowIso(),
      reviewId,
    );
    return;
  }

  const result: ReviewResult = answer.result;

  // The reader refusing is recorded as a refusal, never as a verdict.
  if (!result.rulesReadable) {
    await refuse(
      env,
      reviewId,
      itemId,
      result.refusalReason || 'The review guidelines could not be read.',
    );
    return;
  }

  const body = updateBody(result, { folder: submission.folder, photos: photos.length });
  const fp = await fingerprint(kb);

  await run(
    env.DB,
    `UPDATE reviews SET status = 'DONE', verdict = ?, headline = ?, body = ?,
       kb_fingerprint = ?, folder = ?, photo_count = ?, document_count = ?, model = ?,
       finished_at = ? WHERE id = ?`,
    result.verdict,
    result.headline,
    JSON.stringify(result),
    fp,
    submission.folder,
    photos.length,
    documents.length,
    answer.model,
    nowIso(),
    reviewId,
  );

  const posted = await postUpdate(env, itemId, body);
  if (posted.ok) {
    await run(
      env.DB,
      `UPDATE reviews SET monday_update_id = ?, posted_at = ? WHERE id = ?`,
      posted.updateId,
      nowIso(),
      reviewId,
    );
  }

  // The columns are the board view; the update is the report. A value that did
  // not stick fails loudly rather than looking filed.
  await fileVerdict(env, itemId, result.verdict, whySummary(result));
}

export async function getReview(env: Env, reviewId: string): Promise<Response> {
  const row = await one<Record<string, unknown>>(
    env.DB,
    `SELECT * FROM reviews WHERE id = ?`,
    reviewId,
  );
  if (!row) throw notFound('no such review');
  const body = row['body'];
  return ok({
    review: { ...row, body: typeof body === 'string' ? JSON.parse(body) : null },
  });
}
