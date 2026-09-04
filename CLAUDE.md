# sitecheck

## What this is

**Site Check.** A builder submits site photos through SteedForm's Ready-to-Measure call-up form.
The photos land on a monday item. This reads them against the job's Order Confirmation and joinery
drawings and posts back one of three verdicts — READY, READY WITH VARIATION, NOT READY — on that
same item, so the office can forward it to the builder.

SteedForm is an Adelaide stone benchtop fabrication and installation business. A site measured
before it is ready produces a template that cannot be cut to tolerance, and a remake costs real
money.

## The one rule that shapes everything

> **The knowledge base decides what "ready" means. This app decides which photos and documents a
> review reads, and where the answer goes. It never decides what the answer is.**

The knowledge base is uploaded through the API, versioned and content-hashed. **No review rules in
application code.** If you find yourself writing a tier, a threshold, a checklist line or a list of
what makes a site not ready, stop — that belongs in the knowledge base.

## Things that are true by construction — a change that breaks one is wrong

1. **The app computes no verdict.** It stores the one it was given.
2. **The reference a builder types is never a key.** On live data, two submissions for different
   lots of the same estate both carried `KW16250`, and only one of them was that job — the other
   was `KW16277`. Jobs are resolved by address. The typed reference is used *only* to contradict
   that, and when the two disagree the disagreement is the finding.
3. **Guessing between candidate folders is forbidden.** `ambiguous` and `unresolved` are real
   outcomes that stop a review. A review written against the wrong job is worse than no review,
   because it reads as authoritative.
4. **Photo bytes are content-addressed.** This makes the recycled-photo case a query rather than a
   judgement: an identical sha256 against a different address is one photo set re-submitted across
   several lots, which is a hard stop.
5. **Over-flagging is the designed-against failure.** The spec's §5 and §9 exist because a reviewer
   that raises nine findings when one is real is worse than useless — the builder stops reading at
   item three. Those sections must reach the model verbatim.
6. **When the rules cannot be read, keep capturing and refuse to judge.** An empty knowledge base
   reports `readable: false` and no review runs.
7. **No user interface.** The office already has one: the monday board, where the photos are. A
   second place to look at the same job would be a worse product.
8. **Documents arrive by push, not pull.** The Worker holds no Graph credentials.

## Its relationship to Deep Screen

`sfscreeningapp` (Deep Screen) is a **separate repository, separate Worker, separate storage**. It
screens sales enquiries; this reviews site readiness. They share an author, a company and a design
philosophy, and nothing else. Neither may read the other's data. Site photography of customers'
houses does not belong in the same store as enquiry paperwork.

Deep Screen sits behind Cloudflare Access because people use it. **Site Check deliberately does
not** — it is reached by a Power Automate flow and a monday webhook, never by a person with a
browser, and its endpoints authenticate with shared secrets the callers present themselves.

## Stack

- **Cloudflare Workers**, no assets, no framework
- **D1** for the record, **R2** for photo bytes
- **`@anthropic-ai/sdk`**, model `claude-opus-5`
- **oxlint** (not ESLint), deployed with **wrangler**

## Layout

| Path | Role |
|---|---|
| `worker/index.ts` | The router. No UI, API only |
| `worker/services/folders.ts` | Address → job folder. The matcher, and the four outcomes |
| `worker/services/sharepoint.ts` | The folder index, and the document-fetch client |
| `worker/services/monday.ts` | Read the submission; post the review; file the verdict with read-back |
| `worker/routes/` | `intake` · `sharepoint` · `kb` |
| `migrations/` | Forward-only SQL |

## Where the inputs live

**monday** — board `5031038127` on the `steedformaus` account, "Site measure call up form
submissions". Photos are on `file62rfa77h`; address on `short_textkjcwwz7f`; the builder's reference
on `short_textdgnwtzv3`, which is free text and blank about 40% of the time. Verdict is written to
`color_mm6wkf5h` and the reason to `long_text_mm6ws202` — an allow-list in `wrangler.jsonc`, never
discovered from the board.

**SharePoint** — `steedform.sharepoint.com/sites/STEEDFORMPTYLTD`, library `Shared Documents`, root
`Job Documentation/`, ~1,276 job folders. Each holds `Quote Details/order confirmation.pdf` and
`Job Details/<folder> - Joinery Drawings Rev. N.pdf`. Folder names are **free text** — `22 Railway
Tce, Truro`, `MDC - Price #10780 - Supply Only`, `LOT 113 (#) MELDRUM LANE TAPEROO (FORT LARGS)
(15513)` — which is why matching is fuzzy and refusal is a first-class outcome.

## Commands

```bash
npm install
npm run db:migrate       # apply D1 migrations locally
npm run dev              # wrangler dev
npm run lint             # oxlint
npm run build            # tsc -b
npm run verify           # lint + build
npm run deploy           # build + wrangler deploy
npm run cf-typegen       # regenerate binding types after editing wrangler.jsonc
```

## Conventions and gotchas

- `npm run deploy` runs `tsc -b` first, so **a type error blocks the deploy.**
- `erasableSyntaxOnly` is on: **no constructor parameter properties, no enums.**
- **`Env` is an exported type in `worker/env.ts`**, not a global. Import it explicitly.
- **monday fails silently on content it dislikes.** Text containing `<` is replaced with an empty
  string and the write returns success; `long_text` over ~2,000 characters is silently truncated and
  reads back truncated. So the full report goes in an **update**, the columns carry a budgeted
  summary, and every column write is verified by re-reading it.
- **monday asset URLs expire in about an hour.** Pull the bytes at intake; never store the URL.
- **monday cannot send custom headers**, so the webhook secret rides in the query string. Treat that
  whole URL as a credential.
- **The structured-output schema is a compiled grammar with a size limit.** Keep it flat; `minItems`
  above 1 is rejected, and nested objects and nullable unions inflate it until you get a 400.
- **Do not copy SteedForm's criteria into this repository.** Upload them.
- Secrets go in `.dev.vars` locally (gitignored) and via `wrangler secret put` in production.

## Not built yet

The review itself — the Claude call, the output schema for the three verdicts and three tiers, and
the update text. And the document fetch, which is stubbed behind `fetchJobDocuments` pending the
SharePoint push flow.

Two things worth knowing when the review is built:

- The Ready-to-Measure guide carries a rule the v0.3 spec does not: 12mm single-thickness ceramic,
  sintered stone and porcelain require **solid closed cabinets**, where 20mm equivalents can be
  supported every 600–1200mm. So the material has to be read off the Order Confirmation *before*
  support can be judged.
- The reference photographs in both source PDFs — "what ready looks like" — did not survive text
  extraction. For a tool that judges photographs, holding those as images would be worth a lot.
