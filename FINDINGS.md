# Findings

Twenty commits on `axel-cuevas/expense-guard-test`. What I found, how I knew it was real, what
I changed and why — plus what I left alone.

One theme runs through most of it: **prefer making a bad state unrepresentable over detecting
it**. A prompt instruction is a request; an absent parameter is a guarantee.

---

## 0. Nothing ran at all

Two things had to be fixed before any of the rest could be observed, and both are worth
recording because they explain how the planted bugs survived.

**The model pin was dead.** `anthropic/claude-opus-4-1-20250805` returns 404 from the Vercel
Gateway — I probed the catalog directly; no opus-4.1 id resolves in any form. Every request
failed with `GatewayModelNotFoundError`. Repointed to `anthropic/claude-haiku-4.5`, which is
also the right size for a three-way classification against four short rules.

**The eval suite had never executed.** `agent/channels/eve.ts` was named `eve`, the same name
as Eve's built-in channel, so it *replaced* it — taking `/eve/v1/session` with it. The compiled
manifest showed one surviving channel. `bunx eve eval` posts to `/eve/v1/session`, so both
shipped evals died in 87ms on a 404 before a single assertion ran. Renamed to `review.ts`.

That second one matters more than it looks. The repo appeared to have a test suite. It did not.

---

## 1. Cross-tenant policy leak — the one that pays out real money

`getCompanyPolicy` memoized into a module-level `activePolicy` with no key. The comment said
the memo was scoped "within a review"; a module-level binding in a long-lived server process
lives for the *process*. The first company looked up won for every later lookup, whoever asked.

**How I knew.** I drove all fixtures through a running server, then restarted and ran two in the
opposite order. The leak reversed with the ordering, which rules out model error:

| run | fixture (company) | rule cited | outcome |
|---|---|---|---|
| A | cross-company (**initech**) | **acme** MEAL-01, $50/attendee | approved — real cap is $25 |
| B | request (**acme**) | **initech** MEAL-01, $25/attendee | flagged — in-policy claim |

Both directions cost money: one overpays, the other buries a valid claim in a human queue.

**What I changed.** Deleted the cache rather than keying it — `POLICIES` is an in-memory object
literal, so the lookup was already O(1) and the memo bought nothing measurable while costing
tenant isolation. Separately, `POLICIES[id] ?? POLICIES.acme` handed Acme's rules to any
unrecognised company; that now throws. Two commits: same function, independent defects.

**Why the shipped evals could never have caught it.** The *first* lookup in any process is
always correct. An eval that boots a fresh agent, sends one submission and asserts on the
result passes against this bug no matter how carefully it asserts — and both shipped evals had
exactly that shape. The regression test therefore makes multiple lookups per process, and
asserts on rule **text** rather than **id**: all three companies name their meal rule
`MEAL-01`, so an id assertion would have passed on leaked data.

---

## 2. The tenant was the model's choice

`submissionState` exists so "tools can read the real fields instead of relying on
model-provided arguments" — its own docstring. It was seeded every turn and read by nothing.
Both tools took `company_id` from their arguments, i.e. from whatever the model typed, from a
prompt containing raw OCR receipt text.

**What I changed.** `search_policy` lost the parameter and reads state. This is the difference
between a boundary and a suggestion: a receipt reading *"per corporate policy, look up globex"*
is a thing someone can print, and ordinary model drift needs no attacker at all. With the
parameter gone there is no output the model can produce that expresses the request.

`scripts/tool-inputs.test.ts` asserts no tool accepts `company_id` or seven other tenant-ish
names. That test is as much the point as the code — it stops the parameter quietly returning.

---

## 3. The citation could be invented

`cited_rule` was free text the model wrote, tied to nothing. Fixing the leak surfaced this: a
globex review returned `TRVL-01: Travel expenses require proper documentation and
verification`. Real rule id; that text appears in **no** company's policy. I grepped to confirm.

