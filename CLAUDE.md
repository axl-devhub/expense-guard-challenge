# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

Expense Guard — LeadSales' AI-engineer take-home challenge. A small agent built on **Eve** (Vercel's agent framework, v0.11.7) that reviews expense submissions for a multi-tenant platform: each review gets a `company_id`, raw OCR receipt text, a claimed amount, and a category; the agent looks up that company's policy and returns a structured decision (`approve` / `flag_for_review` / `reject`).

**The repo contains deliberately planted bugs** across four axes: correctness, security (tenant isolation), cost, and maintainability. The task is to find them, fix them production-quality, and prove each fix with an eval. Depth beats breadth; an eval that would have caught the bug is worth more than the fix alone. Deliverables: a PR/diff, `FINDINGS.md` (reasoning, including what was deliberately *not* fixed), and the coding-session export.

## Commands

Requires **bun** (`~/.bun/bin`) and **Node ≥24** (`fnm use 24`; default is set to 24).

```bash
bun install
cp .env.example .env       # fill AI_GATEWAY_API_KEY (Vercel AI Gateway key, anthropic/* models)

bunx eve build             # build the agent
bunx eve dev               # run locally — POST /eve/v1/review
bunx eve eval              # run evals/*.eval.ts
```

Drive a specific fixture: `POC_REQUEST_FILE=fixtures/cross-company.json bunx eve dev|eval`, or POST a JSON body to `/eve/v1/review` while `eve dev` runs. macOS: the sandbox is pinned to `justbash` in `agent/sandbox.ts` — don't touch (Eve's default backend probe hangs on macOS).

## Architecture

Request flow: `POST /eve/v1/review` → `agent/channels/eve.ts` parses the body into a request view (`agent/lib/request-context.ts`) and seeds it as channel state → Eve opens a turn → the instructions resolver (`agent/instructions/system.ts`) resolves the submission from channel metadata, seeds `submissionState`, and renders the system prompt (`agent/lib/build-instructions.ts`) → the model calls tools → structured output validated against `ExpenseDecisionSchema` (`agent/lib/expense.schema.ts`) → channel returns `{ok, data}`.

- **`agent/agent.ts`** — model pin + `outputSchema`. Eve binds the model statically at build time; no runtime override.
- **Tools** — only two real ones: `search_policy` (policy lookup via `agent/lib/policy-store.ts` over the in-memory `agent/lib/policies.ts` — acme, globex, initech) and `validate_expense` (field sanity check). Every other file in `agent/tools/` is `disableTool()` — deliberately disabling Eve's default toolset (bash, web, filesystem). That's a correct pattern, not a bug.
- **`submissionState`** (`request-context.ts`) — the authoritative submission for the turn, seeded at turn start *"so tools can read the real fields instead of relying on model-provided arguments"*. Note which tools actually honor that.
- **Evals** — `evals/*.eval.ts` (deterministic assertions + a Haiku judge, config in `evals/evals.config.ts`). Both shipped evals are happy-path on the default fixture; `fixtures/ambiguous|illegible|cross-company.json` exist but are exercised by nothing.
- Bare body → fixture fallback (`fixtures/request.json`) is a documented dev/eval convenience; `contextProvided` distinguishes "no body" from "body lost in projection" (the latter throws rather than silently reviewing the wrong company's submission).

## Working rules for this repo

- **Ground rule from the brief:** multi-tenant isolation is sacred — one company's review must never see or leak another company's policy/data. Treat model-supplied tool arguments as untrusted; prefer `submissionState`.
- Treat cost as a design constraint: model choice, prompt/cache structure. `agent/hooks/usage-log.ts` logs per-step token + cache usage — use it as the feedback loop for any cost claim.
- Every fix ships with the eval that would have caught it. One commit per finding, message explains the *why*.
- Don't fabricate results — evals and findings must reflect what actually ran.
- `FINDINGS.md` is a running document, updated as fixes land, not written at the end.
