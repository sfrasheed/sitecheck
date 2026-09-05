/**
 * The review.
 *
 * One call to Claude. The knowledge base goes first, behind a cache breakpoint,
 * because it is the same on every run and it is large. The submission's photos
 * and documents come after, because they change every time.
 *
 * NO REVIEW RULE LIVES IN THIS FILE. What makes a site ready to measure is in
 * the knowledge base — the v0.3 spec, the office pre-check, and the standards
 * guide. This file decides what the reader is given and what shape the answer
 * comes back in. It never decides what the answer is.
 *
 * The schema below is deliberately flat. The structured-output grammar is
 * compiled and has a size limit: `minItems` above 1 is rejected outright, and
 * every nested object and nullable union makes it bigger until a schema that is
 * merely expressive gets a 400. Absent values are empty strings.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Env } from '../env.ts';
import type { KbFile } from '../routes/kb.ts';

export const VERDICTS = ['READY', 'READY WITH VARIATION', 'NOT READY'] as const;
export type Verdict = (typeof VERDICTS)[number];

/** Tier 1 and Tier 2 from §3. Tier 3 has its own section — see `verifyOnSite`. */
export const TIERS = ['Hard blocker', 'Commercial flag'] as const;

const REASON = {
  type: 'array',
  description:
    'The reason list from §2. Every entry names the checklist line or T&C clause behind it, and ' +
    'every entry must be something a photograph can actually prove. Empty if there are none — an ' +
    'empty list against a READY verdict is the correct and common outcome.',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      tier: {
        type: 'string',
        enum: TIERS as unknown as string[],
        description:
          'Hard blocker stops the measure. Commercial flag means the site is measurable but does ' +
          'not match what was priced.',
      },
      title: { type: 'string', description: 'The finding, as a heading. One line.' },
      detail: {
        type: 'string',
        description:
          'What was seen and what it means for this job. Name the location precisely — "middle ' +
          'appliance recess, kitchen rear run", never "some cabinets".',
      },
      source: {
        type: 'string',
        description:
          'The checklist line or T&C clause this traces to, quoted or named. A finding that ' +
          'traces to neither does not belong here at all.',
      },
      location: {
        type: 'string',
        description: 'Which photo, and where in it. Empty if you cannot say.',
      },
    },
    required: ['tier', 'title', 'detail', 'source', 'location'],
  },
};

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    rulesReadable: {
      type: 'boolean',
      description:
        'False if the review guidelines could not be read. Then judge nothing and fill in ' +
        'refusalReason instead.',
    },
    refusalReason: { type: 'string', description: 'Why you refused. Empty if you did not.' },

    verdict: { type: 'string', enum: VERDICTS as unknown as string[] },

    headline: {
      type: 'string',
      description:
        'One sentence an estimator reads at a glance: what this job is and why it landed on this ' +
        'verdict.',
    },

    reasons: REASON,

    verifyOnSite: {
      type: 'array',
      description:
        'Tier 3 — genuinely ambiguous, out of frame, or too low-resolution to call. Never a thing ' +
        'the guidelines say not to flag: those are out of scope and belong nowhere in this ' +
        'answer, not here. Empty if there are none.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', description: 'What could not be resolved.' },
          wouldSettleIt: {
            type: 'string',
            description:
              'The photograph that would settle it. "A straight-on shot into the sink cabinet" is ' +
              'useful; "unclear" is not.',
          },
        },
        required: ['title', 'wouldSettleIt'],
      },
    },

    notes: {
      type: 'array',
      description:
        'Worth the office knowing, and carrying no weight in the verdict. Nothing here can move a ' +
        'job from ready to not ready. Optional — leave empty rather than padding it.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          detail: { type: 'string', description: 'One line, factual, never a criticism.' },
        },
        required: ['title', 'detail'],
      },
    },

    coverage: {
      type: 'string',
      description:
        'Which quoted areas the supplied photos actually cover, and which they do not. Thin ' +
        'coverage is normal and is never a finding — state it and move on. Empty if the quote was ' +
        'not available to compare against.',
    },

    quoteWasRead: {
      type: 'boolean',
      description:
        'True only if an Order Confirmation was supplied and read. When false, run the checklist ' +
        'only, do no scope matching, and say so.',
    },
  },
  required: [
    'rulesReadable',
    'refusalReason',
    'verdict',
    'headline',
    'reasons',
    'verifyOnSite',
    'notes',
    'coverage',
    'quoteWasRead',
  ],
};

export type ReviewResult = {
  rulesReadable: boolean;
  refusalReason: string;
  verdict: Verdict;
  headline: string;
  reasons: { tier: string; title: string; detail: string; source: string; location: string }[];
  verifyOnSite: { title: string; wouldSettleIt: string }[];
  notes: { title: string; detail: string }[];
  coverage: string;
  quoteWasRead: boolean;
};

/**
 * The task.
 *
 * Deliberately short. It says what the job is, what the inputs are, and where
 * the rules live — and then gets out of the way. The guidelines are long,
 * specific and hard-won; restating them here would be a second rendering of the
 * same knowledge, and the two would drift.
 */
