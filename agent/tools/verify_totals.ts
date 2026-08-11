// Reconciles the receipt's line items against the amount claimed, in code.
//
// Takes NO arguments on purpose. It reads the authoritative submission out of
// `submissionState`, which the instructions resolver seeds at turn start from the request —
// so the numbers it checks are the ones actually submitted, not the ones the model
// transcribed into a tool call. A tool that accepts the figures it is meant to be verifying
// can only ever confirm what the caller already claimed.
import { defineTool } from "eve/tools";
import { z } from "zod";
import { reconcileTotals } from "../lib/totals.js";
import { submissionState } from "../lib/request-context.js";

export default defineTool({
  description:
    "Check whether the receipt's line items add up to the claimed amount. Takes no " +
    "arguments — it reads the submission under review directly. Call this before deciding: " +
    "it returns the arithmetic as a fact so you do not have to add up the receipt yourself. " +
    "A 'mismatch' status means the claim is not supported by the itemised receipt.",
  inputSchema: z.object({}),
  async execute() {
    const submission = submissionState.get();
    if (!submission) {
      // Should not happen: the instructions resolver seeds this at turn start. Report it
      // rather than inventing a pass, so a broken wiring cannot read as "totals fine".
      return {
        status: "unavailable" as const,
        summary:
          "The submission under review is not available to this tool, so the totals could " +
          "not be reconciled. Do not treat this as the totals being correct.",
      };
    }
    return reconcileTotals(submission);
  },
});
