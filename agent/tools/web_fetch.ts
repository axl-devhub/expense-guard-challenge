// Disable the Eve framework default tool — Expense Guard exposes only its own two tools
// (search_policy, verify_totals).
import { disableTool } from "eve/tools";
export default disableTool();
