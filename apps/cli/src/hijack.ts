import { spawn } from "node:child_process";
import type { SmithersDb } from "@smithers/db/adapter";
import { SmithersError } from "@smithers/errors";

export type NativeHijackEngine =
  | "claude-code"
  | "codex"
  | "gemini"
  | "pi"
  | "kimi"
  | "forge"
  | "amp";

export type HijackCandidate = {
  runId: string;
  nodeId: string;
  iteration: number;
  attempt: number;
  engine: string;
  mode: "native-cli" | "conversation";
  resume?: string;
  messages?: unknown[];
  cwd: string;
};

export type HijackLaunchSpec = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
};

function parseAttemptMeta(metaJson?: string | null): Record<string, unknown> {
  if (!metaJson) return {};
  try {
    const parsed = JSON.parse(metaJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function asNativeHijackEngine(value: unknown): NativeHijackEngine | undefined {
  return value === "claude-code" ||
    value === "codex" ||
    value === "gemini" ||
    value === "pi" ||
    value === "kimi" ||
    value === "forge" ||
    value === "amp"
    ? value
    : undefined;
}

function asConversationMessages(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function extractContinuationFromMeta(
  meta: Record<string, unknown>,
):
  | { engine: string; mode: "native-cli"; resume: string }
  | { engine: string; mode: "conversation"; messages: unknown[] }
  | null {
  const handoff = meta.hijackHandoff;
  if (handoff && typeof handoff === "object" && !Array.isArray(handoff)) {
    const engine = typeof (handoff as any).engine === "string"
      ? (handoff as any).engine
      : undefined;
    const mode: "native-cli" | "conversation" =
      (handoff as any).mode === "conversation" ? "conversation" : "native-cli";
    const resume = typeof (handoff as any).resume === "string" ? (handoff as any).resume : undefined;
    const messages = asConversationMessages((handoff as any).messages);
    if (engine && mode === "native-cli" && resume) {
      return { engine, mode: "native-cli", resume };
    }
    if (engine && mode === "conversation" && messages?.length) {
      return { engine, mode: "conversation", messages };
    }
  }

  const engine = typeof meta.agentEngine === "string" ? meta.agentEngine : undefined;
  const resume = typeof meta.agentResume === "string" ? meta.agentResume : undefined;
  if (engine && resume) {
    return { engine, mode: "native-cli" as const, resume };
  }

  const messages = asConversationMessages(meta.agentConversation);
  if (engine && messages?.length) {
    return { engine, mode: "conversation" as const, messages };
  }

  return null;
}

export async function resolveHijackCandidate(
  adapter: SmithersDb,
  runId: string,
  target?: string,
): Promise<HijackCandidate | null> {
  const attempts = await adapter.listAttemptsForRun(runId);
  const sortedAttempts = [...(attempts as any[])].sort((a, b) => {
    const aMs = a.startedAtMs ?? 0;
    const bMs = b.startedAtMs ?? 0;
    if (aMs !== bMs) return bMs - aMs;
    if ((a.iteration ?? 0) !== (b.iteration ?? 0)) return (b.iteration ?? 0) - (a.iteration ?? 0);
    return (b.attempt ?? 0) - (a.attempt ?? 0);
  });

  for (const attempt of sortedAttempts) {
    const meta = parseAttemptMeta(attempt.metaJson);
    const extracted = extractContinuationFromMeta(meta);
    if (!extracted) continue;
    if (target && target !== extracted.engine && target !== attempt.nodeId) continue;
    return {
      runId,
      nodeId: attempt.nodeId,
      iteration: attempt.iteration ?? 0,
      attempt: attempt.attempt,
      engine: extracted.engine,
      mode: extracted.mode,
      resume: extracted.mode === "native-cli" ? extracted.resume : undefined,
      messages: extracted.mode === "conversation" ? extracted.messages : undefined,
      cwd: attempt.jjCwd ?? process.cwd(),
    };
  }

  return null;
}

export async function waitForHijackCandidate(
  adapter: SmithersDb,
  runId: string,
  options: { target?: string; timeoutMs?: number } = {},
): Promise<HijackCandidate> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const run = await adapter.getRun(runId);
    const candidate = await resolveHijackCandidate(adapter, runId, options.target);
    if (run && run.status !== "running" && candidate) {
      return candidate;
    }
    await Bun.sleep(200);
  }

  throw new SmithersError(
    "HIJACK_TIMEOUT",
    `Timed out waiting for Smithers to hand off run ${runId}`,
    { runId, timeoutMs },
  );
}

export function buildHijackLaunchSpec(candidate: HijackCandidate): HijackLaunchSpec {
  if (candidate.mode !== "native-cli" || !candidate.resume) {
    throw new SmithersError(
      "HIJACK_LAUNCH_MODE",
      `Candidate ${candidate.engine} requires the Smithers conversation hijack flow, not a native CLI launch`,
      candidate,
    );
  }
  const env = { ...process.env } as Record<string, string>;
  if (candidate.engine === "claude-code") {
    if (env.CLAUDE_CODE_ENTRYPOINT) env.CLAUDE_CODE_ENTRYPOINT = "";
    if (env.CLAUDECODE) env.CLAUDECODE = "";
    return {
      command: "claude",
      args: ["--resume", candidate.resume],
      cwd: candidate.cwd,
      env,
    };
  }

  if (candidate.engine === "gemini") {
    return {
      command: "gemini",
      args: ["--resume", candidate.resume],
      cwd: candidate.cwd,
      env,
    };
  }

  if (candidate.engine === "pi") {
    return {
      command: "pi",
      args: ["--session", candidate.resume],
      cwd: candidate.cwd,
      env,
    };
  }

  if (candidate.engine === "kimi") {
    return {
      command: "kimi",
      args: ["--session", candidate.resume, "--work-dir", candidate.cwd],
      cwd: candidate.cwd,
      env,
    };
  }

  if (candidate.engine === "forge") {
    return {
      command: "forge",
      args: ["--conversation-id", candidate.resume, "-C", candidate.cwd],
      cwd: candidate.cwd,
      env,
    };
  }

  if (candidate.engine === "amp") {
    return {
      command: "amp",
      args: ["threads", "continue", candidate.resume],
      cwd: candidate.cwd,
      env,
    };
  }

  return {
    command: "codex",
    args: ["resume", candidate.resume, "-C", candidate.cwd],
    cwd: candidate.cwd,
    env,
  };
}

export function isNativeHijackCandidate(
  candidate: HijackCandidate,
): candidate is HijackCandidate & { mode: "native-cli"; engine: NativeHijackEngine; resume: string } {
  return candidate.mode === "native-cli" &&
    typeof candidate.resume === "string" &&
    Boolean(asNativeHijackEngine(candidate.engine));
}

export function launchHijackSession(spec: HijackLaunchSpec): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 0));
  });
}
