/**
 * <SchemaConformanceGate> — Validate extracted/generated data against schema rules
 * and block or flag bad outputs.
 *
 * Pattern: Input data → validator agent → checks/asserts → pass/fail or warning branch.
 * Use cases: LLM output validation, ETL quality gates, API response conformance,
 * form submission validation, data pipeline integrity checks.
 */
import { createSmithers, Sequence } from "smithers-orchestrator";
import { ToolLoopAgent as Agent } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { bash, read } from "smithers-orchestrator/tools";
import { z } from "zod";
import ValidatePrompt from "./prompts/schema-conformance-gate/validate.mdx";
import DiagnosePrompt from "./prompts/schema-conformance-gate/diagnose.mdx";

const validationSchema = z.object({
  passed: z.boolean(),
  violations: z.array(
    z.object({
      field: z.string(),
      rule: z.string(),
      message: z.string(),
      severity: z.enum(["error", "warning"]),
    })
  ),
  checkedFields: z.number(),
});

const diagnosisSchema = z.object({
  rootCause: z.string(),
  suggestedFixes: z.array(z.string()),
  canAutoFix: z.boolean(),
});

const resultSchema = z.object({
  status: z.enum(["passed", "failed", "warning"]),
  errorCount: z.number(),
  warningCount: z.number(),
  diagnosis: z.string().optional(),
  summary: z.string(),
});

const { Workflow, Task, Branch, smithers, outputs } = createSmithers({
  validation: validationSchema,
  diagnosis: diagnosisSchema,
  result: resultSchema,
});

const validator = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, read },
  instructions: `You are a strict schema conformance validator. Given input data and a set of
schema rules, check every field against the rules. Report all violations with their severity.
Be thorough — missing fields, wrong types, out-of-range values, and format mismatches are all errors.`,
});

const diagnostician = new Agent({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { bash, read },
  instructions: `You are a data quality diagnostician. Given validation violations, determine the
root cause and suggest concrete fixes. Identify whether the issues can be auto-corrected.`,
});

export default smithers((ctx) => {
  const validation = ctx.outputMaybe("validation", { nodeId: "validate" });
  const diagnosis = ctx.outputMaybe("diagnosis", { nodeId: "diagnose" });

  const errors = (validation?.violations ?? []).filter((v) => v.severity === "error");
  const warnings = (validation?.violations ?? []).filter((v) => v.severity === "warning");
  const hasErrors = errors.length > 0;
  const hasWarnings = warnings.length > 0;

  return (
    <Workflow name="schema-conformance-gate">
      <Sequence>
        <Task id="validate" output={outputs.validation} agent={validator}>
          <ValidatePrompt
            data={JSON.stringify(ctx.input.data, null, 2)}
            schemaRules={ctx.input.schemaRules ?? "Validate all fields for type correctness and completeness."}
            strictMode={ctx.input.strictMode ?? true}
          />
        </Task>

        <Branch
          if={hasErrors}
          then={
            <Sequence>
              <Task id="diagnose" output={outputs.diagnosis} agent={diagnostician}>
                <DiagnosePrompt
                  violations={JSON.stringify(errors, null, 2)}
                  originalData={JSON.stringify(ctx.input.data, null, 2)}
                />
              </Task>

              <Task id="fail-result" output={outputs.result}>
                {{
                  status: "failed" as const,
                  errorCount: errors.length,
                  warningCount: warnings.length,
                  diagnosis: diagnosis?.rootCause ?? "Unknown",
                  summary: `Schema conformance gate FAILED: ${errors.length} error(s), ${warnings.length} warning(s). Root cause: ${diagnosis?.rootCause ?? "pending"}`,
                }}
              </Task>
            </Sequence>
          }
          else={
            <Task id="pass-result" output={outputs.result}>
              {{
                status: hasWarnings ? ("warning" as const) : ("passed" as const),
                errorCount: 0,
                warningCount: warnings.length,
                summary: hasWarnings
                  ? `Schema conformance gate PASSED with ${warnings.length} warning(s): ${warnings.map((w) => w.message).join("; ")}`
                  : `Schema conformance gate PASSED: all ${validation?.checkedFields ?? 0} fields conform.`,
              }}
            </Task>
          }
        />
      </Sequence>
    </Workflow>
  );
});
