// Topic narrowing must never hide a company's always-applicable rules.
// Run: bun run scripts/policy-retrieval.test.ts   (pure, no model tokens)
import assert from "node:assert/strict";
import { POLICIES } from "../agent/lib/policies.js";
import { searchPolicy } from "../agent/lib/policy-store.js";

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

console.log("policy retrieval — global rules survive topic narrowing");

// The recorded defect: initech's only blanket gate (GEN-01) and only hard reject (CASH-01)
// were unreachable by every category-shaped topic.
check("a narrowed initech lookup still returns GEN-01 and CASH-01", () => {
  for (const topic of ["office", "meals", "travel", "software"]) {
    const { rules } = searchPolicy("initech", topic);
    assert.ok(rules.includes("GEN-01"), `topic "${topic}" hid GEN-01 (the >$100 review gate)`);
    assert.ok(rules.includes("CASH-01"), `topic "${topic}" hid CASH-01 (the cash-receipt reject)`);
  }
});

check("the topic's own rule is still returned alongside the global ones", () => {
  assert.ok(searchPolicy("initech", "office").rules.includes("OFF-01"));
  assert.ok(searchPolicy("initech", "meals").rules.includes("MEAL-01"));
});

// The pathology that made the bug obvious: a precise topic returned strictly less than a
// nonsense one, because only a zero-hit query fell back to the full ruleset.
//
// Note the invariant is NOT "precise returns at least as many rules as vague" — a precise
// topic legitimately drops irrelevant category-scoped rules, so it can still return fewer.
// What must never happen is a precise topic dropping something that applies regardless of
// category. Asserted structurally: anything the vague result has and the precise one lacks
// must be non-global.
check("anything a precise topic drops relative to a vague one is non-global", () => {
  const precise = searchPolicy("initech", "office").rules;
  const vague = searchPolicy("initech", "office chair").rules;
  const initech = POLICIES.initech;
  assert.ok(initech, "initech policy missing");

  for (const rule of initech.rules) {
    const inVague = vague.includes(rule.id);
    const inPrecise = precise.includes(rule.id);
    if (inVague && !inPrecise) {
      assert.notEqual(
        rule.scope,
        "global",
        `precise topic dropped global rule ${rule.id}, which applies to every submission`,
      );
    }
  }
  // And the drop is real narrowing, not a no-op: MEAL-01 is irrelevant to an office claim.
  assert.ok(!precise.includes("MEAL-01"), "narrowing did not drop the irrelevant meal rule");
});

check("acme's blanket alcohol prohibition is not hidden by a meals lookup", () => {
  // A meal receipt is exactly where an alcohol line item shows up, and ALC-01 is a reject.
  const { rules } = searchPolicy("acme", "meals");
  assert.ok(rules.includes("ALC-01"), "the alcohol reject rule was hidden from a meals lookup");
  assert.ok(rules.includes("MEAL-01"));
});

check("an unmatched topic still returns the whole policy rather than globals alone", () => {
  const { rules } = searchPolicy("globex", "quantum-tunnelling");
  for (const id of ["MEAL-01", "TRVL-01", "SW-01", "ENT-01"]) {
    assert.ok(rules.includes(id), `unmatched topic dropped ${id}`);
  }
});

check("no topic returns the whole policy", () => {
  const { rules } = searchPolicy("acme", undefined);
  for (const id of ["MEAL-01", "TRVL-01", "SW-01", "ALC-01"]) {
    assert.ok(rules.includes(id));
  }
});

// Narrowing must still narrow — otherwise this is just "return everything", which would
// pass every assertion above while giving up the cost benefit entirely.
check("narrowing still excludes unrelated category-scoped rules", () => {
  const { rules } = searchPolicy("globex", "meals");
  assert.ok(rules.includes("MEAL-01"));
  assert.ok(!rules.includes("ENT-01"), "an unrelated category-scoped rule was returned");
  assert.ok(!rules.includes("TRVL-01"), "an unrelated category-scoped rule was returned");
});

check("every rule marked global is reachable from any topic, for every company", () => {
  for (const policy of Object.values(POLICIES)) {
    const globals = policy.rules.filter((r) => r.scope === "global");
    if (globals.length === 0) continue;
    for (const topic of ["meals", "travel", "software", "office", "entertainment"]) {
      const { rules } = searchPolicy(policy.company_id, topic);
      for (const rule of globals) {
        assert.ok(
          rules.includes(rule.id),
          `${policy.company_id}: topic "${topic}" hid global rule ${rule.id}`,
        );
      }
    }
  }
});

if (failures.length > 0) {
  console.error(`\n${failures.length} failing assertion(s).`);
  process.exit(1);
}
console.log("\nall assertions passed.");
