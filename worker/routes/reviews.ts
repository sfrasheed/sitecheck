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
import { failureBody, refusalBody, updateBody, whySummary } from '../services/report.ts';
import { fetchJobDocuments } from '../services/sharepoint.ts';
import { fileVerdict, postUpdate } from '../services/monday.ts';
import * as notice from '../services/notice.ts';

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

/**
 * The image formats the reader can actually take, and nothing else.
 *
 * This used to map `.heic` to `image/jpeg`, which is a lie about the bytes.
 * iPhones shoot HEIC by default, the API takes jpeg, png, gif and webp only,
 * and mislabelling one as another does not convert it — the whole call came
 * back `400 Could not process image`, and because a failed call posted nothing
 * at all, the submission sat on the board looking unreviewed. One builder's
 * single photo of 17 Bray Ave disappeared exactly that way.
 *
 * An unknown extension returns null rather than a plausible guess. Guessing is
 * what caused this.
 */
const MEDIA: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

const mediaTypeOf = (name: string): string | null =>
  MEDIA[(name.split('.').pop() ?? '').toLowerCase()] ?? null;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** One-shot stream over bytes already in hand, for the Images binding. */
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * The longest edge worth sending.
 *
 * The reader scales anything larger than this down before looking at it, so a
 * 3 MB original costs upload and risks the request limit while changing
 * nothing about what is seen. Farquhar send 2 MB photographs and six of them
 * came to 16.84 MB — about 22 MB once base64'd, which the API refused outright
 * with `413 request_too_large`. A whole job went unreviewed because of it.
 */
const LONG_EDGE = 1568;

/**
 * A stored photograph, in a form the reader will take.
 *
 * Every photograph goes through this, not just the odd HEIC — downscaling is
 * the point as much as converting. Two jobs' worth of evidence was lost to
 * size, and the fix for that is the same call that fixes the format.
 *
 * The original bytes are never touched. They are content-addressed and a
 * review that read them has to keep resolving, so this works on a copy and
 * stores nothing.
 *
 * Returns null only when there is no way to read the file at all: an
 * unsupported format that would not convert, with no usable original to fall
 * back on. The caller refuses in English rather than sending bytes the API
 * will reject.
 */
async function forReading(
  env: Env,
  name: string,
  raw: Uint8Array,
): Promise<{ mediaType: string; bytes: Uint8Array } | null> {
  if (env.IMAGES) {
    try {
      const out = await env.IMAGES.input(streamOf(raw))
        .transform({ width: LONG_EDGE, height: LONG_EDGE, fit: 'scale-down' })
        .output({ format: 'image/jpeg' });
      const bytes = new Uint8Array(await out.response().arrayBuffer());
      if (bytes.length > 0) return { mediaType: 'image/jpeg', bytes };
    } catch {
      // Fall through to the original. A binding that is unavailable or a file
      // it cannot read must not cost us a photograph we could already send.
    }
  }
  const direct = mediaTypeOf(name);
  if (direct === null) return null;
  return { mediaType: direct, bytes: raw };
}

/**
 * How the reviewing itself is going.
 *
 * `apiKeyConfigured: true` was true and useless for four weeks. The key was
 * revoked on 6 October, every review since came back `401 invalid x-api-key`,
 * and health went on reporting that a key was configured — which it was. The
 * board filled with "No review" and nothing anywhere said why.
 *
 * So health now reports what actually happened to the last few reviews rather
 * than what is present in the environment. A key that exists and is refused
 * is the same as no key at all, and only one of those was visible.
 */
