// Reference eval (behavioral, judge). The decision cites a concrete company policy rule
// rather than a vague or invented justification. Runs on the default fixture.
//
// The judge now scores the FINALIZED decision — what a caller actually receives — rather
// than raw model output. The model no longer emits the rule's text at all: it names the rule
// by id and the server fills the text in verbatim from the policy store, so judging the raw
// output would score a field that does not exist on it.
import { defineEval } from "eve/evals";
import { ExpenseDecisionSchema } from "../agent/lib/expense.schema.js";
import { finalizeDecision } from "../agent/lib/finalize-decision.js";
import { loadExpenseFixture } from "../agent/lib/request-context.js";

export default defineEval({
  description: "The decision cites a concrete, real company policy rule.",
  tags: ["expense-guard", "happy-path"],
  async test(t) {
    const submission = loadExpenseFixture();

    const turn = await t.send({
      message: "Review the expense submission and return your decision.",
      outputSchema: ExpenseDecisionSchema,
    });

    t.didNotFail();

    const finalized = finalizeDecision(submission.company_id, turn.data);
    const rendered = finalized.ok
      ? `Decision: ${finalized.decision.decision}\n` +
        `Reason: ${finalized.decision.reason}\n` +
        `Cited rule: ${finalized.decision.cited_rule}`
      : `Decision rejected by the citation guardrail (${finalized.code}): ${finalized.logDetail}`;

    await t.judge.autoevals
      .closedQA(
        `This is an automated expense-review decision for company "${submission.company_id}". ` +
          'Does the "Cited rule" field reference a specific, concrete company expense policy rule ' +
          "(a rule id or a clearly-stated policy limit) rather than a vague, generic, or invented " +
          "justification? Be tolerant of formatting.",
        { on: rendered },
      )
      .soft(0.6);
  },
});
