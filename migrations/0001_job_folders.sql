-- The job folder index.
--
-- A cache of what SharePoint currently has under `Job Documentation`, pushed in
-- hourly from outside. The Worker cannot search SharePoint, and the matcher
-- needs something to match against; this is that.
--
-- Deliberately NOT append-only and deliberately carrying no actor. The
-- append-only rule and X-Actor exist to protect the record — decisions,
-- activity, what a named person concluded. This table holds none of that. It is
-- a copy of somebody else's filing cabinet, and the authority on its contents
-- is SharePoint, not this app. A row here proves nothing and decides nothing.
--
-- Rows are never deleted, though, because a folder that stops appearing is
-- worth noticing: if the flow breaks or its permissions narrow, the index would
-- otherwise shrink silently and matches would start failing for no visible
-- reason. Keeping last_seen_at means a stale or shrinking index is a question
-- someone can ask rather than a mystery.
CREATE TABLE job_folders (
  name          TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);

CREATE INDEX job_folders_last_seen ON job_folders (last_seen_at);
