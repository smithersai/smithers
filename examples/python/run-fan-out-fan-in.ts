import { runWorkflow } from "smithers-orchestrator";
import { pythonExample, claude } from "./_config";

const { cleanup, ...wf } = pythonExample("fan_out_fan_in.py", { claude });

const result = await runWorkflow(wf, {
  input: {
    input: "1. I love Python! 2. Orchestration is complex. 3. This SDK is great!",
    operation: "Analyze sentiment for each item independently.",
  },
});

console.log("Status:", result.status);
cleanup();
