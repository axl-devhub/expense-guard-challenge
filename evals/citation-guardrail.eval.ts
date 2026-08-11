// Integration eval for the citation guardrail.
//
// Why this exists: the guardrail used to live inside agent/channels/review.ts, and
// `bunx eve eval` drives the agent through Eve's BUILT-IN session channel — it never
// reaches that file. So every guardrail rule was unit-tested against hand-written strings
// and never once applied to a decision a real model produced. This eval runs a real turn
// and then puts the result through finalizeDecision, exactly as the HTTP channel does.
import { defineEval } from "eve/evals";
import { matches } from "eve/evals/expect";
import { z } from "zod";
import { ExpenseDecisionSchema } from "../agent/lib/expense.schema.js";
import { finalizeDecision } from "../agent/lib/finalize-decision.js";
import { getCompanyPolicy } from "../agent/lib/policy-store.js";
import { loadExpenseFixture } from "../agent/lib/request-context.js";

export default defineEval({
  description:
    "A real model decision survives the same finalization the HTTP channel applies, and " +
    "its cited_rule is verbatim text from the submitting company's own policy.",
  tags: ["expense-guard", "guardrail", "tenant-isolation"],
  async test(t) {
    const submission = loadExpenseFixture();

    const turn = await t.send({
      message: "Review the expense submission and return your decision.",
      outputSchema: ExpenseDecisionSchema,
    });

    t.didNotFail();
    t.calledTool("search_policy").gate();

    const SurvivesFinalization = z.unknown().superRefine((raw, ctx) => {
      const result = finalizeDecision(submission.company_id, raw);
      if (!result.ok) {
        ctx.addIssue({
          code: "custom",
          message: `finalizeDecision rejected the decision — ${result.code}: ${result.logDetail}`,
        });
        return;
      }

      // The returned cited_rule must be a rule from THIS company, verbatim. Asserting on
      // the text and not just the id matters: rule ids collide across tenants (all three
      // companies define a MEAL-01), so an id-only assertion would pass on leaked data.
      const policy = getCompanyPolicy(submission.company_id);
      const cited = result.decision.cited_rule;
      if (!policy.rules.some((rule) => cited.includes(rule.text))) {
        ctx.addIssue({
          code: "custom",
          message:
            `cited_rule is not verbatim text from ${submission.company_id}'s policy: ${cited}`,
        });
      }
      if (!policy.rules.some((rule) => rule.id === result.decision.cited_rule_id)) {
        ctx.addIssue({
          code: "custom",
          message: `cited_rule_id "${result.decision.cited_rule_id}" is not one of this company's rules`,
        });
      }
    });

    t.check(turn.data, matches(SurvivesFinalization)).gate();
  },
});
