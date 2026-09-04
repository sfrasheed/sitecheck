/**
 * Intake — a submission arrives.
 *
 * monday fires a webhook when the call-up form creates an item. This reads the
 * item, takes custody of the photos, works out which job folder the address
 * points at, and records all of it. It does not review anything.
 *
 * Custody is the point of this file. monday's asset URLs expire within the
 * hour, so a review that resolved its photos lazily would be unable to prove
 * later what it actually looked at. The bytes are pulled once, hashed, and
 * stored under their own hash.
 */

import type { Env } from '../env.ts';
import { badRequest, ok } from '../lib/http.ts';
import { sha256 } from '../lib/hash.ts';
import { id, nowIso } from '../lib/ids.ts';
import { all, one, run } from '../store/db.ts';
import { downloadAsset, readSubmission, type MondayAsset } from '../services/monday.ts';
import { resolveFolder } from '../services/folders.ts';
import { knownFolders, secretsMatch } from '../services/sharepoint.ts';

/** The call-up form's columns. Verified against board 5031038127. */
const COLUMN = {
  reference: 'short_textdgnwtzv3',
  address: 'short_textkjcwwz7f',
  company: 'short_textwao83ouv',
  preferredDate: 'date4',
} as const;

/** Extensions we treat as site photography. Anything else is a document. */
const PHOTO = /\.(jpe?g|png|heic|heif|webp|gif)$/i;

type SubmissionRow = {
  id: string;
  address: string | null;
  resolution: string;
  folder: string | null;
};

/**
 * monday's webhook handshake: the first request carries a `challenge` and must
 * be echoed back verbatim, unauthenticated, or the subscription never
 * activates. It carries no item and touches nothing.
 */
function challengeOf(body: unknown): string | null {
  const challenge = (body as { challenge?: unknown } | null)?.challenge;
  return typeof challenge === 'string' ? challenge : null;
}

export async function receiveWebhook(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    challenge?: string;
    event?: { pulseId?: unknown; boardId?: unknown };
  } | null;

  const challenge = challengeOf(body);
  if (challenge) return ok({ challenge });

  // Everything that is not the handshake has to prove itself. monday cannot
  // send custom headers, so the secret rides in the query string — which is
  // why this endpoint's URL must be treated as a credential.
  const expected = env.WEBHOOK_TOKEN;
  const given = new URL(request.url).searchParams.get('token') ?? '';
  if (!expected || !secretsMatch(given, expected)) {
    return ok({ error: 'not authorised' }, 401);
  }

  const itemId = body?.event?.pulseId;
  if (itemId === undefined || itemId === null) {
    throw badRequest('the webhook carried no item id');
  }

  return ingest(env, String(itemId));
}

/**
 * Take custody of a submission.
 *
 * Idempotent by monday item id, because a webhook can fire twice and a second
 * delivery is not a second submission.
 */
