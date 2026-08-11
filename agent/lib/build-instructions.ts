// Builds Expense Guard's system instructions for a single review.
import { type tExpenseSubmission } from "./request-context.js";

function header() {
  let out = "";
  out = out + "You are Expense Guard, an automated expense-review agent for a multi-company expense\n";
  out = out + "platform. Each submission gives you a company_id, a receipt (raw OCR text), a claimed\n";
  out = out + "amount, and a category. Return exactly one decision: approve, flag_for_review, or reject.\n";
  return out;
}

function steps() {
  let x = "";
  x = x + "\n";
  x = x + "How to review a submission:\n";
  x = x + "1. Call search_policy with the submission's company_id to retrieve that company's written\n";
  x = x + "   expense policy. Never rely on policy you remember from another company — each company\n";
  x = x + "   sets its own limits.\n";
  x = x + "2. Compare the claimed amount and category against the rules you retrieved.\n";
  x = x + "3. Double-check that the receipt totals add up and that the receipt is legible before you\n";
  x = x + "   decide. You may call validate_expense to sanity-check the submission's fields.\n";
  return x;
}

function rubric() {
  let r = "";
  r = r + "\n";
  r = r + "Decision rubric:\n";
  r = r + "- approve: the expense clearly falls within a policy rule and nothing looks off.\n";
  r = r + "- flag_for_review: the expense is over a limit that allows manager/approver sign-off, or\n";
  r = r + "  something is ambiguous and a human should take a look.\n";
  r = r + "- reject: the expense violates a hard rule (for example a non-reimbursable category).\n";
  r = r + "\n";
  r = r + "Put the id of the rule that drives your decision in cited_rule_id, exactly as\n";
  r = r + "search_policy returned it (for example MEAL-01). It must be a rule from THIS\n";
  r = r + "submission's company — never one you remember from another company, and never an id\n";
  r = r + "you invent. If no retrieved rule fits, pick the closest one that genuinely applies and\n";
  r = r + "explain the mismatch in reason. Put that rule's text in cited_rule, quoted as closely\n";
  r = r + "as you can rather than paraphrased.\n";
  r = r + "In your reason, quote the specific receipt details that justify the decision so a\n";
  r = r + "reviewer can see the evidence you used, along with any limit you derived (for example\n";
  r = r + "a per-attendee cap multiplied by the number of attendees).";
  return r;
}

function renderSubmission(submission: tExpenseSubmission, now: Date): string {
  const cur = submission.currency ?? "USD";
  const li = submission.line_items ?? [];
  const payload = {
    company_id: submission.company_id,
    category: submission.category,
    claimed_amount: submission.claimed_amount,
    currency: cur,
    receipt: submission.receipt,
    line_items: li,
  };
  let block = "";
  block = block + "Current date: " + now.toISOString() + "\n";
  block = block + "Submission under review:" + "\n";
  block = block + JSON.stringify(payload, null, 2);
  return block;
}

// Static first, volatile last.
//
// Prompt caching keys on a shared prefix: everything from the first byte that differs
// between two requests is uncacheable. This prompt used to open with the submission JSON
// and an ISO timestamp — the two things that change on every single request — so the
// identical instruction block that followed could never be reused, and every review re-billed
// it in full.
//
// Ordering the stable instructions first makes that block a byte-identical prefix across all
// requests, which is the precondition for caching. It does NOT by itself turn caching on:
// that needs an explicit cache breakpoint from the provider/framework, and the per-step
// figures from agent/hooks/usage-log.ts are the only honest way to confirm any of it landed.
// This change makes the prompt cache-READY; it does not claim a measured saving.
//
// Structural invariant, asserted in scripts/prompt-structure.test.ts: two prompts that differ
// only in their submission must share the whole instruction block as a common prefix.
export function buildSystemPrompt(submission: tExpenseSubmission, now: Date): string {
  let prompt = "";
  prompt = prompt + header();
  prompt = prompt + steps();
  prompt = prompt + rubric();
  prompt = prompt + "\n\n";
  prompt = prompt + renderSubmission(submission, now);
  return prompt;
}
