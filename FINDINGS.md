# Findings

Running document. Updated as fixes land, not written at the end.

Environment note: the shipped model pin `anthropic/claude-opus-4-1-20250805` returns 404
from the Vercel AI Gateway (`GatewayModelNotFoundError`) — the dated id is not in the
catalog, so no turn could complete at all. Repointed to `anthropic/claude-haiku-4.5`
before any other work. All behavioural observations below were made against Haiku 4.5.

---

## 1. Cross-tenant policy leak via an unkeyed module-level cache — FIXED

**File:** `agent/lib/policy-store.ts`

**What it was.** `getCompanyPolicy()` memoized into a module-level `activePolicy` with no
key:

```ts
let activePolicy: tCompanyPolicy | null = null;
export function getCompanyPolicy(companyId: string): tCompanyPolicy {
  if (activePolicy) return activePolicy;      // companyId ignored after the first call
  ...
}
```

The comment claimed the memo was scoped "within a review", but a module-level binding in a
long-lived server process lives for the *process*. The first company looked up won for
every subsequent lookup, whoever asked.

**How I confirmed it.** Drove all five fixtures through a running dev server, then
restarted the process and ran two of them in the opposite order. The leak reversed with
the ordering, which rules out model error:

| Run | Position | Fixture (company) | Rule cited | Correct? |
|-----|----------|-------------------|------------|----------|
| A | 1st | ambiguous (acme) | acme SW-01, $200/month | yes |
| A | 2nd | cross-company (**initech**) | **acme** MEAL-01, "$50 per attendee" | no — approved |
| A | 3rd | illegible (**globex**) | **acme** TRVL-01, "$1,500 director approval" | no |
| B | 1st | cross-company (initech) | initech MEAL-01, $25/attendee | yes |
| B | 2nd | request (**acme**) | **initech** MEAL-01, "$25 per attendee" | no — flagged |

Both error directions are real money: in run A, Initech's $40 meal was approved against
Acme's more generous $50 cap; in run B, Acme's in-policy $96 meal for two was flagged
against Initech's $25 cap. The cited rule id looks plausible every time because all three
companies happen to name their meal rule `MEAL-01` — asserting on the id alone would not
have caught this.

**What I changed.** Removed the cache outright. `POLICIES` is an in-memory object literal,
so the lookup is already O(1) and the memo bought nothing measurable while costing tenant
isolation. Left a comment stating that any future cache must be keyed by `companyId` and
scoped to the request.

**The eval that would have caught it.** `scripts/policy-isolation.test.ts`
(`bun run scripts/policy-isolation.test.ts`). Six assertions; all six fail against the old
code and pass against the new.

The important design point: **this bug is invisible to a one-request eval.** The first
lookup in any process is always correct — only the second onward is poisoned. Both shipped
evals boot a fresh agent, send one submission, and assert on the result, so they would pass
against broken code no matter how carefully they asserted. The regression test deliberately
makes multiple lookups per process, and asserts on rule *text* rather than rule *id*.

It is a plain script rather than an `evals/*.eval.ts` for two reasons: the store is pure and
synchronous so it needs no model tokens, and the eve eval harness cannot currently run at
all (finding 3).

---

## 2. Unknown `company_id` silently resolved to Acme — FIXED

**File:** `agent/lib/policy-store.ts` (same function, separate defect)

`POLICIES[companyId] ?? POLICIES.acme` handed Acme's policy to any unrecognised company. A
typo in `company_id` produced a confident decision under the wrong tenant's rules instead of
an error. Same isolation breach as finding 1, reached by a different path.

Now throws, naming the offending id. There is no default tenant. Covered by the last two
assertions in `scripts/policy-isolation.test.ts`.

*Fixed as a separate commit from finding 1 — they are independent defects that happen to
share a function.*

---

## 3. The custom channel shadows Eve's built-in one, so no eval can run — OPEN

**File:** `agent/channels/eve.ts`

The file is named `eve`, the same name as Eve's built-in channel, so it replaces it. The
built-in channel owns `/eve/v1/session`, `/eve/v1/session/:id`, and the stream route. The
compiled manifest shows exactly one channel surviving:

```json
"channels": [{"name":"eve","logicalPath":"channels/eve.ts",
              "method":"POST","urlPath":"/eve/v1/review"}]
```

`bunx eve eval` drives the agent by POSTing to `/eve/v1/session`, which no longer exists.
Both shipped evals fail in 87ms with `404 Cannot find any route matching [POST]
/eve/v1/session` — before a single assertion runs. Confirmed independently by probing the
live server: `POST /eve/v1/session` → 404, `POST /eve/v1/review` → 200.

This blocks every other eval, so it should be fixed before writing more of them.

---

## 4. Prompt is assembled volatile-first, so nothing is cacheable — OPEN

**File:** `agent/lib/build-instructions.ts`

