// Turns a raw model result into a decision that is safe to hand back.
//
// This lives in lib/ rather than in the channel on purpose. "A decision must validate
// against the schema, must cite a rule belonging to this submission's company, and its
// cited_rule is authoritative text from the policy store" is a property of a REVIEW, not
// of an HTTP response. Keeping it in the channel meant `bunx eve eval` — which drives the
// agent through Eve's built-in session channel and never touches agent/channels/review.ts —
// could not exercise any of it. The channel is now reduced to mapping the outcome onto
// status codes, and evals call this directly.
import { ExpenseDecisionSchema, type tExpenseDecision } from "./expense.schema.js";
import { formatRules } from "./policy-store.js";
import { verifyCitation, type tCitationFailureCode } from "./verify-citation.js";

export type tFinalizeFailureCode = "schema_mismatch" | tCitationFailureCode;

export type tFinalizeResult =
  | { ok: true; decision: tExpenseDecision }
  | {
      ok: false;
      code: tFinalizeFailureCode;
      // Safe to return to the caller — never names another tenant or quotes their rules.
      publicMessage: string;
      // Server-side logging only. May name other tenants.
      logDetail: string;
    };

export function finalizeDecision(companyId: string, raw: unknown): tFinalizeResult {
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

  const citation = verifyCitation(companyId, parsed.data.cited_rule_id, parsed.data.cited_rule);
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
  return {
    ok: true,
    decision: {
      ...parsed.data,
      cited_rule_id: citation.rule.id,
      cited_rule: formatRules([citation.rule]),
    },
  };
}
