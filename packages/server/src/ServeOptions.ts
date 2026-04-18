import type { SmithersWorkflow } from "@smithers-orchestrator/components/SmithersWorkflow";
import type { SmithersDb } from "@smithers-orchestrator/db/adapter";

export type ServeOptions = {
  workflow: SmithersWorkflow<unknown>;
  adapter: SmithersDb;
  runId: string;
  abort: AbortController;
  authToken?: string;
  metrics?: boolean;
};
