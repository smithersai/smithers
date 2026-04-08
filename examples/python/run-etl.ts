import { runWorkflow } from "smithers-orchestrator";
import { pythonExample, claude } from "./_config";

const { cleanup, ...wf } = pythonExample("etl.py", { claude });

const result = await runWorkflow(wf, {
  input: {
    source: "user_events database",
    destination: "analytics warehouse",
  },
});

console.log("Status:", result.status);
cleanup();
