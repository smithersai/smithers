import { runWorkflow } from "smithers-orchestrator";
import { pythonExample, reviewer } from "./_config";

const { cleanup, ...wf } = pythonExample("code_review_loop.py", { reviewer });

const result = await runWorkflow(wf, {
  input: { directory: "." },
});

console.log("Status:", result.status);
cleanup();
