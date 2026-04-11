import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { SmithersError } from "@smithers/errors/SmithersError";
import type { SerializedCtx, HostNodeJson } from "./create-external-smithers";

export type PythonSubprocessConfig = {
  /** Path to the Python workflow script. */
  scriptPath: string;
  /** Working directory for the subprocess. Defaults to cwd. */
  cwd?: string;
  /** Timeout in milliseconds. Defaults to 30000. */
  timeoutMs?: number;
  /** Additional environment variables for the subprocess. */
  env?: Record<string, string>;
};

/**
 * Create a synchronous build function that spawns `uv run <script>`,
 * sends serialized ctx on stdin, and reads HostNode JSON from stdout.
 */
export function createPythonBuildFn(
  config: PythonSubprocessConfig,
): (ctx: SerializedCtx) => HostNodeJson {
  const scriptPath = resolve(config.cwd ?? process.cwd(), config.scriptPath);
  const cwd = config.cwd ?? process.cwd();
  const timeoutMs = config.timeoutMs ?? 30_000;

  return (ctx: SerializedCtx): HostNodeJson => {
    const input = JSON.stringify(ctx);

    const result = spawnSync("uv", ["run", scriptPath], {
      input,
      cwd,
      timeout: timeoutMs,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...config.env },
    });

    if (result.error) {
      const msg = (result.error as any).code === "ETIMEDOUT"
        ? `Python workflow timed out after ${timeoutMs}ms: ${scriptPath}`
        : `Failed to spawn Python workflow: ${result.error.message}`;
      throw new SmithersError("EXTERNAL_BUILD_FAILED", msg, {
        scriptPath,
        error: result.error.message,
      });
    }

    if (result.status !== 0) {
      const stderr = (result.stderr ?? "").trim();
      throw new SmithersError(
        "EXTERNAL_BUILD_FAILED",
        `Python workflow exited with code ${result.status}: ${scriptPath}${stderr ? `\n${stderr}` : ""}`,
        { scriptPath, exitCode: result.status, stderr },
      );
    }

    const stdout = (result.stdout ?? "").trim();
    if (!stdout) {
      throw new SmithersError(
        "EXTERNAL_BUILD_FAILED",
        `Python workflow produced no output: ${scriptPath}`,
        { scriptPath },
      );
    }

    let hostNode: HostNodeJson;
    try {
      hostNode = JSON.parse(stdout);
    } catch (e) {
      throw new SmithersError(
        "EXTERNAL_BUILD_FAILED",
        `Python workflow produced invalid JSON: ${scriptPath}\n${(e as Error).message}\nOutput: ${stdout.slice(0, 200)}`,
        { scriptPath, stdout: stdout.slice(0, 500) },
      );
    }

    // Basic shape validation
    if (!hostNode || typeof hostNode !== "object" || !("kind" in hostNode)) {
      throw new SmithersError(
        "EXTERNAL_BUILD_FAILED",
        `Python workflow output is not a valid HostNode (missing "kind"): ${scriptPath}`,
        { scriptPath },
      );
    }

    return hostNode;
  };
}

/**
 * Discover Pydantic schemas from a Python workflow script.
 *
 * Runs `uv run <script> --schemas` and parses the JSON Schema output.
 * Returns a map of schema name → JSON Schema object.
 */
export function discoverPythonSchemas(
  config: PythonSubprocessConfig,
): Record<string, any> {
  const scriptPath = resolve(config.cwd ?? process.cwd(), config.scriptPath);
  const cwd = config.cwd ?? process.cwd();
  const timeoutMs = config.timeoutMs ?? 30_000;

  const result = spawnSync("uv", ["run", scriptPath, "--schemas"], {
    cwd,
    timeout: timeoutMs,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...config.env },
  });

  if (result.error) {
    throw new SmithersError(
      "SCHEMA_DISCOVERY_FAILED",
      `Failed to discover schemas from ${scriptPath}: ${result.error.message}`,
      { scriptPath, error: result.error.message },
    );
  }

  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    throw new SmithersError(
      "SCHEMA_DISCOVERY_FAILED",
      `Schema discovery exited with code ${result.status}: ${scriptPath}${stderr ? `\n${stderr}` : ""}`,
      { scriptPath, exitCode: result.status, stderr },
    );
  }

  const stdout = (result.stdout ?? "").trim();
  if (!stdout) {
    throw new SmithersError(
      "SCHEMA_DISCOVERY_FAILED",
      `Schema discovery produced no output. Does run() have schemas= parameter?\n${scriptPath}`,
      { scriptPath },
    );
  }

  try {
    return JSON.parse(stdout);
  } catch (e) {
    throw new SmithersError(
      "SCHEMA_DISCOVERY_FAILED",
      `Schema discovery produced invalid JSON: ${scriptPath}\n${(e as Error).message}`,
      { scriptPath, stdout: stdout.slice(0, 500) },
    );
  }
}
