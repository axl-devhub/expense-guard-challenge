// Fail-closed guardrail on the decision's `cited_rule`.
//
// `cited_rule` is a free-form string the model writes. Nothing upstream constrains it to
// the rules `search_policy` actually returned, so a decision can cite a rule belonging to
// another tenant (what the policy-store cache bug produced) or one that exists nowhere at
// all. This check runs server-side, after schema validation, against the company_id from
// the request — never a model-supplied value.
//
// It answers exactly one question: does the cited rule belong to THIS company's policy?
// It deliberately does not judge whether the rule justifies the decision.
import { POLICIES, type tPolicyRule } from "./policies.js";
import { findRule, getCompanyPolicy } from "./policy-store.js";

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

// Length of the verbatim word run used to detect copied foreign rule text. Long enough
// that ordinary paraphrase of a company's own rule will not trip it, short enough that
// quoting another company's rule will.
const SHINGLE_WORDS = 6;

function normalize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/,/g, "")
    .replace(/[^a-z0-9$]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function shingles(words: string[], size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i + size <= words.length; i = i + 1) {
    out.push(words.slice(i, i + size).join(" "));
  }
  return out;
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

  const ownIds = new Set(ownPolicy.rules.map((r) => r.id));

  // The decision names the rule by id. Resolving that id against this company's policy is
  // what makes the returned rule text authoritative rather than model prose.
  const normalizedId = (citedRuleId.match(RULE_ID_SHAPE)?.[0] ?? "").toUpperCase();
  const rule = normalizedId ? findRule(companyId, normalizedId) : undefined;
  if (!rule) {
    const owners = Object.values(POLICIES)
      .filter((p) => p.company_id !== companyId && p.rules.some((r) => r.id === normalizedId))
      .map((p) => p.company_id);
    return {
      ok: false,
      code: normalizedId ? "foreign_or_unknown_rule" : "no_rule_id",
      publicMessage: normalizedId
        ? `The decision cited rule "${normalizedId}", which is not part of this company's policy.`
        : "The decision did not cite an identifiable policy rule.",
      logDetail: !normalizedId
        ? `cited_rule_id was not a rule id: ${JSON.stringify(citedRuleId)}`
        : owners.length > 0
          ? `cited_rule_id "${normalizedId}" belongs to [${owners.join(", ")}], not "${companyId}"`
          : `cited_rule_id "${normalizedId}" exists in no configured policy (fabricated id)`,
    };
  }

  // Defence in depth: any rule id the model mentions in its free-text citation must also
  // belong to this company, so a decision cannot reason aloud from a neighbour's rule.
  for (const id of citedRule.match(RULE_ID_PATTERN) ?? []) {
    if (ownIds.has(id)) continue;
    // Same public message whether the id belongs to another tenant or to nobody —
    // distinguishing them would confirm another company's rule inventory to the caller.
    const owners = Object.values(POLICIES)
      .filter((p) => p.company_id !== companyId && p.rules.some((r) => r.id === id))
      .map((p) => p.company_id);
    return {
      ok: false,
      code: "foreign_or_unknown_rule",
      publicMessage: `The decision cited rule "${id}", which is not part of this company's policy.`,
      logDetail:
        owners.length > 0
          ? `cited rule "${id}" belongs to [${owners.join(", ")}], not to "${companyId}"`
          : `cited rule "${id}" exists in no configured policy (fabricated id)`,
    };
  }

  // Ids collide across tenants — every company here defines a MEAL-01 — so a matching id
  // is not sufficient. Catch a decision that quotes another company's rule text verbatim
  // under a locally-valid id, which is exactly what the policy cache leak produced.
  const citedWords = normalize(citedRule).join(" ");
  const ownText = normalize(ownPolicy.rules.map((r) => r.text).join(" ")).join(" ");

  for (const policy of Object.values(POLICIES)) {
    if (policy.company_id === companyId) continue;
    for (const rule of policy.rules) {
      for (const shingle of shingles(normalize(rule.text), SHINGLE_WORDS)) {
        if (!citedWords.includes(shingle)) continue;
        if (ownText.includes(shingle)) continue; // wording this company shares — not a leak
        return {
          ok: false,
          code: "foreign_rule_text",
          publicMessage:
            "The decision quoted policy text that is not part of this company's policy.",
          logDetail:
            `cited_rule quoted "${shingle}" from ${policy.company_id}'s ${rule.id}, ` +
            `which does not appear in "${companyId}"'s policy`,
        };
      }
    }
  }

  return { ok: true, rule };
}
