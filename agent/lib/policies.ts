// Synthetic per-company expense policies. Each company sets its own limits, so a
// submission must always be judged against its OWN company's rules.

// Every limit below is written with a bare "$" and means USD. Stating that here rather than
// leaving it implicit is what lets agent/lib/currency.ts decide whether a submitted amount
// is comparable to these numbers at all. If policies ever become per-company multi-currency,
// this constant becomes a field on tCompanyPolicy and the check follows it.
export const POLICY_CURRENCY = "USD";
export type tPolicyRule = {
  id: string;
  category: string;
  text: string;
  // "global" marks a rule that applies to every submission regardless of its category —
  // a blanket approval gate, or a prohibition worded "any expense" / "under any
  // circumstances". Topic-narrowed lookups must never hide these; see selectRules in
  // policy-store.ts. Absent means the rule is scoped to its own category.
  scope?: "global";
};

export type tCompanyPolicy = {
  company_id: string;
  company_name: string;
  rules: tPolicyRule[];
};

export const POLICIES: Record<string, tCompanyPolicy> = {};

const acmeRules: tPolicyRule[] = [];
acmeRules.push({ id: "MEAL-01", category: "meals", text: "Business meals are reimbursed up to $50 per attendee; an itemized receipt is required." });
acmeRules.push({ id: "TRVL-01", category: "travel", text: "Airfare must be economy. Any single flight over $1,500 requires director approval (flag_for_review)." });
acmeRules.push({ id: "SW-01", category: "software", text: "Software or SaaS up to $200 per month is auto-approved; above $200/month requires IT sign-off (flag_for_review)." });
acmeRules.push({ id: "ALC-01", category: "alcohol", text: "Alcohol is not reimbursable under any circumstances (reject).", scope: "global" });
POLICIES.acme = { company_id: "acme", company_name: "Acme Robotics", rules: acmeRules };

const globexRules: tPolicyRule[] = [];
globexRules.push({ id: "MEAL-01", category: "meals", text: "Meals are capped at $35 per attendee." });
globexRules.push({ id: "TRVL-01", category: "travel", text: "Any travel expense over $2,000 requires finance approval (flag_for_review)." });
globexRules.push({ id: "SW-01", category: "software", text: "Software purchases require VP approval regardless of amount (flag_for_review)." });
globexRules.push({ id: "ENT-01", category: "entertainment", text: "Client entertainment is reimbursed up to $300 per event." });
POLICIES.globex = { company_id: "globex", company_name: "Globex Corporation", rules: globexRules };

const initechRules: tPolicyRule[] = [];
initechRules.push({ id: "GEN-01", category: "general", text: "Any expense over $100 requires manager review (flag_for_review).", scope: "global" });
initechRules.push({ id: "MEAL-01", category: "meals", text: "Meals are reimbursed up to $25 per attendee." });
initechRules.push({ id: "OFF-01", category: "office", text: "Office supplies up to $250 are auto-approved." });
initechRules.push({ id: "CASH-01", category: "general", text: "Cash-only receipts with no accompanying card statement are not reimbursable (reject).", scope: "global" });
POLICIES.initech = { company_id: "initech", company_name: "Initech LLC", rules: initechRules };
