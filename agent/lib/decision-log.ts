// Append-only audit trail of decisions the agent actually returned.
//
// Distinct from agent/hooks/usage-log.ts, which is an observe-only hook on `step.completed`.
// That hook sees token counts but has no idea which company was reviewed or what was
// decided, so it cannot answer the question an audit needs to answer: who was told what,
// on which rule, and what did it cost. This records the decision itself, and only for
// decisions that passed the citation guardrail — a rejected decision is a failure, not an
// outcome, and logging it as one would corrupt the trail.
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export type tDecisionAuditRecord = {
  ts: string;
  company_id: string;
  decision: string;
  cited_rule_id: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
};

// Overridable so tests can write somewhere disposable.
const LOG_PATH = process.env.DECISION_LOG_PATH ?? join(process.cwd(), "logs", "decisions.jsonl");

let directoryReady = false;

/**
 * Append one decision record as a single JSON line.
 *
 * Never throws. A completed, guardrail-approved review should not be turned into a 502
 * because a disk write failed — but a silently missing audit record is its own problem, so
 * failures are logged loudly to stderr. If this trail ever becomes a compliance
 * requirement rather than an operational one, invert that: fail the request instead.
 */
export async function appendDecisionRecord(record: tDecisionAuditRecord): Promise<void> {
  try {
    if (!directoryReady) {
      await mkdir(dirname(LOG_PATH), { recursive: true });
      directoryReady = true;
    }
    // One write of one line. JSONL stays parseable under concurrent appends because each
    // call writes a complete line ending in \n rather than streaming partial content.
    await appendFile(LOG_PATH, `${JSON.stringify(record)}\n`, "utf8");
  } catch (error) {
    console.error("[expense-guard] FAILED to write decision audit record", {
      path: LOG_PATH,
      company_id: record.company_id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function decisionLogPath(): string {
  return LOG_PATH;
}