export async function reviewHealth(env: Env): Promise<{
  done: number;
  refused: number;
  failed: number;
  lastDone: string | null;
  notices: { configured: boolean; sent: number; held: number; lastHeld: string | null };
  concern: string | null;
}> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const rows = await all<{ status: string; n: number }>(
    env.DB,
    `SELECT status, COUNT(*) AS n FROM reviews WHERE requested_at > ? GROUP BY status`,
    since,
  );
  const count = (status: string) => rows.find((r) => r.status === status)?.n ?? 0;
  const done = count('DONE');
  const refused = count('REFUSED');
  const failed = count('FAILED');

  const last = await one<{ finished_at: string | null }>(
    env.DB,
    `SELECT MAX(finished_at) AS finished_at FROM reviews WHERE status = 'DONE'`,
  );
  const lastDone = last?.finished_at ?? null;

  // The most recent failure, said in English. An API error string is not
  // English, but "the key is being refused" is, and it is the one fact that
  // decides whether anyone should be looking at the submissions at all.
  const recent = await one<{ refusal: string | null }>(
    env.DB,
    `SELECT refusal FROM reviews WHERE status = 'FAILED' ORDER BY requested_at DESC LIMIT 1`,
  );
  const latest = recent?.refusal ?? '';

  // Whether anyone is actually being told. A notice path that silently stopped
  // working would hide the very thing it exists to surface.
  const post = await all<{ sent: number; n: number }>(
    env.DB,
    `SELECT sent, COUNT(*) AS n FROM notice WHERE at > ? GROUP BY sent`,
    since,
  );
  const notices = {
    configured: notice.recipients(env).length > 0,
    sent: post.find((r) => r.sent === 1)?.n ?? 0,
    held: post.find((r) => r.sent === 0)?.n ?? 0,
    lastHeld:
      (
        await one<{ held: string }>(
          env.DB,
          `SELECT held FROM notice WHERE sent = 0 AND held != '' ORDER BY at DESC LIMIT 1`,
        )
      )?.held ?? null,
  };

  let concern: string | null = null;
  if (!notices.configured) {
    concern = 'nobody is configured to be told when a submission cannot be judged (NOTICE_TO is empty)';
  }
  if (/401|authentication_error|invalid x-api-key/i.test(latest)) {
    concern =
      'the Anthropic key is being refused — every review is failing with an authentication error, ' +
      'and no submission has been judged since it started. Rotate the key and set it with ' +
      '`wrangler secret put ANTHROPIC_API_KEY`';
  } else if (failed > 0 && done === 0) {
    concern = `every review in the last seven days failed (${failed}) and none completed`;
  } else if (failed > done && failed > 2) {
    concern = `reviews are failing more often than they finish — ${failed} failed against ${done} done in seven days`;
  }

  return { done, refused, failed, lastDone, notices, concern };
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

/**
 * How long one unchanged fault stays quiet before it is worth saying again.
 *
 * Not silence: a credential refused for twenty-six days should keep reminding
 * somebody. Four times a day does that; twenty-five identical emails in an
 * afternoon teaches a person to filter the sender, after which the next
 * genuine one is never read either.
 */
const SAY_AGAIN_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * Tell somebody a submission could not be judged, and write down that we did.
 *
 * ⛔ Never allowed to decide whether the review was recorded. Every path here
 * is wrapped and swallowed — the same rule the board write follows, for the
 * same reason: a mail server having a bad morning must not turn a recorded
 * refusal into no record at all.
 *
 * A refusal is always sent. Each one is a different site and a different
 * person's afternoon. A failure is the app being broken, which is one piece of
 * news however many submissions hit it, so repeats of one cause are held and
 * the holding is recorded.
 */
