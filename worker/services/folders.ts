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

/**
 * The shortest word worth forgiving a typo in.
 *
 * Below this, one letter is too much of the word: `st` and `at`, `bay` and
 * `day`, `hay` and `hall` are different places, not near misses.
 */
const FORGIVE_FROM = 6;

/**
 * Do these two words differ by at most one letter?
 *
 * Substitution, insertion or deletion — `santuary` and `sanctuary`, which is
 * how a real submission for Lot 307 came in. Stripping `lot` as noise left the
 * address as two tokens, `307` and the misspelling, so the one word that
 * distinguishes the job matched nothing and the correct folder tied with four
 * unrelated apartment 307s.
 *
 * Deliberately one letter and no more. Two lets `304` become `307`'s
 * neighbour in spirit if not in code, and on this estate that is a different
 * house.
 */
export function nearlySame(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;

  // Never numbers, whoever asks. `304` and `307` differ by one character and
  // are two different houses on the same street; `4` and `14` are two
  // different lots. The caller guards this too, but a predicate that would
  // call those a near match has no business existing in this file.
  if (isNumber(a) || isNumber(b)) return false;

  if (a.length === b.length) {
    let differences = 0;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i] && (differences += 1) > 1) return false;
    }
    return differences === 1;
  }

  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  let i = 0;
  while (i < short.length && short[i] === long[i]) i += 1;
  return short.slice(i) === long.slice(i + 1);
}

/** Is this token present, allowing one letter's worth of typo in a long word? */
function present(token: string, have: ReadonlySet<string>): boolean {
  if (have.has(token)) return true;
  if (isNumber(token) || token.length < FORGIVE_FROM) return false;
  for (const candidate of have) {
    if (!isNumber(candidate) && nearlySame(token, candidate)) return true;
  }
  return false;
}

export function tokenise(value: string): string[] {
  return value
    .toLowerCase()
    // `7Ferris st Somerton park` arrived with no space after the number. Left
    // glued, `7ferris` is a token that matches nothing, so the street name —
    // the only word that identifies the job — never takes part, and the one
    // Ferris folder in the index was never even offered as a candidate. Split
    // both sides of every digit/letter boundary, on folder names too, so the
    // two sides stay comparable.
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/([a-z])(\d)/g, '$1 $2')
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
    if (present(token, have)) got += weight;
  }
  return got / total;
}

/**
 * Which of an address's tokens actually identify a job.
 *
 * `terrace`, `road` and `street` appear in hundreds of folder names and single
 * out nothing; `finniss`, `sanctuary` and `murrays` appear in one or five and
 * single out everything. Worked out from the index rather than from a list kept
 * here, because the index is what changes.
 *
 * A folder sharing none of these with the address is not a weak match, it is a
 * coincidence — `002-Sinks` scored 0.80 against `2 finniss terrace` on the
 * strength of a `2` and a `terrace`. Weighting the tokens instead of gating on
 * them was tried and measured worse: it made real matches ambiguous without
 * removing the coincidences.
 */
function tokenCounts(folderNames: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const name of folderNames) {
    for (const token of new Set(tokenise(name))) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return counts;
}

function distinctiveTokens(
  wanted: readonly string[],
  folderNames: readonly string[],
  counts: Map<string, number>,
): string[] {
  const ceiling = Math.max(3, Math.floor(folderNames.length * 0.02));
  return wanted.filter((token) => (counts.get(token) ?? 0) <= ceiling);
}

/**
 * The one word in an address that has to appear in the folder name.
 *
 * The rarest of the distinctive words: `ferris` is in one folder name and
 * `somerton` in a dozen, so `ferris` is the street and `somerton` is the
 * postcode's worth of other jobs.
 */
function identifyingToken(
  distinctive: readonly string[],
  counts: Map<string, number>,
): string | null {
  if (distinctive.length === 0) return null;
  return distinctive.reduce((best, token) =>
    (counts.get(token) ?? 0) < (counts.get(best) ?? 0) ? token : best,
  );
}

/**
 * What to put in front of a person when nothing scored well enough to resolve.
 *
 * Ranking the whole index by score is what made this unhelpful: `7Ferris st
 * Somerton park` was offered five Somerton Park streets, not one of them
 * Ferris, while `58179 - 9 Ferris Avenue, Somerton Park` — the only Ferris job
 * there is — sat below the floor and was never shown. Whoever read that had no
 * way to see the answer was "number 9, not 7".
 *
 * So candidates are chosen by the rarest word in the address rather than by
 * score. `ferris` appears in one folder name and `somerton` in a dozen; the
 * rare one is the street, and a folder that does not share it is a different
 * job however well it scores on `street` and `park`.
 *
 * This list never resolves anything. It exists so the person the submission
 * has been handed to can see the near miss.
 */