`buildSystemPrompt` prepends the per-request submission JSON and an ISO timestamp to the
static header, steps, and rubric. Prompt caching keys on a shared prefix, and this prompt
begins with the one thing that differs on every request, so the ~700 tokens of identical
rubric that follow can never be reused.

Measured via `agent/hooks/usage-log.ts` across a five-fixture run: **all ten steps reported
`cacheReadTokens: 0, cacheWriteTokens: 0`**, at roughly 4,100 input tokens per review
(two model steps: ~1,900 then ~2,200).

Inverting the order — static rubric first, volatile block last — is the standard fix and
changes no behaviour. Any claimed improvement should be re-measured against the same hook.

---

## 5. `cited_rule` can be fabricated — GUARDRAILED (partially closed)

**File:** `agent/lib/expense.schema.ts` / `agent/tools/search_policy.ts`

Surfaced by the fix to finding 1: with the correct tenant's policy now being retrieved,
`illegible.json` (globex, travel) returned

> `TRVL-01: Travel expenses require proper documentation and verification`

Globex's actual TRVL-01 reads *"Any travel expense over $2,000 requires finance approval."*
The cited text appears in **no** company's policy — grepped `agent/lib/policies.ts` to
confirm. The rule *id* is real; the rule *text* is invented.

`cited_rule` is a free-form `z.string().min(1)` that the model writes, and nothing checks it
against the rules `search_policy` actually returned. The existing `policy-citation` eval
asks a judge whether the citation looks "specific and concrete rather than vague or
invented" — a fabricated-but-plausible rule passes that bar comfortably, which is why the
eval would not catch this.

Worth noting this was masked by finding 1: while every review was being answered from one
cached policy, a wrong-looking citation was indistinguishable from the leak.

**What I added.** A fail-closed guardrail: `agent/lib/verify-citation.ts`, called from
`agent/channels/eve.ts` immediately after `ExpenseDecisionSchema.safeParse` succeeds. It
resolves the company from the *request* (via `resolveExpenseSubmission`, the same resolver
the prompt was built from — never a model-supplied value) and checks the citation against
that company's own policy. On failure the route returns `{ok: false}` / 502 and logs.

Three checks, in order:

1. **No rule id** → reject. The prompt instructs the model to include the id; a citation
   without one cannot be verified against anything.
2. **Id not in this company's policy** → reject. Covers both a rule belonging to another
   tenant and a fabricated id that exists nowhere.
3. **Verbatim foreign rule text under a locally-valid id** → reject. Necessary because rule
   ids collide — every company here defines a `MEAL-01` — so an id check alone would have
   passed the recorded leak. Uses a 6-word verbatim run, and only fires when that wording
   does not also appear in this company's own policy.

**The guardrail must not become the leak.** The HTTP response never names another tenant or
quotes their rule text; "belongs to another company" and "exists nowhere" return the same
public message, since distinguishing them would confirm another company's rule inventory to
an unauthenticated caller. Full detail goes to the server log only. Asserted in the tests.

