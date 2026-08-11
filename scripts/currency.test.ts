// Currency comparability, and the escalation it forces.
// Run: bun run scripts/currency.test.ts   (pure, no model tokens)
//
// The gap: every policy limit is written with a bare "$" and means USD, while submissions
// carry a `currency` field that nothing read. A non-USD amount was therefore compared to a
// USD cap as though the number meant dollars.
//
// This is not hypothetical. Recorded live before the fix, an acme meal for two claiming
// 900 MXN — about $45, comfortably inside the $50-per-attendee cap — was REJECTED, with the
// model reasoning that the policy allowed "maximum 100 MXN equivalent for 2 people". It had
// silently applied a 1:1 exchange rate.
import assert from "node:assert/strict";
import { checkCurrency } from "../agent/lib/currency.js";
import { finalizeDecision } from "../agent/lib/finalize-decision.js";
import { POLICY_CURRENCY } from "../agent/lib/policies.js";
import type { tExpenseSubmission } from "../agent/lib/request-context.js";

const failures: string[] = [];

function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${message.split("\n").join("\n       ")}`);
  }
}

function submission(over: Partial<tExpenseSubmission> = {}): tExpenseSubmission {
  return {
    company_id: "acme",
    category: "meals",
    claimed_amount: 96,
    currency: "USD",
    receipt: "OLIVE & VINE BISTRO\nTOTAL ... $96.00",
    line_items: [{ label: "Meal", amount: 96 }],
    ...over,
  };
}

function decision(over: Record<string, unknown> = {}) {
  return {
    decision: "approve",
    reason: "Within the per-attendee cap.",
    cited_rule_id: "MEAL-01",
    category: "meals",
    claimed_amount: 96,
    ...over,
  };
}

console.log("currency — comparability against USD policy limits");

check("the policy currency is declared, not implied", () => {
  assert.equal(POLICY_CURRENCY, "USD");
});

check("a USD claim is comparable", () => {
  const result = checkCurrency(submission());
  assert.equal(result.comparable, true);
});

check("an absent currency is treated as the policy currency", () => {
  // The prompt has always defaulted a missing currency to USD; the check must agree, or
  // every fixture that omits the field would suddenly escalate.
  const result = checkCurrency(submission({ currency: undefined }));
  assert.equal(result.comparable, true);
  assert.equal(result.submitted_currency, "USD");
});

check("case and whitespace do not make a USD claim look foreign", () => {
  for (const currency of ["usd", "Usd", " USD "]) {
    assert.equal(checkCurrency(submission({ currency })).comparable, true, `"${currency}" escalated`);
  }
});

check("a non-USD claim is not comparable", () => {
  for (const currency of ["MXN", "EUR", "GBP", "JPY"]) {
    const result = checkCurrency(submission({ currency }));
    assert.equal(result.comparable, false, `${currency} was treated as comparable`);
    assert.equal(result.submitted_currency, currency);
  }
});

check("the explanation names both currencies and refuses to invent a rate", () => {
  const { summary } = checkCurrency(submission({ currency: "MXN" }));
  assert.match(summary, /MXN/);
  assert.match(summary, /USD/);
  assert.match(summary, /exchange rate/i);
});

console.log("\ncurrency — the escalation it forces");

// The recorded failure: a valid MXN claim rejected on an invented 1:1 rate.
check("a reject reached by comparing pesos to dollars is escalated, not upheld", () => {
  const result = finalizeDecision(
    submission({ currency: "MXN", claimed_amount: 900 }),
    decision({
      decision: "reject",
      reason: "900 MXN exceeds the $100 allowed for 2 attendees.",
      claimed_amount: 900,
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(
    result.decision.decision,
    "flag_for_review",
    "a reject based on a cross-currency comparison was allowed to stand",
  );
});

// The mirror case, and the more expensive one: a currency stronger than USD understates the
// number, so a claim over the cap reads as under it.
check("an approve on a stronger currency is escalated too", () => {
  const result = finalizeDecision(
    submission({ currency: "EUR", claimed_amount: 95 }),
    decision({ reason: "95 is under the $100 cap.", claimed_amount: 95 }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.decision.decision, "flag_for_review", "a cross-currency approve stood");
});

check("the escalation says what happened and preserves the model's own reasoning", () => {
  const result = finalizeDecision(
    submission({ currency: "MXN", claimed_amount: 900 }),
    decision({ decision: "reject", reason: "Original model reasoning here.", claimed_amount: 900 }),
  );
  assert.ok(result.ok);
  if (!result.ok) return;
  const { reason } = result.decision;
  assert.match(reason, /Original model reasoning here\./, "the model's reason was discarded");
  assert.match(reason, /\[Platform\]/, "the escalation is not attributed to the platform");
  assert.match(reason, /Escalated from "reject"/, "the original decision is not recorded");
  assert.match(reason, /MXN/);
});

check("a decision already flagged is left exactly as it is", () => {
  const result = finalizeDecision(
    submission({ currency: "MXN", claimed_amount: 900 }),
    decision({ decision: "flag_for_review", reason: "Needs a human.", claimed_amount: 900 }),
  );
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.decision.decision, "flag_for_review");
  assert.equal(result.decision.reason, "Needs a human.", "an already-flagged reason was rewritten");
});

check("a USD decision is never touched by the currency gate", () => {
  for (const verdict of ["approve", "reject", "flag_for_review"]) {
    const result = finalizeDecision(submission(), decision({ decision: verdict }));
    assert.ok(result.ok);
    if (!result.ok) continue;
    assert.equal(result.decision.decision, verdict, `a USD ${verdict} was altered`);
    assert.ok(!result.decision.reason.includes("[Platform]"), "a USD decision got an escalation note");
  }
});

check("the gate does not bypass the citation guardrail", () => {
  // A foreign currency must not become a way to smuggle a bad citation through.
  const result = finalizeDecision(
    submission({ currency: "MXN" }),
    decision({ cited_rule_id: "ENT-01" }), // globex-only rule, cited on an acme submission
  );
  assert.equal(result.ok, false, "a foreign-tenant rule was accepted on a non-USD submission");
  if (result.ok) return;
  assert.equal(result.code, "foreign_or_unknown_rule");
});

if (failures.length > 0) {
  console.error(`\n${failures.length} failing assertion(s).`);
  process.exit(1);
}
console.log("\nall assertions passed.");