async function tell(
  env: Env,
  reviewId: string,
  kind: 'REFUSED' | 'FAILED',
  reason: string,
): Promise<void> {
  try {
    if (notice.recipients(env).length === 0) return;

    const about = await one<{ address: string | null; company: string | null; item: string }>(
      env.DB,
      `SELECT s.address AS address, s.company AS company, s.monday_item_id AS item
         FROM reviews r JOIN submissions s ON s.id = r.submission_id
        WHERE r.id = ?`,
      reviewId,
    );
    const cause = notice.causeOf(kind, reason);

    if (kind === 'FAILED') {
      const recently = await one<{ id: string }>(
        env.DB,
        `SELECT id FROM notice
          WHERE cause = ? AND sent = 1 AND at > ?
            AND at > COALESCE((SELECT MAX(finished_at) FROM reviews WHERE status = 'DONE'), '')
          LIMIT 1`,
        cause,
        new Date(Date.now() - SAY_AGAIN_AFTER_MS).toISOString(),
      );
      if (recently) {
        await run(
          env.DB,
          `INSERT INTO notice (id, review_id, kind, cause, sent, held, at) VALUES (?, ?, ?, ?, 0, ?, ?)`,
          id('ntc'), reviewId, kind, cause,
          'the same fault was already reported and nothing has succeeded since',
          nowIso(),
        );
        return;
      }
    }

    const where = about?.address?.trim() || about?.company?.trim() || 'a submission';
    const link = about
      ? `https://steedformaus.monday.com/boards/${env.MONDAY_BOARD_ID}/pulses/${about.item}`
      : '';

    const subject = kind === 'REFUSED'
      ? `Site Check could not review ${where}`
      : `Site Check did not finish a review — ${where}`;

    const body = kind === 'REFUSED'
      ? [
          `No verdict was reached for ${where}` + (about?.company ? ` (${about.company})` : '') + '.',
          '',
          reason,
          '',
          'Nothing was judged, so this one needs a person before the measure can be booked.',
          link,
          '',
        ].join('\n')
      : [
          `A review of ${where}` + (about?.company ? ` (${about.company})` : '') + ' did not complete.',
          '',
          'This is a fault on our side, not a problem with the submission — nothing needs',
          'chasing with the builder. The submission is still held and can be reviewed again.',
          '',
          `What went wrong: ${reason.slice(0, 300)}`,
          '',
          link,
          '',
        ].join('\n');

    let sent = false;
    let held = '';
    try {
      sent = await notice.send(env, subject, body);
      if (!sent) held = 'nobody is configured to receive notices';
    } catch (e) {
      held = String(e).slice(0, 200);
    }
    await run(
      env.DB,
      `INSERT INTO notice (id, review_id, kind, cause, sent, held, at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id('ntc'), reviewId, kind, cause, sent ? 1 : 0, held, nowIso(),
    );
  } catch (e) {
    // Swallowed on purpose. See the note above.
    console.log('[notice] could not be sent or recorded:', String(e).slice(0, 200));
  }
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

  // Last, and after the record is safe. The board is where it belongs; this
  // is how somebody finds out without going to look.
  await tell(env, reviewId, 'REFUSED', reason);
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
  const unreadable: string[] = [];
  for (const p of photoRows) {
    const object = await env.PHOTOS.get(`photos/${p.sha256}`);
    if (!object) continue;

    const ready = await forReading(env, p.name, new Uint8Array(await object.arrayBuffer()));
    if (ready === null) {
      unreadable.push(p.name);
      continue;
    }
    photos.push({
      name: p.name,
      mediaType: ready.mediaType,
      base64: toBase64(ready.bytes),
    });
  }

  // 5 — something readable to look at. A format the reader cannot open is a
  // fact about the files, like the three stops above, so it is settled here
  // and named plainly. The bytes are kept: if conversion is added later, this
  // submission can be reviewed without asking the builder for anything.
  if (photos.length === 0) {
    await refuse(
      env,
      reviewId,
      itemId,
      unreadable.length > 0
        ? `The ${unreadable.length === 1 ? 'photograph' : `${unreadable.length} photographs`} supplied ` +
          `(${unreadable.join(', ')}) could not be opened, and converting ${
            unreadable.length === 1 ? 'it' : 'them'
          } did not work either. The same pictures re-sent as JPEG will review normally. Nothing was judged.`
        : 'The photographs could not be retrieved from storage, so nothing was judged.',
    );
    return;
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
    // Said on the item, not just in the record. A review that fell over used to
    // write this row and stop, which left the submission looking identical to
    // one nobody had opened — and a failure is precisely the case that needs
    // someone to notice. The reason is not shown to the office: an API error
    // string is not English and tells a person nothing they can act on.
    await fileVerdict(env, itemId, 'NO REVIEW', 'The review did not complete. Nobody has judged this submission yet.');
    const said = await postUpdate(env, itemId, failureBody());
    if (said.ok) {
      await run(
        env.DB,
        `UPDATE reviews SET monday_update_id = ?, posted_at = ? WHERE id = ?`,
        said.updateId,
        nowIso(),
        reviewId,
      );
    }
    await tell(env, reviewId, 'FAILED', answer.error);
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

  const body = updateBody(result, {
    folder: submission.folder,
    photos: photos.length,
    unreadable,
  });
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
