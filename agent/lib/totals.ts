// Deterministic reconciliation of a receipt's line items against the amount claimed.
//
// The system prompt has always told the model to "double-check that the receipt totals add
// up", but nothing ever summed line_items — and the tool offered for the job,
// validate_expense, only checks that fields are present. It returns {valid:true} for a
// submission claiming ten times its own line items.
//
// Arithmetic is not a job for a language model. This does it in code and hands the model a
// fact, so the decision rests on a computed number rather than on the model eyeballing a
// column of figures in OCR text.
import type { tExpenseSubmission } from "./request-context.js";

export type tTotalsStatus = "reconciled" | "mismatch" | "no_line_items";

export type tTotalsCheck = {
  status: tTotalsStatus;
  claimed_amount: number;
  line_items_total: number;
  /** claimed_amount - line_items_total. Signed: positive means the claim exceeds the receipt. */
  difference: number;
  line_item_count: number;
  /** One line a reviewer (or the model) can read without doing the arithmetic again. */
  summary: string;
};

// Money arrives as floats, so 0.1 + 0.2 !== 0.3. Compare in whole cents rather than with an
// epsilon: it is exact for the values this domain actually carries, and it keeps a genuine
// one-cent discrepancy visible instead of hiding it inside a tolerance.
function toCents(amount: number): number {
  return Math.round(amount * 100);
}

export function reconcileTotals(submission: tExpenseSubmission): tTotalsCheck {
  const lineItems = submission.line_items ?? [];
  const claimed = submission.claimed_amount;

  if (lineItems.length === 0) {
    return {
      status: "no_line_items",
      claimed_amount: claimed,
      line_items_total: 0,
      difference: 0,
      line_item_count: 0,
      summary:
        `The submission claims ${claimed} but carries no itemised line items, so the total ` +
        "cannot be verified arithmetically. Judge it on the receipt text alone.",
    };
  }

  const totalCents = lineItems.reduce((sum, item) => sum + toCents(item.amount), 0);
  const claimedCents = toCents(claimed);
  const differenceCents = claimedCents - totalCents;

  const total = totalCents / 100;
  const difference = differenceCents / 100;

  if (differenceCents === 0) {
    return {
      status: "reconciled",
      claimed_amount: claimed,
      line_items_total: total,
      difference: 0,
      line_item_count: lineItems.length,
      summary: `The ${lineItems.length} line items sum to ${total}, matching the claimed ${claimed}.`,
    };
  }

  const direction = differenceCents > 0 ? "MORE than" : "LESS than";
  return {
    status: "mismatch",
    claimed_amount: claimed,
    line_items_total: total,
    difference,
    line_item_count: lineItems.length,
    summary:
      `MISMATCH: the ${lineItems.length} line items sum to ${total}, but the submission ` +
      `claims ${claimed} — ${Math.abs(difference)} ${direction} the receipt supports.`,
  };
}
