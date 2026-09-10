import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The durable composition, driven through a REAL provider route.
 *
 * Every other flow test resolves its seats to a scripted `Model`, which builds
 * no HTTP request and so never meets the capability kernel. The shipped entry
 * points do the opposite: `bin/smithers-review.mjs` and the GitHub action both
 * run `layerNode`, where the host installs a guarded HTTP client and checks
 * every model request as `model:call` against its grant store. A composition
 * that grants no rule for it suspends the run on a permission nobody is there
 * to answer, and the CLI dies with "All fibers interrupted without error".
 *
 * The provider is a local fixture rather than a credential, so the check runs
 * on every machine: the URL is absolute, the route is a real `Route`, and the
 * kernel sees a real `model:call` on a real host and model id.
 *
 * Node, not Bun: `layerNode` builds the host's undici client, whose dispatcher
 * teardown is unavailable under Bun, so the composition the CLI runs can only
 * be exercised from Node. The driver prints one JSON line.
 */

const driver = fileURLToPath(new URL("./fixtures/runNodeReview.ts", import.meta.url));

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
  }
});

/** A repository whose working tree changes `count` files against its first commit. */
function tempRepo(count = 1): string {
  const dir = mkdtempSync(join(tmpdir(), "review-layer-node-"));
  tempDirs.push(dir);
  const run = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  run(["init"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test User"]);
  run(["config", "commit.gpgsign", "false"]);
  mkdirSync(dirname(join(dir, "src/file0.ts")), { recursive: true });
  for (let index = 0; index < count; index++) {
    writeFileSync(join(dir, `src/file${index}.ts`), `export const value${index} = ${index};\n`);
  }
  writeFileSync(join(dir, ".gitignore"), ".smithers-review/\n");
  run(["add", "."]);
  run(["commit", "-m", "base"]);
  for (let index = 0; index < count; index++) {
    writeFileSync(join(dir, `src/file${index}.ts`), `export const value${index} = ${index};\nexport const next${index} = ${index + 1};\n`);
  }
  return dir;
}

describe("the durable composition against a real provider route", () => {
  test("reaches the model through the capability kernel and returns findings", () => {
    const repo = tempRepo();
    const result = spawnSync("node", [driver, repo, join(repo, ".smithers-review", "review.db")], {
      encoding: "utf8",
      env: process.env,
      timeout: 180_000,
    });

    const line = result.stdout.trim().split("\n").filter((text) => text.startsWith("{")).at(-1);
    // No JSON line at all means the driver died before it could report, and its
    // stderr is the only evidence of why.
    expect(line ?? `no report; stderr: ${result.stderr}`).toContain("{");
    const report = JSON.parse(line!) as {
      ok: boolean;
      requests: number;
      status?: string;
      paths?: string[];
      error?: string;
    };

    // The failure this test exists for suspends the run on an ungranted
    // `model:call`, which surfaces as an interrupt rather than a named error,
    // so the message is worth reporting when it happens.
    expect(report.error ?? "none").toBe("none");
    expect(report.ok).toBe(true);
    // The kernel let the call through: the fixture provider was actually asked,
    // and the answer it streamed became the review's finding.
    expect(report.requests).toBeGreaterThan(0);
    expect(report.status).toBe("success");
    expect(report.paths).toEqual(["src/file0.ts"]);
  }, 240_000);
});

test("restarts the same execution after a settled file round without rereading the worktree or recalling its provider", async () => {
  const repo = tempRepo(2);
  const db = join(repo, ".smithers-review", "review.db");
  const executionId = "review-node-restart";
  const run = (id: string) => {
    const result = spawnSync("node", [driver, repo, db, id], {
      encoding: "utf8", env: process.env, timeout: 180_000,
    });
    expect(result.status, result.stderr).toBe(0);
    const line = result.stdout.trim().split("\n").filter((text) => text.startsWith("{")).at(-1);
    expect(line, result.stderr).toBeDefined();
    const report = JSON.parse(line!);
    expect(report.error ?? "none").toBe("none");
    expect(report.ok).toBe(true);
    return report;
  };
  // A complete reference run pins exact findings and the original snapshot.
  const reference = run("review-node-reference");
  expect(reference.calls).toEqual(["src/file0.ts", "src/file1.ts"]);
  expect(reference.findings).toEqual(["src/file0.ts", "src/file1.ts"].map((path) => ({
    path, content: "The new binding shadows the old one.", severity: "major",
    category: "correctness", confidence: "confirmed", startLine: 2, endLine: 2,
    existingCode: "", suggestionCode: "", thinking: "",
  })));
  const child = spawn("node", [driver, repo, db, executionId, "src/file1.ts"], {
    env: process.env, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  try {
    const paused = await new Promise<{ requests: number; calls: string[] }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`pause timed out: ${stderr}`)), 180_000);
      child.stderr.on("data", (data) => { stderr += data.toString(); });
      child.stdout.on("data", (data) => {
        stdout += data.toString();
        for (const line of stdout.split("\n").slice(0, -1)) {
          if (!line.startsWith("{")) continue;
          const report = JSON.parse(line);
          if (report.paused) { clearTimeout(timer); resolve(report); }
        }
      });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", () => { clearTimeout(timer); reject(new Error(`exited before pause: ${stdout} ${stderr}`)); });
    });
    expect(paused.requests).toBe(1);
    expect(paused.calls).toEqual(["src/file0.ts"]);
  } finally {
    child.kill("SIGKILL");
    await closed;
  }
  expect(child.signalCode).toBe("SIGKILL");
  for (let index = 0; index < 2; index++) {
    writeFileSync(join(repo, `src/file${index}.ts`), "export const changedAfterCrash = true;\n");
  }
  const resumed = run(executionId);
  expect(resumed.calls).toEqual(["src/file1.ts"]);
  expect(resumed.requests).toBe(1);
  expect(resumed.findings).toEqual(reference.findings);
  expect(resumed.diffs).toEqual(reference.diffs);
  expect(resumed.diffs.map((file: { diff: string }) => file.diff).join("\n")).toContain("export const next1 = 2;");
  const replayed = run(executionId);
  expect(replayed.requests).toBe(0);
  expect(replayed.findings).toEqual(reference.findings);
}, 600_000);

