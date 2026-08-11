// Loads and searches a company's expense policy for the search_policy tool.
import { POLICIES, type tCompanyPolicy, type tPolicyRule } from "./policies.js";

// Deliberately not memoized. POLICIES is an in-memory object literal, so a lookup is
// already O(1) and a cache buys nothing measurable — but held in module scope it outlives
// the request that filled it. The previous version cached the first company looked up and
// returned it for every subsequent lookup in the process, serving one tenant's policy into
// another tenant's review. Any cache added here must be keyed by companyId and scoped to
// the request. See scripts/policy-isolation.test.ts.
export function getCompanyPolicy(companyId: string): tCompanyPolicy {
  const resolved = POLICIES[companyId] ?? POLICIES.acme;
  if (!resolved) throw new Error("No default expense policy is configured.");
  return resolved;
}

function selectRules(policy: tCompanyPolicy, topic: string | undefined): tPolicyRule[] {
  if (!topic) return policy.rules;
  const q = topic.toLowerCase();
  const hits: tPolicyRule[] = [];
  for (let i = 0; i < policy.rules.length; i = i + 1) {
    const r = policy.rules[i];
    if (!r) continue;
    if (r.category.toLowerCase().indexOf(q) >= 0) {
      hits.push(r);
      continue;
    }
    if (r.text.toLowerCase().indexOf(q) >= 0) {
      hits.push(r);
      continue;
    }
  }
  // const hits2 = policy.rules.filter((x) => x.text.toLowerCase().includes(q));
  // if (hits2.length > 0) return hits2;
  if (hits.length === 0) return policy.rules;
  return hits;
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