function worthOffering(
  address: string,
  distinctive: readonly string[],
  folderNames: readonly string[],
  counts: Map<string, number>,
): string[] {
  const rarest = identifyingToken(distinctive, counts);
  if (rarest === null) return [];
  return folderNames
    .filter((folder) => present(rarest, new Set(tokenise(folder))))
    .map((folder) => ({ folder, confidence: score(address, folder) }))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5)
    .map((c) => c.folder);
}

/** Both sides stripped to letters and digits, for reading a typed reference. */
const bare = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');

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
  // A candidate has to share something that identifies the job, not merely
  // score well on words every second folder contains.
  const counts = tokenCounts(folderNames);
  const wanted = tokenise(submission.address);
  const distinctive = distinctiveTokens(wanted, folderNames, counts);
  // The rarest word in the address is the street, and it is not optional.
  //
  // Sharing *any* distinctive word was not enough. `7Ferris st Somerton park`
  // scored 0.857 against `7 Bungey Street Somerton Park` on the strength of a
  // 7, a street and a suburb, against 0.43 for the one Ferris job there is —
  // so it resolved, confidently, to the wrong street. Requiring the rarest
  // word instead means a folder without `ferris` in it is not a weak match for
  // a Ferris address, it is a different job.
  //
  // This costs recall and it is the right direction to spend it: an address
  // whose street name appears nowhere in the index now goes to a person
  // instead of being answered from the suburb.
  const required = identifyingToken(distinctive, counts);
  const identifies = (folder: string): boolean => {
    if (required === null) return true;
    return present(required, new Set(tokenise(folder)));
  };

  const scored = folderNames
    .filter(identifies)
    .map((folder) => ({ folder, confidence: score(submission.address, folder) }))
    .filter((c) => c.confidence >= 0.6)
    .sort((a, b) => b.confidence - a.confidence);

  /**
   * Does this folder's name contain the reference the builder typed?
   *
   * Read ONLY against folders the address already found. Turned loose on the
   * whole index it was worse than useless: `Res 2` bares to `res2`, which is
   * in thirty folder names, and the first of them was picked — so a submission
   * for 21 Chopin Road, Somerton Park was reported as contradicted by a job on
   * Bowker Street, Warradale. A reference cannot name a job on its own. It can
   * only choose between jobs the address has already narrowed to.
   */
  const referenceKey = bare((submission.reference ?? '').trim());
  const namesReference = (folder: string): boolean =>
    referenceKey.length >= 4 && bare(folder).includes(referenceKey);

  if (scored.length === 0) {
    return {
      status: 'unresolved',
      candidates: worthOffering(submission.address, distinctive, folderNames, counts),
    };
  }

  const best = scored[0]!;

  // Folders the address cannot choose between. `6 Ophir Crescent Seacliff Park`
  // scores 1.00 against both RES. 1 and RES. 2 of the same build, because the
  // address simply does not say which residence it is.
  const tied = scored.filter((c) => best.confidence - c.confidence < 0.15);

  if (tied.length > 1) {
    // Here the reference is not a tripwire, it is the answer. The address has
    // done all it can and stopped between two jobs; `Res 2` says which. That
    // is disambiguation, not contradiction, and it used to be reported as a
    // conflict and stop the review dead.
    const picked = tied.filter((c) => namesReference(c.folder));
    if (picked.length === 1) {
      return { status: 'resolved', folder: picked[0]!.folder, confidence: picked[0]!.confidence };
    }
    // More than one match still narrows it. `Res 2` against the four Chopin
    // Road folders leaves the two that are the same address twice over —
    // which is the useful thing to show, because that is a duplicate in
    // SharePoint and not a decision anyone can make from here.
    return {
      status: 'ambiguous',
      candidates: (picked.length > 1 ? picked : tied).slice(0, 5).map((c) => c.folder),
    };
  }

  // The address was decisive. A reference pointing at a DIFFERENT job that the
  // address also matched is the contradiction worth stopping for: two
  // submissions for different lots both carried `KW16250`, the address named
  // `KW16277`, and the photographs had been recycled from the first.
  const contradiction = scored.find((c) => c.folder !== best.folder && namesReference(c.folder));
  if (contradiction) {
    return { status: 'conflict', folder: best.folder, referenceFolder: contradiction.folder };
  }

  return { status: 'resolved', folder: best.folder, confidence: best.confidence };
}
