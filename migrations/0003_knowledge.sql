-- The knowledge base: what makes a site ready to measure.
--
-- Site Check's own, separate from Deep Screen's. The two answer different
-- questions and neither's rules should move when the other's do.
--
-- Replacing a file supersedes rather than edits, so a review from last month
-- still resolves to the exact words it was given. That is the whole point of
-- keeping a copy: the app is the authority on custody, not on content.

CREATE TABLE kb_files (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,

  -- The text as uploaded. Not parsed, not normalised, not summarised — the
  -- reader is given these bytes. §5's list of false alarms and §9's worked
  -- example are the most load-bearing parts of the spec and they only work
  -- verbatim.
  body          TEXT NOT NULL,
  sha256        TEXT NOT NULL,
  byte_length   INTEGER NOT NULL,

  -- Reading order. The spec's own sections say to read §5 before §4, so the
  -- order files are given in is meaningful rather than cosmetic.
  ordinal       INTEGER NOT NULL DEFAULT 100,

  uploaded_by   TEXT NOT NULL CHECK (LENGTH(TRIM(uploaded_by)) >= 3),
  uploaded_at   TEXT NOT NULL,

  superseded_at TEXT,
  superseded_by TEXT REFERENCES kb_files(id)
);

CREATE INDEX kb_files_current ON kb_files (superseded_at, ordinal, name);
CREATE INDEX kb_files_name ON kb_files (name);
