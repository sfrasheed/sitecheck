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
| `POST /api/submissions/{itemId}/folder` | A person names the job folder the matcher would not decide. Needs `X-Actor` |
| `POST /api/submissions/{itemId}/ingest` | The same, on demand, for submissions that already exist — and a re-match for one that failed to find its folder |
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

Two things make the address side survive contact with a phone keyboard. A word of six letters or
more is matched allowing one letter's difference, so `Santuary` finds `Sanctuary Ave` — never
numbers, because `304` and `307` are two different houses. And a candidate has to share a token that
actually identifies a job: `terrace` and `road` appear in hundreds of folder names, so `002-Sinks`
no longer scores 0.80 against `2 finniss terrace` on the strength of a `2` and a `terrace`. Which
tokens those are is worked out from the index, not from a list kept in the code.

Measured on all 1,281 folders and a set of known-correct answers: no address resolves to the wrong
folder, and an address with a typo in it now finds its job about four times in five instead of three.

## What happens to an iPhone photograph

iPhones save HEIC unless someone changed a setting, and the reader takes jpeg, png, gif and webp.
So a format it cannot open goes through the Images binding on the way past and is read as JPEG. The
original bytes are never touched — they are content-addressed and a review that read them has to
keep resolving — and no converted copy is kept.

Success is reported nowhere: a converted photograph is a photograph. Failure refuses in English,
naming the files, because the alternative is sending bytes the API rejects — which is what used to
happen, and it took the whole review down silently.

## Why the folder index has to say when it is lying

The index is a copy of SharePoint pushed in hourly by a flow. Being a copy, it lags — and being a
copy that never deletes, it cannot tell you it is incomplete. A flow returning a truncated slice
looks exactly like a healthy one: the same names arrive, the count holds steady, and matches quietly
start failing for jobs whose folders were never sent.

That happened. The flow returned the same 999 folders for a day while SharePoint held well over a
thousand, and the first anyone knew of it was a real submission refused with `nothing matched` — a
correct refusal against a broken input, which is the worst kind to notice late.

So every push writes down what it was handed, and `GET /api/health` reports:

- `lastPush.rowsReceived` — rows before files and blanks were dropped. This is the number a flow's
  paging settings cap, so a value that lands on a round number is a paging limit, not a folder count.
- `grewAt` — when a name last entered the index for the first time. Refreshed for days without ever
  growing means either nothing was built, or the same slice keeps arriving.
- `concern` — those two said in English when they point somewhere, and `null` when they do not.

And because the index lags, a submission that failed to match is matched again on the next
`ingest` — before this it was stuck at `unresolved` permanently, recoverable only by editing the row
by hand. Submissions that already resolved are left alone: a review's folder must not change under
it after the fact.

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
