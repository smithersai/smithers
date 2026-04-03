import { renderFrame, zodSchemaToJsonExample } from "../src/index";
import { buildContext, type OutputSnapshot } from "../src/context";

const sharedExampleInput: Record<string, unknown> = {
  topic: "AI workflow orchestration",
  directory: ".",
  cwd: ".",
  repo: "acme/widgets",
  pr: 123,
  branch: "feature/example",
  baseBranch: "main",
  targetBranch: "main",
  sourceBranch: "feature/example",
  mergeMethod: "squash",
  command: "echo ok",
  commands: [{ name: "unit", cmd: "bun test" }],
  checks: [{ name: "health", cmd: "echo ok" }],
  setupCmd: "echo setup",
  sink: "pr-comment",
  serviceName: "payments-api",
  deploymentId: "deploy-123",
  stableMetricsEndpoint: "https://stable.example.com/metrics",
  canaryMetricsEndpoint: "https://canary.example.com/metrics",
  stableLogSource: "s3://logs/stable",
  canaryLogSource: "s3://logs/canary",
  stableTraceStore: "tempo://stable",
  canaryTraceStore: "tempo://canary",
  notifyChannels: ["#deploys"],
  mailbox: "ap@example.com",
  runbook: "Restart the payments service",
  environment: "staging",
  steps: [
    {
      name: "Check rollout status",
      command: "kubectl rollout status deploy/payments",
      reason: "Read-only verification step",
    },
    {
      name: "Restart deployment",
      command: "kubectl rollout restart deploy/payments",
      reason: "Controlled state change",
    },
  ],
  event: {
    title: "Acme renewal review",
    organizer: "ae@example.com",
    attendees: ["buyer@example.com", "champion@example.com"],
    scheduledAt: "2026-02-10T15:00:00Z",
    description: "Review adoption, renewal timeline, and open risks.",
  },
  source: "google",
  diff: "diff --git a/src/app.ts b/src/app.ts\n+console.log('example')\n",
  text: "Acme Corp requested a renewal call and mentioned an outage.",
  content: "Example content for workflow prompts.",
  document: "Invoice 1001 for Acme Corp due next week.",
  schemaSpec: "{ name: string, amount: number }",
  records: [{ id: "row-1", value: "example" }],
  alerts: [{ id: "alert-1", service: "payments", summary: "Latency spike", severity: "warning" }],
  tickets: [{ id: "ticket-1", title: "VPN access", body: "Need access for onboarding" }],
  items: [{ id: "item-1", title: "Improve logging", description: "Add structured logging" }],
  baseline: [{ name: "checkout", valueMs: 120 }],
  thresholds: { errorRate: 0.5, latencyP99Pct: 10 },
  servers: ["github", "linear"],
};

const exampleInputOverrides: Record<string, Record<string, unknown>> = {
  "meeting-briefer": {
    source: "google",
  },
  "runbook-executor": {
    steps: [
      {
        name: "Inspect pod health",
        command: "kubectl get pods",
        reason: "Read-only inspection",
      },
      {
        name: "Restart deployment",
        command: "kubectl rollout restart deploy/payments",
        reason: "Restarts production traffic",
      },
    ],
  },
  smoketest: {
    checks: [
      { name: "health", cmd: "echo ok" },
      { name: "build", cmd: "echo build" },
    ],
  },
};

function exampleInputFor(
  exampleId: string,
  sampleInput: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...sharedExampleInput,
    ...(exampleInputOverrides[exampleId] ?? {}),
    ...sampleInput,
  };
}

function synthesizeBoolean(key: string) {
  if (/(conflict|error|fail|blocked|deny|denied|notable|missing|rollback|regressed|exceeded|drift)/i.test(key)) {
    return false;
  }
  if (/(approved|ready|passed|valid|mergeable|promoted|success|safe|complete|done|healthy|material)/i.test(key)) {
    return true;
  }
  return false;
}

function synthesizeValue(value: unknown, key = ""): unknown {
  if (typeof value === "boolean") {
    return synthesizeBoolean(key);
  }
  if (typeof value === "number") {
    return value === 0 ? 1 : value;
  }
  if (typeof value === "string") {
    if (value === "string" || value === "value") {
      return key ? `${key}-example` : "example";
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => synthesizeValue(item, key));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        synthesizeValue(childValue, childKey),
      ]),
    );
  }
  return value;
}

function synthesizeTaskOutput(task: any) {
  const generated = JSON.parse(zodSchemaToJsonExample(task.outputSchema));
  return synthesizeValue(generated) as Record<string, unknown>;
}

export async function renderHydratedExampleFrame(
  workflow: any,
  exampleId: string,
  sampleInput: Record<string, unknown> = {},
) {
  const runId = `render-${exampleId}`;
  const input = exampleInputFor(exampleId, sampleInput);
  const outputs: OutputSnapshot = {};
  let frame: any = undefined;

  for (let pass = 0; pass < 8; pass++) {
    const ctx = buildContext({
      runId,
      iteration: 0,
      input,
      outputs,
      zodToKeyName: workflow.zodToKeyName,
    });

    frame = await renderFrame(workflow, ctx);

    let added = 0;
    for (const task of frame.tasks as any[]) {
      if (!task.outputSchema || !task.outputTableName) continue;
      const rows = outputs[task.outputTableName] ?? (outputs[task.outputTableName] = []);
      const nodeId = task.nodeId ?? task.id;
      const iteration = task.iteration ?? 0;
      const exists = rows.some((row) => row.nodeId === nodeId && (row.iteration ?? 0) === iteration);
      if (exists) continue;
      rows.push({
        runId,
        nodeId,
        iteration,
        ...synthesizeTaskOutput(task),
      });
      added++;
    }

    if (added === 0) {
      break;
    }
  }

  return { frame, input, outputs };
}
