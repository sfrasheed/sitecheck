-- A receipt for every index push.
--
-- The index itself cannot tell you it is incomplete. `job_folders` never
-- deletes, so a flow that starts returning a truncated slice looks exactly like
-- a flow returning everything: the same names arrive, the count holds steady,
-- and matches quietly start failing for jobs whose folders were never sent.
--
-- That is not hypothetical. The hourly flow returned the same 999 folders for a
-- day while SharePoint held well over a thousand, and the first anyone knew of
-- it was a real submission refused with `nothing matched` — a correct refusal
-- against a broken input, which is the worst kind of failure to notice.
--
-- So each push writes down what it was handed. Two things give truncation away:
-- a `rows_received` that lands on a round number, and an index that keeps being
-- refreshed without ever growing.
--
-- Not append-only and carrying no actor, for the same reason `job_folders` is
-- not: this records a machine copying somebody else's filing cabinet. It proves
-- nothing and decides nothing.
CREATE TABLE folder_index_pushes (
  id            TEXT PRIMARY KEY,
  at            TEXT NOT NULL,

  -- Rows in the payload, before files and blanks were dropped. This is the
  -- number the flow's own settings cap, so this is the number that exposes them.
  rows_received INTEGER NOT NULL,

  -- Distinct folder names kept, and how many had never been seen before.
  names_kept    INTEGER NOT NULL,
  names_added   INTEGER NOT NULL
);

CREATE INDEX folder_index_pushes_at ON folder_index_pushes (at);