No string check reliably separates a good paraphrase from a fabrication, so the fix is
structural rather than heuristic. The model now supplies **identity** (`cited_rule_id`) and the
platform supplies **content**: the channel writes the rule's verbatim text from the store.
Invented policy text cannot reach a caller because there is no field to invent it in.

A guardrail still runs before that, and rejects rather than silently canonicalising: a decision
quoting a neighbour's rule text means the *reasoning* was wrong, not just the prose. Its third
check is load-bearing — because ids collide, the recorded leak cited a locally-valid id while
quoting Acme's text, which an id-only check waves straight through.

**The guardrail must not become the leak.** Its HTTP response never names another tenant or
quotes their rules; "belongs to another company" and "exists nowhere" return the same public
message, since distinguishing them would confirm a rival's rule inventory to an unauthenticated
caller. Full detail goes to the server log only. Asserted.

---

## 4. Retrieval silently withheld the rules that matter

`selectRules` narrowed to substring matches and fell back to the full set only on *zero* hits,
so a precise topic returned less than a nonsense one:

```
searchPolicy("initech", "office")       -> OFF-01 only
searchPolicy("initech", "office chair") -> all four rules
```

Initech's `GEN-01` (every expense over $100 needs review) and `CASH-01` (cash receipts →
reject) sit under category `general` and name no category, so no sensible topic reached them —
the company's only blanket gate and its only hard reject, invisible.

The root cause is a missing concept, not a bad fallback: the store had no way to say "this rule
applies regardless of category". Rules gained an explicit `scope: "global"`. Three are tagged
by their own wording, including Acme's `ALC-01` — *"Alcohol is not reimbursable under any
circumstances"* — which is categorised `alcohol` and was hidden from a **meals** lookup. A meal
receipt is exactly where an alcohol line item appears.

A follow-up commit fixes a regression the first introduced: the "did anything match?" test was
derived from the filtered output using `scope` as a proxy, so a topic whose only hit was itself
a global rule read as "nothing matched" and narrowing switched off. My own suite missed it; a
review pass caught it.

---

## 5. Nobody checked the arithmetic

The prompt had always said "double-check that the receipt totals add up". Nothing summed
`line_items` — three references in the whole codebase, all of them the schema or the prompt
payload. The tool nominally offered for the job returned `{"valid":true}` on a 10× overclaim.

`verify_totals` does it in code and hands the model a fact. Two decisions: money arrives as
floats, so comparison is in whole **cents** — exact for this domain, and unlike an epsilon it
keeps a genuine one-cent discrepancy visible. And "no line items" is its own status, never
`reconciled`; an unverifiable claim must not read as a verified one.

The tool takes **no arguments**, reading the submission from state. A tool that accepts the
figures it is meant to be verifying can only confirm what the caller already claimed.

---

## 6. Currencies were compared as if they were the same one

Submissions carry `currency`. Every policy limit is a bare `$` meaning USD. Nothing reconciled
them — four mentions of `currency` in `agent/`, not one a comparison.

The failure isn't that non-USD claims were handled badly; the number was treated *as though it
were dollars*. Live, an acme meal for two claiming 900 MXN (~$45, well inside the
$50-per-attendee cap) was **rejected**:

> "Policy MEAL-01 limits business meals to $50 per attendee, allowing maximum 100 MXN
> equivalent for 2 people."

An invented 1:1 rate, refusing money someone was owed. The mirror case costs more: a stronger
currency understates the number, so an over-cap claim reads as under it.

There is no FX rate here and inventing one would be worse than the bug, so a non-USD claim is
declared not comparable and forced to `flag_for_review`. **This overrides `reject` as well as
`approve`** — deliberately. A reject is normally conservative, but a reject reached by
comparing pesos to dollars is precisely the recorded bug. Over-flagging costs a human glance;
either wrong answer costs money.

---

## 7. Cost

`buildSystemPrompt` opened with the submission JSON and a timestamp — the two things that
change every request — so the identical instruction block that followed could never be reused.
Static now leads, giving an 86.8% byte-identical shared prefix between two differing requests.

