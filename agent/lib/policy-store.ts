// Loads and searches a company's expense policy for the search_policy tool.
import { POLICIES, type tCompanyPolicy, type tPolicyRule } from "./policies.js";

// Deliberately not memoized. POLICIES is an in-memory object literal, so a lookup is
// already O(1) and a cache buys nothing measurable — but held in module scope it outlives
// the request that filled it. The previous version cached the first company looked up and
// returned it for every subsequent lookup in the process, serving one tenant's policy into
// another tenant's review. Any cache added here must be keyed by companyId and scoped to
// the request. See scripts/policy-isolation.test.ts.
// Cheap membership check for ingress validation, so the channel can reject an unknown
// tenant with a 400 before opening a turn instead of paying for a full review first.
export function hasCompanyPolicy(companyId: string): boolean {
  return Object.hasOwn(POLICIES, companyId);
}

export function getCompanyPolicy(companyId: string): tCompanyPolicy {
  const resolved = POLICIES[companyId];
  if (!resolved) {
    // No default tenant. An unrecognised company_id is a caller error, and answering it
    // with some other company's rules is the same isolation breach as the cache was.
    throw new Error(`No expense policy is configured for company_id "${companyId}".`);
  }
  return resolved;
}

// Narrow a policy to the rules relevant to `topic`, ALWAYS keeping the rules that apply
// regardless of category.
//
// The previous version returned only substring matches and fell back to the full ruleset
// only on zero hits, so a precise topic returned strictly less than a nonsense one:
//
//   searchPolicy("initech", "office")       -> OFF-01 only
//   searchPolicy("initech", "office chair") -> all four rules
//
// That silently hid initech's GEN-01 (every expense over $100 needs manager review) and
// CASH-01 (cash receipts are not reimbursable) from any category-shaped topic — the
// company's only blanket gate and its only hard reject. The model was never told rules had
// been withheld, so it decided against a policy it could not see was incomplete.
function selectRules(policy: tCompanyPolicy, topic: string | undefined): tPolicyRule[] {
  if (!topic) return policy.rules;

  const q = topic.toLowerCase();
  const matchesTopic = (rule: tPolicyRule): boolean =>
    rule.category.toLowerCase().includes(q) || rule.text.toLowerCase().includes(q);

  // A topic that matches nothing is a bad query, not evidence that the policy is empty —
  // return everything rather than deciding on global rules alone. Ask the predicate
  // directly: inferring "did the topic match?" from the filtered output (via `scope`, as a
  // proxy for "got in on merit") misreads a topic whose only hit is itself a global rule,
  // and silently turns narrowing off.
  if (!policy.rules.some(matchesTopic)) return policy.rules;

  return policy.rules.filter((rule) => rule.scope === "global" || matchesTopic(rule));
}

// Which OTHER companies define this rule id? Lives here so policy-store stays the only
// module that reads the raw multi-tenant POLICIES map — the place a real backing store
// would have to land.
export function ownersOfRuleId(ruleId: string, excluding: string): string[] {
  const wanted = ruleId.trim().toUpperCase();
  return Object.values(POLICIES)
    .filter(
      (policy) =>
        policy.company_id !== excluding &&
        policy.rules.some((rule) => rule.id.toUpperCase() === wanted),
    )
    .map((policy) => policy.company_id);
}

// Every company's rules except this one's, for cross-tenant checks.
export function otherPolicies(companyId: string): tCompanyPolicy[] {
  return Object.values(POLICIES).filter((policy) => policy.company_id !== companyId);
}

// Look up a single rule within one company's policy. Used by the citation guardrail to
// resolve a decision's cited_rule_id to its verbatim text.
export function findRule(companyId: string, ruleId: string): tPolicyRule | undefined {
  const policy = getCompanyPolicy(companyId);
  const wanted = ruleId.trim().toUpperCase();
  return policy.rules.find((r) => r.id.toUpperCase() === wanted);
}

export function searchPolicy(
  companyId: string,
  topic: string | undefined,
): { company_name: string; rules: string } {
  const policy = getCompanyPolicy(companyId);
  const rules = selectRules(policy, topic);
  return { company_name: policy.company_name, rules: formatRules(rules) };
}

export function formatRules(rules: tPolicyRule[]): string {
  let s = "";
  for (let i = 0; i < rules.length; i = i + 1) {
    const r = rules[i];
    if (!r) continue;
    s = s + "[" + r.id + "] (" + r.category + ") " + r.text;
    if (i < rules.length - 1) s = s + "\n";
  }
  return s;
}
