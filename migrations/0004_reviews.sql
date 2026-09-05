-- A review of one submission.
--
-- The app stores the verdict it was given and shows it. It never recomputes it,
-- never overrides it, and never quietly corrects it.
--
-- `kb_fingerprint` is the hash of the whole knowledge base as it stood when the
-- review ran, so a verdict can always be traced to the exact words that produced
-- it — including after the rules change.

CREATE TABLE reviews (
  id             TEXT PRIMARY KEY,
  submission_id  TEXT NOT NULL REFERENCES submissions(id),

  status         TEXT NOT NULL DEFAULT 'QUEUED'
                 CHECK (status IN ('QUEUED', 'RUNNING', 'DONE', 'REFUSED', 'FAILED')),

  -- What the review was given, recorded rather than inferred.
  kb_fingerprint TEXT,
  folder         TEXT,
  photo_count    INTEGER NOT NULL DEFAULT 0,
  document_count INTEGER NOT NULL DEFAULT 0,
  model          TEXT,

  -- The answer, exactly as returned. Parsed for display, never edited.
  verdict        TEXT CHECK (verdict IN ('READY', 'READY WITH VARIATION', 'NOT READY')),
  headline       TEXT,
  body           TEXT,

  -- Why no verdict was reached, when there isn't one. A review that refuses is
  -- a real outcome — the knowledge base being unreadable, the job folder
  -- unresolved, or the photos already seen against a different address.
  refusal        TEXT,

  requested_by   TEXT NOT NULL CHECK (LENGTH(TRIM(requested_by)) >= 3),
  requested_at   TEXT NOT NULL,
  finished_at    TEXT,

  -- Where the answer was posted, once a person can see it.
  monday_update_id TEXT,
  posted_at      TEXT
);

CREATE INDEX reviews_submission ON reviews (submission_id, requested_at DESC);
CREATE INDEX reviews_status ON reviews (status);
