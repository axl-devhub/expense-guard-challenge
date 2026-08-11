// The structured decision Expense Guard emits (agent-level outputSchema, also attached
// per message by the channel and evals).
import { z } from "zod";

export const DECISIONS = ["approve", "flag_for_review", "reject"] as const;

export const ExpenseDecisionSchema = z.object({
  decision: z.enum(DECISIONS).describe("The review outcome."),
  reason: z
    .string()
    .min(1)
    .describe(
      "Short explanation for the decision. Put your own working here — quoted receipt " +
        "details, and any limit you derived (for example a per-attendee cap multiplied by " +
        "the number of attendees).",
    ),
  cited_rule_id: z
    .string()
    .min(1)
    .describe(
      'The id of the policy rule the decision relies on, exactly as search_policy returned ' +
        'it (for example "MEAL-01"). It must be a rule id from THIS submission\'s company ' +
        "policy. Do not invent an id, and do not use one you remember from another company.",
    ),
  cited_rule: z
    .string()
    .min(1)
    .describe(
      "The text of that rule. Server-side this is replaced with the verbatim rule text from " +
        "the company's policy, so quote it as closely as you can rather than paraphrasing.",
    ),
  category: z.string().describe("The expense category as understood."),
  claimed_amount: z.number().describe("The total amount claimed, in the receipt currency."),
});

export type tExpenseDecision = z.infer<typeof ExpenseDecisionSchema>;
