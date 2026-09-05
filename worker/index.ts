/**
 * Site Check — Worker entry point.
 *
 * A builder submits site photos through the call-up form; the photos land on a
 * monday item; this reads them against the Order Confirmation and the joinery
 * drawings and posts back a verdict the office can forward to the builder.
 *
 * Separate from Deep Screen on purpose. Different question, different verdict
 * vocabulary, different board, different knowledge base, and its own storage —
 * site photography of customers' houses does not belong in the same bucket as
 * enquiry paperwork.
 *
 * NO REVIEW RULE LIVES IN THIS REPOSITORY. What makes a site not ready is in
 * the knowledge base, uploaded and hashed. This Worker decides which documents
 * a review reads and where the answer goes; it never decides what the answer is.
 *
 * There is no user interface. The office already has one — it is the monday
 * board — and a second place to look at the same job would be a worse product.
 */

import { fail, HttpError, ok } from './lib/http.ts';
import type { Env } from './env.ts';
import { getKbFile, listKb, putKbFile, retireKbFile } from './routes/kb.ts';
import { ingest, receiveWebhook } from './routes/intake.ts';
import { getReview, processReview, startReview, type ReviewMessage } from './routes/reviews.ts';
import { previewResolution, receiveFolders } from './routes/sharepoint.ts';
import { indexState, secretsMatch } from './services/sharepoint.ts';

type Ctx = { request: Request; env: Env; params: string[] };

type Route = { method: string; pattern: RegExp; handler: (ctx: Ctx) => Promise<Response> };

const routes: Route[] = [
  {
    method: 'GET',
    pattern: /^\/api\/health$/,
    handler: async ({ env }) => {
      const index = await indexState(env);
      return ok({
        ok: true,
        model: env.REVIEW_MODEL,
        apiKeyConfigured: Boolean(env.ANTHROPIC_API_KEY),
        monday: env.MONDAY_API_TOKEN ? 'configured' : 'no token',
        // Stated plainly because these are the two ways this Worker goes quiet
        // without erroring: an index nobody is pushing to, and a fetch flow
        // that was never wired up.
        folderIndex: index,
        documentFetch: env.FLOW_FETCH_URL ? 'configured' : 'not configured',
        webhook: env.WEBHOOK_TOKEN ? 'configured' : 'not configured',
        autoReview: env.AUTO_REVIEW === 'on' ? 'on' : 'off',
      });
    },
  },

  // The hourly index flow posts here.
  {
    method: 'POST',
    pattern: /^\/api\/sharepoint\/folders$/,
    handler: ({ request, env }) => receiveFolders(request, env),
  },

  // A dry run for people: which folder would this address find? Fetches
  // nothing, reviews nothing, writes nothing.
  {
    method: 'GET',
    pattern: /^\/api\/sharepoint\/resolve$/,
    handler: ({ request, env }) => previewResolution(env, new URL(request.url)),
  },

  // monday fires this when the call-up form creates an item.
  {
    method: 'POST',
    pattern: /^\/api\/monday\/webhook$/,
    handler: ({ request, env }) => receiveWebhook(request, env),
  },

  // Reviews. Queued, because a review takes minutes.
  {
    method: 'POST',
    pattern: /^\/api\/submissions\/([^/]+)\/review$/,
    handler: async ({ request, env, params }) => {
      const expected = env.PUSH_TOKEN;
      const given = request.headers.get('X-Push-Token') ?? '';
      if (!expected || !secretsMatch(given, expected)) return ok({ error: 'not authorised' }, 401);
      return startReview(env, (request.headers.get('X-Actor') ?? '').trim(), params[0]!);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/reviews\/([^/]+)$/,
    handler: ({ env, params }) => getReview(env, params[0]!),
  },

  // The knowledge base. What makes a site ready to measure lives here, not in
  // this repository.
  { method: 'GET', pattern: /^\/api\/kb$/, handler: ({ env }) => listKb(env) },
  {
    method: 'POST',
    pattern: /^\/api\/kb$/,
    handler: ({ request, env }) => putKbFile(request, env),
  },
  {
    method: 'GET',
    pattern: /^\/api\/kb\/([^/]+)$/,
    handler: ({ env, params }) => getKbFile(env, params[0]!),
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/kb\/([^/]+)$/,
    handler: ({ request, env, params }) => retireKbFile(request, env, params[0]!),
  },

  // Take custody of one named item, without waiting for a webhook. This is how
  // the intake is tried against submissions that already exist.
  {
    method: 'POST',
    pattern: /^\/api\/submissions\/([^/]+)\/ingest$/,
    handler: async ({ request, env, params }) => {
      const expected = env.PUSH_TOKEN;
      const given = request.headers.get('X-Push-Token') ?? '';
      if (!expected || !secretsMatch(given, expected)) {
        return ok({ error: 'not authorised' }, 401);
      }
      return ingest(env, params[0]!);
    },
  },
];

export default {
  /**
   * The review itself. A queue consumer is given minutes, where work started
   * from a request is cut off after about thirty seconds.
   */
  async queue(batch: MessageBatch<ReviewMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processReview(env, message.body.reviewId);
      } catch (error) {
        // processReview records its own failures. Anything reaching here is the
        // consumer falling over; acknowledge regardless, because a silent second
        // read costs money and settles nothing.
        console.log('[queue] review failed outright:', String(error).slice(0, 200));
      }
      message.ack();
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      for (const route of routes) {
        if (route.method !== request.method) continue;
        const match = route.pattern.exec(url.pathname);
        if (!match) continue;
        return await route.handler({
          request,
          env,
          params: match.slice(1).map((p) => decodeURIComponent(p)),
        });
      }

      const allowed = routes.filter((r) => r.pattern.test(url.pathname)).map((r) => r.method);
      if (allowed.length > 0) {
        return fail(405, `${request.method} is not allowed here`, `Try: ${allowed.join(', ')}`);
      }
      return fail(404, `no route for ${request.method} ${url.pathname}`);
    } catch (error) {
      if (error instanceof HttpError) return fail(error.status, error.message, error.detail);
      const message = error instanceof Error ? error.message : String(error);
      // Never turn a failure into a plausible-looking success.
      return fail(500, 'the request failed', message);
    }
  },
};
