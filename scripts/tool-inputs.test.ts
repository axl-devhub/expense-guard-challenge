// Structural tenancy guard: no tool may accept a tenant identifier as an argument.
// Run: bun run scripts/tool-inputs.test.ts   (pure, no model tokens)
//
// This is the assertion that makes cross-tenant retrieval UNREPRESENTABLE rather than
// merely discouraged. `search_policy` used to take a company_id, so the tenant a review was
// scoped to was chosen by the model — from a prompt containing raw OCR receipt text, which
// is attacker-influenced input. Removing the argument means the model has no way to ask for
// another company's rules; there is no wording that expresses the request.
//
// A prompt instruction ("never look up another company") is a request. An absent parameter
// is a guarantee. This test exists so the parameter cannot quietly come back.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import searchPolicy from "../agent/tools/search_policy.js";
import verifyTotals from "../agent/tools/verify_totals.js";

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

type tToolLike = { description: string; inputSchema?: { shape?: Record<string, unknown> } };

function inputKeys(tool: unknown): string[] {
  const shape = (tool as tToolLike).inputSchema?.shape;
  return shape ? Object.keys(shape) : [];
}

// Anything that could name a tenant. If a future tool needs one of these, it should read
// submissionState instead — that is the whole point.
const TENANT_ARGUMENT_NAMES = [
  "company_id",
  "companyId",
  "company",
  "tenant",
  "tenant_id",
  "tenantId",
  "workspace_id",
  "workspaceId",
];

const TOOLS: Array<[string, unknown]> = [
  ["search_policy", searchPolicy],
  ["verify_totals", verifyTotals],
];

console.log("tool inputs — the model cannot choose the tenant");

for (const [name, tool] of TOOLS) {
  check(`${name} accepts no tenant identifier`, () => {
    const keys = inputKeys(tool);
    for (const forbidden of TENANT_ARGUMENT_NAMES) {
      assert.ok(
        !keys.includes(forbidden),
        `${name} accepts "${forbidden}" — the model can choose the tenant again`,
      );
    }
  });
}

check("search_policy still accepts the topic it needs, and nothing more", () => {
  assert.deepEqual(inputKeys(searchPolicy), ["topic"]);
});

check("verify_totals takes no arguments at all", () => {
  // It reconciles the submission it reads from state. Accepting the figures it is meant to
  // be verifying would let it confirm whatever the caller claimed — the exact flaw that
  // made the removed validate_expense useless.
  assert.deepEqual(inputKeys(verifyTotals), []);
});

check("the removed validate_expense tool has not come back", () => {
  // It only checked field presence, which ExpenseSubmissionSchema now enforces at ingress,
  // so it could not return valid:false for any submission that reached the model — while
  // still costing tokens in the tool definitions on every request.
  const path = new URL("../agent/tools/validate_expense.ts", import.meta.url);
  assert.equal(
    existsSync(path),
    false,
    "validate_expense is back; it is tautological, see FINDINGS.md",
  );
});

check("every tool description tells the model the tenant is not its choice", () => {
  // Belt and braces: the schema makes it impossible, the description stops the model
  // wasting a turn trying.
  const description = (searchPolicy as tToolLike).description.toLowerCase();
  assert.ok(
    description.includes("no company_id") || description.includes("not by you"),
    "search_policy's description should say the company is not the model's choice",
  );
});

if (failures.length > 0) {
  console.error(`\n${failures.length} failing assertion(s).`);
  process.exit(1);
}
console.log("\nall assertions passed.");