**Proof.** `scripts/verify-citation.test.ts` — 13 assertions. The negative cases are the
*verbatim recorded leaks* from run A (acme's MEAL-01 text served into an initech review;
acme's TRVL-01 into globex). The positive cases are the *actual* decisions
`./scripts/check.sh` produces, so a false positive fails the suite.

One positive case is worth keeping: for `cross-company.json` the model wrote
`"...up to $25 per attendee (limit: $50 for 2 attendees)"` — correctly deriving 2 × $25 and
landing on $50, a figure that appears nowhere in initech's policy and happens to equal
Acme's cap. Any guardrail keying on dollar amounts would reject that valid decision. This
is why the check keys on rule ids and verbatim text instead.

Verified live: all five fixtures still return `ok: true`, and a POST with
`company_id: "wayne-enterprises"` — which before finding 2's fix would have been silently
adjudicated against Acme's rules — now returns
`{"ok":false,"error":"Decision rejected: The submission's company has no configured expense policy."}`
with the full reason in the server log.

**Residual gap, stated plainly.** This catches cross-tenant citations and fabricated *ids*.
It does not catch a plausible *paraphrase* invented for a rule id that genuinely belongs to
the company — exactly the `illegible.json` case that surfaced this finding. Closing that
needs the decision to reference the retrieved rule by identity rather than by re-typed
prose (e.g. having `search_policy` return rule ids the channel can match against, or
narrowing `cited_rule` to an enum of ids plus a separate free-text field).

**Cost note.** The guardrail runs *after* the model turn, so an unknown `company_id` still
pays for a full review before being rejected. Validating `company_id` at ingress in the
channel, before `send()`, would reject it for zero tokens. Worth doing; not done here
because it is a separate change from the guardrail that was asked for.

---

## 6. Topic narrowing silently withholds a tenant's global rules — OPEN, from the audit

**File:** `agent/lib/policy-store.ts` — `selectRules()`

`selectRules` returns only rules whose `category` or `text` substring-matches the model's
`topic`, and falls back to the full ruleset **only on zero hits**. So a topic matching *at
least one* rule suppresses every rule that doesn't mention it, and the caller gets no signal
that anything was withheld.

Initech is the exposed tenant: `GEN-01` ("Any expense over $100 requires manager review")
and `CASH-01` ("Cash-only receipts … are not reimbursable (reject)") both sit under category
`general` and name no category, so no category-shaped topic reaches them. Verified by
executing the pure function:

```
topic="office"       -> 1 rule   [OFF-01] only
topic="meals"        -> 1 rule   [MEAL-01] only
topic="office chair" -> 4 rules  GEN-01, MEAL-01, OFF-01, CASH-01
topic=undefined      -> 4 rules  all
```

The pathology in one line: **a precise topic returns less than a nonsense one.** Narrowing
is monotonically lossy with no floor, and initech's only hard-reject rule and only blanket
approval gate are unreachable by every sensible topic.

Scope, honestly: no shipped fixture flips on this. `cross-company.json` is initech/meals/$40
paid by Mastercard — under GEN-01's $100 gate and card-paid, so suppressing GEN-01/CASH-01
does not move that decision. Demonstrating a flipped verdict needs a fixture that does not
exist yet (initech, office, ~$180, cash receipt → should `reject` on CASH-01, currently
would `approve` on OFF-01). The retrieval hole is proven; the decision flip is not yet.
Also model-mediated: `buildSystemPrompt` step 1 never tells the model to pass `topic` — only
the tool description invites it.

Root cause is a missing concept rather than a bad fallback: the store has no notion of an
always-applicable rule. The fix is to always union global/`general` rules into any narrowed
result.

---

## Not a finding — checked and dismissed

- **Eval judge model id.** An audit pass claimed `anthropic/claude-haiku-4-5` in
  `evals/evals.config.ts` 404s because the Gateway catalog lists the dot form
  (`claude-haiku-4.5`). **False.** Probed the live Gateway twice: both the dash and dot
  forms return HTTP 200. The alias resolves. Only the dated `opus-4-1-20250805` id was bad.
- **`validate_expense` as a correctness bug.** It does what its description claims — a
  presence check — so it is not a correctness defect. It is dead weight (below), not a
  wrong-answer source.
- **The fixture fallback as a tenant-security breach.** A bare `{}` body does review
  `fixtures/request.json` and return 200, but there is no tenant boundary for it to cross:
  the route passes `{ auth: null }` and has no authentication at all, so any caller can
  legitimately request any company. It is a dev convenience on a production route, which is
  a design smell, not a disclosure primitive.
- **Receipt size as a cost risk.** Claimed that pretty-printing the submission inflates
  large receipts ~22%. Measured: for a large receipt the overhead is +106 chars (+0.13%),
  because `JSON.stringify` indents structure, not the interior of a single string. The 22%
  figure only holds where the absolute cost is ~30 tokens.
- **`validate_expense` forcing an extra model round-trip.** The prompt says "You may call
  validate_expense" — permissive, and nothing in the harness forces a tool call.

**Standing caveat:** `POST /eve/v1/review` has no authentication whatsoever
(`{ auth: null }`, `agent/channels/eve.ts:68`). Several tenant-security findings are milder
than they first appear for that reason — an attacker need not trick the agent into leaking
another tenant's policy when they can simply ask for it directly. I read this as out of
scope for the skeleton rather than a planted bug, but it is the reason I down-rated two
findings, so it is recorded here.

---

## Noted, deliberately not fixed yet

- **`validate_expense` validates almost nothing** (`agent/tools/validate_expense.ts`). It
  confirms three fields are present and returns. It never reconciles `line_items` against
  `claimed_amount`, despite the prompt instructing the model to "double-check that the
  receipt totals add up". Also carries dead scaffolding: an unused `data` object, a `tmp`
  string built and discarded, and `_label` / `_status` computed then dropped by the caller.
- **Both tools read `company_id` from model-supplied arguments** while the authoritative
  value sits unread in `submissionState` — whose docstring says it exists precisely "so
  tools can read the real fields instead of relying on model-provided arguments". The
  guardrail was designed and never wired up. This is the next tenant-security fix; it is
  separate from finding 1 and survives it.
- **`selectRules` returns all rules when a topic matches nothing**
  (`agent/lib/policy-store.ts`). Defensible as a recall choice, but undocumented, and it
  means a "narrowed" search may not be narrowed — a cost as well as a clarity issue.
- **`fixtures/valid.json` and `fixtures/request.json` are byte-identical**, and
  `ambiguous` / `illegible` / `cross-company` are exercised by nothing in the eval suite.
