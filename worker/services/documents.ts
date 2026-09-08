/**
 * Choosing which of a job folder's files the review should read.
 *
 * Pure functions, deliberately. Which document is the current quote is a
 * decision worth being able to test without a flow, a network, or SharePoint.
 *
 * Two conventions live side by side in Job Documentation, because they changed
 * over time and older jobs were never migrated:
 *
 *   Job Details/   <job> - Quote Rev. N.pdf
 *                  <job> - Joinery Drawings Rev. N.pdf
 *   Quote Details/ order confirmation.pdf, Order Confirmation - 2602011.PDF, …
 *
 * So both folders are listed and both are searched.
 */

export const DOC_FOLDERS = ['Job Details', 'Quote Details'] as const;
export type DocFolder = (typeof DOC_FOLDERS)[number];

export type JobFile = { folder: DocFolder; name: string };

export type Chosen = {
  quotes: JobFile[];
  drawings: JobFile[];
  /** Everything considered and not chosen, so a thin read can be explained. */
  ignored: JobFile[];
};

const isPdf = (name: string) => /\.pdf$/i.test(name);

const looksLikeDrawing = (name: string) => /joinery\s*drawings?/i.test(name);

/**
 * How much a filename sounds like the drawing, for jobs that never say
 * "Joinery Drawings".
 *
 * `McDonald - 48 Hill Street Crafers West` holds four PDFs in Job Details:
 * Curved Parts, Detail Drawings, Plans, Solid Surface Plans. Taking the first
 * two in whatever order SharePoint listed them sent Curved Parts — a detail
 * sheet — and left the plans behind.
 *
 * This orders candidates; it never excludes one. Nothing here decides what a
 * drawing means, only which of several unnamed PDFs to hand over first when
 * the cap will not fit them all.
 */
function drawingLikeness(name: string): number {
  if (/\bsolid\s*surface\s*plans?\b/i.test(name)) return 4;
  if (/\bplans?\b/i.test(name)) return 4;
  if (/\bdrawings?\b/i.test(name)) return 3;
  if (/\belevations?\b|\bsections?\b|\blayouts?\b/i.test(name)) return 2;
  if (/\bdetails?\b/i.test(name)) return 1;
  return 0;
}

/**
 * Is this the Order Confirmation?
 *
 * Three namings, all live, because they accumulated rather than replaced each
 * other:
 *
 *   <job> - Quote Rev. N.pdf          the current convention
 *   order confirmation.pdf            older jobs
 *   QU-58428 - <job>.pdf              the quote number straight off the system
 *
 * That third one is not a nicety. `McDonald - 48 Hill Street Crafers West`
 * holds exactly one quote, `QU-58428 - ...pdf` in Quote Details, and without
 * this the chooser saw no quote at all — so the review ran the checklist only
 * and reported the Order Confirmation as unavailable, when it was sitting
 * there. Every check that depends on what was priced was silently skipped.
 */
const looksLikeQuote = (name: string) =>
  /(^|[^a-z])quote([^a-z]|$)/i.test(name) ||
  /order\s*confirmation/i.test(name) ||
  /(^|[^a-z0-9])qu-\s*\d/i.test(name);

/**
 * The revision in a filename, or 0.
 *
 * ONLY MEANINGFUL FOR DRAWINGS. Quote files are overwritten in place, so their
 * names sit at "Quote Rev. 1" while the document inside climbs — one job reads
 * `Quote Rev. 1.pdf` and contains Revision 10. The quote's real revision is
 * printed inside the PDF and the reader takes it from there; this number would
 * be a confident lie.
 */
export function revisionInName(name: string): number {
  const match = /rev\.?\s*(\d+)/i.exec(name);
  return match ? Number(match[1]) : 0;
}

/**
 * Pick what to read.
 *
 * Drawings: the highest revision, because they are versioned by filename and
 * old revisions sit alongside new ones.
 *
 * When nothing is named as a drawing at all — older jobs hold scans with names
 * like `Scan2026-07-27_165251.pdf` — the PDFs in Job Details are taken instead,
 * capped. Guessing from a filename is not possible there, so the reader is given
 * the candidates and works out what they are. Sending one extra scan costs
 * little; sending nothing means the drawing cannot be read at all, and §4 turns
 * on reading the drawing before the photo.
 *
 * Quotes: every candidate, capped. Which is current cannot be told from the
 * outside — the revision is inside the document — so the reader is given what
 * there is and told to establish the revision itself.
 */
export function chooseDocuments(files: readonly JobFile[], quoteCap = 2, drawingCap = 2): Chosen {
  const pdfs = files.filter((f) => isPdf(f.name));

  const named = pdfs.filter((f) => looksLikeDrawing(f.name));
  let drawings: JobFile[];
  if (named.length > 0) {
    const best = named.reduce((winner, file) =>
      revisionInName(file.name) > revisionInName(winner.name) ? file : winner,
    );
    drawings = [best];
  } else {
    drawings = pdfs
      .filter((f) => f.folder === 'Job Details' && !looksLikeQuote(f.name))
      .sort((a, b) => drawingLikeness(b.name) - drawingLikeness(a.name))
      .slice(0, drawingCap);
  }

  // Newest-looking first, so the cap keeps the most plausible candidates. Job
  // Details is preferred because that is the current convention.
  const quotes = pdfs
    .filter((f) => looksLikeQuote(f.name) && !looksLikeDrawing(f.name))
    .sort((a, b) => {
      if (a.folder !== b.folder) return a.folder === 'Job Details' ? -1 : 1;
      return revisionInName(b.name) - revisionInName(a.name);
    })
    .slice(0, quoteCap);

  const chosen = new Set([...quotes, ...drawings].map((f) => `${f.folder}/${f.name}`));
  const ignored = pdfs.filter((f) => !chosen.has(`${f.folder}/${f.name}`));

  return { quotes, drawings, ignored };
}
