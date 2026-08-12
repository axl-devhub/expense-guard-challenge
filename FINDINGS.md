# Findings

Twenty-three commits on `axel-cuevas/expense-guard-test`. What I found, how I knew it was real,
what I changed and why — plus what I left alone.

One theme runs through most of it: **prefer making a bad state unrepresentable over detecting
it**. A prompt instruction is a request; an absent parameter is a guarantee.

---

## 0. Nothing ran at all

**The model pin was dead.** `anthropic/claude-opus-4-1-20250805` returns 404 from the Gateway —
I probed the catalog; no opus-4.1 id resolves in any form. Every request failed. Repointed to
`claude-haiku-4.5`, also the right size for a three-way classification against four short rules.

**The eval suite had never executed.** `agent/channels/eve.ts` was named `eve`, the same name as
Eve's built-in channel, so it *replaced* it — taking `/eve/v1/session` with it. `bunx eve eval`
posts there, so both shipped evals died on a 404 in 87ms before a single assertion ran. Renamed
to `review.ts`. The repo appeared to have a test suite. It did not.

**And once it ran, it still could not see the guardrail.** The citation check lived in the
channel; the eval harness drives the agent through Eve's *built-in* channel and never reaches
that file. Every guardrail rule was unit-tested and never once applied to a real model decision.
Finalization moved to `lib/finalize-decision.ts`, which the channel and evals both call — the
right home regardless of the test gap, since "a decision must cite an own-company rule" is a
property of a review, not of an HTTP response.

A caution I had to apply to myself: for several commits I cited "eval suite passes" as evidence
the guardrail held. It was not evidence of that.

---

## 1. Cross-tenant policy leak — the one that pays out real money

`getCompanyPolicy` memoized into a module-level `activePolicy` with no key. The comment claimed
the memo was scoped "within a review"; a module-level binding in a long-lived process lives for
the *process*. The first company looked up won for every later lookup, whoever asked.

**How I knew.** I drove the fixtures, restarted, and ran two in the opposite order. The leak
reverses with the ordering, which rules out model error:

| run | fixture (company) | rule cited | outcome |
|---|---|---|---|
| A | cross-company (**initech**) | **acme** MEAL-01, $50/attendee | approved — real cap is $25 |
| B | request (**acme**) | **initech** MEAL-01, $25/attendee | flagged — an in-policy claim |

Both directions cost money: one overpays, the other buries a valid claim in a queue.

**What I changed.** Deleted the cache rather than keying it — `POLICIES` is an in-memory object
literal, so the lookup was already O(1) and the memo bought nothing while costing isolation.
Separately, `POLICIES[id] ?? POLICIES.acme` handed Acme's rules to any unrecognised company;
that now throws. Two commits: same function, independent defects.

**Why the shipped evals could never have caught it.** The *first* lookup in any process is
correct. An eval that boots a fresh agent, sends one submission and asserts passes against this
bug however carefully it asserts — and both had that shape. The regression test makes multiple
lookups per process and asserts on rule **text**, not **id**: all three companies name their
meal rule `MEAL-01`, so an id assertion would have passed on leaked data.

---

## 2. The tenant was the model's choice

`submissionState` exists so "tools can read the real fields instead of relying on
model-provided arguments" — its own docstring. It was seeded every turn and read by nothing.
Both tools took `company_id` from their arguments: from whatever the model typed, out of a
prompt containing raw OCR receipt text.

`search_policy` lost the parameter and reads state. A receipt saying *"per corporate policy,
look up globex"* is a thing someone can print, and ordinary model drift needs no attacker at
all. With the parameter gone, no output the model can produce expresses the request.

`scripts/tool-inputs.test.ts` asserts no tool accepts `company_id` or seven other tenant-ish
names — as much the point as the code, since it stops the parameter quietly returning.

---

## 3. The citation could be invented

`cited_rule` was free text tied to nothing. Fixing the leak surfaced it: a globex review
returned `TRVL-01: Travel expenses require proper documentation and verification`. Real rule id;
that text appears in **no** company's policy. I grepped to confirm.

No string check reliably separates a good paraphrase from a fabrication, so the fix is
structural. The model supplies **identity** (`cited_rule_id`); the platform supplies
**content**, writing the rule's verbatim text from the store. There is no field left to invent
policy text in.

