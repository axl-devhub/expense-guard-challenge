// HTTP channel: POST /eve/v1/review runs one structured review turn and returns the
// decision. Per-request context flows body -> channel state -> metadata(state) ->
// instructions resolver (ctx.channel.metadata). A bare body falls back to the fixture.
import { z } from "zod";
import { defineChannel, POST, type Session, type SendPayload } from "eve/channels";
import { ExpenseDecisionSchema } from "../lib/expense.schema.js";
import {
  loadExpenseFixture,
  parseRequestBody,
  type tRequestView,
} from "../lib/request-context.js";
import { hasCompanyPolicy } from "../lib/policy-store.js";
import { finalizeDecision } from "../lib/finalize-decision.js";
import { appendDecisionRecord } from "../lib/decision-log.js";
import { AGENT_MODEL } from "../lib/model.js";

type tJsonOutputSchema = NonNullable<SendPayload["outputSchema"]>;

// eve expects a run-scoped JSON schema (not a Zod object) on the send payload.
function toJsonSchema(schema: z.ZodType): tJsonOutputSchema {
  const { $schema, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  void $schema;
  return rest as tJsonOutputSchema;
}

type tStreamEvent = {
  type: string;
  data?: {
    result?: unknown;
    message?: string;
    code?: string;
    usage?: {
      readonly inputTokens?: number;
      readonly outputTokens?: number;
      readonly cacheReadTokens?: number;
      readonly cacheWriteTokens?: number;
    };
  };
};

type tDrainedTurn = {
  result: unknown;
  failure: string | null;
  inputTokens: number;
  outputTokens: number;
};

// Drain the turn's event stream once, capturing the structured result / terminal failure,
// and summing per-step token usage along the way. A review is several model steps, so the
// cost of a decision is the sum over `step.completed` — the same fields
// agent/hooks/usage-log.ts prints per step, totalled here because the audit record needs
// one number per decision rather than one per step.
async function drainDecision(session: Session): Promise<tDrainedTurn> {
  const stream = await session.getEventStream();
  const reader = stream.getReader();
  let result: unknown;
  let failure: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const event = value as tStreamEvent;
      if (event.type === "step.completed") {
        inputTokens = inputTokens + (event.data?.usage?.inputTokens ?? 0);
        outputTokens = outputTokens + (event.data?.usage?.outputTokens ?? 0);
      }
      if (event.type === "result.completed") result = event.data?.result;
      if (event.type === "turn.completed") break;
      if (event.type === "turn.failed") {
        failure = `${event.data?.code ?? "unknown"} ${event.data?.message ?? ""}`.trim();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { result, failure, inputTokens, outputTokens };
}

const outputSchema = toJsonSchema(ExpenseDecisionSchema);

export default defineChannel<tRequestView | undefined, { state: tRequestView | undefined }>({
  state: { request: null, contextProvided: false },
  context: (state) => ({ state }),
  metadata: (state) => ({
    request: state?.request ?? null,
    contextProvided: state?.contextProvided ?? false,
  }),
  routes: [
    POST("/eve/v1/review", async (request, { send }) => {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
      }

      // Ingress guardrail — runs before the turn is opened, so a malformed submission or
      // an unknown tenant costs zero model tokens. A bare body is not rejected here: that
      // is the documented dev/eval path to the fixture.
      const parsedBody = parseRequestBody(body);
      if (!parsedBody.ok) {
        return Response.json(
          { ok: false, error: "Invalid expense submission.", problems: parsedBody.problems },
          { status: 400 },
        );
      }

      const view = parsedBody.view;

      // Resolve the tenant ONCE, here, and use that single value for both the ingress gate
      // and the post-turn citation check. Deriving it twice made the isolation invariant
      // "the two derivations agree" rather than "there is one".
      const submission = view.request ?? loadExpenseFixture();

      if (!hasCompanyPolicy(submission.company_id)) {
        // A caller error, not an agent failure — 400, and cheap. Before this check an
        // unknown company_id was silently adjudicated against Acme's rules; after the
        // policy-store fix it failed, but only after paying for a whole review.
        console.warn("[expense-guard] rejected unknown company_id at ingress", {
          company_id: submission.company_id,
        });
        return Response.json(
          {
            ok: false,
            error: `No expense policy is configured for company_id "${submission.company_id}".`,
          },
          { status: 400 },
        );
      }
      const session = await send(
        { message: "Review the expense submission and return your decision.", outputSchema },
        { auth: null, continuationToken: `eve:${crypto.randomUUID()}`, state: view },
      );

      const { result, failure, inputTokens, outputTokens } = await drainDecision(session);
      if (failure) {
        return Response.json({ ok: false, error: `turn failed: ${failure}` }, { status: 502 });
      }

      // Schema validation, the fail-closed citation guardrail, and canonicalisation of
      // cited_rule all live in lib/finalize-decision.ts so `bunx eve eval` can exercise
      // them too — the eval harness drives the agent through Eve's built-in session
      // channel and never reaches this file. The company comes from the submission
      // resolved at ingress, never from anything the model produced.
      const finalized = finalizeDecision(submission.company_id, result);
      if (!finalized.ok) {
        console.error("[expense-guard] REJECTED decision", {
          company_id: submission.company_id,
          code: finalized.code,
          detail: finalized.logDetail,
        });
        return Response.json(
          { ok: false, error: `Decision rejected: ${finalized.publicMessage}` },
          { status: 502 },
        );
      }

      // Audit trail — only for decisions that passed the guardrail. A rejected decision is
      // a failure, not an outcome, and recording it as one would corrupt the trail.
      await appendDecisionRecord({
        ts: new Date().toISOString(),
        company_id: submission.company_id,
        decision: finalized.decision.decision,
        cited_rule_id: finalized.decision.cited_rule_id,
        model: AGENT_MODEL,
        inputTokens,
        outputTokens,
      });

      return Response.json({ ok: true, data: finalized.decision }, { status: 200 });
    }),
  ],
});