test("CLI resumes its printed execution ID and refuses changed input in the same database", () => {
  const repo = tempRepo();
  const db = join(repo, ".smithers-review", "review.db");
  const summary = join(repo, ".smithers-review", "summary.json");
  const bin = fileURLToPath(new URL("../../bin/smithers-review.mjs", import.meta.url));
  const run = (extra: string[] = []) => spawnSync("node", [
    bin, repo, "--db", db, "--no-review", "--no-narrate", "--quiz", "off", ...extra,
  ], {
    encoding: "utf8", timeout: 180_000,
    env: { ...process.env, SMITHERS_REVIEW_SUMMARY_PATH: summary },
  });
  const first = run();
  expect(first.status, first.stderr).toBe(0);
  const executionId = /\[smithers-review\] run (\S+) on/.exec(first.stderr)?.[1];
  expect(executionId).toBeDefined();
  const original = JSON.parse(readFileSync(summary, "utf8"));
  writeFileSync(join(repo, "src/file0.ts"), "export const changedAfterCrash = true;\n");
  const resumed = run(["--execution-id", executionId!]);
  expect(resumed.status, resumed.stderr).toBe(0);
  expect(resumed.stderr).toContain(`run ${executionId} on`);
  expect(JSON.parse(readFileSync(summary, "utf8"))).toEqual(original);
  const conflict = run(["--execution-id", executionId!, "--background", "a different review"]);
  expect(conflict.status).toBe(1);
  expect(conflict.stderr).toContain(`run ${executionId} failed`);
  expect(conflict.stderr).toContain("payload identity");
}, 600_000);
