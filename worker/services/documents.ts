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

const looksLikeQuote = (name: string) =>
  /(^|[^a-z])quote([^a-z]|$)/i.test(name) || /order\s*confirmation/i.test(name);

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
 * Quotes: every candidate, capped. Which is current cannot be told from the
 * outside — the revision is inside the document — so the reader is given what
 * there is and told to establish the revision itself.
 */
export function chooseDocuments(files: readonly JobFile[], quoteCap = 2): Chosen {
  const pdfs = files.filter((f) => isPdf(f.name));

  const drawingCandidates = pdfs.filter((f) => looksLikeDrawing(f.name));
  const best = drawingCandidates.reduce<JobFile | null>((winner, file) => {
    if (winner === null) return file;
    return revisionInName(file.name) > revisionInName(winner.name) ? file : winner;
  }, null);
  const drawings = best ? [best] : [];

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
