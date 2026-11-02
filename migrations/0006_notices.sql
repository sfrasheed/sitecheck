-- What was emailed about a submission nobody could judge, and what was not.
--
-- Two reasons to write this down rather than just sending.
--
-- A notice is the only thing this Worker does that leaves the building, so
-- the record has to answer "was anyone actually told, and when" without
-- anybody searching a mailbox.
--
-- And a failure that repeats is not news twice. The Anthropic key was refused
-- for twenty-six days; at one notice per attempt that is twenty-five
-- identical emails, which is how a mailbox rule gets written and the
-- twenty-sixth is never read. A refusal is per-job and always sent, because
-- each one is a different site needing a different person. A failure is sent
-- once per cause until something changes, and the suppressed ones are
-- recorded here so "we were not told" can be answered either way.
CREATE TABLE notice (
  id        TEXT PRIMARY KEY,
  review_id TEXT NOT NULL,
  kind      TEXT NOT NULL CHECK (kind IN ('REFUSED', 'FAILED')),

  -- The cause, reduced to something comparable, so repeats of one fault
  -- collapse while a different fault still gets through.
  cause     TEXT NOT NULL,

  sent      INTEGER NOT NULL CHECK (sent IN (0, 1)),
  -- Empty when it was sent. Otherwise why it was not.
  held      TEXT NOT NULL DEFAULT '',
  at        TEXT NOT NULL
);

CREATE INDEX notice_cause ON notice (cause, at);
CREATE INDEX notice_at ON notice (at);