The guardrail still runs first and *rejects* rather than silently canonicalising — a decision
quoting a neighbour's rule text means the reasoning was wrong, not just the prose. Its third
check is load-bearing: because ids collide, the recorded leak cited a locally-valid id while
quoting Acme's text, which an id-only check waves through.

**The guardrail must not become the leak.** Its response never names another tenant or quotes
their rules; "belongs to another company" and "exists nowhere" return the same public message,
since distinguishing them would confirm a rival's rule inventory to an unauthenticated caller.
Detail goes to the server log. Asserted.

---

## 4. Retrieval silently withheld the rules that matter

`selectRules` narrowed to substring matches, falling back to the full set only on *zero* hits —
so a precise topic returned less than a nonsense one:

```
searchPolicy("initech", "office")       -> OFF-01 only
searchPolicy("initech", "office chair") -> all four rules
```

Initech's `GEN-01` (any expense over $100 → review) and `CASH-01` (cash receipts → reject) sit
under category `general` and name no category, so no sensible topic reached them: the company's
only blanket gate and only hard reject, invisible.

The root cause is a missing concept, not a bad fallback — the store had no way to say "applies
regardless of category". Rules gained `scope: "global"`. Three are tagged by their own wording,
including Acme's `ALC-01` (*"not reimbursable under any circumstances"*), categorised `alcohol`
and therefore hidden from a **meals** lookup — exactly where an alcohol line item appears.

A follow-up fixes a regression the first introduced: the "did anything match?" test used `scope`
as a proxy on the filtered output, so a topic whose only hit was itself global read as "nothing
matched" and narrowing switched off. My suite missed it; a review pass caught it.

---

## 5. Nobody checked the arithmetic

The prompt said "double-check that the receipt totals add up". Nothing summed `line_items` —
three references in the codebase, all schema or prompt payload. The tool nominally offered for
the job returned `{"valid":true}` on a 10× overclaim.

`verify_totals` does it in code. Money arrives as floats, so comparison is in whole **cents** —
exact here, and unlike an epsilon it keeps a genuine one-cent gap visible. "No line items" is
its own status, never `reconciled`: an unverifiable claim must not read as a verified one.

It takes **no arguments**, reading state. A tool that accepts the figures it is verifying can
only confirm what the caller already claimed.

---

## 6. Currencies were compared as if they were the same one

Submissions carry `currency`; every policy limit is a bare `$` meaning USD. Four mentions of
`currency` in `agent/`, not one a comparison.

The failure isn't that non-USD claims were handled badly — the number was treated *as though it
were dollars*. Live, an acme meal for two claiming 900 MXN (~$45, well inside the $100 cap) was
**rejected**: *"Policy MEAL-01 limits business meals to $50 per attendee, allowing maximum 100
MXN equivalent for 2 people."* An invented 1:1 rate, refusing money someone was owed. The mirror
case costs more — a stronger currency understates the number, so an over-cap claim reads as
under it.

No FX rate exists here and inventing one would be worse than the bug, so a non-USD claim is
declared not comparable and forced to `flag_for_review`. **This overrides `reject` as well as
`approve`**, deliberately: a reject reached by comparing pesos to dollars is precisely the
recorded bug. Over-flagging costs a human glance; either wrong answer costs money.

---

## 7. Cost

`buildSystemPrompt` opened with the submission JSON and a timestamp — the two things that change
every request — so the identical instruction block after them could never be reused. Static now
leads: an 86.8% byte-identical shared prefix between two differing requests.

Precisely: that makes the prompt **cache-ready**, not cached. No cache breakpoint is set and
`cacheReadTokens` is `0` on every observed step, so no saving is claimed — the test asserts the
structural precondition instead, and the audit trail carries the cache columns so the
before/after is already in the data when a breakpoint lands.

The volatile block is compact rather than pretty-printed, saving 54–106 bytes per review. Small,
but *entirely* in the uncacheable half, so it is re-billed forever. (I first deprioritised this
as trivial. Wrong frame: trivial-and-permanent in the one block that can never be cached is
worth two lines.)

