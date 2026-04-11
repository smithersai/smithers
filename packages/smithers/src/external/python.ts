import type { SmithersWorkflow } from "@smithers/react/SmithersWorkflow";
import type { AgentLike } from "@smithers/agents/AgentLike";
import { createExternalSmithers } from "./create-external-smithers";
import { createPythonBuildFn, discoverPythonSchemas } from "./python-subprocess";
import { pydanticSchemaToZod } from "./json-schema-to-zod";
import type { z } from "zod";

/**
 * Create a SmithersWorkflow from a Python script.
 *
 * Schemas can be:
 * - Omitted: auto-discovered from Pydantic models in the Python script
 * - Explicit: Zod schemas passed directly (same as before)
 *
 * @example
 * ```ts
 * // Auto-discover schemas from Python Pydantic models
 * const workflow = createPythonWorkflow({
 *   scriptPath: "./workflow.py",
 *   agents: { claude: myClaudeAgent },
 * });
 *
 * // Or provide explicit Zod schemas
 * const workflow = createPythonWorkflow({
 *   scriptPath: "./workflow.py",
 *   schemas: { analysis: z.object({ summary: z.string() }) },
 *   agents: { claude: myClaudeAgent },
 * });
 * ```
 */
export function createPythonWorkflow<S extends Record<string, z.ZodObject<any>> = any>(config: {
  scriptPath: string;
  agents: Record<string, AgentLike>;
  schemas?: S;
  dbPath?: string;
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}): SmithersWorkflow<S> & { tables: Record<string, any>; cleanup: () => void } {
  const subprocessConfig = {
    scriptPath: config.scriptPath,
    cwd: config.cwd,
    timeoutMs: config.timeoutMs,
    env: config.env,
  };

  let schemas: Record<string, z.ZodObject<any>>;

  if (config.schemas) {
    schemas = config.schemas;
  } else {
    // Auto-discover Pydantic schemas from the Python script
    const jsonSchemas = discoverPythonSchemas(subprocessConfig);
    schemas = {};
    for (const [name, jsonSchema] of Object.entries(jsonSchemas)) {
      schemas[name] = pydanticSchemaToZod(jsonSchema);
    }
  }

  return createExternalSmithers({
    schemas: schemas as S,
    agents: config.agents,
    buildFn: createPythonBuildFn(subprocessConfig),
    dbPath: config.dbPath,
  });
}
