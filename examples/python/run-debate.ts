import { runWorkflow } from "smithers-orchestrator";
import { pythonExample, claude } from "./_config";

const { cleanup, ...wf } = pythonExample("debate.py", { claude });

const result = await runWorkflow(wf, {
  input: {
    question: "Should we rewrite the auth service in Rust?",
    rounds: 2,
  },
});

console.log("Status:", result.status);
cleanup();