const TASK = `You are reviewing site photographs for SteedForm, an Adelaide stone benchtop
fabricator, to decide whether a stone site measure can be booked.

The knowledge base above is the authority. Follow it exactly — including its own
instruction to read §5 before §4, and its worked example in §9, which shows eight
findings that were raised and were wrong. That example is there because
over-flagging is the failure this tool is designed against: a reviewer that
reports nine findings when one is real is worse than useless, because the builder
stops reading at item three and the finding that mattered never gets actioned.

You are given the site photographs, and — when they were available — the job's
Order Confirmation and joinery drawings. Read the drawing before the photo. An
open cabinet is only wrong if the drawing says it should be closed.

If no Order Confirmation was supplied, run the checklist only, do no scope
matching, and set quoteWasRead to false.

TAKE THE QUOTE'S REVISION FROM INSIDE THE DOCUMENT — the "Revision" and
"Revision Date" printed on the Order Confirmation. NEVER from its filename. The
quote file is overwritten in place, so its name sits at "Quote Rev. 1" while the
document inside climbs; one job is filed as "Quote Rev. 1.pdf" and contains
Revision 10. Reporting the filename's number would be confidently wrong on
nearly every job. The joinery drawings are the opposite case: their revisions
are real and old ones sit alongside new, so the highest-numbered drawing file is
the current one and that is the one you have been given.

Every line of your answer must be traceable to something visible in a
photograph. If removing the photos would not change a finding, it does not
belong in the answer.`;

export type ReviewInput = {
  kb: KbFile[];
  photos: { name: string; mediaType: string; base64: string }[];
  documents: { name: string; base64: string }[];
  address: string;
  reference: string;
  company: string;
  folder: string;
};

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/**
 * Run the review.
 *
 * Returns the model's answer unchanged. A refusal — `rulesReadable: false` — is
 * returned as-is rather than being turned into a verdict, because a review that
 * could not read its own rules has not reviewed anything.
 */
export async function review(
  env: Env,
  input: ReviewInput,
): Promise<{ ok: true; result: ReviewResult; model: string } | { ok: false; error: string }> {
  if (!env.ANTHROPIC_API_KEY) return { ok: false, error: 'no Anthropic key is configured' };
  if (input.kb.length === 0) return { ok: false, error: 'the knowledge base is empty' };

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  // The knowledge base first and marked cacheable: it is identical on every
  // review and it is the bulk of the prompt. Everything that varies comes after
  // the breakpoint, so the cache survives from one submission to the next.
  const content: Anthropic.ContentBlockParam[] = [
    {
      type: 'text',
      text:
        'SteedForm site photo review guidelines and standards. This is the authority on what ' +
        'makes a site ready to measure.\n\n' +
        input.kb.map((f) => `--- ${f.name} ---\n${f.body}`).join('\n\n'),
      cache_control: { type: 'ephemeral' },
    },
    {
      type: 'text',
      text:
        `Submission\n` +
        `Address as the builder typed it: ${input.address || '(none given)'}\n` +
        `Reference as the builder typed it: ${input.reference || '(none given)'}\n` +
        `Company: ${input.company || '(none given)'}\n` +
        `Job folder this resolved to: ${input.folder}\n` +
        `Photographs supplied: ${input.photos.length}\n` +
        `Order Confirmation and drawings supplied: ${
          input.documents.length === 0 ? 'NO — none were available' : `yes (${input.documents.length})`
        }`,
    },
  ];

  for (const doc of input.documents) {
    content.push({ type: 'text', text: `--- ${doc.name} ---` });
    content.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: doc.base64 },
    });
  }

  for (const photo of input.photos) {
    content.push({ type: 'text', text: `--- photograph: ${photo.name} ---` });
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: (IMAGE_TYPES.has(photo.mediaType)
          ? photo.mediaType
          : 'image/jpeg') as 'image/jpeg',
        data: photo.base64,
      },
    });
  }

  content.push({ type: 'text', text: TASK });

  const model = env.REVIEW_MODEL || 'claude-opus-5';

  try {
    const message = await client.messages.create({
      model,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'high',
        format: { type: 'json_schema', schema: REVIEW_SCHEMA },
      },
      messages: [{ role: 'user', content }],
    } as Anthropic.MessageCreateParamsNonStreaming);

    if (message.stop_reason === 'refusal') {
      return { ok: false, error: 'the model declined to answer this request' };
    }

    const text = message.content.find((b) => b.type === 'text');
    if (!text || text.type !== 'text') {
      return { ok: false, error: 'the model returned no answer' };
    }

    let parsed: ReviewResult;
    try {
      parsed = JSON.parse(text.text) as ReviewResult;
    } catch {
      return { ok: false, error: 'the answer did not parse as JSON' };
    }

    return { ok: true, result: parsed, model };
  } catch (error) {
    return { ok: false, error: `the review call failed: ${String(error).slice(0, 300)}` };
  }
}
