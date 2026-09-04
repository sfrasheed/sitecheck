/**
 * monday.com — the board is both the inbox and the outbox.
 *
 * A builder's call-up form creates an item carrying the site photos. The review
 * reads that item, and posts its answer back as an update on the same item,
 * because that is where the office already is. There is no second place to look.
 *
 * WRITES ARE NAMED, NOT COMPOSED. Every GraphQL document here is built in this
 * file and none is ever accepted from the model, so no mutation can be
 * expressed that this file does not already contain. The columns that may be
 * written are an allow-list carried in configuration — never discovered from
 * the board, because a column being physically present is not the same as it
 * being ours to write. Deep Screen learned that from a column the registry
 * retired and the board still has.
 */

import type { Env } from '../env.ts';

const ENDPOINT = 'https://api.monday.com/v2';
const API_VERSION = '2024-10';

export type MondayError = { ok: false; error: string };

async function query<T>(
  env: Env,
  document: string,
  variables: Record<string, unknown> = {},
): Promise<{ ok: true; data: T } | MondayError> {
  if (!env.MONDAY_API_TOKEN) return { ok: false, error: 'no monday token is configured' };

  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: env.MONDAY_API_TOKEN,
        'Content-Type': 'application/json',
        'API-Version': API_VERSION,
      },
      body: JSON.stringify({ query: document, variables }),
    });
  } catch (error) {
    return { ok: false, error: `could not reach monday.com: ${String(error)}` };
  }

  if (!response.ok) return { ok: false, error: `monday.com returned ${response.status}` };

  const body = (await response.json().catch(() => null)) as {
    data?: T;
    errors?: { message?: string }[];
  } | null;

  if (!body) return { ok: false, error: 'monday.com returned something that was not JSON' };
  if (body.errors?.length) {
    return { ok: false, error: body.errors.map((e) => e.message ?? 'unknown').join('; ') };
  }
  if (body.data === undefined) return { ok: false, error: 'monday.com returned no data' };
  return { ok: true, data: body.data };
}

export type MondayAsset = {
  id: string;
  name: string;
  /** Valid for about an hour. Fetch the bytes now; never store this. */
  publicUrl: string | null;
  extension: string | null;
};

export type Submission = {
  itemId: string;
  boardId: string;
  name: string;
  columns: Record<string, string>;
  assets: MondayAsset[];
};

type ItemsResponse = {
  items: {
    id: string;
    name: string;
    board: { id: string } | null;
    column_values: { id: string; text: string | null }[];
    assets: {
      id: string;
      name: string;
      public_url: string | null;
      file_extension: string | null;
    }[] | null;
  }[];
};

/**
 * Read one submission whole.
 *
 * `assets` is asked for explicitly because the File column's own value is a
 * `protected_static` URL that a bearer token cannot fetch — only the asset's
 * `public_url` is retrievable, and it expires within the hour.
 */
export async function readSubmission(
  env: Env,
  itemId: string,
): Promise<{ ok: true; submission: Submission } | MondayError> {
  const result = await query<ItemsResponse>(
    env,
    `query ($ids: [ID!]) {
       items(ids: $ids) {
         id
         name
         board { id }
         column_values { id text }
         assets { id name public_url file_extension }
       }
     }`,
    { ids: [itemId] },
  );
  if (!result.ok) return result;

  const item = result.data.items?.[0];
  if (!item) return { ok: false, error: `monday has no item ${itemId}` };

  const columns: Record<string, string> = {};
  for (const cv of item.column_values) columns[cv.id] = (cv.text ?? '').trim();

  return {
    ok: true,
    submission: {
      itemId: item.id,
      boardId: item.board?.id ?? '',
      name: item.name,
      columns,
      assets: (item.assets ?? []).map((a) => ({
        id: a.id,
        name: a.name,
        publicUrl: a.public_url,
        extension: a.file_extension,
      })),
    },
  };
}

/** Fetch an asset's bytes while its public URL is still valid. */
export async function downloadAsset(
  asset: MondayAsset,
): Promise<{ ok: true; bytes: Uint8Array } | MondayError> {
  if (!asset.publicUrl) {
    return { ok: false, error: `${asset.name} has no retrievable URL` };
  }
  try {
    const response = await fetch(asset.publicUrl);
    if (!response.ok) {
      return { ok: false, error: `${asset.name} came back ${response.status}` };
    }
    return { ok: true, bytes: new Uint8Array(await response.arrayBuffer()) };
  } catch (error) {
    return { ok: false, error: `could not download ${asset.name}: ${String(error)}` };
  }
}

/**
 * Post the review as an update on the item.
 *
 * The update carries the whole cited report. It is deliberately not a column:
 * monday's `long_text` truncates around 2,000 characters SILENTLY and the
 * read-back shows the truncated value, so a report filed in a column looks
 * complete and is not.
 */
export async function postUpdate(
  env: Env,
  itemId: string,
  body: string,
): Promise<{ ok: true; updateId: string } | MondayError> {
  const result = await query<{ create_update: { id: string } | null }>(
    env,
    `mutation ($itemId: ID!, $body: String!) {
       create_update(item_id: $itemId, body: $body) { id }
     }`,
    { itemId, body },
  );
  if (!result.ok) return result;
  const id = result.data.create_update?.id;
  if (!id) return { ok: false, error: 'monday accepted the update but returned no id' };
  return { ok: true, updateId: id };
}

/**
 * File the verdict and a short reason in their two columns, then read them back.
 *
 * Read-back is not belt-and-braces. monday fails loudly on malformed structure
 * and quietly on content it dislikes — text containing `<` is replaced with an
 * empty string and the write still reports success. A value that did not stick
 * has to fail loudly here rather than look filed.
 */
export async function fileVerdict(
  env: Env,
  itemId: string,
  verdict: string,
  why: string,
): Promise<{ ok: true } | MondayError> {
  const verdictColumn = env.VERDICT_COLUMN;
  const whyColumn = env.WHY_COLUMN;
  if (!verdictColumn || !whyColumn) {
    return { ok: false, error: 'the verdict and reason columns are not configured' };
  }

  // Budgeted well under monday's silent truncation point, and stripped of the
  // one character it deletes without telling anyone.
  const safeWhy = why.replace(/</g, '‹').slice(0, 1800);

  const values = JSON.stringify({
    [verdictColumn]: { label: verdict },
    [whyColumn]: safeWhy,
  });

  const written = await query<{ change_multiple_column_values: { id: string } | null }>(
    env,
    `mutation ($boardId: ID!, $itemId: ID!, $values: JSON!) {
       change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $values) {
         id
       }
     }`,
    { boardId: env.MONDAY_BOARD_ID, itemId, values },
  );
  if (!written.ok) return written;

  const back = await query<ItemsResponse>(
    env,
    `query ($ids: [ID!]) { items(ids: $ids) { id name board { id } column_values { id text } assets { id name public_url file_extension } } }`,
    { ids: [itemId] },
  );
  if (!back.ok) return back;

  const readBack = back.data.items?.[0]?.column_values ?? [];
  const storedVerdict = readBack.find((c) => c.id === verdictColumn)?.text ?? '';
  if (storedVerdict.trim() !== verdict) {
    return {
      ok: false,
      error: `the verdict did not stick — monday reads "${storedVerdict}" where "${verdict}" was written`,
    };
  }
  return { ok: true };
}
