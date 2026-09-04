-- A call-up submission, and the photos that came with it.
--
-- One row per monday item. `monday_item_id` is unique because a webhook can
-- fire twice for the same item and a second review is not a second submission.

CREATE TABLE submissions (
  id                TEXT PRIMARY KEY,
  monday_item_id    TEXT NOT NULL UNIQUE,
  monday_board_id   TEXT NOT NULL,

  -- As the builder typed them. Never cleaned up: the review quotes what was
  -- submitted, and a tidied address would misrepresent what we were given.
  submitted_name    TEXT,
  address           TEXT,
  reference         TEXT,
  company           TEXT,
  preferred_date    TEXT,

  received_at       TEXT NOT NULL,

  -- Which job folder this resolved to, and how confidently.
  --   resolved   — one clear match, `folder` is set
  --   ambiguous  — several equally good matches, a person chooses
  --   conflict   — the address and the typed reference name different jobs
  --   unresolved — nothing matched
  --   pending    — not yet attempted
  -- Anything other than `resolved` means no review runs. A review written
  -- against the wrong folder is worse than no review, because it reads as
  -- authoritative.
  resolution        TEXT NOT NULL DEFAULT 'pending'
                    CHECK (resolution IN
                      ('pending', 'resolved', 'ambiguous', 'conflict', 'unresolved')),
  folder            TEXT,
  resolution_detail TEXT
);

CREATE INDEX submissions_resolution ON submissions (resolution);
CREATE INDEX submissions_address ON submissions (address);

-- Photo bytes are content-addressed, so the same image submitted twice is the
-- same row in R2 under the same key.
--
-- This is what catches the failure spec v0.3 has no rule for: builders
-- re-submit one photo set across several lots. `KW16250` arrived twice, for
-- Lot 04 and Lot 11 of the same estate, carrying identical filenames. A review
-- of Lot 11 written from Lot 04's kitchen would be confidently, invisibly
-- wrong — so an identical sha256 against a different address is a hard stop,
-- and that check is a query rather than a judgement.
CREATE TABLE photos (
  id            TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  name          TEXT NOT NULL,
  sha256        TEXT NOT NULL,
  byte_length   INTEGER NOT NULL,
  stored_at     TEXT NOT NULL
);

CREATE INDEX photos_submission ON photos (submission_id);
CREATE INDEX photos_sha256 ON photos (sha256);