export async function ingest(env: Env, itemId: string): Promise<Response> {
  const existing = await one<SubmissionRow>(
    env.DB,
    `SELECT id, address, resolution, folder FROM submissions WHERE monday_item_id = ?`,
    itemId,
  );
  if (existing) {
    return ok({ submissionId: existing.id, alreadyHeld: true, resolution: existing.resolution });
  }

  const read = await readSubmission(env, itemId);
  if (!read.ok) return ok({ error: read.error }, 502);
  const { submission } = read;

  const address = submission.columns[COLUMN.address] ?? '';
  const reference = submission.columns[COLUMN.reference] ?? '';

  const submissionId = id('sub');
  await run(
    env.DB,
    `INSERT INTO submissions
       (id, monday_item_id, monday_board_id, submitted_name, address, reference,
        company, preferred_date, received_at, resolution)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    submissionId,
    submission.itemId,
    submission.boardId,
    submission.name,
    address,
    reference,
    submission.columns[COLUMN.company] ?? '',
    submission.columns[COLUMN.preferredDate] ?? '',
    nowIso(),
  );

  const photos = submission.assets.filter((a) => PHOTO.test(a.name));
  const stored = await storePhotos(env, submissionId, photos);

  // Photo bytes seen before, on a submission for a different address. This is
  // the recycled-photo case: one set re-submitted across several lots. It is a
  // fact about the bytes, not a judgement about the site, which is why it can
  // be settled here rather than by the review.
  const duplicates = await duplicateSubmissions(env, submissionId, address);

  const resolution = await resolve(env, submissionId, address, reference);

  return ok({
    submissionId,
    itemId: submission.itemId,
    address,
    reference,
    photos: { held: stored.held, failed: stored.failed },
    duplicatePhotosFrom: duplicates,
    resolution,
  });
}

async function storePhotos(
  env: Env,
  submissionId: string,
  assets: MondayAsset[],
): Promise<{ held: number; failed: string[] }> {
  const failed: string[] = [];
  let held = 0;

  for (const asset of assets) {
    const download = await downloadAsset(asset);
    if (!download.ok) {
      failed.push(`${asset.name}: ${download.error}`);
      continue;
    }
    const digest = await sha256(download.bytes);

    // Content-addressed, so the same image arriving twice occupies one key.
    await env.PHOTOS.put(`photos/${digest}`, download.bytes, {
      httpMetadata: { contentType: `image/${(asset.extension ?? 'jpeg').replace(/^\./, '')}` },
    });

    await run(
      env.DB,
      `INSERT INTO photos (id, submission_id, name, sha256, byte_length, stored_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id('pho'),
      submissionId,
      asset.name,
      digest,
      download.bytes.byteLength,
      nowIso(),
    );
    held += 1;
  }

  return { held, failed };
}

/** Other submissions holding these exact bytes against a different address. */
async function duplicateSubmissions(
  env: Env,
  submissionId: string,
  address: string,
): Promise<{ itemId: string; address: string; shared: number }[]> {
  return all<{ itemId: string; address: string; shared: number }>(
    env.DB,
    `SELECT s.monday_item_id AS itemId, s.address AS address, COUNT(*) AS shared
       FROM photos mine
       JOIN photos theirs ON theirs.sha256 = mine.sha256
       JOIN submissions s ON s.id = theirs.submission_id
      WHERE mine.submission_id = ?
        AND theirs.submission_id != ?
        AND LOWER(TRIM(COALESCE(s.address, ''))) != LOWER(TRIM(?))
      GROUP BY s.monday_item_id, s.address`,
    submissionId,
    submissionId,
    address,
  );
}

async function resolve(
  env: Env,
  submissionId: string,
  address: string,
  reference: string,
): Promise<unknown> {
  if (address.trim() === '') {
    await run(
      env.DB,
      `UPDATE submissions SET resolution = 'unresolved',
         resolution_detail = 'the submission carried no address' WHERE id = ?`,
      submissionId,
    );
    return { status: 'unresolved', detail: 'the submission carried no address' };
  }

  const folders = await knownFolders(env);
  if (folders.length === 0) {
    await run(
      env.DB,
      `UPDATE submissions SET resolution = 'pending',
         resolution_detail = 'the folder index is empty' WHERE id = ?`,
      submissionId,
    );
    return { status: 'pending', detail: 'the folder index is empty' };
  }

  const outcome = resolveFolder({ address, reference }, folders);
  const detail =
    outcome.status === 'resolved'
      ? `matched at ${outcome.confidence.toFixed(2)}`
      : outcome.status === 'conflict'
        ? `the address names ${outcome.folder} and the reference names ${outcome.referenceFolder}`
        : outcome.status === 'ambiguous'
          ? `${outcome.candidates.length} folders matched equally well`
          : 'nothing matched';

  await run(
    env.DB,
    `UPDATE submissions SET resolution = ?, folder = ?, resolution_detail = ? WHERE id = ?`,
    outcome.status,
    outcome.status === 'resolved' ? outcome.folder : null,
    detail,
    submissionId,
  );

  return outcome;
}
