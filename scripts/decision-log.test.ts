// The decision audit trail writes parseable JSONL and never throws.
// Run: bun run scripts/decision-log.test.ts   (pure — writes to a temp path, no model tokens)
//
// DECISION_LOG_PATH must be set before importing the module, since the path is resolved at
// module load. The live end-to-end proof (a record landing in logs/decisions.jsonl from a
// real POST) is in the commit message; this covers the shape and the failure behaviour.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "eg-decision-log-"));
const logPath = join(scratch, "nested", "decisions.jsonl");
process.env.DECISION_LOG_PATH = logPath;

const { appendDecisionRecord } = await import("../agent/lib/decision-log.js");

const failures: string[] = [];

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ok   ${name}`);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(name);
      console.log(`  FAIL ${name}\n       ${message.split("\n").join("\n       ")}`);
    });
}

function record(over: Record<string, unknown> = {}) {
  return {
    ts: "2026-08-11T22:00:00.000Z",
    company_id: "acme",
    decision: "approve",
    cited_rule_id: "MEAL-01",
    model: "anthropic/claude-haiku-4.5",
    inputTokens: 1891,
    outputTokens: 175,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...over,
  };
}

console.log("decision audit trail");

await check("creates the log directory if it does not exist", async () => {
  await appendDecisionRecord(record());
  const contents = readFileSync(logPath, "utf8");
  assert.ok(contents.length > 0, "nothing was written");
});

await check("writes one parseable JSON object per line, newline-terminated", async () => {
  await appendDecisionRecord(record({ company_id: "globex", decision: "flag_for_review" }));
  await appendDecisionRecord(record({ company_id: "initech", decision: "reject" }));

  const contents = readFileSync(logPath, "utf8");
  assert.ok(contents.endsWith("\n"), "the file must end with a newline");

  const lines = contents.trim().split("\n");
  assert.equal(lines.length, 3, `expected 3 records, found ${lines.length}`);
  for (const line of lines) {
    JSON.parse(line); // throws if a record was interleaved or truncated
  }
});

await check("every field the audit needs is present and correctly typed", async () => {
  const lines = readFileSync(logPath, "utf8").trim().split("\n");
  const last = lines[lines.length - 1];
  assert.ok(last, "no record to read");
  const parsed = JSON.parse(last) as Record<string, unknown>;

  for (const field of [
    "ts",
    "company_id",
    "decision",
    "cited_rule_id",
    "model",
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
  ]) {
    assert.ok(field in parsed, `record is missing "${field}"`);
  }
  assert.equal(typeof parsed.inputTokens, "number");
  assert.equal(typeof parsed.outputTokens, "number");
  assert.equal(typeof parsed.cacheReadTokens, "number");
  assert.equal(typeof parsed.cacheWriteTokens, "number");
  assert.equal(parsed.company_id, "initech");
  assert.equal(parsed.decision, "reject");
  assert.match(String(parsed.ts), /^\d{4}-\d{2}-\d{2}T/);
});

await check("appends rather than truncating", async () => {
  const before = readFileSync(logPath, "utf8").trim().split("\n").length;
  await appendDecisionRecord(record());
  const after = readFileSync(logPath, "utf8").trim().split("\n").length;
  assert.equal(after, before + 1);
});

await check("a write failure never throws into the request path", async () => {
  // Point the module at a path that cannot be created — the log lives under a FILE here,
  // so mkdir must fail. A completed, guardrail-approved review must not become a 502
  // because of a disk problem.
  const blocked = join(scratch, "nested", "decisions.jsonl", "impossible", "x.jsonl");
  process.env.DECISION_LOG_PATH = blocked;
  const fresh = await import(`../agent/lib/decision-log.js?bust=${Date.now()}`);
  await fresh.appendDecisionRecord(record());
  console.log("       (the error above is expected — it proves the failure is logged, not thrown)");
});

rmSync(scratch, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\n${failures.length} failing assertion(s).`);
  process.exit(1);
}
console.log("\nall assertions passed.");
