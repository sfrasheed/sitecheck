/**
 * The only place machine vocabulary becomes English.
 *
 * The office reads this on the monday item and forwards it to a builder, so it
 * is written for a builder to act on — §8: name the checklist line, be specific
 * about location, keep fix-before-measure separate from commercial variation,
 * and if there is nothing wrong say so in one line and stop.
 *
 * No id, hash, tier code or status appears here. Those belong in the record,
 * not in the reading path.
 */

import type { ReviewResult } from './review.ts';

/** monday updates accept simple HTML. Escape anything that would break it. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const VERDICT_LEAD: Record<string, string> = {
  READY: 'Measure can be booked.',
  'READY WITH VARIATION': 'Measurable, but the scope on site does not match the scope quoted.',
  'NOT READY': 'Measure cannot be booked yet.',
};

/**
 * The full report, posted as an update on the item.
 *
 * Everything goes here rather than in a column, because monday truncates
 * `long_text` at around 2,000 characters silently and reads the truncated value
 * back as though it were whole.
 */
export function updateBody(result: ReviewResult, context: { folder: string; photos: number }): string {
  const out: string[] = [];

  out.push(`<b>${esc(result.verdict)}</b>`);
  out.push(esc(VERDICT_LEAD[result.verdict] ?? ''));
  if (result.headline) out.push(esc(result.headline));

  // Said first, because a review of the wrong job is the failure that matters
  // most and it should be visible before any finding is read.
  out.push('');
  out.push(
    `<i>Read against ${esc(context.folder)} — ${context.photos} photograph${
      context.photos === 1 ? '' : 's'
    }${result.quoteWasRead ? ', with the Order Confirmation' : '. No Order Confirmation was available'}.</i>`,
  );

  const blockers = result.reasons.filter((r) => r.tier === 'Hard blocker');
  const flags = result.reasons.filter((r) => r.tier !== 'Hard blocker');

  if (blockers.length > 0) {
    out.push('');
    out.push('<b>Fix before measure</b>');
    blockers.forEach((r, i) => {
      out.push(`${i + 1}. <b>${esc(r.title)}</b> — ${esc(r.detail)}`);
      if (r.source) out.push(`&nbsp;&nbsp;&nbsp;<i>${esc(r.source)}</i>`);
    });
  }

  if (flags.length > 0) {
    out.push('');
    out.push('<b>Commercial flag</b>');
    flags.forEach((r, i) => {
      out.push(`${i + 1}. <b>${esc(r.title)}</b> — ${esc(r.detail)}`);
      if (r.source) out.push(`&nbsp;&nbsp;&nbsp;<i>${esc(r.source)}</i>`);
    });
  }

  if (result.verifyOnSite.length > 0) {
    out.push('');
    out.push('<b>Verify on site</b>');
    for (const v of result.verifyOnSite) {
      out.push(`• ${esc(v.title)} — ${esc(v.wouldSettleIt)}`);
    }
  }

  // Last, and visibly separate, because nothing here can move the verdict.
  if (result.notes.length > 0 || result.coverage) {
    out.push('');
    out.push('<b>Notes</b>');
    if (result.coverage) out.push(`• Coverage. ${esc(result.coverage)}`);
    for (const n of result.notes) out.push(`• ${esc(n.title)}. ${esc(n.detail)}`);
  }

  if (!result.quoteWasRead) {
    out.push('');
    out.push(
      '<i>The Order Confirmation was not available to this review, so the checklist was run ' +
        'without scope matching. Cut-out counts, GPO counts and anything else that depends on what ' +
        'was priced have not been checked.</i>',
    );
  }

  if (blockers.length === 0 && flags.length === 0 && result.verifyOnSite.length === 0) {
    out.push('');
    out.push('<i>Nothing found against the pre-check.</i>');
  }

  return out.join('<br>');
}

/**
 * The short reason, for the Why column.
 *
 * Budgeted well under monday's silent truncation point. The full report is in
 * the update; this is the line someone reads in a board view without opening
 * anything.
 */
export function whySummary(result: ReviewResult): string {
  const blockers = result.reasons.filter((r) => r.tier === 'Hard blocker');
  const flags = result.reasons.filter((r) => r.tier !== 'Hard blocker');

  const parts: string[] = [];
  if (result.headline) parts.push(result.headline);

  if (blockers.length > 0) {
    parts.push(`Fix before measure: ${blockers.map((r) => r.title).join('; ')}`);
  }
  if (flags.length > 0) {
    parts.push(`Commercial: ${flags.map((r) => r.title).join('; ')}`);
  }
  if (result.verifyOnSite.length > 0) {
    parts.push(`Verify on site: ${result.verifyOnSite.map((v) => v.title).join('; ')}`);
  }
  if (!result.quoteWasRead) {
    parts.push('Checklist only — no Order Confirmation was available, so scope was not matched.');
  }
  if (parts.length === 1) parts.push('Nothing found against the pre-check.');

  return parts.join(' · ').slice(0, 1700);
}

/**
 * What gets posted when the review refused to run.
 *
 * A refusal is a real outcome and it is said plainly, because the alternative —
 * a verdict quietly filled in — is the failure this whole design exists to
 * prevent.
 */
export function refusalBody(reason: string): string {
  return [
    '<b>No review</b>',
    esc(reason),
    '',
    '<i>No verdict has been reached. This submission needs a person before it can be measured.</i>',
  ].join('<br>');
}
