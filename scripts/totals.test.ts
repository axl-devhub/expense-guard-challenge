// Receipt total reconciliation.
// Run: bun run scripts/totals.test.ts   (pure, no model tokens)
//
// The gap this closes: the system prompt tells the model to "double-check that the receipt
// totals add up", but nothing in the codebase ever summed line_items. The tool once
// offered for the job, validate_expense, checked field PRESENCE — it returned
// {valid:true} for a submission claiming 10x its own line items, and it checked the model's
// transcribed arguments rather than the submission, so it could only confirm what the model
// had just asserted. It has since been removed; scripts/tool-inputs.test.ts pins that.
import assert from "node:assert/strict";
import { reconcileTotals } from "../agent/lib/totals.js";
import type { tExpenseSubmission } from "../agent/lib/request-context.js";

const failures: string[] = [];

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ok   ${name}`);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(name);
      console.log(`  FAIL ${name}\n       ${message.split("\n").join("\n       ")}`);
    });
}

function submission(over: Partial<tExpenseSubmission> = {}): tExpenseSubmission {
  return {
    company_id: "acme",
    category: "meals",
    claimed_amount: 96,
    currency: "USD",
    receipt: "OLIVE & VINE BISTRO\nTOTAL ... $96.00",
    line_items: [
      { label: "Entrees", amount: 72 },
      { label: "Sodas & juice", amount: 12 },
      { label: "Sales tax", amount: 12 },
    ],
    ...over,
  };
}

console.log("receipt totals — reconciliation");

await check("a submission whose line items sum to the claim reconciles", () => {
  const result = reconcileTotals(submission());
  assert.equal(result.status, "reconciled");
  assert.equal(result.line_items_total, 96);
  assert.equal(result.difference, 0);
});

await check("a 10x overclaim is caught", () => {
  const result = reconcileTotals(submission({ claimed_amount: 960 }));
  assert.equal(result.status, "mismatch", "the overclaim was not caught");
  assert.equal(result.line_items_total, 96);
  assert.equal(result.difference, 864);
});

await check("a small overclaim is caught too", () => {
  // The realistic fraud shape is a quiet padding, not a 10x.
  const result = reconcileTotals(submission({ claimed_amount: 106 }));
  assert.equal(result.status, "mismatch");
  assert.equal(result.difference, 10);
});

await check("an underclaim is reported as a mismatch, not silently accepted", () => {
  const result = reconcileTotals(submission({ claimed_amount: 80 }));
  assert.equal(result.status, "mismatch");
  assert.equal(result.difference, -16, "difference should be signed");
});

await check("floating point cents do not produce a false mismatch", () => {
  // 0.1 + 0.2 !== 0.3 in IEEE 754. A naive equality check fails this.
  const result = reconcileTotals(
    submission({
      claimed_amount: 0.3,
      line_items: [
        { label: "a", amount: 0.1 },
        { label: "b", amount: 0.2 },
      ],
    }),
  );
  assert.equal(result.status, "reconciled", "float noise was reported as a mismatch");
});

await check("a one-cent discrepancy is still a mismatch", () => {
  const result = reconcileTotals(submission({ claimed_amount: 96.01 }));
  assert.equal(result.status, "mismatch", "a real one-cent gap was swallowed by the tolerance");
});

await check("a submission with no line items reports that it cannot be verified", () => {
  const result = reconcileTotals(submission({ line_items: [] }));
  assert.equal(
    result.status,
    "no_line_items",
    "an unverifiable submission must not be reported as reconciled",
  );
  assert.notEqual(result.status, "reconciled");
});

await check("a missing line_items field behaves the same as an empty one", () => {
  const result = reconcileTotals(submission({ line_items: undefined }));
  assert.equal(result.status, "no_line_items");
});

await check("the result carries the numbers a reviewer needs to see", () => {
  const result = reconcileTotals(submission({ claimed_amount: 960 }));
  assert.equal(result.claimed_amount, 960);
  assert.equal(result.line_items_total, 96);
  assert.equal(result.line_item_count, 3);
  assert.ok(result.summary.includes("960"), "summary should quote the claim");
  assert.ok(result.summary.includes("96"), "summary should quote the line-item total");
});

if (failures.length > 0) {
  console.error(`\n${failures.length} failing assertion(s).`);
  process.exit(1);
}
console.log("\nall assertions passed.");
