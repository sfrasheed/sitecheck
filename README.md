# Site Check

A builder submits site photos through SteedForm's Ready-to-Measure call-up form. The photos land on
a monday item. This reads them against the job's Order Confirmation and joinery drawings and posts
back a verdict — **READY**, **READY WITH VARIATION** or **NOT READY** — as an update on that same
item, with a reason list the office can forward straight to the builder.

**The app holds no review rules of its own.** What makes a site ready to measure lives in the
knowledge base, which is uploaded through the API, versioned and hashed. Replacing a file changes
reviewing immediately; changing this repository does not.

There is no user interface. The office already has one — the monday board, where the photos are.

## Running it locally

```bash
npm install
npm run db:migrate
npm run dev
```

Nothing can be reviewed until the knowledge base is loaded:

```bash
curl -X POST http://localhost:8787/api/kb \
  -H "X-Push-Token: $PUSH_TOKEN" \
  -H 'X-Actor: you@steedform.com' \
  -F 'file=@site-photo-review.md' \
  -F 'name=01-site-photo-review.md' \
  -F 'ordinal=10'
```

`GET /api/kb` reports `readable: false` while it is empty, and no review will run.

## The API

| | |
|---|---|
| `GET /api/health` | What is configured, and what is not |
| `POST /api/sharepoint/folders` | The hourly index push. Accepts SharePoint's raw response, or a list of names |
| `GET /api/sharepoint/resolve?address=…` | Dry run: which job folder would this address find? |
| `POST /api/monday/webhook` | Fired when the call-up form creates an item |
| `POST /api/submissions/{itemId}/ingest` | The same, on demand, for submissions that already exist |
| `GET` `POST` `/api/kb` · `GET` `DELETE` `/api/kb/{id}` | The knowledge base |

## Why a job is resolved by address and not by its reference

The reference a builder types is free text. It is blank on roughly 40% of submissions and it is
sometimes simply wrong: two submissions for different lots of the same estate both carried
`KW16250`, and only one of them was that job — the other was `KW16277`, and the photos had been
recycled from the first.

So the address is matched against the SharePoint folder name, and the typed reference is used only
to *contradict* that match. When the two name different jobs, the review stops and says so. Two
folders matching equally well also stops it. A review written against the wrong job is worse than no
review, because it reads as authoritative.

Photo bytes are content-addressed, which turns the recycled-photo problem into a query: the same
sha256 against a different address is one set re-submitted across several lots.

## Before the first deploy

Create the D1 database and the R2 bucket, put the real `database_id` in `wrangler.jsonc`, then set
the secrets:

```bash
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put MONDAY_API_TOKEN
wrangler secret put PUSH_TOKEN
wrangler secret put WEBHOOK_TOKEN
```

Locally they live in `.dev.vars`, which is gitignored.

## Related

[`sfscreeningapp`](https://github.com/sfrasheed/sfscreeningapp) — Deep Screen, which screens sales
enquiries. A separate repository with separate storage. The two share a design philosophy and
nothing else.