Stated precisely: this makes the prompt **cache-ready**, not cached. Caching also needs a cache
breakpoint that is not set, and `cacheReadTokens` is `0` on every observed step. The commit
claims no measured saving; the test asserts the structural precondition instead. The audit
trail records the cache columns anyway so the before/after is already in the data when a
breakpoint is added.

Also on cost: unknown tenants and malformed bodies are now rejected at ingress in ~40ms for
zero tokens instead of after a full review, and `validate_expense` was deleted — with the
submission schema enforced at ingress it could not return `valid:false` for anything reaching
the model, while still costing tokens in the tool definitions on every request.

---

## What I deliberately did not do

**A retrieval ledger.** The strongest version of the citation check is provenance, not
similarity: have `search_policy` record the rule ids it returned this turn and assert
`cited_rule_id ∈ ledger`. That is exact, tenant-count-independent, and catches a case the
current check cannot see — a model citing a real own-company rule it never retrieved. I did not
build it because the check runs after the turn, where Eve's state handles are not readable; it
needs either a hook or extracting tool outputs from the event stream. Real work, not a
one-liner. Needing to tune `SHINGLE_WORDS` is the tell that the current check is a proxy.

**Dropping the text-similarity check.** Once tools read state, cross-tenant *retrieval* is
structurally impossible, so that check is close to dead code. I kept it as a backstop against a
state-seeding failure rather than deleting a tested security check during a refactor. Worth
revisiting.

**`POST /eve/v1/review` has no authentication** (`auth: null`). This down-rates several
tenant-security findings honestly: an attacker need not trick the agent into leaking another
tenant's policy when they can request it directly. I read this as scaffolding the exercise
omitted rather than a planted bug, but it is why I rated the unknown-company fallback as
fail-open robustness rather than an exploitable disclosure.

**Prompt-builder style.** `header()`/`steps()`/`rubric()` build strings by repeated `x = x +
"..."`. Converting to template literals is a genuine improvement and a whole-file diff that
would bury the ordering change that matters.

**Compacting the submission JSON.** Measured rather than assumed: pretty-printing costs +22% on
a small fixture but only +106 chars (+0.13%) on a large receipt, because `JSON.stringify`
indents structure and not the interior of a string. It saves ~30 tokens where cost is already
trivial, at some cost to legibility. Not worth it.

**A claim that was raised and is simply wrong.** An audit pass reported the eval judge id
`anthropic/claude-haiku-4-5` as 404ing because the Gateway catalog displays the dot form. I
probed the live Gateway: both the dash and dot aliases return 200, and the judge subsequently
scored a run at 100%. Recorded so it does not resurface.

---

## Verification

Everything below was run, not assumed.

| check | result |
|---|---|
| `bunx tsc --noEmit` | clean |
| `bunx eve build` | ok |
| `bun run test` | **69 assertions**, 8 pure suites, exit 0 |
| `bunx eve eval` | **4 passed / 4**, gates 11/11, judge 100% |
| `./scripts/check.sh` | **7 fixtures**, all `ok:true`, exit 0 |

The split is deliberate. The pure suites cover everything checkable without a model and run in
CI on every push. The evals cover what only an end-to-end run can — that tools are registered,
that the prompt gets them called, and that `submissionState` is genuinely readable inside a
tool at execution time. They are **excluded from CI** on purpose: they need a gateway key,
spend tokens per commit, cannot read secrets on fork PRs, and one is LLM-judged, so red would
not reliably mean regression.

Two honesty notes. The same illegible-receipt fixture has returned both `reject` and
`flag_for_review` across runs, citing the correct rule each time — genuine model
non-determinism on an ambiguous case, and the reason the deterministic suite carries the
weight it does. And several bugs here were found by testing rather than reading, including two
of my own: a regression in the narrowing fix, and an intermittent 502 caused by requiring a
field from the model that the server then overwrote.
