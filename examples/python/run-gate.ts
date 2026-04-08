import { runWorkflow } from "smithers-orchestrator";
import { pythonExample, claude } from "./_config";

const { cleanup, ...wf } = pythonExample("gate.py", { claude });

const result = await runWorkflow(wf, {
  input: { target: "http://localhost:3000/health" },
});

console.log("Status:", result.status);
cleanup();
