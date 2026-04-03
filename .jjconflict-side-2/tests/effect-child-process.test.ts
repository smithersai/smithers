import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { spawnCaptureEffect } from "../src/effect/child-process";
import { runPromise } from "../src/effect/runtime";
import { renderPrometheusMetrics } from "../src/observability";

const CWD = "/tmp";

function metricValue(name: string): number {
  const prefix = `${name} `;
  const line = renderPrometheusMetrics()
    .split("\n")
    .find((entry) => entry.startsWith(prefix));
  if (!line) return 0;
  return Number(line.slice(prefix.length));
}

describe("spawnCaptureEffect", () => {
  // ---------------------------------------------------------------------------
  // 1. Successful command
  // ---------------------------------------------------------------------------
  describe("successful command", () => {
    test("captures stdout from echo", async () => {
      const result = await runPromise(
        spawnCaptureEffect("echo", ["hello"], { cwd: CWD }),
      );
      expect(result.stdout.trim()).toBe("hello");
      expect(result.exitCode).toBe(0);
    });

    test("captures multi-word stdout", async () => {
      const result = await runPromise(
        spawnCaptureEffect("echo", ["hello world"], { cwd: CWD }),
      );
      expect(result.stdout.trim()).toBe("hello world");
      expect(result.exitCode).toBe(0);
    });

    test("returns empty stdout for silent command", async () => {
      const result = await runPromise(
        spawnCaptureEffect("true", [], { cwd: CWD }),
      );
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Failed command (non-zero exit code)
  // ---------------------------------------------------------------------------
  describe("failed command", () => {
    test("returns exit code 1 for false", async () => {
      const result = await runPromise(
        spawnCaptureEffect("false", [], { cwd: CWD }),
      );
      expect(result.exitCode).toBe(1);
    });

    test("returns arbitrary non-zero exit code", async () => {
      const result = await runPromise(
        spawnCaptureEffect("sh", ["-c", "exit 42"], { cwd: CWD }),
      );
      expect(result.exitCode).toBe(42);
    });

    test("returns exit code 127 for bad shell command", async () => {
      const result = await runPromise(
        spawnCaptureEffect("sh", ["-c", "exit 127"], { cwd: CWD }),
      );
      expect(result.exitCode).toBe(127);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Stderr capture
  // ---------------------------------------------------------------------------
  describe("stderr capture", () => {
    test("captures stderr output", async () => {
      const result = await runPromise(
        spawnCaptureEffect("sh", ["-c", "echo err >&2"], { cwd: CWD }),
      );
      expect(result.stderr.trim()).toBe("err");
    });

    test("captures stderr while stdout is empty", async () => {
      const result = await runPromise(
        spawnCaptureEffect("sh", ["-c", "echo only-stderr >&2"], { cwd: CWD }),
      );
      expect(result.stdout).toBe("");
      expect(result.stderr.trim()).toBe("only-stderr");
    });

    test("captures both stdout and stderr simultaneously", async () => {
      const result = await runPromise(
        spawnCaptureEffect(
          "sh",
          ["-c", "echo out-line && echo err-line >&2"],
          { cwd: CWD },
        ),
      );
      expect(result.stdout.trim()).toBe("out-line");
      expect(result.stderr.trim()).toBe("err-line");
      expect(result.exitCode).toBe(0);
    });

    test("increments truncation metric when output exceeds maxOutputBytes", async () => {
      const before = metricValue("smithers_tool_output_truncated_total");
      const result = await runPromise(
        spawnCaptureEffect(
          "sh",
          ["-c", "i=0; while [ $i -lt 256 ]; do printf x; i=$((i + 1)); done"],
          {
            cwd: CWD,
            maxOutputBytes: 32,
          },
        ),
      );
      expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(32);
      expect(metricValue("smithers_tool_output_truncated_total")).toBe(before + 1);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Input piping (stdin)
  // ---------------------------------------------------------------------------
  describe("input piping", () => {
    test("pipes input to stdin and captures via cat", async () => {
      const result = await runPromise(
        spawnCaptureEffect("cat", [], {
          cwd: CWD,
          input: "hello from stdin",
        }),
      );
      expect(result.stdout).toBe("hello from stdin");
      expect(result.exitCode).toBe(0);
    });

    test("pipes multiline input", async () => {
      const multiline = "line1\nline2\nline3";
      const result = await runPromise(
        spawnCaptureEffect("cat", [], { cwd: CWD, input: multiline }),
      );
      expect(result.stdout).toBe(multiline);
    });

    test("pipes empty input", async () => {
      const result = await runPromise(
        spawnCaptureEffect("cat", [], { cwd: CWD, input: "" }),
      );
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Timeout (timeoutMs)
  // ---------------------------------------------------------------------------
  describe("timeout", () => {
    test("kills process that exceeds timeoutMs", async () => {
      const effect = spawnCaptureEffect("sleep", ["10"], {
        cwd: CWD,
        timeoutMs: 100,
      });
      try {
        await runPromise(effect);
        expect(true).toBe(false); // should not reach
      } catch (err: any) {
        expect(err.message).toContain("timed out");
        expect(err.message).toContain("100ms");
      }
    });

    test("does not time out when command finishes in time", async () => {
      const result = await runPromise(
        spawnCaptureEffect("echo", ["fast"], {
          cwd: CWD,
          timeoutMs: 5000,
        }),
      );
      expect(result.stdout.trim()).toBe("fast");
      expect(result.exitCode).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Idle timeout (idleTimeoutMs)
  // ---------------------------------------------------------------------------
  describe("idle timeout", () => {
    test("kills process that goes idle after initial output", async () => {
      // Produce one line of output then sleep forever
      const effect = spawnCaptureEffect(
        "sh",
        ["-c", "echo start; sleep 30"],
        {
          cwd: CWD,
          idleTimeoutMs: 150,
          timeoutMs: 10000, // safety net
        },
      );
      try {
        await runPromise(effect);
        expect(true).toBe(false);
      } catch (err: any) {
        expect(err.message).toContain("idle timed out");
        expect(err.message).toContain("150ms");
      }
    });

    test("resets idle timer on continued output", async () => {
      // Produce output every 50ms for 200ms total, with a 150ms idle timeout.
      // The idle timer should keep resetting so the command completes.
      const result = await runPromise(
        spawnCaptureEffect(
          "sh",
          ["-c", "for i in 1 2 3 4; do echo $i; sleep 0.05; done"],
          {
            cwd: CWD,
            idleTimeoutMs: 150,
            timeoutMs: 5000,
          },
        ),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("4");
    });

    test("idle timeout fires when no output is ever produced", async () => {
      const effect = spawnCaptureEffect("sleep", ["30"], {
        cwd: CWD,
        idleTimeoutMs: 100,
        timeoutMs: 10000,
      });
      try {
        await runPromise(effect);
        expect(true).toBe(false);
      } catch (err: any) {
        expect(err.message).toContain("idle timed out");
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Abort signal
  // ---------------------------------------------------------------------------
  describe("abort signal", () => {
    test("aborts a running process via AbortController", async () => {
      const controller = new AbortController();
      const effect = spawnCaptureEffect("sleep", ["10"], {
        cwd: CWD,
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 50);
      try {
        await runPromise(effect);
        expect(true).toBe(false);
      } catch (err: any) {
        expect(err.message).toContain("aborted");
      }
    });

    test("handles already-aborted signal synchronously", async () => {
      const controller = new AbortController();
      controller.abort();
      const effect = spawnCaptureEffect("echo", ["hi"], {
        cwd: CWD,
        signal: controller.signal,
      });
      try {
        await runPromise(effect);
        expect(true).toBe(false);
      } catch (err: any) {
        expect(err.message).toContain("aborted");
      }
    });

    test("does not abort when signal is never triggered", async () => {
      const controller = new AbortController();
      const result = await runPromise(
        spawnCaptureEffect("echo", ["not aborted"], {
          cwd: CWD,
          signal: controller.signal,
        }),
      );
      expect(result.stdout.trim()).toBe("not aborted");
      expect(result.exitCode).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 8. Output truncation (maxOutputBytes)
  // ---------------------------------------------------------------------------
  describe("output truncation", () => {
    test("truncates stdout to maxOutputBytes", async () => {
      const result = await runPromise(
        spawnCaptureEffect("sh", ["-c", "printf 'A%.0s' {1..1000}"], {
          cwd: CWD,
          maxOutputBytes: 50,
        }),
      );
      const byteLen = Buffer.from(result.stdout, "utf8").length;
      expect(byteLen).toBeLessThanOrEqual(50);
    });

    test("truncates stderr to maxOutputBytes", async () => {
      const result = await runPromise(
        spawnCaptureEffect(
          "sh",
          ["-c", "printf 'B%.0s' {1..1000} >&2"],
          { cwd: CWD, maxOutputBytes: 40 },
        ),
      );
      const byteLen = Buffer.from(result.stderr, "utf8").length;
      expect(byteLen).toBeLessThanOrEqual(40);
    });

    test("does not truncate when output fits within limit", async () => {
      const result = await runPromise(
        spawnCaptureEffect("echo", ["short"], {
          cwd: CWD,
          maxOutputBytes: 10000,
        }),
      );
      expect(result.stdout.trim()).toBe("short");
    });

    test("default maxOutputBytes is 200_000", async () => {
      // Produce ~1000 bytes of output, well under the 200k default
      const result = await runPromise(
        spawnCaptureEffect("sh", ["-c", "printf 'X%.0s' {1..1000}"], {
          cwd: CWD,
        }),
      );
      expect(result.stdout.length).toBe(1000);
    });
  });

  // ---------------------------------------------------------------------------
  // 9. onStdout / onStderr callbacks
  // ---------------------------------------------------------------------------
  describe("onStdout / onStderr callbacks", () => {
    test("calls onStdout with output chunks", async () => {
      const chunks: string[] = [];
      await runPromise(
        spawnCaptureEffect("echo", ["callback test"], {
          cwd: CWD,
          onStdout: (text) => chunks.push(text),
        }),
      );
      expect(chunks.join("").trim()).toBe("callback test");
    });

    test("calls onStderr with error chunks", async () => {
      const chunks: string[] = [];
      await runPromise(
        spawnCaptureEffect("sh", ["-c", "echo stderr-data >&2"], {
          cwd: CWD,
          onStderr: (text) => chunks.push(text),
        }),
      );
      expect(chunks.join("").trim()).toBe("stderr-data");
    });

    test("calls both onStdout and onStderr for mixed output", async () => {
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      await runPromise(
        spawnCaptureEffect(
          "sh",
          ["-c", "echo out-data && echo err-data >&2"],
          {
            cwd: CWD,
            onStdout: (text) => stdoutChunks.push(text),
            onStderr: (text) => stderrChunks.push(text),
          },
        ),
      );
      expect(stdoutChunks.join("").trim()).toBe("out-data");
      expect(stderrChunks.join("").trim()).toBe("err-data");
    });

    test("onStdout receives multiple chunks for large output", async () => {
      const chunks: string[] = [];
      await runPromise(
        spawnCaptureEffect(
          "sh",
          ["-c", "for i in $(seq 1 100); do echo line$i; done"],
          {
            cwd: CWD,
            onStdout: (text) => chunks.push(text),
          },
        ),
      );
      const combined = chunks.join("");
      expect(combined).toContain("line1");
      expect(combined).toContain("line100");
    });
  });

  // ---------------------------------------------------------------------------
  // 10. Non-existent command (spawn error)
  // ---------------------------------------------------------------------------
  describe("non-existent command", () => {
    test("rejects with error containing command name", async () => {
      const effect = spawnCaptureEffect("nonexistent_cmd_xyz_42", [], {
        cwd: CWD,
      });
      try {
        await runPromise(effect);
        expect(true).toBe(false);
      } catch (err: any) {
        expect(err.message).toContain("nonexistent_cmd_xyz_42");
      }
    });

    test("error is an instance of Error", async () => {
      try {
        await runPromise(
          spawnCaptureEffect("__no_such_binary__", [], { cwd: CWD }),
        );
        expect(true).toBe(false);
      } catch (err: any) {
        expect(err).toBeInstanceOf(Error);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Additional edge cases
  // ---------------------------------------------------------------------------
  describe("environment variables", () => {
    test("passes custom env to child process", async () => {
      const result = await runPromise(
        spawnCaptureEffect("sh", ["-c", "echo $MY_TEST_VAR"], {
          cwd: CWD,
          env: { ...process.env, MY_TEST_VAR: "custom_value" },
        }),
      );
      expect(result.stdout.trim()).toBe("custom_value");
    });
  });

  describe("cwd option", () => {
    test("runs command in the specified working directory", async () => {
      const result = await runPromise(
        spawnCaptureEffect("pwd", [], { cwd: "/tmp" }),
      );
      // On macOS /tmp is a symlink to /private/tmp
      expect(result.stdout.trim()).toMatch(/\/(tmp|private\/tmp)$/);
      expect(result.exitCode).toBe(0);
    });
  });

  describe("combined options", () => {
    test("timeout + abort: whichever fires first wins", async () => {
      const controller = new AbortController();
      const effect = spawnCaptureEffect("sleep", ["30"], {
        cwd: CWD,
        timeoutMs: 100,
        signal: controller.signal,
      });
      try {
        await runPromise(effect);
        expect(true).toBe(false);
      } catch (err: any) {
        // Either timeout or abort could fire first; both are valid
        expect(
          err.message.includes("timed out") ||
            err.message.includes("aborted"),
        ).toBe(true);
      }
    });

    test("input + callbacks: callbacks see piped stdin echoed back", async () => {
      const chunks: string[] = [];
      const result = await runPromise(
        spawnCaptureEffect("cat", [], {
          cwd: CWD,
          input: "piped-data",
          onStdout: (text) => chunks.push(text),
        }),
      );
      expect(result.stdout).toBe("piped-data");
      expect(chunks.join("")).toBe("piped-data");
    });
  });
});
