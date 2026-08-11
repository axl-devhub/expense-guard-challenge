// Turns a raw model result into a decision that is safe to hand back.
//
// This lives in lib/ rather than in the channel on purpose. "A decision must validate
// against the schema, must cite a rule belonging to this submission's company, and its
// cited_rule is authoritative text from the policy store" is a property of a REVIEW, not
// of an HTTP response. Keeping it in the channel meant `bunx eve eval` — which drives the
// agent through Eve's built-in session channel and never touches agent/channels/review.ts —
// could not exercise any of it. The channel is now reduced to mapping the outcome onto
// status codes, and evals call this directly.
import { checkCurrency } from "./currency.js";
import { ExpenseDecisionSchema, type tFinalizedDecision } from "./expense.schema.js";
import { formatRules } from "./policy-store.js";
import type { tExpenseSubmission } from "./request-context.js";
import { verifyCitation, type tCitationFailureCode } from "./verify-citation.js";

export type tFinalizeFailureCode = "schema_mismatch" | tCitationFailureCode;

export type tFinalizeResult =
  | { ok: true; decision: tFinalizedDecision }
  | {
      ok: false;
      code: tFinalizeFailureCode;
      // Safe to return to the caller — never names another tenant or quotes their rules.
      publicMessage: string;
      // Server-side logging only. May name other tenants.
      logDetail: string;
    };

export function finalizeDecision(
  submission: tExpenseSubmission,
  raw: unknown,
): tFinalizeResult {
  const companyId = submission.company_id;
  const parsed = ExpenseDecisionSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      code: "schema_mismatch",
      publicMessage: "Agent output did not match the decision schema.",
      logDetail: parsed.error.issues
        .map((issue) => {
          const path = issue.path.join(".");
          return path ? `${path}: ${issue.message}` : issue.message;
        })
        .join("; "),
    };
  }

  // The free-text half of the check runs over `reason`, which is where the model's own
  // prose now lives — it is the field that would carry a neighbour's rule text if the model
  // had reasoned from the wrong tenant's policy.
  const citation = verifyCitation(companyId, parsed.data.cited_rule_id, parsed.data.reason);
  if (!citation.ok) {
    return {
      ok: false,
      code: citation.code,
      publicMessage: citation.publicMessage,
      logDetail: citation.logDetail,
    };
  }

  // Return the rule verbatim from the policy store rather than the model's rendering of
  // it. The id was verified against this company's policy above, so an invented or
  // paraphrased rule text cannot reach the caller — the model's own wording stays in
  // `reason`, where it belongs.
  const decision: tFinalizedDecision = {
    ...parsed.data,
    cited_rule_id: citation.rule.id,
    cited_rule: formatRules([citation.rule]),
  };

  // Currency gate. Policy limits are USD; a claim in another currency cannot be measured
  // against them without an exchange rate this system does not have. Rather than let the
  // model apply an invented rate — observed live, it treated $50 as 50 MXN and rejected a
  // valid claim — force the review to a human.
  //
  // This overrides BOTH approve and reject, deliberately. A reject is normally the
  // conservative outcome, but a reject reached by comparing pesos to dollars is just as
  // wrong as an approve, and it silently refuses money someone is owed. The cost of
  // over-flagging is a human glance; the cost of either wrong answer is real.
  const currency = checkCurrency(submission);
  if (!currency.comparable && decision.decision !== "flag_for_review") {
    return {
      ok: true,
      decision: {
        ...decision,
        decision: "flag_for_review",
        reason:
          `${decision.reason}\n\n[Platform] Escalated from "${decision.decision}": ` +
          currency.summary,
      },
    };
  }

  return { ok: true, decision };
}
