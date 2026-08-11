// Is the claimed amount even comparable to the policy's limits?
//
// Every policy limit in agent/lib/policies.ts is written with a bare "$" and no currency
// declared, and every one of them means USD. Submissions, meanwhile, carry a `currency`
// field that nothing ever read: it was accepted, defaulted, rendered into the prompt, and
// compared to nothing.
//
// The result was not that non-USD claims were handled badly — it is that they were handled
// as though the number meant USD. Observed live, an acme meal for two claiming 900 MXN
// (about $45, comfortably inside the $50-per-attendee cap) was REJECTED, with the model
// reasoning that the policy allowed "maximum 100 MXN equivalent for 2 people". It had
// silently applied a 1:1 exchange rate. The mirror case is worse: a currency stronger than
// USD understates the number, so a claim over the cap reads as under it and gets approved.
//
// There is no FX rate in this system and inventing one would be worse than the bug. So the
// honest answer is that a non-USD amount cannot be judged against a USD limit at all, and
// the review belongs with a human who can convert it.
import { POLICY_CURRENCY } from "./policies.js";
import type { tExpenseSubmission } from "./request-context.js";

export type tCurrencyCheck = {
  /** Can claimed_amount be compared to this policy's limits at all? */
  comparable: boolean;
  submitted_currency: string;
  policy_currency: string;
  /** One line the model and a reviewer can both act on. */
  summary: string;
};

export function checkCurrency(submission: tExpenseSubmission): tCurrencyCheck {
  // An absent currency means the platform default, which is what the prompt has always
  // rendered. Compare case- and whitespace-insensitively so "usd" is not treated as foreign.
  const submitted = (submission.currency ?? POLICY_CURRENCY).trim().toUpperCase();

  if (submitted === POLICY_CURRENCY) {
    return {
      comparable: true,
      submitted_currency: submitted,
      policy_currency: POLICY_CURRENCY,
      summary: `The claim is in ${POLICY_CURRENCY}, the same currency as the policy limits.`,
    };
  }

  return {
    comparable: false,
    submitted_currency: submitted,
    policy_currency: POLICY_CURRENCY,
    summary:
      `The claim is in ${submitted} but every policy limit is expressed in ` +
      `${POLICY_CURRENCY}. No exchange rate is available to this system, so the claimed ` +
      `amount cannot be compared to the limits — treating the number as ${POLICY_CURRENCY} ` +
      `would apply an invented 1:1 rate. A human must convert the amount and decide.`,
  };
}