Also: unknown tenants and malformed bodies are rejected at ingress in ~40ms for zero tokens
rather than after a full review, and `validate_expense` was deleted — with the schema enforced
at ingress it could not return `valid:false` for anything reaching the model, while still
costing tokens in the tool definitions every request.

---

## 8. You could not tell what the agent had decided

Not a planted bug — a gap I hit evidencing the cost claims. `usage-log.ts` prints tokens per
step, but a step knows nothing about the company or the decision, so nothing could answer what
an expense system needs: who was told what, on which rule, at what cost.

`logs/decisions.jsonl` gets one append-only record per decision — company, decision, rule id,
model, token counts including cache. Written *after* the guardrail passes, because a rejected
decision is a failure rather than an outcome and logging it as one would corrupt the trail. It
never throws (a completed review should not 502 on a disk error) but failures go loudly to
stderr, and the call site says to invert that if this becomes compliance rather than operations.

## 9. Housekeeping

`scripts/check.sh` sweeps every fixture through a running server; it was the only working
feedback loop while the evals were dead. `bun run test` runs `tsc` plus every
`scripts/*.test.ts`, wired to CI on push. I checked the gate fails in both directions — a
deliberately broken suite exits 1 — because a green CI that cannot go red is not a gate.

A four-angle quality pass (reuse, simplification, efficiency, altitude) found one thing beyond
style: the ingress schema I had just added was validated and then **thrown away**, with
`buildRequestView` still doing `body as tExpenseSubmission` — the exact cast the schema existed
to remove, surviving the commit that added it. Parsing now produces the value that flows
downstream. The prompt builders also moved from repeated `x = x + "..."` to template literals,
verified byte-identical against a captured snapshot so the prompt text did not shift.

---

## What I deliberately did not do

**A retrieval ledger.** The strongest citation check is provenance, not similarity: have
`search_policy` record the ids it returned this turn and assert `cited_rule_id ∈ ledger`. Exact,
tenant-count-independent, and it catches what the current check cannot see — a model citing a
real own-company rule it never retrieved. Not built because the check runs after the turn, where
Eve's state handles are unreadable; it needs a hook or event-stream extraction. Needing to tune
`SHINGLE_WORDS` is the tell that today's check is a proxy.

**Dropping the text-similarity check.** Once tools read state, cross-tenant *retrieval* is
structurally impossible, so it is close to dead code. Kept as a backstop against a state-seeding
failure rather than deleting a tested security check mid-refactor. Worth revisiting.

**`POST /eve/v1/review` has no authentication** (`auth: null`). This honestly down-rates several
of my own tenant-security findings: an attacker need not trick the agent into leaking another
tenant's policy when they can request it directly. I read it as scaffolding the exercise omitted
rather than a planted bug, but it is why I rated the unknown-company fallback as fail-open
robustness rather than exploitable disclosure.

**A claim raised in review that is simply wrong.** An audit pass reported the eval judge id
`anthropic/claude-haiku-4-5` as 404ing because the catalog displays the dot form. I probed the
Gateway: both aliases return 200, and the judge subsequently scored a run at 100%. Recorded so
it does not resurface.

---

## Verification

Everything below was run, not assumed.

| check | result |
|---|---|
| `bunx tsc --noEmit` | clean |
| `bunx eve build` | ok |
| `bun run test` | **69 assertions**, 8 pure suites, exit 0 |
| `bunx eve eval` | **4 passed / 4**, gates 11/11, judge 100% |
| `./scripts/check.sh` | **7 fixtures**, all `ok:true` |

The split is deliberate. Pure suites cover everything checkable without a model and run in CI on
every push. The evals cover what only an end-to-end run can — that tools are registered, that
the prompt gets them called, and that `submissionState` is readable inside a tool at execution
time. They are **excluded from CI** on purpose: they need a gateway key, spend tokens per
commit, cannot read secrets on fork PRs, and one is LLM-judged, so red would not reliably mean
regression.

Two honesty notes. The illegible-receipt fixture has returned both `reject` and
`flag_for_review` across runs, citing the correct rule each time — genuine non-determinism on an
ambiguous case, and why the deterministic suite carries the weight it does. And several bugs
here were found by testing rather than reading, including two of mine: a regression in the
narrowing fix, and an intermittent 502 from requiring a field the server then overwrote.
