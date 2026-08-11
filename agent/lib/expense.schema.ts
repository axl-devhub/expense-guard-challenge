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
  // NOTE: the model is deliberately NOT asked for the rule's text. It names the rule by id
  // and the server fills the text in from the policy store — see FinalizedDecisionSchema.
  // Asking for both meant requiring a field whose value is then discarded, and 502-ing the
  // whole review when the model omitted it, which it did intermittently.
  category: z.string().describe("The expense category as understood."),
  claimed_amount: z.number().describe("The total amount claimed, in the receipt currency."),
});

export type tExpenseDecision = z.infer<typeof ExpenseDecisionSchema>;

// What the API actually returns: the model's decision plus the cited rule's verbatim text,
// filled in server-side from the policy store after the id has been verified against the
// submitting company's policy. Splitting the two schemas is what makes invented policy text
// unrepresentable — the model is never asked for the text, so it has no channel to invent it
// through, and the field can never be missing because the server is the one writing it.
export const FinalizedDecisionSchema = ExpenseDecisionSchema.extend({
  cited_rule: z
    .string()
    .min(1)
    .describe("The cited rule, verbatim from the company's policy. Server-supplied."),
});

export type tFinalizedDecision = z.infer<typeof FinalizedDecisionSchema>;
