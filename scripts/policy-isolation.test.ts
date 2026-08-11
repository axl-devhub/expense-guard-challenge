// Tenant-isolation regression test for the policy store.
//
// The store is pure and synchronous, so this runs without booting the agent or spending
// gateway tokens: `bun run scripts/policy-isolation.test.ts`.
//
// This exists because the HTTP-level bug it guards against is invisible to a one-request
// eval. The defect only appears from the SECOND lookup of a process onward, so any test
// that boots a fresh agent, sends one submission, and asserts on the result will pass
// against broken code. These assertions deliberately make more than one lookup per process.
import assert from "node:assert/strict";
import { getCompanyPolicy, searchPolicy } from "../agent/lib/policy-store.js";

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

console.log("policy store — tenant isolation");

// The core regression: a module-level memo made the FIRST company looked up in a process
// win for every later lookup, in whichever direction the requests happened to arrive.
check("sequential lookups each return their own company (acme then initech)", () => {
  const acme = getCompanyPolicy("acme");
  const initech = getCompanyPolicy("initech");
  assert.equal(acme.company_id, "acme");
  assert.equal(initech.company_id, "initech", "initech lookup returned another tenant's policy");
});

check("the leak does not reverse with request order (initech then acme)", () => {
  const initech = getCompanyPolicy("initech");
  const acme = getCompanyPolicy("acme");
  assert.equal(initech.company_id, "initech");
  assert.equal(acme.company_id, "acme", "acme lookup returned another tenant's policy");
});

check("a third tenant interleaved between two others stays isolated", () => {
  assert.equal(getCompanyPolicy("acme").company_id, "acme");
  assert.equal(getCompanyPolicy("globex").company_id, "globex");
  assert.equal(getCompanyPolicy("initech").company_id, "initech");
  assert.equal(getCompanyPolicy("globex").company_id, "globex");
});

// Rule ids collide across tenants — all three companies define MEAL-01 with different
// limits — so asserting on the id alone would not have caught the leak. Assert on text.
check("searchPolicy returns each tenant's own meal limit, not a neighbour's", () => {
  const acme = searchPolicy("acme", "meals");
  const globex = searchPolicy("globex", "meals");
  const initech = searchPolicy("initech", "meals");

  assert.equal(acme.company_name, "Acme Robotics");
  assert.match(acme.rules, /\$50 per attendee/, "acme should cite its own $50 cap");

  assert.equal(globex.company_name, "Globex Corporation");
  assert.match(globex.rules, /\$35 per attendee/, "globex should cite its own $35 cap");

  assert.equal(initech.company_name, "Initech LLC");
  assert.match(initech.rules, /\$25 per attendee/, "initech should cite its own $25 cap");

  assert.notEqual(acme.rules, initech.rules, "two tenants returned identical rule text");
});

// Second defect in the same function: `POLICIES[companyId] ?? POLICIES.acme` silently
// handed Acme's policy to any unrecognised company_id.
check("an unknown company_id throws instead of silently resolving to acme", () => {
  assert.throws(
    () => getCompanyPolicy("not-a-real-company"),
    /not-a-real-company/,
    "unknown company should fail loudly, not borrow another tenant's policy",
  );
});

check("a typo'd company_id does not quietly return acme's rules", () => {
  assert.throws(() => searchPolicy("acmee", "meals"), /acmee/);
});

if (failures.length > 0) {
  console.error(`\n${failures.length} failing assertion(s).`);
  process.exit(1);
}
console.log("\nall assertions passed.");
