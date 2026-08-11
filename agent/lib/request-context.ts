// Per-request context for a review: the expense submission plus a few trace-identity
// fields. In production a channel maps the POST body onto the session; in dev / eval it
// loads a representative submission from a fixture (override with POC_REQUEST_FILE).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { defineState } from "eve/context";

export const ExpenseLineItemSchema = z.object({
  label: z.string(),
  amount: z.number().finite(),
});

// The submission contract, enforced at ingress. Previously the body was cast straight to
// this type (`body as tExpenseSubmission`) with no validation at all, so a body missing
// company_id — or carrying a number where a string belongs — reached the prompt and the
// tools unchecked.
export const ExpenseSubmissionSchema = z.object({
  company_id: z.string().min(1),
  category: z.string().min(1),
  claimed_amount: z.number().finite().nonnegative(),
  currency: z.string().min(1).optional(),
  receipt: z.string().min(1),
  line_items: z.array(ExpenseLineItemSchema).optional(),
  workspace_id: z.string().optional(),
  chat_id: z.string().optional(),
  label: z.string().optional(),
});

export type tExpenseLineItem = z.infer<typeof ExpenseLineItemSchema>;
export type tExpenseSubmission = z.infer<typeof ExpenseSubmissionSchema>;

export type tBodyValidation = { ok: true } | { ok: false; problems: string[] };

// Ingress check, run by the channel BEFORE a turn is opened, so a malformed submission
// costs zero model tokens. A bare body is not an error — it is the documented dev/eval
// path to the fixture — so only a non-empty object is validated here.
export function validateRequestBody(body: unknown): tBodyValidation {
  if (!isPlainObject(body) || Object.keys(body).length === 0) return { ok: true };

  const parsed = ExpenseSubmissionSchema.safeParse(body);
  if (parsed.success) return { ok: true };

  return {
    ok: false,
    problems: parsed.error.issues.map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    }),
  };
}

// The per-session projection carried by channel state -> metadata(state). `contextProvided`
// tells "bare request, use fixture" apart from "a body was sent but did not survive the
// projection".
export type tRequestView = {
  request: tExpenseSubmission | null;
  contextProvided: boolean;
};

const FIXTURE_PATH = process.env.POC_REQUEST_FILE ?? join(process.cwd(), "fixtures", "request.json");

export function loadExpenseFixture(): tExpenseSubmission {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as tExpenseSubmission;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// WRITE side — the channel builds the state to seed from the parsed body. A bare body
// (missing/empty/non-object) -> fixture path (contextProvided:false). A non-empty object
// body IS the submission (contextProvided:true).
export function buildRequestView(body: unknown): tRequestView {
  if (isPlainObject(body) && Object.keys(body).length > 0) {
    return { request: body as tExpenseSubmission, contextProvided: true };
  }
  return { request: null, contextProvided: false };
}

// READ side — loud fallback: a body was provided but did not reach the resolver via the
// metadata projection -> throw (fail the turn). Silently rendering the fixture would
// review another company's submission. Bare / eval requests -> fixture.
export function resolveExpenseSubmission(
  view: { request?: unknown; contextProvided?: unknown } | undefined,
): tExpenseSubmission {
  if (view?.contextProvided === true) {
    if (isPlainObject(view.request)) return view.request as tExpenseSubmission;
    throw new Error(
      "Per-request expense context was provided but did not reach the resolver via channel " +
        "metadata/state. Refusing to fall back to the fixture — that would review another " +
        "company's submission.",
    );
  }
  return loadExpenseFixture();
}

// The authoritative submission for this turn, seeded by the instructions resolver so
// tools can read the real fields instead of relying on model-provided arguments.
export const submissionState = defineState<tExpenseSubmission | null>(
  "expense-guard.submission",
  () => null,
);
