/**
 * Resolving a call-up submission to its job folder.
 *
 * The submission carries an address a builder typed on a phone; SharePoint
 * carries ~1,276 folder names a human typed at some point over several years.
 * Neither follows a convention. `32 Hagen crescent hackham west` has to find
 * `32 Hagen Crescent, Hackham West`, and `Lot 04 Bolivar Highway 1` has to find
 * `Lot 4 Bolivar Highway 1 Cabins (KW16277)`.
 *
 * NO SCREENING RULE LIVES HERE. This file decides which documents a review
 * reads, never what the review makes of them.
 *
 * The one thing worth understanding before changing anything: the reference the
 * builder types is NOT a key and must never be used as one. On the live board,
 * two submissions for different lots both carried `KW16250`, and only one of
 * them was that job — the other was `KW16277`, and the photos were recycled
 * from the first. So the reference is used here only to contradict the address.
 * When the two disagree, that disagreement is the finding.
 */

/** Street types the two sides spell differently. Longest form wins. */
const STREET_TYPES: Record<string, string> = {
  cres: 'crescent', cresc: 'crescent', cr: 'crescent',
  st: 'street', str: 'street',
  rd: 'road',
  ave: 'avenue', av: 'avenue',
  tce: 'terrace', ter: 'terrace',
  ct: 'court', crt: 'court',
  hwy: 'highway',
  pde: 'parade',
  dr: 'drive', drv: 'drive',
  pl: 'place',
  ln: 'lane',
};

/**
 * Words that appear on one side and not the other and carry no signal. `lot`
 * goes because the number after it is what matters; `cabins` goes because it is
 * an estate name the builder never types.
 */
const NOISE = new Set([
  'lot', 'lots', 'cabins', 'cabin', 'unit', 'no', 'the', 'and', 'of',
  'supply', 'only', 'kitchen', 'laundry', 'bathroom', 'ref', 'sa',
]);

/** A token that is only digits, with leading zeros stripped: `04` and `4` agree. */
const isNumber = (token: string) => /^\d+$/.test(token);

export function tokenise(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((t) => (isNumber(t) ? String(Number(t)) : (STREET_TYPES[t] ?? t)))
    .filter((t) => !NOISE.has(t));
}

/**
 * How well a folder name answers an address.
 *
 * Numbers are weighted heavily and asymmetrically: a street number or lot
 * number is the whole difference between twenty otherwise identical Bolivar
 * cabins, so a number present on one side and absent on the other is a much
 * stronger signal than a missing word. Everything is scored against the
 * submission's tokens, not the folder's, because folder names carry extra
 * material — estate names, job numbers, surnames — that should not be punished.
 */
export function score(address: string, folderName: string): number {
  const wanted = tokenise(address);
  if (wanted.length === 0) return 0;
  const have = new Set(tokenise(folderName));

  let got = 0;
  let total = 0;
  for (const token of wanted) {
    const weight = isNumber(token) ? 3 : 1;
    total += weight;
    if (have.has(token)) got += weight;
  }
  return got / total;
}

export type Resolution =
  | { status: 'resolved'; folder: string; confidence: number }
  | { status: 'ambiguous'; candidates: string[] }
  | { status: 'conflict'; folder: string; referenceFolder: string }
  | { status: 'unresolved'; candidates: string[] };

/**
 * Pick the job folder, or refuse to.
 *
 * Refusing is a real outcome and not a failure: a review written against the
 * wrong folder is worse than no review, because it reads as authoritative. Both
 * `ambiguous` and `unresolved` mean a person chooses; `conflict` means the
 * submission itself is internally inconsistent and someone should look at it
 * before any review happens at all.
 */
export function resolveFolder(
  submission: { address: string; reference?: string },
  folderNames: readonly string[],
): Resolution {
  const scored = folderNames
    .map((folder) => ({ folder, confidence: score(submission.address, folder) }))
    .filter((c) => c.confidence >= 0.6)
    .sort((a, b) => b.confidence - a.confidence);

  // The reference is a tripwire, never a key. If the builder's reference names
  // a folder outright, it has to be the same folder the address found.
  const reference = (submission.reference ?? '').trim();
  const referenceFolder =
    reference.length >= 4
      ? folderNames.find((f) =>
          f.toLowerCase().replace(/[^a-z0-9]/g, '').includes(
            reference.toLowerCase().replace(/[^a-z0-9]/g, ''),
          ),
        )
      : undefined;

  if (scored.length === 0) {
    return { status: 'unresolved', candidates: referenceFolder ? [referenceFolder] : [] };
  }

  const best = scored[0]!;

  if (referenceFolder && referenceFolder !== best.folder) {
    return { status: 'conflict', folder: best.folder, referenceFolder };
  }

  // Two folders scoring alike is the Bolivar shape — twenty near-identical
  // names where one token decides. Never guess between them.
  const runnerUp = scored[1];
  if (runnerUp && best.confidence - runnerUp.confidence < 0.15) {
    return { status: 'ambiguous', candidates: scored.slice(0, 5).map((c) => c.folder) };
  }

  return { status: 'resolved', folder: best.folder, confidence: best.confidence };
}
