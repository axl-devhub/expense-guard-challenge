// The agent must actually call verify_totals, and act on what it returns.
//
// The reconciliation logic itself is covered deterministically in scripts/totals.test.ts.
// What only an eval can establish is the end-to-end wiring: that the tool is registered,
// that the prompt gets the model to call it, and that submissionState is genuinely
// readable from inside a tool at execution time. That last one is the interesting part —
// verify_totals takes no arguments, so if the state seeding were broken the tool would
// return "unavailable" and this eval would catch it.
import { defineEval } from "eve/evals";
import { matches } from "eve/evals/expect";
import { z } from "zod";
import { ExpenseDecisionSchema } from "../agent/lib/expense.schema.js";
import { reconcileTotals } from "../agent/lib/totals.js";
import { loadExpenseFixture } from "../agent/lib/request-context.js";

export default defineEval({
  description: "The agent calls verify_totals and its decision is consistent with the result.",
  tags: ["expense-guard", "totals"],
  async test(t) {
    const submission = loadExpenseFixture();
    const expected = reconcileTotals(submission);

    const turn = await t.send({
      message: "Review the expense submission and return your decision.",
      outputSchema: ExpenseDecisionSchema,
    });

    t.didNotFail();

    // The tool must be called, and it must have resolved the submission from state rather
    // than reporting it unavailable.
    t.calledTool("verify_totals").gate();
    t.calledTool("verify_totals", {
      output: (value: unknown) =>
        typeof value === "object" &&
        value !== null &&
        (value as { status?: string }).status === expected.status,
    }).gate();

    // The default fixture reconciles (72 + 12 + 12 = 96), so a decision that rejects or
    // flags on totals grounds would mean the agent misread a correct receipt.
    const ConsistentWithTotals = z.unknown().superRefine((raw, ctx) => {
      const parsed = ExpenseDecisionSchema.safeParse(raw);
      if (!parsed.success) {
        ctx.addIssue({ code: "custom", message: "decision did not match the schema" });
        return;
      }
      if (expected.status !== "reconciled") return; // fixture changed; the tool-call gates still apply
      if (/mismatch|do(es)? not add up|discrepan/i.test(parsed.data.reason)) {
        ctx.addIssue({
          code: "custom",
          message: `totals reconcile (${expected.summary}) but the reason claims otherwise: ${parsed.data.reason}`,
        });
      }
    });

    t.check(turn.data, matches(ConsistentWithTotals)).gate();
  },
});
