// The system prompt must be cache-READY: everything that varies per request comes last, so
// two prompts share the whole instruction block as a byte-identical prefix.
//
// This asserts prompt STRUCTURE only. It does not claim caching is switched on — that needs
// a provider cache breakpoint, and agent/hooks/usage-log.ts is the only honest confirmation.
// Run: bun run scripts/prompt-structure.test.ts   (pure, no model tokens)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSystemPrompt } from "../agent/lib/build-instructions.js";
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
    line_items: [{ label: "Entrees", amount: 96 }],
    ...over,
  };
}

function sharedPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i = i + 1;
  return i;
}

console.log("system prompt — cache readiness");

const A = buildSystemPrompt(submission(), new Date("2026-08-11T21:00:00.000Z"));
const B = buildSystemPrompt(
  submission({ company_id: "initech", category: "office", claimed_amount: 180 }),
  new Date("2026-08-12T09:30:00.000Z"),
);

check("two prompts differing only in submission share the whole instruction block", () => {
  const shared = sharedPrefixLength(A, B);
  const instructionsEnd = A.indexOf("Current date:");
  assert.notEqual(instructionsEnd, -1, "the volatile block marker was not found");
  assert.ok(
    shared >= instructionsEnd,
    `shared prefix is ${shared} chars but the instruction block runs to ${instructionsEnd}`,
  );
});

check("the shared prefix is the bulk of the prompt, not a scrap", () => {
  const shared = sharedPrefixLength(A, B);
  const ratio = shared / Math.min(A.length, B.length);
  assert.ok(ratio > 0.5, `only ${(ratio * 100).toFixed(1)}% of the prompt is a shared prefix`);
  console.log(
    `       (${shared} of ${Math.min(A.length, B.length)} chars shared — ${(ratio * 100).toFixed(1)}%)`,
  );
});

check("the volatile block is last — nothing static follows the submission", () => {
  const marker = A.indexOf("Current date:");
  const tail = A.slice(marker);
  assert.ok(tail.includes("Submission under review:"), "submission is not in the tail");
  for (const staticFragment of ["You are Expense Guard", "How to review", "Decision rubric"]) {
    assert.ok(
      !tail.includes(staticFragment),
      `static text "${staticFragment}" appears AFTER the volatile block`,
    );
  }
});

check("the timestamp alone does not break the prefix", () => {
  // Same submission, different clock — this is the common case for two near-simultaneous
  // reviews of the same company, and it must still share the instruction block.
  const one = buildSystemPrompt(submission(), new Date("2026-08-11T21:00:00.000Z"));
  const two = buildSystemPrompt(submission(), new Date("2026-08-11T21:00:01.000Z"));
  const shared = sharedPrefixLength(one, two);
  assert.ok(shared >= one.indexOf("Current date:"));
});

check("the instruction block still carries the content the model needs", () => {
  const head = A.slice(0, A.indexOf("Current date:"));
  for (const required of [
    "You are Expense Guard",
    "search_policy",
    "cited_rule_id",
    "approve",
    "flag_for_review",
    "reject",
  ]) {
    assert.ok(head.includes(required), `the static block lost "${required}"`);
  }
});

check("the dead oldRender scaffolding is gone", () => {
  const source = readFileSync(
    new URL("../agent/lib/build-instructions.ts", import.meta.url),
    "utf8",
  );
  assert.ok(!source.includes("oldRender"), "the commented-out oldRender helper is still there");
});

if (failures.length > 0) {
  console.error(`\n${failures.length} failing assertion(s).`);
  process.exit(1);
}
console.log("\nall assertions passed.");
