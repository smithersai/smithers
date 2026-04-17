import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { mkdir, realpath, stat } from "node:fs/promises";
import { SmithersError } from "@smithers/errors/SmithersError";
import {
  assertPathWithinRoot,
  resolveSandboxPath,
} from "@smithers/sandbox/sandboxPath";
import { getToolContext } from "./context.js";

export const DEFAULT_MAX_OUTPUT_BYTES = 200_000;
export const DEFAULT_TIMEOUT_MS = 60_000;

export function getToolRuntimeOptions() {
  const ctx = getToolContext();
  return {
    ctx,
    rootDir: ctx?.rootDir ?? process.cwd(),
    allowNetwork: ctx?.allowNetwork ?? false,
    maxOutputBytes: ctx?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    timeoutMs: ctx?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function truncateToBytes(text, maxBytes) {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) {
    return text;
  }
  return buf.subarray(0, maxBytes).toString("utf8");
}

export async function resolveToolPath(rootDir, inputPath) {
  const resolved = resolveSandboxPath(rootDir, inputPath);
  await assertPathWithinRoot(rootDir, resolved);
  return resolved;
}

export async function ensureParentDir(path) {
  await mkdir(dirname(path), { recursive: true });
}

export async function assertReadableFileWithinLimit(path, maxBytes) {
  const fileStat = await stat(path);
  if (Number(fileStat.size) > maxBytes) {
    throw new SmithersError(
      "TOOL_FILE_TOO_LARGE",
      `File too large (${fileStat.size} bytes)`,
    );
  }
}

export async function canonicalRoot(rootDir) {
  return realpath(rootDir);
}

function appendLimited(chunks, state, chunk, maxBytes) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  state.totalBytes += buffer.length;
  const remaining = maxBytes - state.storedBytes;
  if (remaining <= 0) {
    state.truncated = true;
    return;
  }
  if (buffer.length <= remaining) {
    chunks.push(buffer);
    state.storedBytes += buffer.length;
    return;
  }
  chunks.push(buffer.subarray(0, remaining));
  state.storedBytes += remaining;
  state.truncated = true;
}

export function captureProcess(
  command,
  args,
  {
    cwd,
    env = process.env,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    detached = false,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    const state = {
      storedBytes: 0,
      totalBytes: 0,
      truncated: false,
    };
    let settled = false;
    let timer;

    const child = spawn(command, args, {
      cwd,
      env,
      detached,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (fn) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      fn();
    };

    const kill = () => {
      try {
        if (detached && child.pid) {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    };

    if (timeoutMs) {
      timer = setTimeout(() => {
        kill();
        finish(() =>
          reject(
            new SmithersError(
              "PROCESS_TIMEOUT",
              `Command timed out after ${timeoutMs}ms`,
              { command, args, cwd, timeoutMs },
            ),
          ),
        );
      }, timeoutMs);
    }

    child.stdout.on("data", (chunk) => {
      appendLimited(stdoutChunks, state, chunk, maxOutputBytes);
    });
    child.stderr.on("data", (chunk) => {
      appendLimited(stderrChunks, state, chunk, maxOutputBytes);
    });
    child.on("error", (error) => {
      finish(() =>
        reject(
          new SmithersError("PROCESS_FAILED", `Failed to spawn ${command}`, {
            command,
            args,
            cwd,
          }, { cause: error }),
        ),
      );
    });
    child.on("close", (exitCode, signal) => {
      finish(() => {
        resolve({
          exitCode: exitCode ?? (signal ? 1 : 0),
          signal,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          truncated: state.truncated,
          totalBytes: state.totalBytes,
        });
      });
    });
  });
}
