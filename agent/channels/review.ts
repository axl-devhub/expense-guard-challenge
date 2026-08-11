// HTTP channel: POST /eve/v1/review runs one structured review turn and returns the
// decision. Per-request context flows body -> channel state -> metadata(state) ->
// instructions resolver (ctx.channel.metadata). A bare body falls back to the fixture.
import { z } from "zod";
import { defineChannel, POST, type Session, type SendPayload } from "eve/channels";
import { ExpenseDecisionSchema } from "../lib/expense.schema.js";
import {
  buildRequestView,
  resolveExpenseSubmission,
  validateRequestBody,
  type tRequestView,
} from "../lib/request-context.js";
import { hasCompanyPolicy } from "../lib/policy-store.js";
import { verifyCitation } from "../lib/verify-citation.js";

type tJsonOutputSchema = NonNullable<SendPayload["outputSchema"]>;

// eve expects a run-scoped JSON schema (not a Zod object) on the send payload.
function toJsonSchema(schema: z.ZodType): tJsonOutputSchema {
  const { $schema, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  void $schema;
  return rest as tJsonOutputSchema;
}

type tStreamEvent = {
  type: string;
  data?: { result?: unknown; message?: string; code?: string };
};

// Drain the turn's event stream once, capturing the structured result / terminal failure.
async function drainDecision(session: Session): Promise<{ result: unknown; failure: string | null }> {
  const stream = await session.getEventStream();
  const reader = stream.getReader();
  let result: unknown;
  let failure: string | null = null;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const event = value as tStreamEvent;
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
  return { result, failure };
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
      const shape = validateRequestBody(body);
      if (!shape.ok) {
        return Response.json(
          { ok: false, error: "Invalid expense submission.", problems: shape.problems },
          { status: 400 },
        );
      }

      const view = buildRequestView(body);

      if (view.request && !hasCompanyPolicy(view.request.company_id)) {
        // A caller error, not an agent failure — 400, and cheap. Before this check an
        // unknown company_id was silently adjudicated against Acme's rules; after the
        // policy-store fix it failed, but only after paying for a whole review.
        console.warn("[expense-guard] rejected unknown company_id at ingress", {
          company_id: view.request.company_id,
        });
        return Response.json(
          {
            ok: false,
            error: `No expense policy is configured for company_id "${view.request.company_id}".`,
          },
          { status: 400 },
        );
      }
      const session = await send(
        { message: "Review the expense submission and return your decision.", outputSchema },
        { auth: null, continuationToken: `eve:${crypto.randomUUID()}`, state: view },
      );

      const { result, failure } = await drainDecision(session);
      if (failure) {
        return Response.json({ ok: false, error: `turn failed: ${failure}` }, { status: 502 });
      }

      const parsed = ExpenseDecisionSchema.safeParse(result);
      if (!parsed.success) {
        return Response.json(
          { ok: false, error: "Agent output did not match the decision schema." },
          { status: 502 },
        );
      }

      // Fail-closed citation guardrail. The model writes `cited_rule` as free text and
      // nothing upstream ties it to the rules search_policy actually returned, so verify
      // server-side that the cited rule belongs to this submission's company. The company
      // is taken from the request (via the same resolver the prompt was built from), never
      // from anything the model produced.
      let companyId: string;
      try {
        companyId = resolveExpenseSubmission(view).company_id;
      } catch (error) {
        console.error("[expense-guard] could not resolve the submission for the citation check", {
          error: error instanceof Error ? error.message : String(error),
        });
        return Response.json(
          { ok: false, error: "Could not resolve the submission under review." },
          { status: 502 },
        );
      }

      const citation = verifyCitation(companyId, parsed.data.cited_rule);
      if (!citation.ok) {
        console.error("[expense-guard] REJECTED decision — citation check failed", {
          company_id: companyId,
          code: citation.code,
          detail: citation.logDetail,
          decision: parsed.data.decision,
          cited_rule: parsed.data.cited_rule,
        });
        return Response.json(
          { ok: false, error: `Decision rejected: ${citation.publicMessage}` },
          { status: 502 },
        );
      }

      return Response.json({ ok: true, data: parsed.data }, { status: 200 });
    }),
  ],
});
