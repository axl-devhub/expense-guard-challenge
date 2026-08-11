// The model this agent is pinned to.
//
// Lives in its own module so the audit trail can record which model produced a decision
// without importing agent.ts — Eve treats that module as the agent definition, and pulling
// it into a channel to read one string invites surprises. One constant, two importers.
export const AGENT_MODEL = "anthropic/claude-haiku-4.5";
