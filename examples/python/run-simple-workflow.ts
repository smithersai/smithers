import { runWorkflow } from "smithers-orchestrator";
import { pythonExample, researcher, writer } from "./_config";

// Schemas auto-discovered from Pydantic models in simple_workflow.py
const { cleanup, ...wf } = pythonExample("simple_workflow.py", { researcher, writer });

const result = await runWorkflow(wf, {
  input: { topic: "The future of AI orchestration" },
});

console.log("Status:", result.status);
cleanup();
