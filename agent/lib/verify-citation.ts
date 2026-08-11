// Fail-closed guardrail on a decision's citation.
//
// `cited_rule` is a free-form string the model writes, and `cited_rule_id` names the rule
// it claims to be applying. Nothing upstream constrains either to the rules search_policy
// actually returned, so a decision can cite a rule belonging to another tenant (what the
// policy-store cache bug produced) or one that exists nowhere at all. This runs server-side
// against the company_id from the request — never a model-supplied value.
//
// It answers one question: does the cited rule belong to THIS company's policy? It does not
// judge whether the rule justifies the decision.
import type { tPolicyRule } from "./policies.js";
import { findRule, getCompanyPolicy, otherPolicies, ownersOfRuleId } from "./policy-store.js";

export type tCitationFailureCode =
  | "unresolvable_policy"
  | "no_rule_id"
  | "foreign_or_unknown_rule"
  | "foreign_rule_text";

export type tCitationCheck =
  | { ok: true; rule: tPolicyRule }
  | {
      ok: false;
      code: tCitationFailureCode;
      // Safe to return over HTTP. Deliberately does not reveal which other company owns a
      // rule, or any other tenant's rule text — that would turn the guardrail itself into
      // the disclosure channel it exists to prevent.
      publicMessage: string;
      // Server-side logging only. May name other tenants.
      logDetail: string;
    };

// Rule ids in this policy set look like MEAL-01, TRVL-01, GEN-01, CASH-01, SW-01.
// The scanning pattern is uppercase-only on purpose: it runs over free-form prose, where a
// case-insensitive match would fire on ordinary hyphenated tokens.
const RULE_ID_PATTERN = /\b[A-Z]{2,8}-\d{1,3}\b/g;
// The dedicated cited_rule_id field is allowed to be sloppy — "[meal-01]" is still a
// recognisable id — but it must at least have the shape of one.
const RULE_ID_SHAPE = /\b[A-Za-z]{2,8}-\d{1,3}\b/;

// Length of the verbatim word run used to detect copied foreign rule text. Long enough that
// ordinary paraphrase of a company's own rule will not trip it, short enough that quoting
// another company's rule will.
const SHINGLE_WORDS = 6;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/,/g, "")
    .replace(/[^a-z0-9$]+/g, " ")
    .trim();
}

function shingles(text: string, size: number): string[] {
  const words = text.split(" ").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i + size <= words.length; i = i + 1) {
    out.push(words.slice(i, i + size).join(" "));
  }
  return out;
}

type tForeignShingle = { company: string; ruleId: string; shingle: string };

// POLICIES never mutates at runtime, so the cross-tenant index and each company's own
// normalized corpus are derived once at module load rather than rebuilt on every request.
// At three tenants that is microseconds either way — the reason to precompute is that the
// per-request path collapses from a four-deep nested loop to a flat scan, and the cost
// stops being O(tenants x rules x words) per review.
const FOREIGN_SHINGLES = new Map<string, tForeignShingle[]>();
const OWN_TEXT = new Map<string, string>();

function foreignShinglesFor(companyId: string): tForeignShingle[] {
  const cached = FOREIGN_SHINGLES.get(companyId);
  if (cached) return cached;
  const built = otherPolicies(companyId).flatMap((policy) =>
    policy.rules.flatMap((rule) =>
      shingles(normalize(rule.text), SHINGLE_WORDS).map((shingle) => ({
        company: policy.company_id,
        ruleId: rule.id,
        shingle,
      })),
    ),
  );
  FOREIGN_SHINGLES.set(companyId, built);
  return built;
}

function ownTextFor(companyId: string, rules: readonly tPolicyRule[]): string {
  const cached = OWN_TEXT.get(companyId);
  if (cached !== undefined) return cached;
  const built = normalize(rules.map((rule) => rule.text).join(" "));
  OWN_TEXT.set(companyId, built);
  return built;
}

// Same public message whether the id belongs to another tenant or to nobody —
// distinguishing them would confirm another company's rule inventory to the caller.
function foreignOrUnknownRule(companyId: string, ruleId: string, where: string): tCitationCheck {
  const owners = ownersOfRuleId(ruleId, companyId);
  return {
    ok: false,
    code: "foreign_or_unknown_rule",
    publicMessage: `The decision cited rule "${ruleId}", which is not part of this company's policy.`,
    logDetail:
      owners.length > 0
        ? `${where} "${ruleId}" belongs to [${owners.join(", ")}], not to "${companyId}"`
        : `${where} "${ruleId}" exists in no configured policy (fabricated id)`,
  };
}

export function verifyCitation(
  companyId: string,
  citedRuleId: string,
  citedRule: string,
): tCitationCheck {
  let ownPolicy;
  try {
    ownPolicy = getCompanyPolicy(companyId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      code: "unresolvable_policy",
      publicMessage: "The submission's company has no configured expense policy.",
      logDetail: `getCompanyPolicy("${companyId}") threw: ${message}`,
    };
  }

  // The decision names the rule by id. Resolving that id against this company's policy is
  // what makes the returned rule text authoritative rather than model prose.
  const normalizedId = (citedRuleId.match(RULE_ID_SHAPE)?.[0] ?? "").toUpperCase();
  if (!normalizedId) {
    return {
      ok: false,
      code: "no_rule_id",
      publicMessage: "The decision did not cite an identifiable policy rule.",
      logDetail: `cited_rule_id was not a rule id: ${JSON.stringify(citedRuleId)}`,
    };
  }

  const rule = findRule(companyId, normalizedId);
  if (!rule) return foreignOrUnknownRule(companyId, normalizedId, "cited_rule_id");

  // Defence in depth: any rule id the model mentions in its free-text citation must also
  // belong to this company, so a decision cannot reason aloud from a neighbour's rule.
  const ownIds = new Set(ownPolicy.rules.map((r) => r.id));
  for (const id of citedRule.match(RULE_ID_PATTERN) ?? []) {
    if (!ownIds.has(id)) return foreignOrUnknownRule(companyId, id, "cited_rule mentioned");
  }

  // Ids collide across tenants — every company here defines a MEAL-01 — so a matching id is
  // not sufficient. Catch a decision that quotes another company's rule text verbatim under
  // a locally-valid id, which is exactly what the policy cache leak produced.
  //
  // Note this is now a signal, not a containment barrier: the caller replaces cited_rule
  // with canonical store text regardless, so foreign wording cannot reach a consumer. What
  // it still catches is the model having REASONED from the wrong tenant's policy, which is
  // worth rejecting rather than silently canonicalising.
  const citedWords = normalize(citedRule);
  const ownText = ownTextFor(companyId, ownPolicy.rules);
  for (const foreign of foreignShinglesFor(companyId)) {
    if (!citedWords.includes(foreign.shingle)) continue;
    if (ownText.includes(foreign.shingle)) continue; // wording this company shares — not a leak
    return {
      ok: false,
      code: "foreign_rule_text",
      publicMessage:
        "The decision quoted policy text that is not part of this company's policy.",
      logDetail:
        `cited_rule quoted "${foreign.shingle}" from ${foreign.company}'s ${foreign.ruleId}, ` +
        `which does not appear in "${companyId}"'s policy`,
    };
  }

  return { ok: true, rule };
}
