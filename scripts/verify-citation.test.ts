// Tests for the fail-closed cited_rule guardrail.
// Run: bun run scripts/verify-citation.test.ts
//
// Every "real output" string below was recorded from an actual run against the dev server,
// so the false-positive cases are decisions the agent genuinely produces — not invented
// examples that happen to pass.
import assert from "node:assert/strict";
import { verifyCitation } from "../agent/lib/verify-citation.js";

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

console.log("cited_rule guardrail");

// ---------------------------------------------------------------------------
// Must PASS — real decisions recorded from ./scripts/check.sh.
// ---------------------------------------------------------------------------
const REAL_GOOD: Array<[string, string, string, string]> = [
  ["acme", "SW-01", "SW-01: Software or SaaS up to $200 per month is auto-approved; above $200/month requires IT sign-off", "ambiguous.json"],
  ["initech", "MEAL-01", "[MEAL-01] Meals are reimbursed up to $25 per attendee (limit: $50 for 2 attendees)", "cross-company.json"],
  ["acme", "MEAL-01", "MEAL-01: Business meals up to $50 per attendee", "request.json"],
  ["acme", "MEAL-01", "[MEAL-01] Business meals reimbursed up to $50 per attendee; limit for 2 attendees = $100.00", "valid.json"],
  ["globex", "TRVL-01", "TRVL-01 (travel): Any travel expense over $2,000 requires finance approval.", "illegible.json"],
];

for (const [company, id, cited, source] of REAL_GOOD) {
  check(`accepts the real ${source} decision (${company})`, () => {
    const result = verifyCitation(company, id, cited);
    assert.equal(result.ok, true, result.ok ? "" : `${result.code} — ${result.logDetail}`);
  });
}

// The model multiplied initech's own $25 cap by 2 attendees and wrote "$50" — a number
// absent from initech's policy that happens to equal acme's cap. A guardrail keying on
// dollar amounts would reject this valid decision.
check("does not reject a correctly-derived total that coincides with another cap", () => {
  const result = verifyCitation(
    "initech",
    "MEAL-01",
    "[MEAL-01] Meals are reimbursed up to $25 per attendee (limit: $50 for 2 attendees)",
  );
  assert.equal(result.ok, true);
});

check("tolerates a bracketed or lower-cased rule id", () => {
  for (const id of ["[MEAL-01]", " meal-01 ", "MEAL-01"]) {
    const result = verifyCitation("acme", id, "Business meals up to $50 per attendee");
    assert.equal(result.ok, true, `id ${JSON.stringify(id)} was rejected`);
  }
});

// ---------------------------------------------------------------------------
// The residual gap this guardrail was extended to close.
// ---------------------------------------------------------------------------

// Recorded live: a globex review cited a REAL globex id with text invented wholesale.
// The id check cannot catch it, so the guardrail instead resolves the id to its canonical
// text and the channel returns that — making the fabricated prose unreachable.
check("resolves a fabricated paraphrase back to the canonical rule text", () => {
  const result = verifyCitation(
    "globex",
    "TRVL-01",
    "TRVL-01: Travel expenses require proper documentation and verification",
  );
  assert.equal(result.ok, true, "a real own-company id should still verify");
  if (!result.ok) return;
  assert.equal(
    result.rule.text,
    "Any travel expense over $2,000 requires finance approval (flag_for_review).",
    "the canonical text must come from the policy store, not the model",
  );
  assert.ok(
    !result.rule.text.includes("proper documentation"),
    "the invented wording must not survive into the returned rule",
  );
});

// ---------------------------------------------------------------------------
// Must FAIL — the leaks this guardrail exists to stop.
// ---------------------------------------------------------------------------

// Verbatim from run A, when the unkeyed policy cache served acme's policy into an initech
// review. MEAL-01 IS valid for initech, so an id-only check would miss this.
check("rejects acme's rule text served into an initech review (recorded leak)", () => {
  const result = verifyCitation(
    "initech",
    "MEAL-01",
    "MEAL-01: Business meals are reimbursed up to $50 per attendee; an itemized receipt is required.",
  );
  assert.equal(result.ok, false, "the recorded cross-tenant leak was accepted");
  if (result.ok) return;
  assert.equal(result.code, "foreign_rule_text");
});

check("rejects acme's travel rule served into a globex review (recorded leak)", () => {
  const result = verifyCitation(
    "globex",
    "TRVL-01",
    "TRVL-01: Airfare must be economy. Any single flight over $1,500 requires director approval.",
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "foreign_rule_text");
});

check("rejects a rule id belonging exclusively to another company", () => {
  for (const [company, id] of [["acme", "ENT-01"], ["initech", "ALC-01"], ["globex", "CASH-01"]] as const) {
    const result = verifyCitation(company, id, `${id}: some limit applies here`);
    assert.equal(result.ok, false, `${company} citing ${id} was accepted`);
    if (result.ok) continue;
    assert.equal(result.code, "foreign_or_unknown_rule");
  }
});

check("rejects a foreign rule id mentioned only in the free-text citation", () => {
  const result = verifyCitation("initech", "MEAL-01", "Per ALC-01, alcohol is never reimbursable.");
  assert.equal(result.ok, false, "a neighbour's rule id in the prose was accepted");
  if (result.ok) return;
  assert.equal(result.code, "foreign_or_unknown_rule");
});

check("rejects a fabricated rule id that exists in no policy", () => {
  const result = verifyCitation("acme", "MEAL-99", "MEAL-99: Meals up to $500 per attendee");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "foreign_or_unknown_rule");
  assert.match(result.logDetail, /fabricated/);
});

check("rejects a cited_rule_id that is not a rule id at all", () => {
  const result = verifyCitation("acme", "company policy", "Company policy allows this expense.");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "no_rule_id");
});

check("rejects when the company has no policy at all", () => {
  const result = verifyCitation("wayne-enterprises", "MEAL-01", "up to $50 per attendee");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "unresolvable_policy");
});

// ---------------------------------------------------------------------------
// The guardrail must not become the disclosure channel it prevents.
// ---------------------------------------------------------------------------
check("never names another tenant or quotes their rule text in the public message", () => {
  const leaks = ["acme", "globex", "initech", "Acme", "Globex", "Initech", "Robotics", "$50"];
  const cases: Array<[string, string, string]> = [
    ["initech", "MEAL-01", "MEAL-01: Business meals are reimbursed up to $50 per attendee; an itemized receipt is required."],
    ["initech", "ALC-01", "ALC-01: Alcohol is not reimbursable under any circumstances."],
    ["globex", "TRVL-01", "TRVL-01: Airfare must be economy. Any single flight over $1,500 requires director approval."],
  ];
  for (const [company, id, cited] of cases) {
    const result = verifyCitation(company, id, cited);
    assert.equal(result.ok, false, `expected the ${company} case to fail`);
    if (result.ok) continue;
    for (const token of leaks) {
      if (token === company) continue; // the caller's own id is not a leak
      assert.ok(
        !result.publicMessage.includes(token),
        `publicMessage leaked "${token}": ${result.publicMessage}`,
      );
    }
  }
});

if (failures.length > 0) {
  console.error(`\n${failures.length} failing assertion(s).`);
  process.exit(1);
}
console.log("\nall assertions passed.");
